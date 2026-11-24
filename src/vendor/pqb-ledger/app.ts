import {
  COMMITMENTS,
  MENU_WIDTHS,
  SCRIPT_LEN,
  checkRequest,
  disclosureDigest,
  parseRecord,
  parseReveal,
  vaultScript,
  verifyDisclosure,
  withdrawalTx,
  type DisclosureRequest,
  type DisclosureResponse,
  type StateSummary,
  type VaultRecord,
} from "./pqb.js";
import { concat, equalBytes, parseTx, serializeOutputs, stripWitness, txidInternal, u32be, u32le, type TxOutput } from "./tx.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** APDU class and instructions; see docs/apdu.md. */
export const CLA = 0xe0;
export const INS = {
  GET_VERSION: 0x03,
  GET_APP_NAME: 0x04,
  GET_COMMITMENTS: 0x10,
  GET_VAULT: 0x11,
  GET_SCRIPT: 0x12,
  GET_DEPOSIT_ADDRESS: 0x13,
  GET_STATE: 0x14,
  ALLOCATE: 0x20,
  RETIRE: 0x21,
  SIGN_DEPOSIT: 0x30,
  SIGN_IN: 0x31,
  WITHDRAW: 0x40,
  REVEAL_READ: 0x41,
  MENU_POINTS: 0x42,
} as const;
const DEPOSIT_STEP = { START: 0, INPUT: 1, PREVTX: 2, OUTPUTS: 3, REVIEW: 4, SIGN: 5 } as const;
const WITHDRAW_STEP = { START: 0, PREVTX: 1, OUTPUTS: 2, REVIEW: 3 } as const;
const DEPOSIT_KIND = { sweep: 0x01, refund: 0x02 } as const;
const CHUNK = 255;
/** The longest sign-in challenge the app takes. */
const SIGN_IN_MAX = 512;
const COMMITMENT_CHUNK = 12;
const SCRIPT_CHUNK = 250;
const MENU_POINT_CHUNK = 7;
const SW_OK = 0x9000;
/** The device was showing a status screen and didn't take the command; safe to resend. */
const SW_NOT_ACCEPTED = 0x6901;

/** Status words of docs/apdu.md, by name. */
export const STATUS = {
  REJECTED: 0x6985,
  INVALID_DATA: 0x6a80,
  WRONG_P1P2: 0x6a86,
  WRONG_LENGTH: 0x6a87,
  CONFLICT: 0x6a90,
  NO_DISCLOSURE: 0x6a91,
  STATE_UNREADABLE: 0x6a93,
  STATE_FORBIDS: 0x6a94,
  NO_HISTORY: 0x6a95,
  NO_ROOM: 0x6a96,
  MENU_POINTS_UNAUTHORIZED: 0x6a97,
  UNKNOWN_INS: 0x6d00,
  WRONG_CLA: 0x6e00,
  OUT_OF_ORDER: 0xb001,
  TX_PARSE: 0xb003,
  PREVTX_MISMATCH: 0xb004,
  NOT_DEPOSIT_ADDRESS: 0xb005,
  NOT_VAULT_SCRIPT: 0xb006,
  UNSUPPORTED_LAYOUT: 0xb007,
  OUTPUT_NOT_ADDRESS: 0xb008,
  BAD_AMOUNT: 0xb009,
  SIGNING_FAILED: 0xb00b,
  KEY_DERIVATION_FAILED: 0xb00c,
} as const;
export type StatusName = keyof typeof STATUS;
const STATUS_NAMES = new Map<number, StatusName>(Object.entries(STATUS).map(([k, v]) => [v, k as StatusName]));

/** The device refused a command; `statusWord` and `status` (its name) are in docs/apdu.md. */
export class PqbStatusError extends Error {
  readonly status: StatusName | "UNKNOWN";
  constructor(readonly statusWord: number) {
    const status = STATUS_NAMES.get(statusWord) ?? "UNKNOWN";
    super(`PQB app refused the command: 0x${statusWord.toString(16).padStart(4, "0")} (${status})`);
    this.status = status;
  }
}

/**
 * What the app needs from a transport: one APDU in, the response with its status word out.
 * Adapted to Uint8Array (upstream takes Node Buffers) so it runs in a browser.
 */
export interface ApduTransport {
  send(cla: number, ins: number, p1: number, p2: number, data?: Uint8Array): Promise<Uint8Array>;
}

const statusOf = (error: unknown): number | undefined =>
  typeof error === "object" && error !== null && "statusCode" in error && typeof error.statusCode === "number"
    ? error.statusCode
    : undefined;

/** GET_VAULT `status`. */
export const VAULT_STATUS = ["not-allocated", "allocated", "exposed", "retired", "unknown", "reserved", "no-history"] as const;
export type VaultStatus = (typeof VAULT_STATUS)[number];

export type VaultInfo = { root: Uint8Array; scriptHash: Uint8Array; status: VaultStatus; funded: boolean };

/** A withdrawal to disclose for: the vault output's previous transaction and T's fields. */
export type WithdrawRequest = DisclosureRequest & {
  /** The transaction that created the vault output (witnesses are stripped before streaming). */
  prevTx: Uint8Array;
  vout: number;
  version: number;
  sequence: number;
  lockTime: number;
  outputs: TxOutput[];
};

export type WithdrawResult = DisclosureResponse & {
  /** T: the withdrawal with an empty scriptSig. Keep it: a retry must send these exact bytes. */
  transaction: Uint8Array;
  /** B = SHA256(T). */
  binding: Uint8Array;
  /** D, as the device recorded it. */
  digest: Uint8Array;
};

const checkVault = (v: number) => {
  if (!Number.isInteger(v) || v < 0 || v >= 2 ** 31) throw new Error(`Invalid vault index: ${v}`);
};

/** Thin wrapper over the PQB app's APDUs. */
export class PqbApp {
  constructor(private readonly transport: ApduTransport) {}

  /**
   * Send one APDU and return its data, throwing PqbStatusError unless the app
   * answered 0x9000 (whether or not the transport checks). A command sent while
   * a status screen is up is refused with 0x6901 without being processed, so it
   * is resent.
   */
  async exchange(ins: number, p1: number, data: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    for (let attempt = 0; ; attempt++) {
      let response: Uint8Array;
      try {
        response = await this.transport.send(CLA, ins, p1, 0x00, data);
      } catch (error) {
        const sw = statusOf(error);
        if (sw === SW_NOT_ACCEPTED && attempt < 20) {
          await new Promise((r) => setTimeout(r, 250));
          continue;
        }
        if (sw !== undefined) throw new PqbStatusError(sw);
        throw error;
      }
      if (response.length < 2) throw new Error("Truncated APDU response.");
      const sw = (response[response.length - 2] << 8) | response[response.length - 1];
      if (sw === SW_NOT_ACCEPTED && attempt < 20) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (sw !== SW_OK) throw new PqbStatusError(sw);
      return new Uint8Array(response.subarray(0, response.length - 2));
    }
  }

  /** App version and the derivation profile it implements (`PQB-v1`). */
  async getVersion(): Promise<{ version: string; profile: string }> {
    const r = await this.exchange(INS.GET_VERSION, 0);
    if (r.length < 4) throw new Error("Unexpected GET_VERSION response.");
    return { version: `${r[0]}.${r[1]}.${r[2]}`, profile: new TextDecoder().decode(r.subarray(3)) };
  }

  async getAppName(): Promise<string> {
    return new TextDecoder().decode(await this.exchange(INS.GET_APP_NAME, 0));
  }

  /** The 154 commitments of vault `v`, in root order. Read-only: not proof the vault is safe to fund. */
  async getCommitments(v: number): Promise<Uint8Array[]> {
    checkVault(v);
    const out: Uint8Array[] = [];
    for (let start = 0; start < COMMITMENTS; start += COMMITMENT_CHUNK) {
      const count = Math.min(COMMITMENT_CHUNK, COMMITMENTS - start);
      const r = await this.exchange(INS.GET_COMMITMENTS, 0, concat(u32be(v), Uint8Array.of(start, count)));
      if (r.length !== 20 * count) throw new Error("Unexpected GET_COMMITMENTS response.");
      for (let i = 0; i < count; i++) out.push(r.slice(20 * i, 20 * i + 20));
    }
    return out;
  }

  /** Root, script hash and status of vault `v`; with `display`, after the user has seen it on the device. */
  async getVault(v: number, display = false): Promise<VaultInfo> {
    checkVault(v);
    const r = await this.exchange(INS.GET_VAULT, display ? 1 : 0, u32be(v));
    if (r.length !== 66 || r[64] >= VAULT_STATUS.length) throw new Error("Unexpected GET_VAULT response.");
    return { root: r.slice(0, 32), scriptHash: r.slice(32, 64), status: VAULT_STATUS[r[64]], funded: r[65] === 1 };
  }

  /** The vault's 4,696-byte locking script. */
  async getScript(v: number): Promise<Uint8Array> {
    checkVault(v);
    const parts: Uint8Array[] = [];
    for (let offset = 0; offset < SCRIPT_LEN; offset += SCRIPT_CHUNK) {
      const r = await this.exchange(INS.GET_SCRIPT, 0, concat(u32be(v), Uint8Array.of(offset >> 8, offset & 0xff)));
      if (r.length !== Math.min(SCRIPT_CHUNK, SCRIPT_LEN - offset)) throw new Error("Unexpected GET_SCRIPT response.");
      parts.push(r);
    }
    return concat(...parts);
  }

  /** The P2WPKH deposit address of vault `v`; with `display`, shown on the device for comparison. */
  async getDepositAddress(v: number, display = false): Promise<{ publicKey: Uint8Array; address: string }> {
    checkVault(v);
    const r = await this.exchange(INS.GET_DEPOSIT_ADDRESS, display ? 1 : 0, u32be(v));
    if (r.length < 34 || r.length !== 34 + r[33]) throw new Error("Unexpected GET_DEPOSIT_ADDRESS response.");
    return { publicKey: r.slice(0, 33), address: new TextDecoder().decode(r.subarray(34)) };
  }

  /** The seed's namespace summary. */
  async getState(): Promise<StateSummary> {
    const r = await this.exchange(INS.GET_STATE, 0);
    if (r.length !== 23) throw new Error("Unexpected GET_STATE response.");
    const view = new DataView(r.buffer, r.byteOffset, r.byteLength);
    return { walletId: r.slice(0, 16), namespace: r[16], nextV: view.getUint32(17), records: r[21], capacity: r[22] };
  }

  /** The `i`-th record of this seed. */
  async getRecord(i: number): Promise<VaultRecord> {
    return parseRecord(await this.exchange(INS.GET_STATE, 1, Uint8Array.of(i)));
  }

  /** All of this seed's records. */
  async getRecords(): Promise<VaultRecord[]> {
    const { records } = await this.getState();
    const out: VaultRecord[] = [];
    for (let i = 0; i < records; i++) out.push(await this.getRecord(i));
    return out;
  }

  /** Reserve the next vault index (the user approves on the device). */
  async allocate(): Promise<{ v: number; root: Uint8Array; scriptHash: Uint8Array }> {
    const r = await this.exchange(INS.ALLOCATE, 0);
    if (r.length !== 68) throw new Error("Unexpected ALLOCATE response.");
    return { v: new DataView(r.buffer, r.byteOffset).getUint32(0), root: r.slice(4, 36), scriptHash: r.slice(36, 68) };
  }

  /** Retire vault `v` for good (the user approves on the device). */
  async retire(v: number): Promise<void> {
    checkVault(v);
    await this.exchange(INS.RETIRE, 0, u32be(v));
  }

  /** Sign the sweep that funds vault `v`; returns `DER || 0x01` per input. */
  signSweep(v: number, unsignedTx: Uint8Array, previousTxs: Uint8Array[]): Promise<Uint8Array[]> {
    return this.signDeposit("sweep", v, unsignedTx, previousTxs);
  }

  /** Sign a refund from vault `v`'s deposit address; returns `DER || 0x01` per input. */
  signRefund(v: number, unsignedTx: Uint8Array, previousTxs: Uint8Array[]): Promise<Uint8Array[]> {
    return this.signDeposit("refund", v, unsignedTx, previousTxs);
  }

  /**
   * Sign a QSB sign-in challenge (`POST /v1/auth/challenge`) as vault `v`'s
   * deposit address, after the user approves it on the device. The app signs
   * only that template, for that address. Returns the signature
   * (`DER || 0x01`) and the BIP-322 "simple" signature to send to
   * `/v1/auth/verify`: the witness `[signature, deposit public key]`, base64.
   */
  async signIn(v: number, message: string): Promise<{ address: string; signature: Uint8Array; bip322: string }> {
    checkVault(v);
    const bytes = new TextEncoder().encode(message);
    if (bytes.length < 1 || bytes.length > SIGN_IN_MAX) throw new Error(`A sign-in challenge has 1 to ${SIGN_IN_MAX} bytes.`);
    const { publicKey, address } = await this.getDepositAddress(v);
    const data = concat(u32be(v), Uint8Array.of(bytes.length >> 8, bytes.length & 0xff), bytes);
    let signature: Uint8Array = new Uint8Array();
    for (let i = 0; i < data.length; i += CHUNK) {
      signature = await this.exchange(INS.SIGN_IN, i === 0 ? 0x00 : 0x80, data.subarray(i, i + CHUNK));
    }
    checkSignature(signature);
    const witness = concat(Uint8Array.of(2, signature.length), signature, Uint8Array.of(publicKey.length), publicKey);
    return { address, signature, bip322: btoa(String.fromCharCode(...witness)) };
  }

  /**
   * Stream an unsigned transaction spending vault `v`'s deposit address, wait
   * for the user's approval, then collect one signature per input. Each input's
   * previous transaction is picked from `previousTxs` by txid.
   */
  private async signDeposit(kind: keyof typeof DEPOSIT_KIND, v: number, unsignedTx: Uint8Array, previousTxs: Uint8Array[]): Promise<Uint8Array[]> {
    checkVault(v);
    const tx = parseTx(unsignedTx);
    if (tx.inputs.length < 1 || tx.inputs.length > 8) throw new Error("A deposit transaction has 1 to 8 inputs.");
    if (tx.outputs.length < 1 || tx.outputs.length > (kind === "sweep" ? 1 : 2)) throw new Error(`Too many outputs for a ${kind}.`);
    const known = previousTxs.map((raw) => {
      const stripped = stripWitness(raw);
      return { stripped, txid: txidInternal(stripped) };
    });
    const prevs = tx.inputs.map((input) => {
      const prev = known.find((p) => equalBytes(p.txid, input.txid));
      if (!prev) throw new Error("Missing the previous transaction of an input.");
      return prev.stripped;
    });
    const D = DEPOSIT_STEP;
    await this.exchange(
      INS.SIGN_DEPOSIT,
      D.START,
      concat(Uint8Array.of(DEPOSIT_KIND[kind]), u32be(v), u32le(tx.version), u32le(tx.lockTime), Uint8Array.of(tx.inputs.length, tx.outputs.length)),
    );
    for (const [i, input] of tx.inputs.entries()) {
      await this.exchange(INS.SIGN_DEPOSIT, D.INPUT, concat(input.txid, u32le(input.vout), u32le(input.sequence)));
      await this.stream(INS.SIGN_DEPOSIT, D.PREVTX, prevs[i]);
    }
    await this.stream(INS.SIGN_DEPOSIT, D.OUTPUTS, serializeOutputs(tx.outputs));
    await this.exchange(INS.SIGN_DEPOSIT, D.REVIEW);
    const signatures: Uint8Array[] = [];
    for (let i = 0; i < tx.inputs.length; i++) {
      const signature = await this.exchange(INS.SIGN_DEPOSIT, D.SIGN, Uint8Array.of(i));
      checkSignature(signature);
      signatures.push(signature);
    }
    return signatures;
  }

  /**
   * Disclose vault `v`'s secrets for one withdrawal (the user approves on the
   * device), read them back, and verify every item against `commitments` (the
   * vault's 154, root order, as the host funded it) before returning.
   * Throws DisclosureError if the device's response doesn't verify.
   *
   * The device records the disclosure before releasing anything: keep the
   * returned `transaction` (T): a retry must request these exact bytes again.
   */
  async withdraw(v: number, request: WithdrawRequest, commitments: Uint8Array[]): Promise<WithdrawResult> {
    checkVault(v);
    checkRequest(request);
    if (request.outputs.length < 1 || request.outputs.length > 4) throw new Error("A withdrawal has 1 to 4 outputs.");
    const prev = stripWitness(request.prevTx);
    const prevOut = parseTx(prev).outputs[request.vout];
    if (!prevOut || !equalBytes(prevOut.script, vaultScript(commitments)))
      throw new Error("The previous transaction's output is not this vault's script.");
    const prevTxid = txidInternal(prev);
    const transaction = withdrawalTx({ ...request, prevTxid });
    const binding = sha256(transaction);
    const digest = disclosureDigest(request, binding);

    const W = WITHDRAW_STEP;
    await this.exchange(
      INS.WITHDRAW,
      W.START,
      concat(
        u32be(v),
        u32le(request.version),
        prevTxid,
        u32le(request.vout),
        u32le(request.sequence),
        u32le(request.lockTime),
        Uint8Array.of(request.outputs.length),
        Uint8Array.from(request.round0),
        Uint8Array.from(request.round1),
        Uint8Array.from(request.picks),
      ),
    );
    await this.stream(INS.WITHDRAW, W.PREVTX, prev);
    await this.stream(INS.WITHDRAW, W.OUTPUTS, serializeOutputs(request.outputs));
    await this.exchange(INS.WITHDRAW, W.REVIEW);
    const chunks: Uint8Array[] = [];
    for (let chunk = 0; chunk <= 4; chunk++) chunks.push(await this.exchange(INS.REVEAL_READ, chunk));
    const response = parseReveal(chunks);
    verifyDisclosure(commitments, request, transaction, response);
    return { ...response, transaction, binding, digest };
  }

  /** Ask the user to authorize exporting vault `v`'s menu points. */
  async authorizeMenuPoints(v: number): Promise<void> {
    checkVault(v);
    await this.exchange(INS.MENU_POINTS, 0, u32be(v));
  }

  /**
   * The stage's menu points (r^-1 * x[i]) * R for every i, R the recovery point
   * of `variant` (add_n << 1 | odd). Private to the solver.
   */
  async getMenuPoints(v: number, stage: 0 | 1 | 2, variant: number): Promise<Uint8Array[]> {
    checkVault(v);
    const width = MENU_WIDTHS[stage];
    if (width === undefined || !Number.isInteger(variant) || variant < 0 || variant > 3) throw new Error("Invalid stage or variant.");
    const out: Uint8Array[] = [];
    for (let start = 0; start < width; start += MENU_POINT_CHUNK) {
      const count = Math.min(MENU_POINT_CHUNK, width - start);
      const r = await this.exchange(INS.MENU_POINTS, 1, concat(u32be(v), Uint8Array.of(stage, variant, start, count)));
      if (r.length !== 33 * count) throw new Error("Unexpected MENU_POINTS response.");
      for (let i = 0; i < count; i++) out.push(r.slice(33 * i, 33 * i + 33));
    }
    return out;
  }

  /**
   * The `r` all menu signatures of `stage` share, which the solver needs with
   * the points (pqb v1: 1 for stage 0, 0x81 for stages 1 and 2). Needs the
   * same authorization as the points.
   */
  async getMenuR(v: number, stage: 0 | 1 | 2): Promise<bigint> {
    checkVault(v);
    if (MENU_WIDTHS[stage] === undefined) throw new Error("Invalid stage.");
    const r = await this.exchange(INS.MENU_POINTS, 2, concat(u32be(v), Uint8Array.of(stage)));
    if (r.length !== 32) throw new Error("Unexpected MENU_POINTS response.");
    let n = 0n;
    for (const b of r) n = (n << 8n) | BigInt(b);
    if (n === 0n) throw new Error("Invalid menu r.");
    return n;
  }

  private async stream(ins: number, p1: number, bytes: Uint8Array) {
    for (let i = 0; i < bytes.length; i += CHUNK) await this.exchange(ins, p1, bytes.subarray(i, i + CHUNK));
  }
}

/** `DER signature || SIGHASH_ALL`, as the app returns it. */
function checkSignature(sig: Uint8Array) {
  if (sig.length < 9 || sig.length > 73 || sig[0] !== 0x30 || sig[1] !== sig.length - 3 || sig[sig.length - 1] !== 0x01)
    throw new Error("Malformed signature from the device.");
}
