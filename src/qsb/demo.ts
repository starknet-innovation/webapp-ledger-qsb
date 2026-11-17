// A simulated Ledger and QSB service (add ?demo to the address). No device, no network, no bitcoin.
import type { Device, Say } from "../ledger/device";
import type { Backend, Snapshot } from "./backend";

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const ADDRESS = "bc1qdemo0000000000000000000000000000000demo";
const TXID = "d".repeat(64);

let installed = false;

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
    return { version: "0.2.0", profile: "PQB-v1", vaults: 0 };
  },
  async disconnect() {},
};

export function demoBackend(): Backend {
  const state: Snapshot = { address: ADDRESS, walletSats: 250_000n, vault: null, withdrawal: null };
  const approve = async (say: Say) => {
    say("Check the details on your Ledger, then approve.");
    await wait(2000);
    say("");
  };
  return {
    snapshot: async () => structuredClone(state),
    showAddress: () => wait(1500),
    async deposit(sats, say) {
      await approve(say);
      state.walletSats -= sats + 400n;
      state.vault = { status: "submitted", sats, txid: TXID };
      setTimeout(() => (state.vault = { status: "confirmed", sats, txid: TXID }), 6000);
    },
    async withdraw(destination) {
      await wait(600);
      state.withdrawal = { state: "searching", destination };
      setTimeout(() => (state.withdrawal = { state: "ready", destination }), 8000);
    },
    async finishWithdrawal(say) {
      await approve(say);
      if (state.vault && state.vault.status !== "unfunded") state.vault = { ...state.vault, status: "spent" };
      state.withdrawal = { state: "sent", destination: state.withdrawal!.destination, txid: TXID };
    },
  };
}
