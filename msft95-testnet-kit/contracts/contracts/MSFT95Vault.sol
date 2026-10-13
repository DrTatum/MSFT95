// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/**
 * @title MSFT95 games vault (v3)
 * @notice Custody contract for the MSFT95 casino (Stake-style: deposit on-chain, play off-chain, withdraw on-chain).
 *
 *  - Players deposit supported tokens (or native ETH). The vault only records the deposit in an event;
 *    the backend ledger credits the player's balance after enough confirmations.
 *  - Players withdraw with an EIP-712 voucher signed by the backend's SIGNER key. Large withdrawals
 *    also need a second signature from a COSIGNER key held on separate infrastructure.
 *  - Every voucher is single use (per-user nonce), bound to this chain and contract, valid while
 *    block.timestamp < deadline, at most MAX_VOUCHER_LIFETIME after the issuedAt it claims, and bound to the
 *    current voucherEpoch. Bumping the epoch (guardian or admin: voidAllVouchers, or automatically whenever a
 *    SIGNER or COSIGNER key is revoked) kills every outstanding voucher at once, whatever issuedAt it claims,
 *    including vouchers pre-signed with a future issuedAt.
 *  - Per-token limits cap the damage of a stolen signer key: a maximum per withdrawal and a daily
 *    total. The day is a 24h window that starts with the first outflow after the previous window
 *    ended, so in the worst case 2x dailyCap can leave inside any 24 hours. Size dailyCap with that in mind.
 *  - A GUARDIAN (e.g. the monitoring bot) can pause deposits and/or withdrawals instantly; only the
 *    admin can unpause. A withdrawal pause also stops house sweeps.
 *  - Only the admin or a BANKROLL wallet can add house bankroll; players can only enter through deposit().
 *  - All roles, tokens and the allowlist are set in the constructor, so the admin (a Safe on mainnet) holds
 *    admin rights from block one and no hot deployer key is ever admin.
 *
 *  Trust model: like any custodial casino, players trust the operator to sign their withdrawals. The
 *  contract limits how fast funds can leave if a key is compromised; it does not know player balances.
 *  Value can still be forced into the vault without an event (SELFDESTRUCT, plain ERC-20 transfer), so
 *  off-chain reconciliation must check balance >= liabilities, never equality.
 */
contract MSFT95Vault is AccessControlDefaultAdminRules, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- roles
    bytes32 public constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    bytes32 public constant SIGNER_ROLE = keccak256("SIGNER_ROLE");
    bytes32 public constant COSIGNER_ROLE = keccak256("COSIGNER_ROLE");
    bytes32 public constant BANKROLL_ROLE = keccak256("BANKROLL_ROLE");

    /// @dev native ETH is represented by address(0)
    address public constant ETH = address(0);

    bytes32 public constant WITHDRAWAL_TYPEHASH = keccak256(
        "Withdrawal(address user,address token,uint256 amount,uint256 nonce,uint256 epoch,uint256 issuedAt,uint256 deadline)"
    );

    uint256 public constant WINDOW = 1 days;
    uint256 public constant MAX_VOUCHER_LIFETIME = 1 days;
    /// @dev tolerance for the signer's clock running a little ahead of the chain
    uint256 public constant MAX_CLOCK_SKEW = 5 minutes;
    /// @dev longest admin-handover delay accepted (protects against unit mistakes that would lock admin rotation for years)
    uint48 public constant MAX_ADMIN_DELAY = 30 days;
    /// @dev cosignAbove value that explicitly means "this token never needs a cosigner"
    uint128 public constant NO_COSIGN = type(uint128).max;

    // ---------------------------------------------------------------- types
    struct TokenConfig {
        bool listed;           // withdrawals possible (never unlisted while players hold balances)
        bool depositsEnabled;  // new deposits accepted
        uint128 minDeposit;    // smallest deposit accepted (token units)
        uint128 maxWithdrawal; // largest single withdrawal
        uint128 dailyCap;      // most that can leave per 24h window (players + house sweeps); see note above
        uint128 cosignAbove;   // withdrawals above this need a COSIGNER signature too (< maxWithdrawal, or NO_COSIGN)
    }

    struct Window {
        uint64 start;
        uint192 spent;
    }

    struct Withdrawal {
        address user;
        address token;
        uint256 amount;
        uint256 nonce;
        uint256 epoch;    // must equal voucherEpoch when paid
        uint256 issuedAt; // when the backend signed it (unix seconds)
        uint256 deadline; // valid while block.timestamp < deadline; deadline - issuedAt <= MAX_VOUCHER_LIFETIME
    }

    struct TokenSetup {
        address token;
        TokenConfig config;
    }

    struct Setup {
        address admin;          // Safe on mainnet
        uint48 adminDelay;      // waiting period for handing over admin
        address signer;         // may be zero (grant later)
        address cosigner;       // may be zero
        address guardian;       // may be zero
        address bankroller;     // may be zero (the admin can always fund the bankroll)
        bool allowlistOnly;
        address[] allowed;
        TokenSetup[] tokens;
    }

    // ---------------------------------------------------------------- state
    mapping(address => TokenConfig) public tokenConfig;
    mapping(address => Window) public window;
    mapping(address => mapping(uint256 => bool)) public nonceUsed;

    bool public depositsPaused;
    bool public withdrawalsPaused;

    bool public allowlistOnly;
    mapping(address => bool) public allowed;

    uint256 public depositCount;

    /// @notice only vouchers signed for the current epoch can be paid; bumped to void every outstanding voucher
    uint256 public voucherEpoch;

    // ---------------------------------------------------------------- events
    event Deposited(address indexed user, address indexed token, uint256 amount, uint256 indexed depositId);
    event BankrollFunded(address indexed from, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount, uint256 indexed nonce, address relayer);
    event HouseWithdrawal(address indexed token, address indexed to, uint256 amount);
    event TokenConfigured(address indexed token, TokenConfig config);
    event DepositsPaused(bool paused, address by);
    event WithdrawalsPaused(bool paused, address by);
    event AllowlistOnly(bool on);
    event AllowedSet(address indexed user, bool allowed);
    event VouchersVoided(uint256 newEpoch, address by);

    // ---------------------------------------------------------------- errors
    error TokenNotListed(address token);
    error DepositsClosed();
    error WithdrawalsClosed();
    error NotAllowed(address user);
    error BelowMinDeposit(uint256 received, uint256 min);
    error ZeroAmount();
    error UseDepositETH();
    error AmountMismatch();
    error VoucherExpired();
    error VoucherTooLong();
    error VoucherNotYetValid();
    error VoucherVoided();
    error NonceAlreadyUsed();
    error AboveMaxWithdrawal(uint256 amount, uint256 max);
    error DailyCapExceeded(uint256 wouldSpend, uint256 cap);
    error BadSignatures();
    error EthTransferFailed();
    error BadConfig();
    error Unauthorized();

    constructor(Setup memory s)
        AccessControlDefaultAdminRules(s.adminDelay, s.admin)
        EIP712("MSFT95Vault", "1")
    {
        if (s.adminDelay > MAX_ADMIN_DELAY) revert BadConfig();
        if (s.signer != address(0)) _grantRole(SIGNER_ROLE, s.signer);
        if (s.cosigner != address(0)) _grantRole(COSIGNER_ROLE, s.cosigner);
        if (s.guardian != address(0)) _grantRole(GUARDIAN_ROLE, s.guardian);
        if (s.bankroller != address(0)) _grantRole(BANKROLL_ROLE, s.bankroller);
        for (uint256 i; i < s.tokens.length; ++i) _setToken(s.tokens[i].token, s.tokens[i].config);
        allowlistOnly = s.allowlistOnly;
        emit AllowlistOnly(s.allowlistOnly);
        for (uint256 i; i < s.allowed.length; ++i) {
            allowed[s.allowed[i]] = true;
            emit AllowedSet(s.allowed[i], true);
        }
    }

    // ================================================================ deposits

    /// @notice Deposit an ERC-20. The amount credited is what the vault actually received
    ///         (fee-on-transfer tokens are credited net of the fee).
    function deposit(address token, uint256 amount) external nonReentrant returns (uint256 received) {
        if (token == ETH) revert UseDepositETH();
        _checkDeposit(token);
        if (amount == 0) revert ZeroAmount();
        uint256 before = IERC20(token).balanceOf(address(this));
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        received = IERC20(token).balanceOf(address(this)) - before;
        _recordDeposit(token, received);
    }

    /// @notice Deposit native ETH.
    function depositETH() external payable nonReentrant returns (uint256) {
        _checkDeposit(ETH);
        _recordDeposit(ETH, msg.value);
        return msg.value;
    }

    /// @notice Add house bankroll (admin or BANKROLL wallet only). Never credited to a player.
    ///         For ETH, `amount` must equal msg.value.
    function fundBankroll(address token, uint256 amount) external payable nonReentrant {
        if (!hasRole(BANKROLL_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) revert Unauthorized();
        if (!tokenConfig[token].listed) revert TokenNotListed(token);
        uint256 received;
        if (token == ETH) {
            if (amount != msg.value) revert AmountMismatch();
            received = msg.value;
        } else {
            if (msg.value != 0) revert UseDepositETH();
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(token).balanceOf(address(this)) - before;
        }
        if (received == 0) revert ZeroAmount();
        emit BankrollFunded(msg.sender, token, received);
    }

    /// @dev plain ETH transfers are rejected so nobody loses funds by sending without depositETH()
    receive() external payable {
        revert UseDepositETH();
    }

    function _checkDeposit(address token) private view {
        TokenConfig storage c = tokenConfig[token];
        if (!c.listed) revert TokenNotListed(token);
        if (depositsPaused || !c.depositsEnabled) revert DepositsClosed();
        if (allowlistOnly && !allowed[msg.sender]) revert NotAllowed(msg.sender);
    }

    function _recordDeposit(address token, uint256 received) private {
        if (received == 0) revert ZeroAmount();
        uint256 min = tokenConfig[token].minDeposit;
        if (received < min) revert BelowMinDeposit(received, min);
        unchecked { ++depositCount; }
        emit Deposited(msg.sender, token, received, depositCount);
    }

    // ================================================================ withdrawals

    /// @notice Pay out a signed withdrawal voucher. Anyone may submit it (e.g. a gas relayer);
    ///         the funds always go to `w.user`.
    /// @param sigs one SIGNER signature, plus one COSIGNER signature when amount > cosignAbove
    function withdraw(Withdrawal calldata w, bytes[] calldata sigs) external nonReentrant {
        if (withdrawalsPaused) revert WithdrawalsClosed();
        TokenConfig storage c = tokenConfig[w.token];
        if (!c.listed) revert TokenNotListed(w.token);
        if (w.amount == 0) revert ZeroAmount();
        if (block.timestamp >= w.deadline) revert VoucherExpired();
        if (w.issuedAt > block.timestamp + MAX_CLOCK_SKEW) revert VoucherNotYetValid();
        if (w.deadline <= w.issuedAt || w.deadline - w.issuedAt > MAX_VOUCHER_LIFETIME) revert VoucherTooLong();
        if (w.epoch != voucherEpoch) revert VoucherVoided();
        if (nonceUsed[w.user][w.nonce]) revert NonceAlreadyUsed();
        if (w.amount > c.maxWithdrawal) revert AboveMaxWithdrawal(w.amount, c.maxWithdrawal);

        _verify(w, sigs, w.amount > c.cosignAbove);

        nonceUsed[w.user][w.nonce] = true;
        _spend(w.token, w.amount);
        _pay(w.token, w.user, w.amount);
        emit Withdrawn(w.user, w.token, w.amount, w.nonce, msg.sender);
    }

    function hashWithdrawal(Withdrawal calldata w) public view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(WITHDRAWAL_TYPEHASH, w.user, w.token, w.amount, w.nonce, w.epoch, w.issuedAt, w.deadline))
        );
    }

    function _verify(Withdrawal calldata w, bytes[] calldata sigs, bool needCosigner) private view {
        bytes32 digest = hashWithdrawal(w);
        address signer;
        address cosigner;
        uint256 n = sigs.length;
        if (n == 0 || n > 2) revert BadSignatures();
        for (uint256 i; i < n; ++i) {
            address a = ECDSA.recover(digest, sigs[i]); // reverts on malformed / high-s signatures
            if (signer == address(0) && hasRole(SIGNER_ROLE, a) && a != cosigner) {
                signer = a;
            } else if (cosigner == address(0) && hasRole(COSIGNER_ROLE, a) && a != signer) {
                cosigner = a;
            } else {
                revert BadSignatures(); // unknown key, a second key of the same role, or the same key twice
            }
        }
        if (signer == address(0)) revert BadSignatures();
        if (needCosigner && cosigner == address(0)) revert BadSignatures();
    }

    function _spend(address token, uint256 amount) private {
        Window storage win = window[token];
        if (block.timestamp >= uint256(win.start) + WINDOW) {
            win.start = uint64(block.timestamp);
            win.spent = 0;
        }
        uint256 spent = uint256(win.spent) + amount;
        uint256 cap = tokenConfig[token].dailyCap;
        if (spent > cap) revert DailyCapExceeded(spent, cap);
        win.spent = uint192(spent); // spent <= cap <= type(uint128).max
    }

    function _pay(address token, address to, uint256 amount) private {
        if (token == ETH) {
            (bool ok, ) = to.call{value: amount}("");
            if (!ok) revert EthTransferFailed();
        } else {
            IERC20(token).safeTransfer(to, amount);
        }
    }

    // ================================================================ views

    /// @notice How much more of `token` can leave before the current 24h window resets.
    function remainingToday(address token) external view returns (uint256) {
        Window memory win = window[token];
        uint256 cap = tokenConfig[token].dailyCap;
        if (block.timestamp >= uint256(win.start) + WINDOW) return cap;
        return win.spent >= cap ? 0 : cap - win.spent;
    }

    function balanceOf(address token) external view returns (uint256) {
        return token == ETH ? address(this).balance : IERC20(token).balanceOf(address(this));
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    // ================================================================ admin

    function setToken(address token, TokenConfig calldata cfg) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setToken(token, cfg);
    }

    function _setToken(address token, TokenConfig memory cfg) private {
        if (!cfg.listed) {
            // unlisting: the rest of the config is meaningless, so clear it (no stale NO_COSIGN or limits left behind
            // for a later re-listing). An all-zero config is the natural way to ask for this.
            if (cfg.depositsEnabled) revert BadConfig();
            delete tokenConfig[token];
            emit TokenConfigured(token, tokenConfig[token]);
            return;
        }
        if (cfg.maxWithdrawal > cfg.dailyCap) revert BadConfig();
        // the cosigner must stay reachable: cosignAbove below maxWithdrawal, or the explicit NO_COSIGN opt-out
        if (cfg.cosignAbove != NO_COSIGN && cfg.cosignAbove >= cfg.maxWithdrawal) revert BadConfig();
        tokenConfig[token] = cfg;
        emit TokenConfigured(token, cfg);
    }

    /// @notice House withdrawal (profits, bankroll moves). Counts against the same daily cap as players and
    ///         is blocked while withdrawals are paused. On mainnet the admin is a timelocked multisig.
    function sweep(address token, address to, uint256 amount) external onlyRole(DEFAULT_ADMIN_ROLE) nonReentrant {
        if (withdrawalsPaused) revert WithdrawalsClosed();
        if (!tokenConfig[token].listed) revert TokenNotListed(token);
        if (amount == 0 || to == address(0)) revert ZeroAmount();
        _spend(token, amount);
        _pay(token, to, amount);
        emit HouseWithdrawal(token, to, amount);
    }

    function setAllowlistOnly(bool on) external onlyRole(DEFAULT_ADMIN_ROLE) {
        allowlistOnly = on;
        emit AllowlistOnly(on);
    }

    function setAllowed(address[] calldata users, bool ok) external onlyRole(DEFAULT_ADMIN_ROLE) {
        for (uint256 i; i < users.length; ++i) {
            allowed[users[i]] = ok;
            emit AllowedSet(users[i], ok);
        }
    }

    /// @notice Guardian or admin can pause; only the admin can unpause.
    function pauseDeposits() external {
        _checkPauser();
        depositsPaused = true;
        emit DepositsPaused(true, msg.sender);
    }

    function pauseWithdrawals() external {
        _checkPauser();
        withdrawalsPaused = true;
        emit WithdrawalsPaused(true, msg.sender);
    }

    function unpauseDeposits() external onlyRole(DEFAULT_ADMIN_ROLE) {
        depositsPaused = false;
        emit DepositsPaused(false, msg.sender);
    }

    function unpauseWithdrawals() external onlyRole(DEFAULT_ADMIN_ROLE) {
        withdrawalsPaused = false;
        emit WithdrawalsPaused(false, msg.sender);
    }

    /// @notice Emergency: void every outstanding voucher, whatever issuedAt it claims (e.g. after a signer key
    ///         leak). Guardian or admin. The backend refunds the affected players as soon as it sees the new epoch.
    function voidAllVouchers() external {
        _checkPauser();
        _bumpEpoch();
    }

    function _bumpEpoch() private {
        unchecked { ++voucherEpoch; }
        emit VouchersVoided(voucherEpoch, msg.sender);
    }

    function _checkPauser() private view {
        if (!hasRole(GUARDIAN_ROLE, msg.sender) && !hasRole(DEFAULT_ADMIN_ROLE, msg.sender)) {
            revert AccessControlUnauthorizedAccount(msg.sender, GUARDIAN_ROLE);
        }
    }

    /// @dev SIGNER, COSIGNER and GUARDIAN must be three different keys (otherwise one stolen key could pass the
    ///      cosign check, or the monitoring bot's key could sign withdrawals)
    function _grantRole(bytes32 role, address account) internal override returns (bool) {
        if (role == SIGNER_ROLE || role == COSIGNER_ROLE || role == GUARDIAN_ROLE) {
            if (role != SIGNER_ROLE && hasRole(SIGNER_ROLE, account)) revert BadConfig();
            if (role != COSIGNER_ROLE && hasRole(COSIGNER_ROLE, account)) revert BadConfig();
            if (role != GUARDIAN_ROLE && hasRole(GUARDIAN_ROLE, account)) revert BadConfig();
        }
        return super._grantRole(role, account);
    }

    /// @dev revoking a signing key (or a key renouncing) voids every outstanding voucher, so re-granting that key
    ///      later can never revive anything it signed before.
    function _revokeRole(bytes32 role, address account) internal override returns (bool revoked) {
        revoked = super._revokeRole(role, account);
        if (revoked && (role == SIGNER_ROLE || role == COSIGNER_ROLE)) _bumpEpoch();
    }

    /// @dev the same bound as the constructor, for later delay changes
    function _changeDefaultAdminDelay(uint48 newDelay) internal override {
        if (newDelay > MAX_ADMIN_DELAY) revert BadConfig();
        super._changeDefaultAdminDelay(newDelay);
    }
}
