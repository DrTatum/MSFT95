// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test token for Robinhood Chain testnet (anyone can mint).
contract TestToken is ERC20 {
    uint8 private immutable _dec;
    constructor(string memory n, string memory s, uint8 d) ERC20(n, s) { _dec = d; }
    function decimals() public view override returns (uint8) { return _dec; }
    function mint(address to, uint256 amount) external { _mint(to, amount); }
}

/// @notice Token that burns 1% on every transfer (to test that deposits credit what actually arrived).
contract FeeToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0), fee);
            value -= fee;
        }
        super._update(from, to, value);
    }
}

interface IVault {
    struct Withdrawal { address user; address token; uint256 amount; uint256 nonce; uint256 issuedAt; uint256 deadline; }
    function withdraw(Withdrawal calldata w, bytes[] calldata sigs) external;
    function depositETH() external payable returns (uint256);
}

/// @notice Receives ETH and tries to re-enter the vault with a second voucher.
contract Reenterer {
    IVault public vault;
    IVault.Withdrawal public next;
    bytes[] public nextSigs;
    bool public tried;
    bool public reentryFailed;
    constructor(IVault v) { vault = v; }
    function arm(IVault.Withdrawal calldata w, bytes[] calldata sigs) external {
        next = w;
        delete nextSigs;
        for (uint256 i; i < sigs.length; ++i) nextSigs.push(sigs[i]);
    }
    receive() external payable {
        if (!tried) {
            tried = true;
            try vault.withdraw(next, nextSigs) { } catch { reentryFailed = true; }
        }
    }
}

/// @notice Rejects ETH.
contract NoEth {}

interface IDepositVault { function deposit(address token, uint256 amount) external returns (uint256); }

/// @notice ERC-777-style token: its transfer hook calls back into the vault once (to test reentrancy).
contract HookToken is ERC20 {
    address public vault;
    bool public armed;
    constructor() ERC20("Hook", "HOOK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function arm(address v) external { vault = v; armed = true; }
    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && to == vault) {
            armed = false;
            IDepositVault(vault).deposit(address(this), 1);
        }
    }
}

/// @notice USDC-style token with a blocklist: transfers to a blocked address revert.
contract BlockToken is ERC20 {
    mapping(address => bool) public blocked;
    constructor() ERC20("Block", "BLK") {}
    function mint(address to, uint256 amount) external { _mint(to, amount); }
    function setBlocked(address a, bool b) external { blocked[a] = b; }
    function _update(address from, address to, uint256 value) internal override {
        require(!blocked[to], "blocked");
        super._update(from, to, value);
    }
}

/// @notice Sends ETH to a target with SELFDESTRUCT (forced ETH, no receive() call).
contract Bomb {
    constructor(address payable to) payable { selfdestruct(to); }
}
