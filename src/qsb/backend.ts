// What the vault screens need, in the user's terms. Two implementations:
// - src/qsb/ledgerBackend.ts: the PQB Ledger app (device-held vault) and the QSB SDK/service;
// - src/qsb/demo.ts: a simulation for `?demo`.
//
// One vault at a time: the newest vault this Ledger created that isn't finished, else none.
// A vault takes one deposit (everything at its deposit address, swept in one transaction) and
// one withdrawal (everything, to one address, after a search that takes hours).
import type { Say } from "../ledger/session";

export type VaultStep =
  /** Created on the Ledger, registered with QSB, nothing at its deposit address yet. */
  | "awaiting-bitcoin"
  /** Enough confirmed bitcoin at the deposit address (at least `minimumSats`), ready to be moved in. */
  | "ready-to-deposit"
  /** The deposit (sweep) was sent; waiting for confirmation. */
  | "depositing"
  /** The vault holds the bitcoin. A withdrawal can start. */
  | "in-vault"
  /**
   * This browser saved a withdrawal to `destination`, but QSB never received it (cut off): start
   * that same one (the SDK only resumes a saved withdrawal unchanged).
   */
  | "withdrawal-not-started"
  /** A withdrawal's search is running (hours). */
  | "searching"
  /** The search is paused; `detail` says why, `canResume` whether the user can continue it. */
  | "paused"
  /** The search is done, but its fee is below the miner's minimum now: wait for fees to drop. */
  | "waiting-for-fees"
  /** The search is done: approve the withdrawal on the Ledger. */
  | "ready-to-approve"
  /** The withdrawal was sent and the miner has it; waiting for confirmation. Keep the vault. */
  | "sending"
  /** The withdrawal may have been sent; QSB is checking. Keep the vault. */
  | "checking-send"
  /** The withdrawal is confirmed. The vault is finished. */
  | "sent"
  /** Something needs QSB's operator; `detail` says what. Nothing more can be done from the page. */
  | "failed";

export type VaultView = {
  /** The vault's index on the Ledger. */
  v: number;
  /** First 8 bytes of the vault's commitment root, as the Ledger shows it, e.g. "6c37 5dd4 d49e 27a6". */
  fingerprint: string;
  step: VaultStep;
  /** The vault's own deposit address (P2WPKH, derived on the Ledger). */
  depositAddress: string;
  /** Confirmed sats waiting at the deposit address (what a deposit would sweep, before fee). */
  waitingSats: bigint;
  /**
   * The least the deposit address must hold before it can be moved in: enough to pay the deposit's
   * fee and leave a vault that can still pay its own withdrawal fee if fees rise.
   */
  minimumSats?: bigint;
  /** Sats in the vault (the deposit's vault output), once deposited. */
  vaultSats?: bigint;
  /** The deposit's or the withdrawal's txid, for "View the transaction". */
  txid?: string;
  /** The withdrawal's destination, once one started. */
  destination?: string;
  /** Why the last step failed or stopped, in plain words. */
  detail?: string;
  /** "paused": the user can continue the search (Backend.resumeWithdrawal). */
  canResume?: boolean;
  /** "ready-to-approve": the withdrawal was started in another browser; ask the user to check the address. */
  fromElsewhere?: boolean;
  /**
   * Confirmed sats still at the deposit address after the deposit confirmed (arrived later, or
   * beyond what one sweep takes). Not in the vault, and this page can't move them yet.
   */
  leftoverSats?: bigint;
  /** An identifier to give QSB's operator (the withdrawal's, else the vault's). */
  reference?: string;
};

export type Snapshot = {
  /** The current vault, or null when the user has none in progress. */
  vault: VaultView | null;
};

export interface Backend {
  /** Reads the Ledger and the QSB service. May ask the Ledger to approve a sign-in (`say` tells the user). */
  snapshot(say: Say): Promise<Snapshot>;
  /**
   * Creates a vault on the Ledger and registers it with QSB. Three approvals on the device: create
   * the vault, export its menu points to the solver, sign in. Resolves once it's registered.
   */
  createVault(say: Say): Promise<void>;
  /** Shows the current vault's deposit address on the Ledger so the user can compare it. */
  showDepositAddress(say: Say): Promise<void>;
  /** Sweeps everything at the deposit address into the vault (approve on the Ledger), then sends it. */
  deposit(say: Say): Promise<void>;
  /** Starts the withdrawal's search: everything in the vault, minus the fee, to `destination`. */
  withdraw(destination: string, say: Say): Promise<void>;
  /** Continues a paused search, when `canResume`. */
  resumeWithdrawal(say: Say): Promise<void>;
  /** Once the search is done: approve on the Ledger, then send. */
  finishWithdrawal(say: Say): Promise<void>;
}

export const SATS = 100_000_000n;
export const btc = (sats: bigint) => {
  const whole = sats / SATS;
  const frac = (sats % SATS).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? `.${frac}` : ""} BTC`;
};
