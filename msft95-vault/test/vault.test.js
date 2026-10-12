const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, DAY, signWithdrawal, now, cfg, deploy } = require("./helpers");

const E = (x) => ethers.parseEther(String(x));

describe("MSFT95Vault", function () {
  async function fixture() {
    const f = await deploy();
    // bankroll so withdrawals can be paid
    await f.tok.mint(f.admin.address, E(100000));
    await f.tok.connect(f.admin).approve(await f.vault.getAddress(), ethers.MaxUint256);
    await f.vault.connect(f.admin).fundBankroll(await f.tok.getAddress(), E(20000));
    await f.vault.connect(f.admin).fundBankroll(ETH, 0, { value: E(500) });
    return f;
  }
  async function voucher(f, o = {}) {
    const w = Object.assign({ user: f.alice.address, token: await f.tok.getAddress(), amount: E(10), nonce: 1n, deadline: BigInt(await now()) + 3600n }, o);
    return w;
  }

  describe("deposits", function () {
    it("credits an ERC-20 deposit with an event and a running id", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await expect(f.vault.connect(f.alice).deposit(t, E(50))).to.emit(f.vault, "Deposited").withArgs(f.alice.address, t, E(50), 1n);
      await expect(f.vault.connect(f.bob).deposit(t, E(1))).to.emit(f.vault, "Deposited").withArgs(f.bob.address, t, E(1), 2n);
      expect(await f.vault.balanceOf(t)).to.equal(E(20051));
    });
    it("credits ETH deposits", async function () {
      const f = await loadFixture(fixture);
      await expect(f.vault.connect(f.alice).depositETH({ value: E(2) })).to.emit(f.vault, "Deposited").withArgs(f.alice.address, ETH, E(2), 1n);
    });
    it("rejects plain ETH transfers", async function () {
      const f = await loadFixture(fixture);
      await expect(f.alice.sendTransaction({ to: await f.vault.getAddress(), value: 1n })).to.be.revertedWithCustomError(f.vault, "UseDepositETH");
    });
    it("rejects ETH through deposit()", async function () {
      const f = await loadFixture(fixture);
      await expect(f.vault.connect(f.alice).deposit(ETH, 1n)).to.be.revertedWithCustomError(f.vault, "UseDepositETH");
    });
    it("credits fee-on-transfer tokens net of the fee", async function () {
      const f = await loadFixture(fixture);
      const Fee = await ethers.getContractFactory("FeeToken"); const fee = await Fee.deploy(); const a = await fee.getAddress();
      await f.vault.setToken(a, cfg());
      await fee.mint(f.alice.address, E(100)); await fee.connect(f.alice).approve(await f.vault.getAddress(), ethers.MaxUint256);
      await expect(f.vault.connect(f.alice).deposit(a, E(100))).to.emit(f.vault, "Deposited").withArgs(f.alice.address, a, E(99), 1n);
    });
    it("rejects unlisted tokens, disabled deposits, pauses, zero and dust", async function () {
      const f = await loadFixture(fixture);
      const Tok = await ethers.getContractFactory("TestToken"); const x = await Tok.deploy("X", "X", 18);
      await expect(f.vault.connect(f.alice).deposit(await x.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, "TokenNotListed");
      const u = await f.usdc.getAddress();
      await expect(f.vault.connect(f.alice).deposit(u, 999_999n)).to.be.revertedWithCustomError(f.vault, "BelowMinDeposit");
      await expect(f.vault.connect(f.alice).deposit(await f.tok.getAddress(), 0)).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
      await f.vault.setToken(u, cfg({ depositsEnabled: false, minDeposit: 1_000_000n, maxWithdrawal: 10_000_000_000n, dailyCap: 50_000_000_000n, cosignAbove: 1_000_000_000n }));
      await expect(f.vault.connect(f.alice).deposit(u, 2_000_000n)).to.be.revertedWithCustomError(f.vault, "DepositsClosed");
      await f.vault.connect(f.guardian).pauseDeposits();
      await expect(f.vault.connect(f.alice).depositETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, "DepositsClosed");
    });
    it("enforces the allowlist while it is on", async function () {
      const f = await loadFixture(fixture);
      await f.vault.setAllowlistOnly(true);
      await f.vault.setAllowed([f.alice.address], true);
      await f.vault.connect(f.alice).depositETH({ value: 1n });
      await expect(f.vault.connect(f.bob).depositETH({ value: 1n })).to.be.revertedWithCustomError(f.vault, "NotAllowed");
      await f.vault.setAllowlistOnly(false);
      await f.vault.connect(f.bob).depositETH({ value: 1n });
    });
  });

  describe("withdrawals", function () {
    it("pays a voucher signed by the signer, once", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.connect(f.alice).withdraw(w, [s])).to.changeTokenBalances(f.tok, [f.alice, f.vault], [E(10), -E(10)]);
      expect(await f.vault.nonceUsed(f.alice.address, 1n)).to.equal(true);
      await expect(f.vault.connect(f.alice).withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "NonceAlreadyUsed");
    });
    it("lets a relayer submit but always pays the user", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.connect(f.relayer).withdraw(w, [s])).to.emit(f.vault, "Withdrawn").withArgs(f.alice.address, w.token, w.amount, w.nonce, f.relayer.address);
      expect(await f.tok.balanceOf(f.relayer.address)).to.equal(0n);
    });
    it("pays ETH", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f, { token: ETH, amount: E(1) }); const s = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.connect(f.relayer).withdraw(w, [s])).to.changeEtherBalances([f.alice, f.vault], [E(1), -E(1)]);
    });
    it("rejects tampered vouchers and strangers' signatures", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      for (const change of [{ amount: E(11) }, { user: f.bob.address }, { nonce: 2n }, { deadline: w.deadline + 1n }, { token: ETH }]) {
        await expect(f.vault.withdraw({ ...w, ...change }, [s])).to.be.reverted;
      }
      const s2 = await signWithdrawal(f.vault, f.outsider, w);
      await expect(f.vault.withdraw(w, [s2])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [s, s, s])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
    });
    it("rejects a voucher signed for another vault or chain", async function () {
      const f = await loadFixture(fixture);
      const Vault = await ethers.getContractFactory("MSFT95Vault");
      const other = await Vault.deploy(f.admin.address, DAY);
      const w = await voucher(f); const sOther = await signWithdrawal(other, f.signer, w);
      await expect(f.vault.withdraw(w, [sOther])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      const net = await ethers.provider.getNetwork();
      const wrongChain = await f.signer.signTypedData({ name: "MSFT95Vault", version: "1", chainId: net.chainId + 1n, verifyingContract: await f.vault.getAddress() },
        { Withdrawal: [{ name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, w);
      await expect(f.vault.withdraw(w, [wrongChain])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
    });
    it("rejects expired and over-long vouchers", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f, { deadline: BigInt(await now()) + 10n }); const s = await signWithdrawal(f.vault, f.signer, w);
      await time.increase(60);
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "VoucherExpired");
      const w2 = await voucher(f, { deadline: BigInt(await now()) + BigInt(DAY) + 100n }); const s2 = await signWithdrawal(f.vault, f.signer, w2);
      await expect(f.vault.withdraw(w2, [s2])).to.be.revertedWithCustomError(f.vault, "VoucherTooLong");
    });
    it("needs the cosigner above the threshold, and never the same key twice", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f, { amount: E(150) });
      const s = await signWithdrawal(f.vault, f.signer, w), c = await signWithdrawal(f.vault, f.cosigner, w);
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [c])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [s, s])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [c, c])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await f.vault.withdraw(w, [c, s]); // order does not matter
      expect(await f.tok.balanceOf(f.alice.address)).to.equal(E(100150));
    });
    it("refuses to give one key both signer and cosigner roles", async function () {
      const f = await loadFixture(fixture);
      await expect(f.vault.grantRole(await f.vault.COSIGNER_ROLE(), f.signer.address)).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await expect(f.vault.grantRole(await f.vault.SIGNER_ROLE(), f.cosigner.address)).to.be.revertedWithCustomError(f.vault, "BadConfig");
    });
    it("caps single withdrawals and the rolling 24h total", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setToken(t, cfg({ maxWithdrawal: E(40), dailyCap: E(100), cosignAbove: E(40) }));
      let n = 1n; const go = async (amt) => { const w = await voucher(f, { amount: E(amt), nonce: n++ }); return f.vault.withdraw(w, [await signWithdrawal(f.vault, f.signer, w)]); };
      await expect(go(41)).to.be.revertedWithCustomError(f.vault, "AboveMaxWithdrawal");
      await go(40); await go(40);
      expect(await f.vault.remainingToday(t)).to.equal(E(20));
      await expect(go(21)).to.be.revertedWithCustomError(f.vault, "DailyCapExceeded");
      await go(20);
      await time.increase(DAY);
      expect(await f.vault.remainingToday(t)).to.equal(E(100));
      await go(40);
    });
    it("house sweeps count against the same daily cap", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setToken(t, cfg({ maxWithdrawal: E(40), dailyCap: E(100), cosignAbove: E(40) }));
      await f.vault.sweep(t, f.admin.address, E(90));
      const w = await voucher(f, { amount: E(20) });
      await expect(f.vault.withdraw(w, [await signWithdrawal(f.vault, f.signer, w)])).to.be.revertedWithCustomError(f.vault, "DailyCapExceeded");
    });
    it("blocks re-entry from an ETH receiver", async function () {
      const f = await loadFixture(fixture);
      const R = await ethers.getContractFactory("Reenterer"); const r = await R.deploy(await f.vault.getAddress());
      const ra = await r.getAddress();
      const w1 = await voucher(f, { user: ra, token: ETH, amount: E(1), nonce: 1n });
      const w2 = await voucher(f, { user: ra, token: ETH, amount: E(1), nonce: 2n });
      await r.arm(w2, [await signWithdrawal(f.vault, f.signer, w2)]);
      await f.vault.withdraw(w1, [await signWithdrawal(f.vault, f.signer, w1)]);
      expect(await r.reentryFailed()).to.equal(true);
      expect(await ethers.provider.getBalance(ra)).to.equal(E(1));
      expect(await f.vault.nonceUsed(ra, 2n)).to.equal(false);
    });
    it("fails cleanly (nonce kept) when the receiver rejects ETH", async function () {
      const f = await loadFixture(fixture);
      const N = await ethers.getContractFactory("NoEth"); const n = await N.deploy();
      const w = await voucher(f, { user: await n.getAddress(), token: ETH, amount: E(1) });
      await expect(f.vault.withdraw(w, [await signWithdrawal(f.vault, f.signer, w)])).to.be.revertedWithCustomError(f.vault, "EthTransferFailed");
      expect(await f.vault.nonceUsed(await n.getAddress(), 1n)).to.equal(false);
    });
    it("stops when paused; guardian can pause, only admin can unpause", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.connect(f.outsider).pauseWithdrawals()).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await f.vault.connect(f.guardian).pauseWithdrawals();
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "WithdrawalsClosed");
      await expect(f.vault.connect(f.guardian).unpauseWithdrawals()).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await f.vault.unpauseWithdrawals();
      await f.vault.withdraw(w, [s]);
    });
    it("a revoked signer's old vouchers stop working", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      await f.vault.revokeRole(await f.vault.SIGNER_ROLE(), f.signer.address);
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
    });
  });

  describe("admin", function () {
    it("only the admin configures, sweeps and edits the allowlist", async function () {
      const f = await loadFixture(fixture);
      const v = f.vault.connect(f.outsider), t = await f.tok.getAddress();
      await expect(v.setToken(t, cfg())).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await expect(v.sweep(t, f.outsider.address, 1n)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await expect(v.setAllowed([f.outsider.address], true)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await expect(v.setAllowlistOnly(false)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await expect(f.vault.connect(f.signer).grantRole(await f.vault.SIGNER_ROLE(), f.outsider.address)).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
    });
    it("rejects inconsistent token limits", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await expect(f.vault.setToken(t, cfg({ cosignAbove: E(2000) }))).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await expect(f.vault.setToken(t, cfg({ maxWithdrawal: E(6000) }))).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await expect(f.vault.setToken(t, cfg({ listed: false }))).to.be.revertedWithCustomError(f.vault, "BadConfig");
    });
    it("exposes the EIP-712 domain the backend must sign for", async function () {
      const f = await loadFixture(fixture);
      const net = await ethers.provider.getNetwork();
      const d = ethers.TypedDataEncoder.hashDomain({ name: "MSFT95Vault", version: "1", chainId: net.chainId, verifyingContract: await f.vault.getAddress() });
      expect(await f.vault.domainSeparator()).to.equal(d);
      const w = await voucher(f);
      expect(await f.vault.hashWithdrawal(w)).to.equal(ethers.TypedDataEncoder.hash({ name: "MSFT95Vault", version: "1", chainId: net.chainId, verifyingContract: await f.vault.getAddress() },
        { Withdrawal: [{ name: "user", type: "address" }, { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] }, w));
    });
    it("deposits reopen only when the admin unpauses", async function () {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.guardian).pauseDeposits();
      await expect(f.vault.connect(f.guardian).unpauseDeposits()).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await f.vault.unpauseDeposits();
      await f.vault.connect(f.alice).depositETH({ value: 1n });
    });
    it("bankroll funding: ETH and tokens, never mixed, never unlisted", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await expect(f.vault.connect(f.alice).fundBankroll(t, E(1), { value: 1n })).to.be.revertedWithCustomError(f.vault, "UseDepositETH");
      const Tok = await ethers.getContractFactory("TestToken"); const x = await Tok.deploy("X", "X", 18);
      await expect(f.vault.fundBankroll(await x.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, "TokenNotListed");
      await expect(f.vault.fundBankroll(ETH, 0)).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
      await expect(f.vault.connect(f.alice).fundBankroll(t, E(5))).to.emit(f.vault, "BankrollFunded").withArgs(f.alice.address, t, E(5));
    });
    it("house can sweep ETH; remainingToday reaches zero at the cap", async function () {
      const f = await loadFixture(fixture);
      await f.vault.setToken(ETH, cfg({ maxWithdrawal: E(5), dailyCap: E(10), cosignAbove: E(5) }));
      await expect(f.vault.sweep(ETH, f.bob.address, E(10))).to.changeEtherBalance(f.bob, E(10));
      expect(await f.vault.remainingToday(ETH)).to.equal(0n);
      await expect(f.vault.sweep(ETH, ethers.ZeroAddress, 1n)).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
    });
    it("handing over admin takes the configured delay and must be accepted", async function () {
      const f = await loadFixture(fixture);
      await f.vault.beginDefaultAdminTransfer(f.bob.address);
      await expect(f.vault.connect(f.bob).acceptDefaultAdminTransfer()).to.be.revertedWithCustomError(f.vault, "AccessControlEnforcedDefaultAdminDelay");
      await time.increase(2 * DAY + 1);
      await f.vault.connect(f.bob).acceptDefaultAdminTransfer();
      expect(await f.vault.defaultAdmin()).to.equal(f.bob.address);
    });
  });

  describe("invariant: tokens in == tokens out + balance", function () {
    it("holds over 300 random deposits, withdrawals and sweeps", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      let inn = E(20000), out = 0n, n = 1n, seed = 12345;
      const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
      for (let i = 0; i < 300; i++) {
        const who = [f.alice, f.bob][rnd(2)], op = rnd(3), amt = E(1 + rnd(90));
        if (op === 0) { await f.vault.connect(who).deposit(t, amt); inn += amt; }
        else if (op === 1) {
          const w = { user: who.address, token: t, amount: amt, nonce: n++, deadline: BigInt(await now()) + 3600n };
          const sigs = [await signWithdrawal(f.vault, f.signer, w)]; if (amt > E(100)) sigs.push(await signWithdrawal(f.vault, f.cosigner, w));
          try { await f.vault.connect(f.relayer).withdraw(w, sigs); out += amt; } catch (e) { if (!/DailyCapExceeded/.test(e.message)) throw e; }
        } else if (rnd(10) === 0) { try { await f.vault.sweep(t, f.admin.address, amt); out += amt; } catch (e) { if (!/DailyCapExceeded/.test(e.message)) throw e; } }
        if (rnd(20) === 0) await time.increase(DAY / 3);
        expect(await f.tok.balanceOf(await f.vault.getAddress())).to.equal(inn - out);
      }
    });
  });
});
