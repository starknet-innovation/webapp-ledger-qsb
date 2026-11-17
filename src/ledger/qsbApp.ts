// Browser port of app-qsb's clients/js/src/app.ts (Uint8Array instead of Buffer).
// Protocol: https://github.com/starknet-innovation/app-qsb/blob/main/docs/apdu.md
import { sha256 } from "@noble/hashes/sha2.js";

const CLA = 0xe0;
const INS = { GET_WALLET_ADDRESS: 0x05, SIGN_TX: 0x06, SIGN_IN: 0x07 } as const;
const STEP = { START: 0, INPUT: 1, PREVTX: 2, OUTPUTS: 3, REVIEW: 4, SIGN: 5 } as const;
const CHUNK = 255;
const HARDENED = 0x80000000;
const SW_OK = 0x9000;
/** The device was showing a status screen and didn't take the command; safe to resend. */
const SW_NOT_ACCEPTED = 0x6901;
const MESSAGE_MAX = 512;

export type TxKind = "deposit" | "withdrawal";
export type UnsignedTx = {
  version: number;
  lockTime: number;
  inputs: { txid: string; vout: number; sequence: number; previousTx: Uint8Array }[];
  outputs: { amount: bigint; script: Uint8Array }[];
};

/** Sends one raw APDU and returns the status word and data. */
export type Exchange = (apdu: Uint8Array) => Promise<{ sw: number; data: Uint8Array }>;

export class QsbStatusError extends Error {
  constructor(readonly statusWord: number) {
    super(`The QSB app refused the request (0x${statusWord.toString(16).padStart(4, "0")}).`);
  }
}

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const u32le = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
const u64le = (n: bigint) => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
const compactSize = (n: number) =>
  n < 0xfd ? Uint8Array.of(n) : n <= 0xffff ? Uint8Array.of(0xfd, n & 0xff, n >> 8) : concat(Uint8Array.of(0xfe), u32le(n));
const fromHex = (h: string) => Uint8Array.from(h.match(/../g)!.map((b) => parseInt(b, 16)));
const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

function serializePath(path: string): Uint8Array {
  if (!/^m(\/\d+['hH]?)+$/.test(path)) throw new Error(`Invalid BIP-32 path: ${path}`);
  const parts = path.split("/").slice(1);
  const out = new Uint8Array(1 + 4 * parts.length);
  const view = new DataView(out.buffer);
  out[0] = parts.length;
  parts.forEach((part, i) => {
    const hardened = /['hH]$/.test(part);
    const n = Number(hardened ? part.slice(0, -1) : part);
    view.setUint32(1 + 4 * i, hardened ? n + HARDENED : n);
  });
  return out;
}

/** The legacy serialization of a transaction (no SegWit marker, flag or witnesses): what the txid commits to. */
function stripWitness(raw: Uint8Array): Uint8Array {
  let pos = 4;
  const varint = () => {
    const first = raw[pos++];
    if (first < 0xfd) return first;
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    let n = 0;
    for (let i = size - 1; i >= 0; i--) n = n * 256 + raw[pos + i];
    pos += size;
    return n;
  };
  if (raw[4] !== 0x00) return raw;
  if (raw[5] !== 0x01) throw new Error("Unknown transaction serialization.");
  pos = 6;
  const bodyStart = pos;
  const inputs = varint();
  for (let i = 0; i < inputs; i++) {
    pos += 36;
    const script = varint();
    pos += script + 4;
  }
  const outputs = varint();
  for (let i = 0; i < outputs; i++) {
    pos += 8;
    const script = varint();
    pos += script;
  }
  const bodyEnd = pos;
  for (let i = 0; i < inputs; i++) {
    const items = varint();
    for (let j = 0; j < items; j++) {
      const item = varint();
      pos += item;
    }
  }
  if (pos + 4 !== raw.length) throw new Error("Malformed SegWit transaction.");
  return concat(raw.subarray(0, 4), raw.subarray(bodyStart, bodyEnd), raw.subarray(pos));
}

function checkSignature(sig: Uint8Array) {
  if (sig.length < 9 || sig.length > 73 || sig[0] !== 0x30 || sig[1] !== sig.length - 3 || sig[sig.length - 1] !== 0x01)
    throw new Error("Malformed signature from the device.");
}

export class QsbApp {
  constructor(private readonly send: Exchange) {}

  private async exchange(ins: number, p1: number, data: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const apdu = concat(Uint8Array.of(CLA, ins, p1, 0x00, data.length), data);
    for (let attempt = 0; ; attempt++) {
      const { sw, data: response } = await this.send(apdu);
      if (sw === SW_NOT_ACCEPTED && attempt < 20) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (sw !== SW_OK) throw new QsbStatusError(sw);
      return response;
    }
  }

  /** The wallet key and address at `path`; with `display`, after the user confirms it on the device. */
  async getWalletAddress(path: string, display = false): Promise<{ publicKey: Uint8Array; address: string }> {
    const r = await this.exchange(INS.GET_WALLET_ADDRESS, display ? 1 : 0, serializePath(path));
    if (r.length < 34 || r.length !== 34 + r[33]) throw new Error("Unexpected address response from the device.");
    return { publicKey: r.subarray(0, 33), address: new TextDecoder().decode(r.subarray(34, 34 + r[33])) };
  }

  /** Stream `tx`, wait for the user's approval, then collect a signature (DER || SIGHASH_ALL) per index in `sign`. */
  async signTransaction(kind: TxKind, path: string, tx: UnsignedTx, sign: number[]): Promise<Map<number, Uint8Array>> {
    if (tx.inputs.length > 8 || tx.outputs.length > 2) throw new Error("Not a QSB deposit or withdrawal.");
    await this.exchange(
      INS.SIGN_TX,
      STEP.START,
      concat(
        Uint8Array.of(kind === "deposit" ? 1 : 2),
        serializePath(path),
        u32le(tx.version),
        u32le(tx.lockTime),
        Uint8Array.of(tx.inputs.length, tx.outputs.length),
      ),
    );
    for (const input of tx.inputs) {
      const previous = stripWitness(input.previousTx);
      if (toHex(sha256(sha256(previous)).reverse()) !== input.txid.toLowerCase())
        throw new Error(`Previous transaction for ${input.txid} has a different txid.`);
      await this.exchange(INS.SIGN_TX, STEP.INPUT, concat(fromHex(input.txid).reverse(), u32le(input.vout), u32le(input.sequence)));
      for (let i = 0; i < previous.length; i += CHUNK)
        await this.exchange(INS.SIGN_TX, STEP.PREVTX, previous.subarray(i, i + CHUNK));
    }
    const outputs = concat(...tx.outputs.flatMap((o) => [u64le(o.amount), compactSize(o.script.length), o.script]));
    for (let i = 0; i < outputs.length; i += CHUNK)
      await this.exchange(INS.SIGN_TX, STEP.OUTPUTS, outputs.subarray(i, i + CHUNK));
    await this.exchange(INS.SIGN_TX, STEP.REVIEW);
    const signatures = new Map<number, Uint8Array>();
    for (const index of sign) {
      const signature = await this.exchange(INS.SIGN_TX, STEP.SIGN, Uint8Array.of(index));
      checkSignature(signature);
      signatures.set(index, signature);
    }
    return signatures;
  }

  /** BIP-322 signature (DER || SIGHASH_ALL) of a QSB sign-in challenge. */
  async signIn(path: string, message: string): Promise<Uint8Array> {
    const bytes = new TextEncoder().encode(message);
    if (bytes.length === 0 || bytes.length > MESSAGE_MAX) throw new Error("Not a QSB sign-in challenge.");
    const header = concat(serializePath(path), Uint8Array.of(bytes.length >> 8, bytes.length & 0xff));
    const first = bytes.subarray(0, CHUNK - header.length);
    let response = await this.exchange(INS.SIGN_IN, 0x00, concat(header, first));
    for (let i = first.length; i < bytes.length; i += CHUNK)
      response = await this.exchange(INS.SIGN_IN, 0x80, bytes.subarray(i, i + CHUNK));
    checkSignature(response);
    return response;
  }
}
