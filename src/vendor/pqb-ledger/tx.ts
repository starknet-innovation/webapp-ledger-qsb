import { sha256 } from "@noble/hashes/sha2.js";

/** Byte helpers and a minimal Bitcoin transaction codec, for what the app streams. */

export const concat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
export const u32be = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
};
export const u32le = (n: number): Uint8Array => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0, true);
  return out;
};
export const u64le = (n: bigint): Uint8Array => {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, n, true);
  return out;
};
export function compactSize(n: number): Uint8Array {
  if (n < 0xfd) return Uint8Array.of(n);
  if (n <= 0xffff) return Uint8Array.of(0xfd, n & 0xff, n >> 8);
  return concat(Uint8Array.of(0xfe), u32le(n));
}
export const fromHex = (h: string): Uint8Array => {
  if (h.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(h)) throw new Error("Invalid hex.");
  return Uint8Array.from(h.match(/../g) ?? [], (b) => parseInt(b, 16));
};
export const toHex = (b: Uint8Array): string => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
export const equalBytes = (a: Uint8Array, b: Uint8Array): boolean =>
  a.length === b.length && a.every((x, i) => x === b[i]);

export type TxInput = { txid: Uint8Array; vout: number; scriptSig: Uint8Array; sequence: number };
export type TxOutput = { amount: bigint; script: Uint8Array };
/** A parsed transaction. `txid`s of inputs are in serialization (internal) order. */
export type Tx = {
  version: number;
  inputs: TxInput[];
  outputs: TxOutput[];
  lockTime: number;
  /** Whether the input bytes carried a SegWit marker, flag and witnesses. */
  segwit: boolean;
};

/** Parse a whole transaction (legacy or SegWit serialization); trailing bytes are an error. */
export function parseTx(raw: Uint8Array): Tx {
  let pos = 0;
  const need = (n: number) => {
    if (pos + n > raw.length) throw new Error("Truncated transaction.");
  };
  const take = (n: number) => {
    need(n);
    const out = raw.subarray(pos, pos + n);
    pos += n;
    return out;
  };
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const u32 = () => {
    need(4);
    pos += 4;
    return view.getUint32(pos - 4, true);
  };
  const varint = () => {
    need(1);
    const first = raw[pos++];
    if (first < 0xfd) return first;
    const size = first === 0xfd ? 2 : first === 0xfe ? 4 : 8;
    need(size);
    let n = 0;
    for (let i = size - 1; i >= 0; i--) n = n * 256 + raw[pos + i];
    pos += size;
    if (n > raw.length) throw new Error("Implausible length in transaction.");
    return n;
  };
  const version = u32();
  let segwit = false;
  if (raw[pos] === 0x00) {
    if (raw[pos + 1] !== 0x01) throw new Error("Unknown transaction serialization.");
    segwit = true;
    pos += 2;
  }
  const inputs: TxInput[] = [];
  for (let i = 0, n = varint(); i < n; i++) {
    const txid = take(32).slice();
    const vout = u32();
    const scriptSig = take(varint()).slice();
    inputs.push({ txid, vout, scriptSig, sequence: u32() });
  }
  const outputs: TxOutput[] = [];
  for (let i = 0, n = varint(); i < n; i++) {
    need(8);
    const amount = view.getBigUint64(pos, true);
    pos += 8;
    outputs.push({ amount, script: take(varint()).slice() });
  }
  if (segwit) for (let i = 0; i < inputs.length; i++) for (let j = 0, n = varint(); j < n; j++) take(varint());
  const lockTime = u32();
  if (pos !== raw.length) throw new Error("Trailing bytes after transaction.");
  return { version, inputs, outputs, lockTime, segwit };
}

/** The serialized outputs, without their count, as the app streams them. */
export const serializeOutputs = (outputs: TxOutput[]): Uint8Array =>
  concat(...outputs.flatMap((o) => [u64le(o.amount), compactSize(o.script.length), o.script]));

/** The legacy serialization (no SegWit marker, flag or witnesses). */
export function serializeTx(tx: Omit<Tx, "segwit">): Uint8Array {
  return concat(
    u32le(tx.version),
    compactSize(tx.inputs.length),
    ...tx.inputs.flatMap((i) => [i.txid, u32le(i.vout), compactSize(i.scriptSig.length), i.scriptSig, u32le(i.sequence)]),
    compactSize(tx.outputs.length),
    serializeOutputs(tx.outputs),
    u32le(tx.lockTime),
  );
}

/**
 * The legacy serialization of a transaction: SegWit marker, flag and witnesses
 * removed. That is what the txid commits to, and what the app hashes.
 */
export const stripWitness = (raw: Uint8Array): Uint8Array => serializeTx(parseTx(raw));

/** The txid of a transaction in internal (serialization) order. */
export const txidInternal = (raw: Uint8Array): Uint8Array => sha256(sha256(stripWitness(raw)));

/** The display-order txid of a transaction. */
export const txidOf = (raw: Uint8Array): string => toHex(txidInternal(raw).reverse());
