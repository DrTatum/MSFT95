import { ethers } from "ethers";
import type { Chain } from "./chain.js";

/**
 * Pause vault withdrawals on-chain with the GUARDIAN key. Never hangs: the transaction gets a timeout, and a stuck
 * one is retried by the next caller (it re-checks withdrawalsPaused first).
 */
export async function guardianPause(ch: Chain, guardianKey: string | undefined, reason: string, log: (m: string) => void = () => {}, timeoutMs = 90_000): Promise<boolean> {
  if (!guardianKey) { log(`ALERT guardian key not configured, cannot pause vault (${reason})`); return false; }
  try {
    const g = new ethers.Wallet(guardianKey, ch.provider);
    const v = ch.vault.connect(g) as ethers.Contract;
    if (await v.getFunction("withdrawalsPaused")()) return true;
    const sent: ethers.ContractTransactionResponse = await v.getFunction("pauseWithdrawals")();
    const rec = await sent.wait(1, timeoutMs);
    log(`vault withdrawals paused on-chain by guardian (${reason}) tx ${rec?.hash}`);
    return true;
  } catch (e: any) {
    log(`ALERT guardian pause failed (${reason}): ${e?.shortMessage ?? e?.message}`);
    return false;
  }
}
