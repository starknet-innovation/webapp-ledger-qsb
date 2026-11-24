// The real Backend: a vault held by the PQB Ledger app, registered with and run by the QSB service
// through its SDK (github.com/starknet-innovation/qsb-app, sdk/).
//
// Each vault has its own deposit address (P2WPKH, derived on the Ledger). That address is the SDK's
// one wallet: it signs in, owns the vault on the service and pays the deposit. So there is one
// QsbClient per vault index v. The Ledger signs a deposit only as a sweep (exactly one output, into
// the vault's script), so a deposit moves everything at the deposit address with no change.
//
// Vault discovery: the newest record on the Ledger that isn't retired is the current vault. If the
// service doesn't know it (createVault was interrupted between the Ledger and the service), the
// snapshot still shows it from its deposit address, and the next createVault or deposit finishes
// the registration before anything moves into the vault. Nothing is ever swept into an unregistered
// vault, and bitcoin at the deposit address stays the Ledger's.
//
// Every device interaction goes through device.use / device.signIn, with the `say` of the backend
// call in progress. Calls are serialized: the Ledger does one thing at a time, and the SDK's
// credentials, signer and custody callbacks read `say` from the call that is running.
import {
  ApiRequestError,
  QsbClient,
  type AuthorizationStore,
  type Credentials,
  type ExternalCustody,
  type PendingDeposit,
  type PendingDeposits,
  type QsbClientOptions,
  type Signer,
  type SignedWithdrawal,
  type WithdrawalSigningRequest,
} from "@starknet-innovation/qsb-sdk";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64, hex } from "@scure/base";
import { Address, NETWORK, OutScript, RawTx, SigHash, Transaction, p2pkh, p2wpkh } from "@scure/btc-signer";
import { Plain, type Device, type PqbApp, type Say } from "../ledger/session";
import { fingerprint, SCRIPT_LEN } from "../vendor/pqb-ledger/pqb";
import type { VaultRecord } from "../vendor/pqb-ledger/pqb";
import type { Backend, Snapshot, VaultStep, VaultView } from "./backend";
import { authorizeOnDevice, descriptorFor, readDeviceVault, type DeviceVault } from "./deviceVault";

const HINT = {
  create: "On your Ledger, confirm creating the vault.",
  export: "On your Ledger, allow sharing the vault's search data with QSB.",
  deposit: "Check the deposit on your Ledger, then approve.",
  withdraw: "Check the withdrawal on your Ledger, then approve.",
  address: "Compare the address on your Ledger with this page, then confirm.",
  refund: "Check the address and amount on your Ledger, then approve.",
  read: "",
};

/** The Ledger signs a sweep with at most this many inputs. */
export const MAX_SWEEP_INPUTS = 8;
/** A sign-in session lasts an hour on the service; sign in again a little before. */
const SESSION_MS = 50 * 60_000;

// ---- Fee math: qsb-app src/lib/transactions.ts, for a native P2WPKH sweep with no change. ----

const varintSize = (n: number) => (n < 0xfd ? 1 : n <= 0xffff ? 3 : 5);

/**
 * The SDK's fundingVsize(inputCount, nested = false, vaultScriptLength, change = false): one
 * output (the vault), every input a P2WPKH spend counted at the 72-byte DER maximum.
 */
export function sweepVsize(inputCount: number, vaultScriptLength: number): number {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) throw new Error("A sweep has at least one input.");
  const outputs = 8 + varintSize(vaultScriptLength) + vaultScriptLength;
  const base = 4 + varintSize(inputCount) + inputCount * 41 + varintSize(1) + outputs + 4;
  const witness = 2 + inputCount * (1 + 1 + 72 + 1 + 33);
  return Math.ceil((base * 4 + witness) / 4);
}

/**
 * Everything in `values`, less the miner fee, as one vault output. The fee is the SDK's
 * rate × vsize rounded up (rate in millisatoshis per vB), so with this amount the SDK's
 * fundingFeeForRate picks the no-change transaction and the same fee.
 */
export function sweepQuote(values: bigint[], vaultScriptLength: number, milliSatPerVb: bigint) {
  const vsize = sweepVsize(values.length, vaultScriptLength);
  const fee = (BigInt(vsize) * milliSatPerVb + 999n) / 1000n;
  const total = values.reduce((sum, value) => sum + value, 0n);
  return { total, fee, vsize, amount: total - fee };
}

/**
 * Upper bound on a one-input PQB withdrawal's size in vB: qsb-app's
 * withdrawalVsize(null, 34, PQB_MAX_SCRIPTSIG) at 29fd868 (scriptSig bound 1,599 bytes, the largest
 * output script a P2WSH/P2TR destination has).
 */
export const WITHDRAWAL_VSIZE = 1695;
/**
 * The SDK's withdrawalVsize(null, outputScriptLength, PQB bound): the same as WITHDRAWAL_VSIZE less
 * the bytes a shorter destination script saves (output bytes count one vB each).
 */
export const withdrawalVsizeFor = (outputScriptLength: number) => WITHDRAWAL_VSIZE - 34 + outputScriptLength;
/** The withdrawal fee a vault must be able to pay: at five times today's rate, and at least 20 sat/vB. */
const WITHDRAWAL_RATE_MARGIN = 5n;
const WITHDRAWAL_RATE_FLOOR = 20_000n; // millisat/vB
const DUST = 546n;

/** What a vault must hold after its deposit: its withdrawal fee if fees rise, plus a non-dust output. */
export function withdrawalReserve(milliSatPerVb: bigint): bigint {
  const withdrawalRate = milliSatPerVb * WITHDRAWAL_RATE_MARGIN > WITHDRAWAL_RATE_FLOOR ? milliSatPerVb * WITHDRAWAL_RATE_MARGIN : WITHDRAWAL_RATE_FLOOR;
  return (BigInt(WITHDRAWAL_VSIZE) * withdrawalRate + 999n) / 1000n + DUST;
}

/**
 * The least a deposit address must hold before it's moved into a vault: the sweep's own fee (for
 * `inputs` inputs) plus the withdrawal reserve. The deposit itself checks the real quote's amount.
 */
export function minimumDeposit(vaultScriptLength: number, milliSatPerVb: bigint, inputs = 1): bigint {
  const n = Math.min(Math.max(inputs, 1), MAX_SWEEP_INPUTS);
  return withdrawalReserve(milliSatPerVb) + sweepQuote(Array<bigint>(n).fill(0n), vaultScriptLength, milliSatPerVb).fee;
}

/** MARA's minimum exactly as the SDK checks it (ceilMilliSatPerVb(minerMinimumRate)), in millisat/vB. */
export function minerFloor(rates: { submit_fee_rate: number; market_rate?: number }): bigint {
  const floor = rates.submit_fee_rate;
  const market = rates.market_rate;
  if (!Number.isFinite(floor) || floor < 0) throw new Error("Invalid miner fee floor.");
  const satPerVb = typeof market === "number" && Number.isFinite(market) && market > floor ? market : floor;
  return BigInt(Math.ceil(Math.round(satPerVb * 1e6) / 1e3));
}

/** MARA's minimum (the SDK's minerMinimumRate), in millisatoshis per vB rounded up, at least 1 sat/vB. */
export function minerRate(rates: { submit_fee_rate: number; market_rate?: number }): bigint {
  const rate = minerFloor(rates);
  return rate < 1000n ? 1000n : rate;
}

/**
 * The rate a withdrawal is quoted at: max(2 × floor, floor + 2 sat/vB). The search takes hours and
 * the Ledger signs once, with no fee bump, and MARA's floor is checked again only at submission.
 * Doubling covers the usual swings of a few hours; the +2 sat/vB matters when fees are near
 * 1 sat/vB, where doubling adds almost nothing. It costs little: at a 2 sat/vB floor, 4 sat/vB on
 * at most 1,695 vB, about 3,400 sats more. The deposit reserved 5× its own rate (and at least
 * 20 sat/vB), so a vault pays this unless fees rose more than 2.5× since its deposit; then the
 * floor itself is used (see withdrawalQuoteRate).
 */
export function withdrawalRate(floorMilliSatPerVb: bigint): bigint {
  const floor = floorMilliSatPerVb < 1000n ? 1000n : floorMilliSatPerVb;
  const doubled = floor * 2n;
  const plus = floor + 2000n;
  return doubled > plus ? doubled : plus;
}

/** The margin rate when the vault can pay it with a non-dust output left, otherwise the floor. */
export function withdrawalQuoteRate(floorMilliSatPerVb: bigint, vaultSats: bigint, outputScriptLength: number): bigint {
  const rate = withdrawalRate(floorMilliSatPerVb);
  const fee = (BigInt(withdrawalVsizeFor(outputScriptLength)) * rate + 999n) / 1000n;
  if (vaultSats - fee > DUST) return rate;
  return floorMilliSatPerVb < 1000n ? 1000n : floorMilliSatPerVb;
}

/** A withdrawal's fee rate in millisat/vB, as the SDK computes it before signing (a lower bound on the signed rate). */
export function intentRate(manifest: { fee: string; outputScript: string }): bigint {
  return (BigInt(manifest.fee) * 1000n) / BigInt(withdrawalVsizeFor(manifest.outputScript.length / 2));
}

/** A millisat/vB rate as the SDK's parseFeeRate takes it, e.g. "2" or "2.25". */
export function feeRateText(milliSatPerVb: bigint): string {
  const fraction = (milliSatPerVb % 1000n).toString().padStart(3, "0").replace(/0+$/, "");
  return `${milliSatPerVb / 1000n}${fraction ? `.${fraction}` : ""}`;
}

// ---- Refunds: bitcoin at the deposit address sent back out, never into the vault. ----

/** Output script types the Ledger pays in a refund (app-qsb docs/apdu.md, SIGN_DEPOSIT kind 0x02). */
const REFUND_TYPES = new Set(["pkh", "sh", "wpkh", "wsh", "tr"]);

/**
 * A refund's size in vB: every input a P2WPKH spend from the deposit address (72-byte DER maximum),
 * one output with a `outputScriptLength`-byte script, no change.
 */
export function refundVsize(inputCount: number, outputScriptLength: number): number {
  if (!Number.isSafeInteger(inputCount) || inputCount < 1) throw new Error("A refund has at least one input.");
  const base = 4 + varintSize(inputCount) + 41 * inputCount + varintSize(1) + 8 + varintSize(outputScriptLength) + outputScriptLength + 4;
  const witness = 2 + inputCount * (1 + 1 + 72 + 1 + 33);
  return Math.ceil((base * 4 + witness) / 4);
}

/** Everything in `values`, less the fee at `milliSatPerVb` (rounded up), as one output. */
export function refundQuote(values: bigint[], outputScriptLength: number, milliSatPerVb: bigint) {
  const vsize = refundVsize(values.length, outputScriptLength);
  const fee = (BigInt(vsize) * milliSatPerVb + 999n) / 1000n;
  const total = values.reduce((sum, value) => sum + value, 0n);
  return { total, fee, vsize, amount: total - fee };
}

/** The longest script a refund may pay (P2WSH, P2TR): what `refundableSats` is quoted for. */
const LONGEST_REFUND_SCRIPT = 34;

/**
 * The refund's output script for `destination` (a mainnet address the Ledger can pay), refusing
 * the vault's own deposit address and its script.
 */
export function refundScript(destination: string, own: { depositScript: Uint8Array; vaultScript?: Uint8Array }): Uint8Array {
  let script: Uint8Array;
  try {
    const decoded = Address(NETWORK).decode(destination);
    if (!REFUND_TYPES.has(decoded.type)) throw new Error(`unsupported ${decoded.type}`);
    script = OutScript.encode(decoded);
  } catch (cause) {
    throw new Plain("That isn't a Bitcoin address your Ledger can send to. Check it and try again.", { cause });
  }
  const same = (a: Uint8Array, b?: Uint8Array) => !!b && a.length === b.length && a.every((x, i) => x === b[i]);
  if (same(script, own.depositScript) || same(script, own.vaultScript))
    throw new Plain("That's this vault's own address. Send it back to another address.");
  return script;
}

type Outpoint = { txid: string; vout: number };
const pointKey = (p: Outpoint) => `${p.txid.toLowerCase()}:${p.vout}`;

/** The outpoints a raw transaction spends, as the service writes them (txid in display order). */
export function spentBy(rawTxHex: string): Outpoint[] {
  const tx = Transaction.fromRaw(hex.decode(rawTxHex), { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
  return Array.from({ length: tx.inputsLength }, (_, i) => {
    const input = tx.getInput(i);
    return { txid: hex.encode(input.txid!), vout: input.index! };
  });
}

/**
 * What a refund may spend: the largest MAX_SWEEP_INPUTS outputs at the deposit address, leaving
 * out those a pending deposit, a withdrawal's helper or an already-sent refund spends.
 */
export function refundableUtxos<T extends Outpoint & { value: string }>(utxos: T[], reserved: Outpoint[]): T[] {
  const taken = new Set(reserved.map(pointKey));
  return [...utxos]
    .filter((u) => !taken.has(pointKey(u)))
    .sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0))
    .slice(0, MAX_SWEEP_INPUTS);
}

/** A signed refund, kept until its inputs leave the deposit address so a retry resends these bytes. */
export type SignedRefund = { txid: string; hex: string; destination: string; inputs: Outpoint[]; amount: string; broadcast: boolean };

/** Signed refunds by deposit address, in localStorage (`qsb-refund:<address>`) with a copy in memory. */
export function localRefunds(storage: () => KeyValue | undefined = browserStorage) {
  const key = (address: string) => `qsb-refund:${address}`;
  const memory = new Map<string, SignedRefund>();
  return {
    get(address: string): SignedRefund | undefined {
      try {
        const raw = storage()?.getItem(key(address));
        if (raw) return JSON.parse(raw) as SignedRefund;
      } catch {
        // Fall back to this page's copy.
      }
      return memory.get(address);
    },
    set(address: string, refund: SignedRefund) {
      memory.set(address, refund);
      try {
        storage()?.setItem(key(address), JSON.stringify(refund));
      } catch {
        // Kept in memory for this page.
      }
    },
    delete(address: string) {
      memory.delete(address);
      try {
        storage()?.removeItem(key(address));
      } catch {
        // Nothing to do.
      }
    },
  };
}

/** Throws unless every input's signature is a valid BIP-143 SIGHASH_ALL signature by `publicKey`. */
export function verifyRefund(tx: Transaction, publicKey: Uint8Array, signatures: Uint8Array[]) {
  // BIP-143: a P2WPKH input's scriptCode is the P2PKH script of its key.
  const scriptCode = p2pkh(publicKey, NETWORK).script;
  if (signatures.length !== tx.inputsLength) throw new Error("The Ledger returned the wrong number of signatures.");
  signatures.forEach((signature, i) => {
    if (signature.at(-1) !== SigHash.ALL) throw new Error("The Ledger signed with an unexpected sighash type.");
    const amount = tx.getInput(i).witnessUtxo?.amount;
    if (amount === undefined) throw new Error("A refund input is missing its amount.");
    const digest = tx.preimageWitnessV0(i, scriptCode, SigHash.ALL, amount);
    if (!secp256k1.verify(signature.subarray(0, -1), digest, publicKey, { prehash: false, format: "der" }))
      throw new Error(`The Ledger's signature for input ${i} doesn't verify.`);
  });
}

// ---- What the screens show. ----

type JobLike = { status: string; error?: string };

const SAFE = "Your bitcoin is safe in the vault.";
const OPERATOR = "This needs QSB's operator: contact them and mention the reference below.";

/**
 * A failed withdrawal, in the user's words. A failed withdrawal can't be retried: QSB keeps the
 * vault's deposit reserved to it, and refuses another withdrawal for the vault (qsb-app runbook,
 * "Deterministic pinning failures": no recovery path yet).
 */
export function jobFailure(error: string | undefined): string {
  const e = error ?? "";
  const why = /fee|rate|mara/i.test(e)
    ? "The network fee went up while the search ran."
    : /budget|gpu|limit|quota|capacity/i.test(e)
      ? "The search hit one of QSB's limits."
      : /destination|address/i.test(e)
        ? "QSB couldn't use the withdrawal address."
        : "The search stopped.";
  return `${why} ${SAFE} It can't be restarted from this page. ${OPERATOR}`;
}

/** Pauses an owner may lift with withdrawals.resume. Anything else needs the operator (runbook). */
const OWNER_RESUMABLE = ["Mainnet disabled by deployment.", "Wallet is not allowed by deployment configuration."];

/** A paused withdrawal: whether the owner can continue it, and why it stopped. */
export function jobPause(error: string | undefined): { canResume: boolean; detail: string } {
  let rest = (error ?? "").trim();
  for (const reason of OWNER_RESUMABLE) rest = rest.replace(reason, "").trim();
  if (rest)
    return { canResume: false, detail: `The search stopped and needs QSB's operator before it can go on. ${SAFE} Nothing is needed from you now.` };
  if (error?.includes(OWNER_RESUMABLE[0]))
    return { canResume: true, detail: `QSB has paused withdrawals for now. ${SAFE} Once QSB is back, continue the search.` };
  if (error?.includes(OWNER_RESUMABLE[1]))
    return { canResume: true, detail: `QSB isn't taking withdrawals from this vault right now. ${SAFE} Try to continue later.` };
  return { canResume: true, detail: `The search is paused. ${SAFE} Continue it when you're ready.` };
}

export type StepInput = {
  vault?: { status: "unfunded" | "submitted" | "confirmed" | "spent" } | null;
  /** A signed deposit is kept in this browser, waiting for the miner to take it. */
  pendingDeposit?: boolean;
  waitingSats: bigint;
  /** What one deposit can sweep (the largest MAX_SWEEP_INPUTS outputs); defaults to waitingSats. */
  sweepableSats?: bigint;
  /** Below this, bitcoin at the deposit address waits for more (see minimumDeposit). */
  minimumSats?: bigint;
  /** The miner refused this vault's last deposit, with its reason. */
  depositRejected?: string;
  job?: JobLike | null;
  /** This browser's journal holds a withdrawal intent for the vault, but QSB has no withdrawal yet. */
  savedIntent?: boolean;
  /** The Ledger recorded a different deposit than QSB's vault: nothing may go on. */
  fundingMismatch?: boolean;
  /** The finished search's fee is now below MARA's minimum. */
  feeTooLow?: boolean;
  /** Why this browser can't take over a withdrawal started elsewhere, if it can't. */
  reclaimProblem?: string;
  /** For a submitted withdrawal: what QSB last observed (GET /jobs/:id/status, or submit's answer). */
  submission?: { status?: string; alert?: unknown };
};

/** The step a vault is at, from the service's vault and newest withdrawal and what's at the deposit address. */
export function vaultStep(input: StepInput): { step: VaultStep; detail?: string; canResume?: boolean } {
  const { vault, job } = input;
  if (job && (job.status === "submitted" || job.status === "confirmed")) {
    if (job.status === "confirmed") return { step: "sent" };
    const s = input.submission;
    if (s?.alert || s?.status === "conflict")
      return {
        step: "failed",
        detail: `The vault's bitcoin was spent by a different transaction than the one you approved. Don't approve anything else. ${OPERATOR}`,
      };
    if (s?.status === "confirmed") return { step: "sent" };
    if (s?.status === "submitted") return { step: "sending" };
    return { step: "checking-send" };
  }
  if (vault?.status === "spent") return { step: "sent" };
  if (!vault || vault.status === "unfunded") {
    if (input.pendingDeposit) return { step: "depositing" };
    const rejected =
      input.depositRejected !== undefined
        ? `Your last deposit wasn't accepted${input.depositRejected ? ` (${input.depositRejected})` : ""}. Nothing left the deposit address. Try again.`
        : undefined;
    if (input.waitingSats === 0n) return { step: "awaiting-bitcoin" };
    if (input.minimumSats !== undefined && (input.sweepableSats ?? input.waitingSats) < input.minimumSats)
      return { step: "awaiting-bitcoin", detail: "That's not enough yet. Send more to the same address." };
    return rejected ? { step: "ready-to-deposit", detail: rejected } : { step: "ready-to-deposit" };
  }
  if (vault.status === "submitted") return { step: "depositing" };
  if (input.fundingMismatch)
    return {
      step: "failed",
      detail: `The deposit QSB has for this vault isn't the one your Ledger recorded, so nothing can go on from this page. ${OPERATOR}`,
    };
  if (!job) return input.savedIntent ? { step: "withdrawal-not-started" } : { step: "in-vault" };
  switch (job.status) {
    case "awaiting_authorization":
      if (input.reclaimProblem) return { step: "failed", detail: input.reclaimProblem };
      return input.feeTooLow ? { step: "waiting-for-fees" } : { step: "ready-to-approve" };
    case "failed":
      return { step: "failed", detail: jobFailure(job.error) };
    case "paused": {
      const { canResume, detail } = jobPause(job.error);
      return { step: "paused", detail, canResume };
    }
    default:
      return { step: "searching" };
  }
}

// ---- The SDK's withdrawal intent, as its journal holds it. ----

type Point = { txid: string; vout: number; value: string };
/** The SDK's Withdrawal (qsb-app src/lib/model.ts withdrawalSchema). */
export type Manifest = {
  vaultId: string;
  funding: Point;
  helper?: Point;
  destination: string;
  outputScript: string;
  outputValue: string;
  fee: string;
  idempotencyKey: string;
  costAccepted: true;
  solverReleaseId?: string;
};

/** The SDK's journal key for a vault's intent: `qsb-intent:${NETWORK_ID}:${scriptHash}`; QSB is mainnet only. */
export const intentKey = (scriptHash: string) => `qsb-intent:mainnet:${scriptHash}`;

/**
 * The SDK's journal value for an intent: JSON.stringify(canonicalManifest(manifest)), where
 * canonicalManifest re-parses with withdrawalSchema, so keys come in the schema's order and absent
 * optional ones are left out. The service's manifestHash is SHA-256 over the same text, so a match
 * proves this is exactly what the SDK wrote.
 */
export function canonicalIntent(m: Manifest): string {
  const point = (p: Point) => ({ txid: p.txid, vout: p.vout, value: p.value });
  return JSON.stringify({
    vaultId: m.vaultId,
    funding: point(m.funding),
    ...(m.helper !== undefined ? { helper: point(m.helper) } : {}),
    destination: m.destination,
    outputScript: m.outputScript,
    outputValue: m.outputValue,
    fee: m.fee,
    idempotencyKey: m.idempotencyKey,
    costAccepted: m.costAccepted,
    ...(m.solverReleaseId !== undefined ? { solverReleaseId: m.solverReleaseId } : {}),
  });
}

/** The Ledger record's deposit, as the service writes an outpoint (txid in display order). */
export function recordFunding(record: Pick<VaultRecord, "funding">): Point | undefined {
  const f = record.funding;
  return f ? { txid: hex.encode(Uint8Array.from(f.txid).reverse()), vout: f.vout, value: f.value.toString() } : undefined;
}

const samePoint = (a: Point, b: Point) => a.txid.toLowerCase() === b.txid.toLowerCase() && a.vout === b.vout && BigInt(a.value) === BigInt(b.value);

/** True when the Ledger recorded a deposit for this vault and QSB's is a different one. */
export function fundingDiffers(record: Pick<VaultRecord, "funding">, funding: Point | undefined): boolean {
  const recorded = recordFunding(record);
  return !!recorded && (!funding || !samePoint(recorded, funding));
}

/**
 * Why this browser may not take over a withdrawal started elsewhere (undefined when it may): the
 * job's manifest must hash to its manifestHash, spend QSB's recorded deposit of this vault, and
 * match the Ledger's record (allocated, or exposed with that same deposit).
 */
export function reclaimProblem(
  record: Pick<VaultRecord, "state" | "funding">,
  vault: { id: string; funding?: Point },
  job: { id: string; manifest: Manifest; manifestHash: string },
): string | undefined {
  const blocked = (why: string) => `This withdrawal was started in another browser, and ${why} So this page won't ask your Ledger to approve it. ${SAFE} ${OPERATOR}`;
  const m = job.manifest;
  if (hex.encode(sha256(new TextEncoder().encode(canonicalIntent(m)))) !== job.manifestHash.toLowerCase())
    return blocked("QSB's copy of it doesn't check out.");
  if (m.vaultId !== vault.id || m.idempotencyKey !== job.id) return blocked("it belongs to another vault.");
  if (!vault.funding || !samePoint(m.funding, vault.funding)) return blocked("it doesn't spend this vault's deposit.");
  const recorded = recordFunding(record);
  if (record.state === "allocated" && (!recorded || samePoint(recorded, m.funding))) return undefined;
  if (record.state === "exposed" && recorded && samePoint(recorded, m.funding)) return undefined;
  return blocked("your Ledger's record of this vault doesn't match it.");
}

// ---- The SDK's stores, in this browser. ----

type KeyValue = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const browserStorage = (): KeyValue | undefined => {
  try {
    return globalThis.localStorage ?? undefined;
  } catch {
    return undefined;
  }
};

const CANT_SAVE = "This browser can't save what QSB needs. Allow this site to store data (not in a private window), then try again.";

/** Asks the browser not to evict this site's storage (best effort; it may say no or not ask). */
const requestPersistence = () => {
  try {
    void globalThis.navigator?.storage?.persist?.().catch(() => {});
  } catch {
    // Not offered here.
  }
};

/**
 * The SDK's one-time authorization journal, in localStorage. The SDK asks for a store that is
 * durable and shared by every device using the vault; localStorage is per browser and is lost with
 * the site's data. So: the first write asks the browser to keep the site's storage
 * (navigator.storage.persist), and a withdrawal whose intent this browser lost is taken back from
 * QSB's job, only when it checks out exactly (see reclaimProblem). The Ledger itself records the
 * one disclosure a vault allows and refuses a second, different one.
 */
export function localJournal(storage: () => KeyValue | undefined = browserStorage, persist: () => void = requestPersistence): AuthorizationStore {
  let persisted = false;
  const key = (k: string) => `qsb-journal:${k}`;
  const read = (k: string) => {
    try {
      const s = storage();
      if (!s) throw new Error("no storage");
      return s.getItem(key(k)) ?? undefined;
    } catch (cause) {
      throw new Plain(CANT_SAVE, { cause });
    }
  };
  return {
    async get(k) {
      return read(k);
    },
    async claim(k, value) {
      const existing = read(k);
      if (existing !== undefined) {
        if (existing === value) return;
        throw new Plain("This vault is already set to a different withdrawal. Finish that one instead.");
      }
      try {
        storage()!.setItem(key(k), value);
      } catch (cause) {
        throw new Plain(CANT_SAVE, { cause });
      }
      if (read(k) !== value) throw new Plain(CANT_SAVE);
      if (!persisted) {
        persisted = true;
        persist();
      }
    },
  };
}

/**
 * Signed deposits waiting for the miner, in localStorage (with a copy in memory if storage fails),
 * so that a retry can only resend those bytes. The service keeps them too (deposits.resubmit).
 */
export function localPendingDeposits(storage: () => KeyValue | undefined = browserStorage): PendingDeposits {
  const key = (id: string) => `qsb-pending:${id}`;
  const memory = new Map<string, PendingDeposit>();
  return {
    async get(id) {
      try {
        const raw = storage()?.getItem(key(id));
        if (raw) return JSON.parse(raw) as PendingDeposit;
      } catch {
        // Fall back to this page's copy.
      }
      return memory.get(id);
    },
    async set(id, deposit) {
      memory.set(id, deposit);
      try {
        storage()?.setItem(key(id), JSON.stringify(deposit));
      } catch {
        // Kept in memory; the service holds the same bytes for deposits.resubmit.
      }
    },
    async delete(id) {
      memory.delete(id);
      try {
        storage()?.removeItem(key(id));
      } catch {
        // Nothing to do.
      }
    },
  };
}

// ---- The SDK's wallet: vault v's deposit key on the Ledger. ----

/**
 * The SDK's Signer for vault `v`'s deposit address. It signs only a sweep into the vault: every
 * input, exactly one output; the Ledger checks the output is the vault's script. Never broadcasts.
 */
export function sweepSigner(device: Pick<Device, "use">, v: number, deposit: { address: string; publicKey: Uint8Array }, say: () => Say): Signer {
  return {
    address: deposit.address,
    publicKey: hex.encode(deposit.publicKey),
    async signPsbt(address, psbt, inputs) {
      if (address !== deposit.address) throw new Error("This deposit is for another address.");
      const tx = Transaction.fromPSBT(base64.decode(psbt), { allowUnknownInputs: true, allowUnknownOutputs: true });
      if (tx.outputsLength !== 1)
        throw new Plain("Your Ledger only moves everything at the deposit address into the vault, with no change. Try the deposit again.");
      if (tx.inputsLength < 1 || tx.inputsLength > MAX_SWEEP_INPUTS) throw new Error("A sweep has 1 to 8 inputs.");
      if (inputs.length !== tx.inputsLength || inputs.some((i, k) => i !== k)) throw new Error("A sweep signs every input.");
      const previous = Array.from({ length: tx.inputsLength }, (_, i) => {
        const prev = tx.getInput(i).nonWitnessUtxo;
        if (!prev) throw new Error("The deposit is missing an input's previous transaction.");
        return RawTx.encode(prev);
      });
      const unsigned = tx.unsignedTx;
      const signatures = await device.use(HINT.deposit, say(), (app) => app.signSweep(v, unsigned, previous));
      if (signatures.length !== tx.inputsLength) throw new Error("The Ledger returned the wrong number of signatures.");
      signatures.forEach((signature, i) => tx.updateInput(i, { partialSig: [[deposit.publicKey, signature]] }));
      return base64.encode(tx.toPSBT());
    },
  };
}

// ---- Errors. ----

const VAULT_REFUSED: Record<string, string> = {
  vault_secrets_reused: "QSB already has a vault with this vault's secrets. Create a new vault.",
  vault_script_registered: "Another QSB vault already uses this vault's script. Create a new vault.",
  vault_script_paid: "This vault's script was already paid on chain. Create a new vault.",
};

const FEES_TOO_HIGH =
  "Network fees are higher right now than this withdrawal pays, so it can't be sent yet. It can be sent once fees drop; this page checks by itself. Your bitcoin is safe in the vault, and nothing was asked of your Ledger.";

/** A Plain error for anything that went wrong, with the original kept as `cause`. */
function plain(error: unknown, fallback: string): Plain {
  if (error instanceof Plain) return error;
  if (error instanceof ApiRequestError) {
    if (error.code && VAULT_REFUSED[error.code]) return new Plain(VAULT_REFUSED[error.code], { cause: error });
    if (error.code === "reconcile_required" || error.code === "operator_review_required")
      return new Plain(`This needs QSB's operator before it can go on. ${SAFE}`, { cause: error });
    if (error.status === 401) return new Plain("Your QSB sign-in expired. Try again.", { cause: error });
    if (error.status === 403) return new Plain("QSB isn't open to this vault right now. Try again later.", { cause: error });
    if (error.status === 429) return new Plain("QSB is busy. Try again in a minute.", { cause: error });
  }
  const message = error instanceof Error ? error.message : "";
  if (error instanceof TypeError && /fetch|network|load/i.test(message))
    return new Plain("Couldn't reach QSB. Check your internet connection and try again.", { cause: error });
  if (/insufficient funds/i.test(message))
    return new Plain("There isn't enough at the deposit address to pay the network fee.", { cause: error });
  // A withdrawal's POST may have reached the miner (SDK submitWithdrawal; server/submit-exact.ts).
  if (/submission outcome is uncertain/i.test(message))
    return new Plain(
      "Your withdrawal may have been sent. QSB is checking, and this page will update by itself. If it asks you to approve again, that's safe: exactly the same transaction is sent.",
      { cause: error },
    );
  if (/spent by a different transaction/i.test(message))
    return new Plain(`The vault's bitcoin was spent by a different transaction. Don't approve anything else. ${OPERATOR}`, { cause: error });
  if (/below MARA's current minimum/i.test(message)) return new Plain(FEES_TOO_HIGH.replace(", and nothing was asked of your Ledger", ""), { cause: error });
  if (/fee quote is unavailable/i.test(message)) return new Plain("The network fee couldn't be checked. Try again in a moment.", { cause: error });
  if (/switched off|disabled/i.test(message)) return new Plain("QSB isn't taking transactions right now. Try again later.", { cause: error });
  if (/submission to MARA isn't confirmed/i.test(message))
    return new Plain("Your deposit is signed, but QSB couldn't confirm it was sent. Try again: the same deposit is resent.", { cause: error });
  return new Plain(fallback, { cause: error });
}

// ---- The backend. ----

type PublicVault = Parameters<ExternalCustody["confirmVault"]>[0];
/** The parts of QsbClient this backend uses. */
export type QsbClientLike = Pick<QsbClient, "utxos" | "rates" | "vaults" | "deposits" | "withdrawals">;
type Job = Awaited<ReturnType<QsbClient["withdrawals"]["list"]>>[number];

/** Vault v as this page knows it. */
type Current = {
  v: number;
  /** The Ledger's record of the vault, as last read. */
  record: VaultRecord;
  fingerprint: string;
  scriptHash: string;
  address: string;
  signer: Signer;
  client: QsbClientLike;
  /** The device's vault (commitments, script), read once when custody needs it. */
  deviceVault?: DeviceVault;
  /** The service's vault: undefined until looked up, null when the service doesn't have it. */
  serviceVault?: PublicVault | null;
};

export type LedgerBackendOptions = {
  /** The QSB service's origin; defaults to config.api. */
  api?: string;
  storage?: () => KeyValue | undefined;
  fetch?: typeof fetch;
  /** Makes the SDK client (tests); defaults to `new QsbClient(options)`. */
  client?: (options: QsbClientOptions) => QsbClientLike;
  /** Asks the browser to keep this site's storage; defaults to navigator.storage.persist. */
  persist?: () => void;
  /** Clock, in ms (tests). */
  now?: () => number;
  /** Where a refund is broadcast (POST, raw hex as text); defaults to config.broadcastUrl. */
  broadcastUrl?: string;
};

/** A submitted withdrawal's status is checked at most this often (the webapp's own pace, docs/API.md). */
const STATUS_MS = 60_000;

export function ledgerBackend(device: Device, options: LedgerBackendOptions = {}): Backend {
  let say: Say = () => {};
  const currentSay = () => say;
  const now = options.now ?? Date.now;
  const journal = localJournal(options.storage, options.persist);
  const pending = localPendingDeposits(options.storage);
  const sessions = new Map<string, { token: string; at: number }>();
  /** A sign-in in progress, by address: concurrent requests share it (one SIGN_IN on the Ledger). */
  const signingIn = new Map<string, Promise<string>>();
  const known = new Map<number, Current>();
  /** A signed withdrawal not yet accepted, by job: a retry resends these bytes. */
  const signed = new Map<string, SignedWithdrawal>();
  /** What QSB last said about a submitted withdrawal, by job. */
  const observed = new Map<string, { at: number; status?: string; alert?: unknown }>();
  /** Vaults whose pending deposit this page already resent on its own (once per session). */
  const resent = new Set<string>();
  /** The miner's refusal of a vault's last deposit, by vault, until a deposit goes through. */
  const rejected = new Map<string, string>();
  const makeClient = options.client ?? ((o: QsbClientOptions) => new QsbClient(o));
  /** Signed refunds by deposit address: a retry resends these bytes; dropped once their inputs are spent. */
  const refunds = localRefunds(options.storage);

  const fetcher: typeof fetch = (input, init) => (options.fetch ?? globalThis.fetch)(input, { ...init, redirect: "error" });
  let api: Promise<string> | undefined;
  const origin = () => (api ??= options.api !== undefined ? Promise.resolve(options.api) : import("../env").then((m) => m.config.api));
  let broadcastTo: Promise<string> | undefined;
  const broadcastUrl = () =>
    (broadcastTo ??= options.broadcastUrl !== undefined ? Promise.resolve(options.broadcastUrl) : import("../env").then((m) => m.config.broadcastUrl));

  // One call at a time: each owns the Ledger and `say` until it finishes.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(hint: Say, fallback: string, work: () => Promise<T>): Promise<T> => {
    const run = queue.then(async () => {
      say = hint;
      try {
        return await work();
      } catch (error) {
        throw plain(error, fallback);
      } finally {
        say("");
        say = () => {};
      }
    });
    queue = run.catch(() => {});
    return run;
  };

  /** A POST to the QSB service; with `token`, as the signed-in deposit address. */
  const post = async <T>(path: string, body: unknown, token?: string): Promise<T> => {
    const json = JSON.stringify(body);
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json)));
    const response = await fetcher(`${(await origin()).replace(/\/$/, "")}/v1${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        // CloudFront needs the body's hash on every POST to the QSB service.
        "x-amz-content-sha256": hex.encode(digest),
        ...(token ? { "X-Qsb-Authorization": `Bearer ${token}` } : {}),
      },
      body: json,
    });
    if (!response.ok) {
      if (!token) throw new Plain("Couldn't sign in to QSB. Try again in a moment.");
      const answer = (await response.json().catch(() => ({}))) as { code?: string; error?: string; message?: string };
      throw new ApiRequestError(answer.message ?? answer.error ?? `QSB answered ${response.status}.`, response.status, answer.code);
    }
    return (await response.json()) as T;
  };

  const credentials = (v: number, address: string): Credentials => ({
    get() {
      const session = sessions.get(address);
      if (session && now() - session.at < SESSION_MS) return Promise.resolve(session.token);
      // Two requests at once (e.g. utxos and vaults.list) share one sign-in: the Ledger does one thing at a time.
      let flight = signingIn.get(address);
      if (!flight) {
        flight = (async () => {
          const challenge = await post<{ id: string; message: string }>("/auth/challenge", { address });
          const { signature, address: signedAs } = await device.signIn(v, challenge.message, currentSay());
          if (signedAs !== address) throw new Error("The Ledger signed in as another address.");
          const { token } = await post<{ token: string }>("/auth/verify", { id: challenge.id, signature });
          sessions.set(address, { token, at: now() });
          return token;
        })().finally(() => signingIn.delete(address));
        signingIn.set(address, flight);
      }
      return flight;
    },
  });

  const deviceVaultOf = async (c: Current) =>
    (c.deviceVault ??= await device.use(HINT.read, currentSay(), (app) => readDeviceVault(app, c.v)));

  const custody = (c: Current): ExternalCustody => ({
    async confirmVault(vault) {
      if (c.record.state === "retired") throw new Plain("This vault was retired on your Ledger.");
      const dv = await deviceVaultOf(c);
      if (vault.scriptHex.toLowerCase() !== hex.encode(dv.script)) throw new Plain("This vault doesn't match the one on your Ledger.");
    },
    async authorizeWithdrawal(request: WithdrawalSigningRequest) {
      const dv = await deviceVaultOf(c);
      return device.use(HINT.withdraw, currentSay(), (app) => authorizeOnDevice(app, dv, request));
    },
  });

  /** The client for vault `record.v`, whose wallet is its deposit address. */
  const open = async (app: PqbApp, record: VaultRecord): Promise<Current> => {
    const { v } = record;
    const cached = known.get(v);
    if (cached && cached.scriptHash === hex.encode(record.scriptHash)) {
      cached.record = record;
      return cached;
    }
    const deposit = await app.getDepositAddress(v);
    const signer = sweepSigner(device, v, deposit, currentSay);
    const c: Current = {
      v,
      record,
      fingerprint: fingerprint(record.root),
      scriptHash: hex.encode(record.scriptHash),
      address: deposit.address,
      signer,
      client: undefined as unknown as QsbClientLike,
    };
    c.client = makeClient({
      baseUrl: await origin(),
      signer,
      custody: custody(c),
      authorizations: journal,
      credentials: credentials(v, deposit.address),
      pendingDeposits: pending,
      fetch: fetcher,
    });
    known.set(v, c);
    return c;
  };

  /** The newest vault on the Ledger that isn't retired, or null. */
  const discover = (): Promise<Current | null> =>
    device.use(HINT.read, currentSay(), async (app) => {
      const records = (await app.getRecords()).filter((r) => r.state !== "retired").sort((a, b) => b.v - a.v);
      const r = records[0];
      return r ? open(app, r) : null;
    });

  /** Runs `work` with c's client, signing in again once if the session expired. */
  const withClient = async <T>(c: Current, work: (client: QsbClientLike) => Promise<T>): Promise<T> => {
    try {
      return await work(c.client);
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 401)) throw error;
      sessions.delete(c.address);
      return work(c.client);
    }
  };

  const serviceVault = async (c: Current) => {
    const { vaults } = await withClient(c, (q) => q.vaults.list());
    c.serviceVault = vaults.find((x) => x.config === "PQB" && x.scriptHash === c.scriptHash) ?? null;
    return c.serviceVault;
  };

  /** Registers c with the service: the user allows the export of its menu points, then it's created. */
  const register = async (c: Current): Promise<PublicVault> => {
    const dv = await deviceVaultOf(c);
    const descriptor = await device.use(HINT.export, currentSay(), async (app) => {
      await app.authorizeMenuPoints(c.v);
      return descriptorFor(app, dv);
    });
    const { vault } = await withClient(c, (q) => q.vaults.create({ name: `Ledger vault #${c.v}`, descriptor }));
    c.serviceVault = vault as PublicVault;
    return c.serviceVault;
  };

  const newestJob = async (c: Current, vaultId: string): Promise<Job | undefined> =>
    (await withClient(c, (q) => q.withdrawals.list()))
      .filter((j) => j.vaultId === vaultId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];

  /** This browser's saved intent for the vault, or undefined (also when storage can't be read). */
  const savedIntent = async (vault: PublicVault) => {
    try {
      return await journal.get(intentKey(vault.scriptHash));
    } catch {
      return undefined;
    }
  };

  /** Stops before any paid search or Ledger approval when the Ledger recorded another deposit. */
  const assertFunding = (c: Current, vault: PublicVault) => {
    if (fundingDiffers(c.record, vault.funding))
      throw new Plain(
        `The deposit QSB has for this vault isn't the one your Ledger recorded. Nothing was started or signed. ${SAFE} ${OPERATOR.replace(" and mention the reference below", "")}`,
      );
  };

  /**
   * Makes sure this browser's journal holds the job's exact intent, as the SDK needs before it
   * asks the Ledger. One started in another browser (or before site data was cleared) is taken
   * back from QSB's job, only when it checks out against QSB's vault and the Ledger's record.
   */
  const ensureIntent = async (c: Current, vault: PublicVault, job: Job) => {
    const value = canonicalIntent(job.manifest as Manifest);
    const saved = await journal.get(intentKey(vault.scriptHash));
    if (saved !== undefined) {
      if (saved !== value)
        throw new Plain(`This browser has a different withdrawal saved for this vault than the one QSB has. Nothing was signed. ${OPERATOR}`);
      return;
    }
    const problem = reclaimProblem(c.record, vault, job as Parameters<typeof reclaimProblem>[2]);
    if (problem) throw new Plain(problem);
    await journal.claim(intentKey(vault.scriptHash), value);
  };

  /** What QSB says about a submitted withdrawal, at most once a minute. */
  const observe = async (c: Current, job: Job) => {
    const last = observed.get(job.id);
    if (last && now() - last.at < STATUS_MS) return last;
    try {
      const answer = await withClient(c, (q) => q.withdrawals.status(job.id));
      const status = answer.job.status === "confirmed" ? "confirmed" : typeof answer.submissionStatus === "string" ? answer.submissionStatus : undefined;
      const seen = { at: now(), status: status ?? last?.status, alert: answer.alert };
      observed.set(job.id, seen);
      return seen;
    } catch {
      return last;
    }
  };

  const needCurrent = async () => {
    const c = await discover();
    if (!c) throw new Plain("There's no vault on this Ledger yet. Create one first.");
    return c;
  };

  const byValue = <T extends { value: string }>(utxos: T[]) =>
    [...utxos].sort((a, b) => (BigInt(b.value) > BigInt(a.value) ? 1 : BigInt(b.value) < BigInt(a.value) ? -1 : 0));

  /**
   * This address's signed refund, if its inputs are all still at the deposit address; one whose
   * inputs left (confirmed, or spent otherwise) is dropped.
   */
  const liveRefund = (address: string, utxos: Outpoint[]): SignedRefund | undefined => {
    const refund = refunds.get(address);
    if (!refund) return undefined;
    const unspent = new Set(utxos.map(pointKey));
    if (refund.inputs.every((i) => unspent.has(pointKey(i)))) return refund;
    refunds.delete(address);
    return undefined;
  };

  /** The deposit address's outputs, less those a refund already sent spends: they're on their way out. */
  const notRefunded = <T extends Outpoint>(utxos: T[], refund?: SignedRefund) => {
    if (!refund?.broadcast) return utxos;
    const sent = new Set(refund.inputs.map(pointKey));
    return utxos.filter((u) => !sent.has(pointKey(u)));
  };

  /** The deposit address's previous transaction for `utxo`, from the service, checked against it. */
  const previousTx = async (c: Current, depositScript: Uint8Array, utxo: Outpoint & { value: string }) => {
    const ask = async () =>
      post<{ previousTxHex: string }>("/payment-input", { txid: utxo.txid, vout: utxo.vout, value: utxo.value }, await credentials(c.v, c.address).get());
    let answer: { previousTxHex: string };
    try {
      answer = await ask();
    } catch (error) {
      if (!(error instanceof ApiRequestError && error.status === 401)) throw error;
      sessions.delete(c.address);
      answer = await ask();
    }
    const raw = hex.decode(answer.previousTxHex);
    const prev = Transaction.fromRaw(raw, { allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
    const out = utxo.vout < prev.outputsLength ? prev.getOutput(utxo.vout) : undefined;
    if (prev.id !== utxo.txid.toLowerCase() || !out?.script || out.amount !== BigInt(utxo.value) || hex.encode(out.script) !== hex.encode(depositScript))
      throw new Error(`QSB's previous transaction for ${utxo.txid}:${utxo.vout} doesn't match it.`);
    return { raw, amount: out.amount };
  };

  /** POSTs the raw refund to the broadcast URL; the answer must be its txid. */
  const broadcast = async (refund: SignedRefund) => {
    const resend = "Nothing new needs approving: try again and the same transaction is resent.";
    let response: Response;
    try {
      response = await fetcher(await broadcastUrl(), { method: "POST", headers: { "content-type": "text/plain" }, body: refund.hex });
    } catch (cause) {
      throw new Plain(`Couldn't reach the Bitcoin network to send it back. Check your connection. ${resend}`, { cause });
    }
    const text = (await response.text().catch(() => "")).trim();
    if (!response.ok) {
      // Sent before (this page lost the answer): it's out there already.
      if (/already in (block ?chain|mempool)|txn-already-(known|in-mempool)/i.test(text)) return;
      throw new Plain(`The Bitcoin network didn't take it${text ? ` (${text.slice(0, 160)})` : ""}. ${resend}`, {
        cause: new Error(`Broadcast answered ${response.status}: ${text}`),
      });
    }
    if (text.toLowerCase() !== refund.txid)
      throw new Plain(`The broadcast answered with a different transaction than the one you approved. ${resend}`, {
        cause: new Error(`Broadcast answered ${text}, expected ${refund.txid}.`),
      });
  };

  return {
    snapshot: (s) =>
      serial(s, "Couldn't read your vault. Try again in a moment.", async (): Promise<Snapshot> => {
        const c = await discover();
        if (!c) return { vault: null };
        // Both may need a sign-in: they share one (see credentials).
        const [allUtxos, vault] = await Promise.all([withClient(c, (q) => q.utxos()), serviceVault(c)]);
        const refund = liveRefund(c.address, allUtxos);
        const utxos = notRefunded(allUtxos, refund);
        const waitingSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
        const sweepable = byValue(utxos).slice(0, MAX_SWEEP_INPUTS);
        const sweepableSats = sweepable.reduce((sum, u) => sum + BigInt(u.value), 0n);
        let waiting = vault ? await pending.get(vault.id) : undefined;
        if (vault && waiting && vault.status === "unfunded" && !resent.has(vault.id)) {
          // A signed deposit whose sending wasn't confirmed: resend the same bytes (no Ledger
          // needed), once per session; after that the user's "Move it" button resends it.
          resent.add(vault.id);
          const answer = await withClient(c, (q) => q.deposits.resubmit(vault.id)).catch(() => undefined);
          if (answer) {
            c.serviceVault = answer.vault;
            if (answer.submission === "rejected") rejected.set(vault.id, answer.reason ?? "");
            waiting = await pending.get(vault.id);
          }
        }
        const current = c.serviceVault ?? null;
        const funded = !!current && current.status !== "unfunded";
        const job = funded ? await newestJob(c, current.id) : undefined;
        const needRates = !funded || job?.status === "awaiting_authorization" || utxos.length > 0;
        const rates = needRates ? await withClient(c, (q) => q.rates()) : undefined;
        const minimumSats =
          !funded && rates ? minimumDeposit(current ? current.scriptHex.length / 2 : SCRIPT_LEN, minerRate(rates), sweepable.length) : undefined;
        const intent = funded && current ? await savedIntent(current) : undefined;
        const fromElsewhere = !!job && intent === undefined;
        const submission = job && (job.status === "submitted" || job.status === "confirmed") ? await observe(c, job) : undefined;
        const { step, detail, canResume } = vaultStep({
          vault: current,
          pendingDeposit: !!waiting,
          waitingSats,
          sweepableSats,
          minimumSats,
          depositRejected: current ? rejected.get(current.id) : undefined,
          job,
          savedIntent: intent !== undefined,
          fundingMismatch: !!current && funded && fundingDiffers(c.record, current.funding),
          feeTooLow: job?.status === "awaiting_authorization" && !!rates && intentRate(job.manifest) < minerFloor(rates),
          reclaimProblem:
            job?.status === "awaiting_authorization" && current && fromElsewhere
              ? reclaimProblem(c.record, current, job as Parameters<typeof reclaimProblem>[2])
              : undefined,
          submission,
        });
        const savedDestination = !job && intent !== undefined ? (JSON.parse(intent) as Manifest).destination : undefined;
        const withdrawn = (job?.status === "submitted" || job?.status === "confirmed") && job.txid;
        // After the deposit confirmed, anything at the deposit address arrived later or didn't fit the sweep.
        const leftoverSats = current && (current.status === "confirmed" || current.status === "spent") && waitingSats > 0n ? waitingSats : undefined;
        // While a deposit is pending, nothing is refundable: a refund would spend its inputs.
        const refundable =
          step === "depositing" || !rates
            ? []
            : refundableUtxos(utxos, [...(waiting ? spentBy(waiting.rawTxHex) : []), ...(job?.manifest.helper ? [job.manifest.helper] : [])]);
        const refundQuoted = refundable.length ? refundQuote(refundable.map((u) => BigInt(u.value)), LONGEST_REFUND_SCRIPT, minerRate(rates!)) : undefined;
        const refundableSats = refundQuoted && refundQuoted.amount >= DUST ? refundQuoted.total : undefined;
        const view: VaultView = {
          v: c.v,
          fingerprint: c.fingerprint,
          step,
          depositAddress: c.address,
          waitingSats,
          ...(minimumSats !== undefined ? { minimumSats } : {}),
          ...(current?.funding ? { vaultSats: BigInt(current.funding.value) } : {}),
          ...(withdrawn ? { txid: job.txid } : current?.funding ? { txid: current.funding.txid } : waiting ? { txid: waiting.txid } : {}),
          ...(job ? { destination: job.manifest.destination } : savedDestination ? { destination: savedDestination } : {}),
          ...(detail ? { detail } : {}),
          ...(canResume !== undefined ? { canResume } : {}),
          ...(step === "ready-to-approve" && fromElsewhere ? { fromElsewhere: true } : {}),
          ...(leftoverSats !== undefined ? { leftoverSats } : {}),
          ...(refundableSats !== undefined ? { refundableSats } : {}),
          ...(refund?.broadcast ? { refundTxid: refund.txid } : {}),
          ...(job ? { reference: job.id } : current ? { reference: current.id } : {}),
        };
        return { vault: view };
      }),

    createVault: (s) =>
      serial(s, "The vault wasn't created. Try again.", async () => {
        // Finish an interrupted registration (seen by the last snapshot) instead of creating another vault.
        const last = await discover();
        if (last && last.serviceVault === null) {
          await register(last);
          return;
        }
        const { v } = await device.use(HINT.create, s, (app) => app.allocate());
        const c = await device.use(HINT.read, s, async (app) => {
          const record = (await app.getRecords()).find((r) => r.v === v);
          if (!record) throw new Error("The Ledger didn't keep the new vault.");
          return open(app, record);
        });
        await register(c);
      }),

    showDepositAddress: (s) =>
      serial(s, "Couldn't show the address. Try again.", async () => {
        const c = await needCurrent();
        const shown = await device.use(HINT.address, s, (app) => app.getDepositAddress(c.v, true));
        if (shown.address !== c.address) throw new Plain("Your Ledger showed a different address. Don't use this one; reconnect and try again.");
      }),

    deposit: (s) =>
      serial(s, "The deposit didn't go through. Try again in a moment.", async () => {
        const c = await needCurrent();
        const vault = (await serviceVault(c)) ?? (await register(c));
        const refused = (reason?: string) => {
          rejected.set(vault.id, reason ?? "");
          return new Plain(`The deposit wasn't accepted${reason ? `: ${reason}` : "."} Nothing left the deposit address. Try again.`);
        };
        if (await pending.get(vault.id)) {
          const answer = await withClient(c, (q) => q.deposits.resubmit(vault.id));
          if (answer.submission === "rejected") throw refused(answer.reason);
          rejected.delete(vault.id);
          return;
        }
        if (vault.status !== "unfunded" || vault.funding) throw new Plain("This vault already has its deposit.");
        const all = await withClient(c, (q) => q.utxos());
        const utxos = byValue(notRefunded(all, liveRefund(c.address, all))).slice(0, MAX_SWEEP_INPUTS);
        if (!utxos.length) throw new Plain("There's no confirmed bitcoin at the deposit address yet.");
        const rate = minerRate(await c.client.rates());
        const quote = sweepQuote(
          utxos.map((u) => BigInt(u.value)),
          vault.scriptHex.length / 2,
          rate,
        );
        // What the vault will hold, after this sweep's real fee, must cover its withdrawal later.
        if (quote.amount < withdrawalReserve(rate))
          throw new Plain("There isn't enough at the deposit address yet: the vault must be able to pay its withdrawal fee later. Send more to the same address.");
        const prepared = await withClient(c, (q) =>
          q.deposits.prepare(vault.id, {
            amount: quote.amount,
            feeRate: feeRateText(rate),
            utxos: utxos.map(({ txid, vout }) => ({ txid, vout })),
          }),
        );
        const outputs = Transaction.fromPSBT(base64.decode(prepared.psbt), { allowUnknownInputs: true, allowUnknownOutputs: true }).outputsLength;
        if (prepared.change !== "0" || outputs !== 1 || prepared.amount !== quote.amount.toString() || prepared.serviceFee)
          throw new Plain("QSB proposed a deposit your Ledger can't sign (it must move everything, with no change). Nothing was sent.");
        const signedPsbt = await c.signer.signPsbt(c.address, prepared.psbt, prepared.signInputs);
        const sent = await withClient(c, (q) => q.deposits.submit(prepared, signedPsbt, { costAccepted: true }));
        c.serviceVault = sent.vault;
        if (sent.submission === "rejected") throw refused(sent.reason);
        rejected.delete(vault.id);
      }),

    withdraw: (destination, s) =>
      serial(s, "The withdrawal didn't start. Try again in a moment.", async () => {
        const to = destination.trim();
        let script: Uint8Array;
        try {
          script = OutScript.encode(Address(NETWORK).decode(to));
        } catch {
          throw new Plain("That isn't a Bitcoin address. Check it and try again.");
        }
        const c = await needCurrent();
        const vault = await serviceVault(c);
        if (!vault || vault.status !== "confirmed" || !vault.funding) throw new Plain("The vault isn't ready to withdraw from yet.");
        assertFunding(c, vault);
        const job = await newestJob(c, vault.id);
        if (job?.status === "failed") throw new Plain(jobFailure(job.error));
        if (job) throw new Plain("A withdrawal from this vault has already started.");
        const rates = await c.client.rates();
        const saved = await journal.get(intentKey(vault.scriptHash));
        if (saved !== undefined) {
          // This browser saved the intent but QSB has no withdrawal (its creation was cut off):
          // the SDK resumes it only unchanged, with nothing but the vault.
          const intent = JSON.parse(saved) as Manifest;
          if (intent.destination !== to)
            throw new Plain(`This vault is already set to withdraw to ${intent.destination}. Start that withdrawal instead.`);
          if (intentRate(intent) < minerFloor(rates)) throw new Plain(FEES_TOO_HIGH);
          await withClient(c, (q) => q.withdrawals.create({ vaultId: vault.id, costAccepted: true }));
          return;
        }
        const rate = withdrawalQuoteRate(minerRate(rates), BigInt(vault.funding.value), script.length);
        await withClient(c, (q) => q.withdrawals.create({ vaultId: vault.id, destination: to, feeRate: feeRateText(rate), costAccepted: true }));
      }),

    resumeWithdrawal: (s) =>
      serial(s, "The search didn't continue. Try again in a moment.", async () => {
        const c = await needCurrent();
        const vault = await serviceVault(c);
        const job = vault && (await newestJob(c, vault.id));
        if (!job || job.status !== "paused") return;
        if (!jobPause(job.error).canResume) throw new Plain(jobPause(job.error).detail);
        await withClient(c, (q) => q.withdrawals.resume(job.id));
      }),

    finishWithdrawal: (s) =>
      serial(s, "The withdrawal wasn't sent. Try again in a moment.", async () => {
        const c = await needCurrent();
        const vault = await serviceVault(c);
        const job = vault && (await newestJob(c, vault.id));
        if (!vault || !job) throw new Plain("There's no withdrawal to finish.");
        if (job.status === "submitted" || job.status === "confirmed") return;
        let result = signed.get(job.id);
        if (!result) {
          if (job.status !== "awaiting_authorization") throw new Plain("The search isn't done yet.");
          assertFunding(c, vault);
          // The Ledger signs once, with no fee bump: don't ask it unless the fee can be sent now.
          if (intentRate(job.manifest) < minerFloor(await c.client.rates())) throw new Plain(FEES_TOO_HIGH);
          await ensureIntent(c, vault, job);
          result = await withClient(c, (q) => q.withdrawals.assemble(job.id));
          // Kept so a retry after a failed send resends these bytes instead of asking the Ledger again.
          signed.set(job.id, result);
        }
        // The user approved this exact transaction (outputs and fee) on the Ledger's screen.
        const sent = await withClient(c, (q) => q.withdrawals.submit(result, { approve: (review) => review.txid }));
        signed.delete(job.id);
        // "submitted" means the miner acknowledged it, "uncertain" that it may not have it: the
        // snapshot shows which until QSB's own checks say more.
        observed.set(job.id, { at: now(), status: sent.status });
      }),

    refund: (destination, s) =>
      serial(s, "It wasn't sent back. Try again in a moment.", async () => {
        const to = destination.trim();
        const c = await needCurrent();
        const publicKey = hex.decode(c.signer.publicKey);
        const depositScript = p2wpkh(publicKey, NETWORK).script;
        const vault = await serviceVault(c);
        const script = refundScript(to, { depositScript, vaultScript: vault ? hex.decode(vault.scriptHex) : undefined });
        const all = await withClient(c, (q) => q.utxos());
        let refund = liveRefund(c.address, all);
        if (refund?.broadcast) throw new Plain("It was already sent back. Wait for it to confirm.");
        if (refund && refund.destination !== to)
          throw new Plain(`You already approved sending it back to ${refund.destination}. Send it there: the same transaction is resent.`);
        if (!refund) {
          if (vault && (vault.status === "submitted" || (vault.status === "unfunded" && (await pending.get(vault.id)))))
            throw new Plain("Your deposit is on its way, so nothing can be sent back now. Wait for it to confirm.");
          const job = vault && vault.status !== "unfunded" ? await newestJob(c, vault.id) : undefined;
          const waiting = vault ? await pending.get(vault.id) : undefined;
          const inputs = refundableUtxos(all, [...(waiting ? spentBy(waiting.rawTxHex) : []), ...(job?.manifest.helper ? [job.manifest.helper] : [])]);
          if (!inputs.length) throw new Plain("There's no confirmed bitcoin at the deposit address to send back.");
          const quote = refundQuote(
            inputs.map((u) => BigInt(u.value)),
            script.length,
            minerRate(await withClient(c, (q) => q.rates())),
          );
          if (quote.amount < DUST) throw new Plain("There's too little at the deposit address to pay the network fee and send it back.");
          const previous: { raw: Uint8Array; amount: bigint }[] = [];
          for (const u of inputs) previous.push(await previousTx(c, depositScript, u));
          const tx = new Transaction({ version: 2, lockTime: 0 });
          inputs.forEach((u, i) =>
            tx.addInput({ txid: u.txid, index: u.vout, sequence: 0xfffffffd, witnessUtxo: { script: depositScript, amount: previous[i].amount } }),
          );
          tx.addOutput({ script, amount: quote.amount });
          const signatures = await device.use(HINT.refund, s, (app) => app.signRefund(c.v, tx.unsignedTx, previous.map((p) => p.raw)));
          verifyRefund(tx, publicKey, signatures);
          signatures.forEach((signature, i) => {
            tx.updateInput(i, { partialSig: [[publicKey, signature]] });
            tx.finalizeIdx(i);
          });
          refund = { txid: tx.id, hex: hex.encode(tx.extract()), destination: to, inputs: inputs.map(({ txid, vout }) => ({ txid, vout })), amount: quote.amount.toString(), broadcast: false };
          // Kept before broadcasting, so a retry resends these bytes instead of asking the Ledger again.
          refunds.set(c.address, refund);
        }
        await broadcast(refund);
        refunds.set(c.address, { ...refund, broadcast: true });
        return { txid: refund.txid };
      }),
  };
}
