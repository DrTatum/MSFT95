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
    struct Withdrawal { address user; address token; uint256 amount; uint256 nonce; uint256 deadline; }
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
