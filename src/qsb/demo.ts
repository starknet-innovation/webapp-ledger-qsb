// A simulated Ledger and QSB service (add ?demo to the address). No device, no network, no bitcoin.
// Other screens: ?demo=fail (the withdrawal needs the operator), ?demo=pause (the search pauses),
// ?demo=fees (fees rose before approval), ?demo=uncertain (the send is being checked),
// ?demo=leftover (bitcoin left at the deposit address).
import type { Device, Say } from "../ledger/device";
import type { Backend, Snapshot, VaultView } from "./backend";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ADDRESS = "bc1qdemo0000000000000000000000000000000demo";
const DEPOSIT_TXID = "d".repeat(64);
const WITHDRAW_TXID = "e".repeat(64);
const FEE = 420n;

let installed = false;
let vaults = 0;

export const demoDevice: Device = {
  name: "Ledger (demo)",
  async openApp() {
    await wait(500);
    return installed;
  },
  async install(progress, say) {
    say("On your Ledger, allow Ledger Manager.");
    await wait(1500);
    say("");
    for (let i = 1; i <= 20; i++) {
      await wait(120);
      progress(i / 20);
    }
    installed = true;
  },
  async status() {
    return { version: "0.2.0", profile: "PQB-v1", vaults, signIn: true };
  },
  async depositAddress() {
    return { address: ADDRESS };
  },
  async use() {
    throw new Error("The demo has no Ledger.");
  },
  async signIn() {
    throw new Error("The demo doesn't sign in.");
  },
  async disconnect() {},
};

const fingerprintFor = (v: number) =>
  Array.from({ length: 4 }, (_, i) => ((0x6c37 + v * 0x1f3d + i * 0x9e27) & 0xffff).toString(16).padStart(4, "0")).join(" ");

export function demoBackend(): Backend {
  const state: Snapshot = { vault: null };
  let signedIn = false;
  const variant = new URLSearchParams(location.search).get("demo");
  let failNext = variant === "fail";
  let pauseNext = variant === "pause";
  let feesNext = variant === "fees";

  /** A Ledger approval: the hint stays up while the "user" reads the screen. */
  const approve = async (say: Say, hint = "Check the details on your Ledger, then approve.") => {
    say(hint);
    await wait(2000);
    say("");
  };
  const vault = () => {
    if (!state.vault) throw new Error("You don't have a vault yet.");
    return state.vault;
  };
  /** Moves the vault on after `ms`, if it is still the same vault at the same step. */
  const later = (ms: number, from: VaultView, change: Partial<VaultView>) => {
    const step = from.step;
    setTimeout(() => {
      if (state.vault === from && from.step === step) Object.assign(from, change);
    }, ms);
  };

  return {
    async snapshot(say) {
      if (!signedIn) {
        await approve(say, "Approve the sign-in on your Ledger.");
        signedIn = true;
      }
      return structuredClone(state);
    },
    async createVault(say) {
      await approve(say, "On your Ledger, approve creating the vault (1 of 3).");
      await approve(say, "On your Ledger, approve sharing the vault's details (2 of 3).");
      await approve(say, "On your Ledger, approve the sign-in (3 of 3).");
      const v = vaults++;
      const created: VaultView = { v, fingerprint: fingerprintFor(v), step: "awaiting-bitcoin", depositAddress: ADDRESS, waitingSats: 0n, minimumSats: 41_000n };
      state.vault = created;
      // Someone sends bitcoin to the deposit address and it confirms.
      later(5000, created, { step: "ready-to-deposit", waitingSats: 250_000n, minimumSats: undefined });
    },
    async showDepositAddress(say) {
      await approve(say, "Compare the address on your Ledger with the one on this page.");
    },
    async deposit(say) {
      const current = vault();
      await approve(say, `On your Ledger, check the amount and approve the deposit.`);
      Object.assign(current, { step: "depositing", vaultSats: current.waitingSats - FEE, waitingSats: 0n, txid: DEPOSIT_TXID });
      later(6000, current, variant === "leftover" ? { step: "in-vault", waitingSats: 12_000n, leftoverSats: 12_000n } : { step: "in-vault" });
    },
    async withdraw(destination) {
      const current = vault();
      await wait(600);
      Object.assign(current, { step: "searching", destination, detail: undefined, txid: DEPOSIT_TXID, reference: "3f1c2a9e-demo" });
      if (failNext) {
        failNext = false;
        later(6000, current, {
          step: "failed",
          detail:
            "The search stopped. Your bitcoin is safe in the vault. It can't be restarted from this page. This needs QSB's operator: contact them and mention the reference below.",
        });
      } else if (pauseNext) {
        pauseNext = false;
        later(5000, current, { step: "paused", canResume: true, detail: "QSB has paused withdrawals for now. Your bitcoin is safe in the vault. Once QSB is back, continue the search." });
      } else if (feesNext) {
        feesNext = false;
        later(6000, current, { step: "waiting-for-fees" });
        setTimeout(() => state.vault === current && current.step === "waiting-for-fees" && Object.assign(current, { step: "ready-to-approve" }), 14000);
      } else later(8000, current, { step: "ready-to-approve" });
    },
    async resumeWithdrawal() {
      const current = vault();
      await wait(600);
      Object.assign(current, { step: "searching", detail: undefined, canResume: undefined });
      later(6000, current, { step: "ready-to-approve" });
    },
    async finishWithdrawal(say) {
      const current = vault();
      await approve(say, "On your Ledger, check the address and amount, then approve the withdrawal.");
      Object.assign(current, { step: variant === "uncertain" ? "checking-send" : "sending", txid: WITHDRAW_TXID });
      if (variant === "uncertain") later(6000, current, { step: "sending" });
      setTimeout(() => state.vault === current && current.step === "sending" && Object.assign(current, { step: "sent" }), variant === "uncertain" ? 14000 : 8000);
    },
  };
}
