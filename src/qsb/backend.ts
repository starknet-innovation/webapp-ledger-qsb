// What the screens need from QSB, in the user's terms. `real.ts` implements it with the QSB SDK
// and the Ledger; `demo.ts` simulates it.
import type { Say } from "../ledger/device";

export type Snapshot = {
  /** The Ledger's QSB wallet address: it pays deposits and the withdrawal's network fee. */
  address: string;
  /** Confirmed sats at `address`. */
  walletSats: bigint;
  vault:
    | null
    | { status: "unfunded" }
    | { status: "submitted" | "confirmed" | "spent"; sats: bigint; txid: string };
  withdrawal:
    | null
    | { state: "searching" | "ready" | "sent" | "failed"; destination: string; txid?: string; detail?: string };
};

export interface Backend {
  snapshot(): Promise<Snapshot>;
  /** Shows the wallet address on the Ledger so the user can compare it. */
  showAddress(): Promise<void>;
  /** Creates the vault if needed, then pays `sats` into it. One deposit per vault. */
  deposit(sats: bigint, say: Say): Promise<void>;
  /** Starts the withdrawal's search. It takes hours and continues without this page. */
  withdraw(destination: string, say: Say): Promise<void>;
  /** Once the search is done: approve on the Ledger and send. */
  finishWithdrawal(say: Say): Promise<void>;
}

export const SATS = 100_000_000n;
export const btc = (sats: bigint) => {
  const whole = sats / SATS;
  const frac = (sats % SATS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} BTC`;
};
/** "0.001" → sats; undefined when it isn't a positive amount with at most 8 decimals. */
export const parseBtc = (input: string): bigint | undefined => {
  const m = /^(\d{0,8})(?:[.,](\d{0,8}))?$/.exec(input.trim());
  if (!m || (!m[1] && !m[2])) return undefined;
  const sats = BigInt(m[1] || "0") * SATS + BigInt((m[2] || "").padEnd(8, "0"));
  return sats > 0n ? sats : undefined;
};
