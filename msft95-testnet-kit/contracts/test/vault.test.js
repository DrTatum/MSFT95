const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, DAY, NO_COSIGN, TYPES, signWithdrawal, now, cfg, setup, deploy } = require("./helpers");

const E = (x) => ethers.parseEther(String(x));

describe("MSFT95Vault", function () {
  async function fixture() {
    const f = await deploy();
    // bankroll so withdrawals can be paid
    await f.tok.mint(f.admin.address, E(100000));
    await f.tok.connect(f.admin).approve(await f.vault.getAddress(), ethers.MaxUint256);
    await f.vault.connect(f.admin).fundBankroll(await f.tok.getAddress(), E(20000));
    await f.vault.connect(f.admin).fundBankroll(ETH, E(500), { value: E(500) });
    return f;
  }
  async function voucher(f, o = {}) {
    const t = BigInt(await now());
    const w = Object.assign({ user: f.alice.address, token: await f.tok.getAddress(), amount: E(10), nonce: 1n, epoch: await f.vault.voucherEpoch(), issuedAt: t, deadline: t + 3600n }, o);
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
      for (const change of [{ amount: E(11) }, { user: f.bob.address }, { nonce: 2n }, { deadline: w.deadline + 1n }, { issuedAt: w.issuedAt - 1n }, { token: ETH }]) {
        await expect(f.vault.withdraw({ ...w, ...change }, [s])).to.be.reverted;
      }
      const s2 = await signWithdrawal(f.vault, f.outsider, w);
      await expect(f.vault.withdraw(w, [s2])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [s, s, s])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
    });
    it("rejects a voucher signed for another vault or chain", async function () {
      const f = await loadFixture(fixture);
      const other = await f.Vault.deploy(setup({ admin: f.admin.address, signer: f.signer.address }));
      const w = await voucher(f); const sOther = await signWithdrawal(other, f.signer, w);
      await expect(f.vault.withdraw(w, [sOther])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      const net = await ethers.provider.getNetwork();
      const wrongChain = await signWithdrawal(f.vault, f.signer, w, net.chainId + 1n);
      await expect(f.vault.withdraw(w, [wrongChain])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
    });
    it("rejects expired and over-long vouchers", async function () {
      const f = await loadFixture(fixture);
      const t = BigInt(await now());
      const w = await voucher(f, { deadline: t + 10n }); const s = await signWithdrawal(f.vault, f.signer, w);
      await time.increase(60);
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "VoucherExpired");
      const w2 = await voucher(f, { deadline: BigInt(await now()) + BigInt(DAY) + 100n }); const s2 = await signWithdrawal(f.vault, f.signer, w2);
      await expect(f.vault.withdraw(w2, [s2])).to.be.revertedWithCustomError(f.vault, "VoucherTooLong");
      const n3 = BigInt(await now()); const w3 = await voucher(f, { issuedAt: n3 + 120n, deadline: n3 + 100n }); const s3 = await signWithdrawal(f.vault, f.signer, w3);
      await expect(f.vault.withdraw(w3, [s3])).to.be.revertedWithCustomError(f.vault, "VoucherTooLong");   // deadline before issuedAt
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
      await expect(f.vault.grantRole(await f.vault.SIGNER_ROLE(), f.guardian.address)).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await expect(f.vault.grantRole(await f.vault.GUARDIAN_ROLE(), f.signer.address)).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await expect(f.vault.grantRole(await f.vault.GUARDIAN_ROLE(), f.cosigner.address)).to.be.revertedWithCustomError(f.vault, "BadConfig");
    });
    it("caps single withdrawals and the rolling 24h total", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setToken(t, cfg({ maxWithdrawal: E(40), dailyCap: E(100), cosignAbove: NO_COSIGN }));
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
      await f.vault.setToken(t, cfg({ maxWithdrawal: E(40), dailyCap: E(100), cosignAbove: NO_COSIGN }));
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
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");   // the revoke bumped the epoch
      const w2 = await voucher(f, { nonce: 2n });   // even a voucher for the new epoch, signed by the revoked key, fails
      await expect(f.vault.withdraw(w2, [await signWithdrawal(f.vault, f.signer, w2)])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
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
      await expect(f.vault.setToken(t, cfg({ cosignAbove: E(1000) }))).to.be.revertedWithCustomError(f.vault, "BadConfig");   // == maxWithdrawal: cosigner unreachable
      await f.vault.setToken(t, cfg({ cosignAbove: NO_COSIGN }));   // explicit opt-out is allowed
    });
    it("exposes the EIP-712 domain the backend must sign for", async function () {
      const f = await loadFixture(fixture);
      const net = await ethers.provider.getNetwork();
      const d = ethers.TypedDataEncoder.hashDomain({ name: "MSFT95Vault", version: "1", chainId: net.chainId, verifyingContract: await f.vault.getAddress() });
      expect(await f.vault.domainSeparator()).to.equal(d);
      const w = await voucher(f);
      expect(await f.vault.hashWithdrawal(w)).to.equal(ethers.TypedDataEncoder.hash({ name: "MSFT95Vault", version: "1", chainId: net.chainId, verifyingContract: await f.vault.getAddress() },
        TYPES, w));
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
      await expect(f.vault.connect(f.treasury).fundBankroll(t, E(1), { value: 1n })).to.be.revertedWithCustomError(f.vault, "UseDepositETH");
      const Tok = await ethers.getContractFactory("TestToken"); const x = await Tok.deploy("X", "X", 18);
      await expect(f.vault.fundBankroll(await x.getAddress(), 1n)).to.be.revertedWithCustomError(f.vault, "TokenNotListed");
      await expect(f.vault.fundBankroll(ETH, 0)).to.be.revertedWithCustomError(f.vault, "ZeroAmount");
      await expect(f.vault.connect(f.treasury).fundBankroll(t, E(5))).to.emit(f.vault, "BankrollFunded").withArgs(f.treasury.address, t, E(5));
    });
    it("house can sweep ETH; remainingToday reaches zero at the cap", async function () {
      const f = await loadFixture(fixture);
      await f.vault.setToken(ETH, cfg({ maxWithdrawal: E(5), dailyCap: E(10), cosignAbove: E(1) }));
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


  // ------------------------------------------------------------------ audit 2026-10-12 (findings 1-9)
  describe("audit fixes and regression tests", function () {
    it("F1: only the admin or the BANKROLL wallet can fund the bankroll", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setAllowlistOnly(true);
      await f.vault.connect(f.guardian).pauseDeposits();
      await expect(f.vault.connect(f.outsider).deposit(t, E(10))).to.be.revertedWithCustomError(f.vault, "DepositsClosed");
      await expect(f.vault.connect(f.outsider).fundBankroll(t, E(10))).to.be.revertedWithCustomError(f.vault, "Unauthorized");
      await expect(f.vault.connect(f.outsider).fundBankroll(ETH, E(1), { value: E(1) })).to.be.revertedWithCustomError(f.vault, "Unauthorized");
      await expect(f.vault.connect(f.alice).fundBankroll(t, E(10))).to.be.revertedWithCustomError(f.vault, "Unauthorized");
      await f.vault.connect(f.treasury).fundBankroll(t, E(10));
      await f.vault.connect(f.admin).fundBankroll(t, E(10));
    });
    it("F2: a voucher can never be paid more than 24h after it was signed, and vouchers can be voided", async function () {
      const f = await loadFixture(fixture);
      const t = BigInt(await now());
      // the auditor's sleeper: deadline a year out -> rejected at signing time and forever after
      const sleeper = await voucher(f, { issuedAt: t, deadline: t + 365n * BigInt(DAY) });
      const ss = await signWithdrawal(f.vault, f.signer, sleeper);
      await expect(f.vault.withdraw(sleeper, [ss])).to.be.revertedWithCustomError(f.vault, "VoucherTooLong");
      await time.increase(364 * DAY);
      await expect(f.vault.withdraw(sleeper, [ss])).to.be.revertedWithCustomError(f.vault, "VoucherTooLong");
      // a voucher claiming to be signed in the future is refused (beyond 5 minutes of clock skew)
      const n2 = BigInt(await now());
      const future = await voucher(f, { nonce: 2n, issuedAt: n2 + 3600n, deadline: n2 + 7200n });
      await expect(f.vault.withdraw(future, [await signWithdrawal(f.vault, f.signer, future)])).to.be.revertedWithCustomError(f.vault, "VoucherNotYetValid");
      const skew = await voucher(f, { nonce: 3n, issuedAt: n2 + 60n, deadline: n2 + 3600n });
      await f.vault.withdraw(skew, [await signWithdrawal(f.vault, f.signer, skew)]);
      // emergency void: every outstanding voucher dies at once
      const old = await voucher(f, { nonce: 4n }); const os = await signWithdrawal(f.vault, f.signer, old);
      await expect(f.vault.connect(f.outsider).voidAllVouchers()).to.be.revertedWithCustomError(f.vault, "AccessControlUnauthorizedAccount");
      await expect(f.vault.connect(f.guardian).voidAllVouchers()).to.emit(f.vault, "VouchersVoided").withArgs(1n, f.guardian.address);
      await expect(f.vault.withdraw(old, [os])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");
      const fresh = await voucher(f, { nonce: 5n }); await f.vault.withdraw(fresh, [await signWithdrawal(f.vault, f.signer, fresh)]);
    });
    it("F2: re-granting a revoked key never revives anything it signed (revoking bumps the epoch)", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f, { amount: E(150) });
      const s = await signWithdrawal(f.vault, f.signer, w), c = await signWithdrawal(f.vault, f.cosigner, w);
      await f.vault.revokeRole(await f.vault.COSIGNER_ROLE(), f.cosigner.address);
      expect(await f.vault.voucherEpoch()).to.equal(1n);
      await f.vault.grantRole(await f.vault.COSIGNER_ROLE(), f.cosigner.address);   // straight back, inside the voucher's lifetime
      await expect(f.vault.withdraw(w, [s, c])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");
      // revoking an unrelated role doesn't touch vouchers
      await f.vault.grantRole(await f.vault.BANKROLL_ROLE(), f.bob.address);
      await f.vault.revokeRole(await f.vault.BANKROLL_ROLE(), f.bob.address);
      expect(await f.vault.voucherEpoch()).to.equal(1n);
      // a signer renouncing its own role also voids
      await f.vault.connect(f.signer).renounceRole(await f.vault.SIGNER_ROLE(), f.signer.address);
      expect(await f.vault.voucherEpoch()).to.equal(2n);
    });

    // ---------------------------------------------------------------- audit #2 (job 91ed3906), ported from its Foundry proof
    it("A2-1: a sleeper voucher with a future issuedAt dies when vouchers are voided", async function () {
      const f = await loadFixture(fixture);
      const T = BigInt(await now());
      const w = await voucher(f, { user: f.outsider.address, token: ETH, amount: E(1) / 10n, issuedAt: T + 30n * BigInt(DAY), deadline: T + 31n * BigInt(DAY) });
      const sg = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.withdraw(w, [sg])).to.be.revertedWithCustomError(f.vault, "VoucherNotYetValid");
      await time.increase(3600);
      await f.vault.connect(f.guardian).voidAllVouchers();
      await time.increaseTo(T + 30n * BigInt(DAY));
      await expect(f.vault.withdraw(w, [sg])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");
    });
    it("A2-1: ...and when its key is revoked and later re-granted", async function () {
      const f = await loadFixture(fixture);
      const T = BigInt(await now());
      const w = await voucher(f, { user: f.outsider.address, token: ETH, amount: E(1) / 10n, nonce: 2n, issuedAt: T + 30n * BigInt(DAY), deadline: T + 31n * BigInt(DAY) });
      const sg = await signWithdrawal(f.vault, f.signer, w);
      await time.increase(3600);
      await f.vault.revokeRole(await f.vault.SIGNER_ROLE(), f.signer.address);
      await time.increaseTo(T + 29n * BigInt(DAY));
      await f.vault.grantRole(await f.vault.SIGNER_ROLE(), f.signer.address);
      await time.increaseTo(T + 30n * BigInt(DAY));
      await expect(f.vault.withdraw(w, [sg])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");
    });
    it("A2-1: ...and a voucher inside the 5-minute skew band has no blind spot", async function () {
      const f = await loadFixture(fixture);
      const T = BigInt(await now());
      const w = await voucher(f, { user: f.outsider.address, token: ETH, amount: E(1) / 10n, nonce: 3n, issuedAt: T + 300n, deadline: T + 300n + BigInt(DAY) });
      const sg = await signWithdrawal(f.vault, f.signer, w);
      await time.increase(10);
      await f.vault.connect(f.guardian).voidAllVouchers();
      await time.increaseTo(T + 300n + BigInt(DAY) - 2n);
      await expect(f.vault.withdraw(w, [sg])).to.be.revertedWithCustomError(f.vault, "VoucherVoided");
      // and vouchers signed for the new epoch work normally
      const fresh = await voucher(f, { nonce: 4n });
      expect(fresh.epoch).to.equal(1n);
      await f.vault.withdraw(fresh, [await signWithdrawal(f.vault, f.signer, fresh)]);
    });
    it("A2-2: admin delay is bounded at 30 days, at deploy and later", async function () {
      const f = await loadFixture(fixture);
      await expect(f.Vault.deploy(setup({ admin: f.admin.address, adminDelay: 172_800_000 }))).to.be.revertedWithCustomError(f.Vault, "BadConfig");
      await expect(f.Vault.deploy(setup({ admin: f.admin.address, adminDelay: (1n << 48n) - 1n }))).to.be.revertedWithCustomError(f.Vault, "BadConfig");
      await f.Vault.deploy(setup({ admin: f.admin.address, adminDelay: 30 * DAY }));
      await expect(f.vault.changeDefaultAdminDelay(31 * DAY)).to.be.revertedWithCustomError(f.vault, "BadConfig");
      await f.vault.changeDefaultAdminDelay(DAY);
    });
    it("A2-3: a token can be unlisted with an all-zero config, which clears it", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setToken(t, cfg({ cosignAbove: NO_COSIGN }));
      await f.vault.setToken(t, { listed: false, depositsEnabled: false, minDeposit: 0, maxWithdrawal: 0, dailyCap: 0, cosignAbove: 0 });
      const c = await f.vault.tokenConfig(t);
      expect(c.listed).to.equal(false); expect(c.cosignAbove).to.equal(0n); expect(c.maxWithdrawal).to.equal(0n);   // no stale sentinel left behind
      await expect(f.vault.connect(f.alice).deposit(t, E(1))).to.be.revertedWithCustomError(f.vault, "TokenNotListed");
      await expect(f.vault.setToken(t, { listed: false, depositsEnabled: true, minDeposit: 0, maxWithdrawal: 0, dailyCap: 0, cosignAbove: 0 })).to.be.revertedWithCustomError(f.vault, "BadConfig");
    });
    it("A2-4: the shipped signing script's voucher type is the one the vault accepts", async function () {
      const f = await loadFixture(fixture);
      const { signVoucher } = require("../scripts/voucher");
      const net = await ethers.provider.getNetwork();
      const w = await voucher(f, { nonce: 9n });
      const sg = await signVoucher(f.signer, await f.vault.getAddress(), net.chainId, w);
      await f.vault.withdraw(w, [sg]);
      const src = require("fs").readFileSync(require("path").join(__dirname, "..", "scripts", "sign-withdrawal.js"), "utf8");
      expect(src).to.match(/require\("\.\/voucher"\)/);   // the script uses the shared definition
    });
    it("F3: fundBankroll with ETH requires amount == msg.value", async function () {
      const f = await loadFixture(fixture);
      await expect(f.vault.fundBankroll(ETH, E(999), { value: E(1) })).to.be.revertedWithCustomError(f.vault, "AmountMismatch");
      await expect(f.vault.fundBankroll(ETH, 0, { value: E(1) })).to.be.revertedWithCustomError(f.vault, "AmountMismatch");
      await expect(f.vault.fundBankroll(ETH, E(1), { value: E(1) })).to.emit(f.vault, "BankrollFunded").withArgs(f.admin.address, ETH, E(1));
    });
    it("F4: the deadline second itself is already expired", async function () {
      const f = await loadFixture(fixture);
      const T = BigInt(await now()) + 100n;
      const w = await voucher(f, { deadline: T }); const s = await signWithdrawal(f.vault, f.signer, w);
      await time.setNextBlockTimestamp(T);
      await expect(f.vault.withdraw(w, [s])).to.be.revertedWithCustomError(f.vault, "VoucherExpired");
      const w2 = await voucher(f, { nonce: 2n, deadline: T + 100n }); const s2 = await signWithdrawal(f.vault, f.signer, w2);
      await time.setNextBlockTimestamp(T + 99n);
      await f.vault.withdraw(w2, [s2]);   // one second before the deadline still pays
    });
    it("F5: a withdrawal pause also stops house sweeps", async function () {
      const f = await loadFixture(fixture);
      await f.vault.connect(f.guardian).pauseWithdrawals();
      await expect(f.vault.sweep(await f.tok.getAddress(), f.admin.address, E(1))).to.be.revertedWithCustomError(f.vault, "WithdrawalsClosed");
      await f.vault.unpauseWithdrawals();
      await f.vault.sweep(await f.tok.getAddress(), f.admin.address, E(1));
    });
    it("F7: forced ETH (SELFDESTRUCT) only adds surplus; it never breaks withdrawals", async function () {
      const f = await loadFixture(fixture);
      const va = await f.vault.getAddress();
      const before = await ethers.provider.getBalance(va);
      const Bomb = await ethers.getContractFactory("Bomb");
      await Bomb.deploy(va, { value: E(1) });
      expect(await ethers.provider.getBalance(va)).to.equal(before + E(1));
      const w = await voucher(f, { token: ETH, amount: E(1) });
      await f.vault.withdraw(w, [await signWithdrawal(f.vault, f.signer, w)]);
    });
    it("F8a: daily window rolls over at exactly start + 24h", async function () {
      const f = await loadFixture(fixture);
      const t = await f.tok.getAddress();
      await f.vault.setToken(t, cfg({ maxWithdrawal: E(100), dailyCap: E(100), cosignAbove: NO_COSIGN }));
      const T = BigInt(await now()) + 10n;
      const w1 = await voucher(f, { amount: E(100), issuedAt: T - 5n, deadline: T + 3600n });
      await time.setNextBlockTimestamp(T);
      await f.vault.withdraw(w1, [await signWithdrawal(f.vault, f.signer, w1)]);
      const w2 = await voucher(f, { nonce: 2n, amount: 1n, issuedAt: T + BigInt(DAY) - 100n, deadline: T + BigInt(DAY) + 3600n });
      const s2 = await signWithdrawal(f.vault, f.signer, w2);
      await time.setNextBlockTimestamp(T + BigInt(DAY) - 1n);
      await expect(f.vault.withdraw(w2, [s2])).to.be.revertedWithCustomError(f.vault, "DailyCapExceeded").withArgs(E(100) + 1n, E(100));
      const w3 = await voucher(f, { nonce: 3n, amount: E(100), issuedAt: T + BigInt(DAY) - 100n, deadline: T + BigInt(DAY) + 3600n });
      await time.setNextBlockTimestamp(T + BigInt(DAY));
      await f.vault.withdraw(w3, [await signWithdrawal(f.vault, f.signer, w3)]);
      const win = await f.vault.window(t);
      expect(win.start).to.equal(T + BigInt(DAY)); expect(win.spent).to.equal(E(100));
    });
    it("F8b: malformed, empty, 64-byte and high-s signatures revert and leave the nonce unused", async function () {
      const f = await loadFixture(fixture);
      const w = await voucher(f); const s = await signWithdrawal(f.vault, f.signer, w);
      const sig = ethers.Signature.from(s);
      const N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
      const highS = ethers.concat([sig.r, ethers.toBeHex(N - BigInt(sig.s), 32), sig.v === 27 ? "0x1c" : "0x1b"]);
      for (const bad of ["0x", sig.compactSerialized, highS, "0x" + "00".repeat(65)]) {
        await expect(f.vault.withdraw(w, [bad])).to.be.reverted;
        await expect(f.vault.withdraw(w, [s, bad])).to.be.reverted;
      }
      expect(await f.vault.nonceUsed(f.alice.address, 1n)).to.equal(false);
      await f.vault.withdraw(w, [s]);
    });
    it("F8c: cosign rules: two SIGNER keys, signer+outsider and cosigner-only all fail; amount == cosignAbove needs one key", async function () {
      const f = await loadFixture(fixture);
      await f.vault.grantRole(await f.vault.SIGNER_ROLE(), f.bob.address);   // a second signer key
      const w = await voucher(f, { amount: E(150) });
      const s = await signWithdrawal(f.vault, f.signer, w), s2 = await signWithdrawal(f.vault, f.bob, w), o = await signWithdrawal(f.vault, f.outsider, w), c = await signWithdrawal(f.vault, f.cosigner, w);
      await expect(f.vault.withdraw(w, [s, s2])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [s, o])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await expect(f.vault.withdraw(w, [c])).to.be.revertedWithCustomError(f.vault, "BadSignatures");
      await f.vault.withdraw(w, [s2, c]);
      const edge = await voucher(f, { nonce: 2n, amount: E(100) });   // == cosignAbove
      await f.vault.withdraw(edge, [await signWithdrawal(f.vault, f.signer, edge)]);
    });
    it("F8e: an ERC-777-style hook re-entering deposit() is blocked", async function () {
      const f = await loadFixture(fixture);
      const H = await ethers.getContractFactory("HookToken"); const h = await H.deploy(); const ha = await h.getAddress();
      await f.vault.setToken(ha, cfg());
      await h.mint(f.alice.address, E(10)); await h.connect(f.alice).approve(await f.vault.getAddress(), ethers.MaxUint256);
      await h.arm(await f.vault.getAddress());
      await expect(f.vault.connect(f.alice).deposit(ha, E(1))).to.be.revertedWithCustomError(f.vault, "ReentrancyGuardReentrantCall");
      expect(await f.vault.depositCount()).to.equal(0n);
    });
    it("F8f: a blocklisted recipient's withdrawal fails cleanly (nonce unused, daily window untouched)", async function () {
      const f = await loadFixture(fixture);
      const B = await ethers.getContractFactory("BlockToken"); const b = await B.deploy(); const ba = await b.getAddress();
      await f.vault.setToken(ba, cfg());
      await b.mint(f.admin.address, E(1000)); await b.approve(await f.vault.getAddress(), ethers.MaxUint256);
      await f.vault.fundBankroll(ba, E(1000));
      await b.setBlocked(f.alice.address, true);
      const w = await voucher(f, { token: ba }); const s = await signWithdrawal(f.vault, f.signer, w);
      await expect(f.vault.withdraw(w, [s])).to.be.reverted;
      expect(await f.vault.nonceUsed(f.alice.address, 1n)).to.equal(false);
      expect((await f.vault.window(ba)).spent).to.equal(0n);
      await b.setBlocked(f.alice.address, false);
      await f.vault.withdraw(w, [s]);
    });
    it("F9: everything is configured in the constructor, so the admin can be the Safe from block one", async function () {
      const f = await loadFixture(fixture);
      const safe = f.bob.address;
      const v = await f.Vault.deploy(setup({ admin: safe, adminDelay: 2 * DAY, signer: f.signer.address, cosigner: f.cosigner.address, guardian: f.guardian.address,
        allowlistOnly: true, allowed: [f.alice.address], tokens: [{ token: ETH, config: cfg() }] }));
      expect(await v.defaultAdmin()).to.equal(safe);
      expect(await v.hasRole(await v.DEFAULT_ADMIN_ROLE(), f.admin.address)).to.equal(false);   // the deployer holds nothing
      expect(await v.hasRole(await v.SIGNER_ROLE(), f.signer.address)).to.equal(true);
      expect(await v.allowed(f.alice.address)).to.equal(true);
      expect(await v.allowlistOnly()).to.equal(true);
      expect(await v.voucherEpoch()).to.equal(0n);
      expect((await v.tokenConfig(ETH)).listed).to.equal(true);
      // the constructor enforces the same rules
      await expect(f.Vault.deploy(setup({ admin: safe, signer: f.signer.address, cosigner: f.signer.address }))).to.be.revertedWithCustomError(f.Vault, "BadConfig");
      await expect(f.Vault.deploy(setup({ admin: safe, tokens: [{ token: ETH, config: cfg({ cosignAbove: E(1000) }) }] }))).to.be.revertedWithCustomError(f.Vault, "BadConfig");
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
          const ts = BigInt(await now()); const w = { user: who.address, token: t, amount: amt, nonce: n++, epoch: 0n, issuedAt: ts, deadline: ts + 3600n };
          const sigs = [await signWithdrawal(f.vault, f.signer, w)]; if (amt > E(100)) sigs.push(await signWithdrawal(f.vault, f.cosigner, w));
          try { await f.vault.connect(f.relayer).withdraw(w, sigs); out += amt; } catch (e) { if (!/DailyCapExceeded/.test(e.message)) throw e; }
        } else if (rnd(10) === 0) { try { await f.vault.sweep(t, f.admin.address, amt); out += amt; } catch (e) { if (!/DailyCapExceeded/.test(e.message)) throw e; } }
        if (rnd(20) === 0) await time.increase(DAY / 3);
        expect(await f.tok.balanceOf(await f.vault.getAddress())).to.equal(inn - out);
      }
    });
    it("holds for ETH too (200 random operations)", async function () {
      const f = await loadFixture(fixture);
      const va = await f.vault.getAddress();
      let inn = E(500), out = 0n, n = 1n, seed = 777;
      const rnd = (m) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % m; };
      for (let i = 0; i < 200; i++) {
        const who = [f.alice, f.bob][rnd(2)], op = rnd(3), amt = E(1 + rnd(9)) / 10n;
        if (op === 0) { await f.vault.connect(who).depositETH({ value: amt }); inn += amt; }
        else if (op === 1) {
          const ts = BigInt(await now()); const w = { user: who.address, token: ETH, amount: amt, nonce: n++, epoch: 0n, issuedAt: ts, deadline: ts + 3600n };
          await f.vault.connect(f.relayer).withdraw(w, [await signWithdrawal(f.vault, f.signer, w)]); out += amt;
        } else if (rnd(10) === 0) { await f.vault.sweep(ETH, f.treasury.address, amt); out += amt; }
        expect(await ethers.provider.getBalance(va)).to.equal(inn - out);
      }
    });
  });
});
