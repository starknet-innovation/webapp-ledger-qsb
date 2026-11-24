import { secp256k1 } from "@noble/curves/secp256k1.js";
import { ripemd160, sha1 } from "@noble/hashes/legacy.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { TEMPLATE_BASE64, TEMPLATE_SHA256 } from "./template.js";
import { concat, equalBytes, parseTx, serializeTx, toHex, u32le, type TxOutput } from "./tx.js";

/**
 * PQB-v1 host computations (BIP "PQB Vault Secret Management"): everything a
 * host can check about a vault without its seed. No device involved.
 */

export const PROFILE = "PQB-v1";
/** Table entries, shared by both rounds. */
export const TABLE = 109;
/** Commitments in the root: c[0..109], m_pin[0..12], m_round0[0..16], m_round1[0..16], q. */
export const COMMITMENTS = 154;
/** Menu widths of stages 0 (pin), 1 (round 0) and 2 (round 1). */
export const MENU_WIDTHS = [12, 16, 16] as const;
/** Root index of each stage's first menu commitment. */
export const MENU_OFFSETS = [109, 121, 137] as const;
/** Root index of q, HASH160 of the co-signing key. */
export const Q_INDEX = 153;
export const ROUND0 = 8;
export const ROUND1 = 9;
export const SCRIPT_LEN = 4696;

const enc = new TextEncoder();
const SIGHASH_ALL = 0x01;

export const hash160 = (b: Uint8Array): Uint8Array => ripemd160(sha256(b));

/** R = SHA256("PQB-v1/root" || the 154 commitments in root order). */
export function commitmentRoot(commitments: Uint8Array[]): Uint8Array {
  if (commitments.length !== COMMITMENTS || commitments.some((c) => c.length !== 20))
    throw new Error(`Expected ${COMMITMENTS} commitments of 20 bytes.`);
  return sha256(concat(enc.encode(`${PROFILE}/root`), ...commitments));
}

/** The root's first eight bytes in four groups, as the device shows them. Not for matching. */
export function fingerprint(root: Uint8Array): string {
  return toHex(root.subarray(0, 8)).match(/..../g)!.join(" ");
}

let templateBytes: Uint8Array | undefined;
/** The PQB-v1 script template, commitments zeroed. */
export function template(): Uint8Array {
  if (!templateBytes) {
    const t = Uint8Array.from(atob(TEMPLATE_BASE64), (c) => c.charCodeAt(0));
    if (t.length !== SCRIPT_LEN || toHex(sha256(t)) !== TEMPLATE_SHA256) throw new Error("Corrupt script template.");
    templateBytes = t;
  }
  return templateBytes.slice();
}

/** In script order: (offset of the first push opcode, stride, count, first root index). */
const LAYOUT: [number, number, number, number][] = [
  [6, 0, 1, 153],
  [34, 21, 12, 109],
  [306, 31, 109, 0],
  [3675, 21, 16, 121],
  [4175, 21, 16, 137],
];
/** [offset of the 20 committed bytes, root index] of each slot. */
const SLOTS: [number, number][] = LAYOUT.flatMap(([push, stride, count, first]) =>
  Array.from({ length: count }, (_, i) => [push + i * stride + 1, first + i] as [number, number]),
);

/** The vault's 4,908-byte locking script: the template with the commitments filled in. */
export function vaultScript(commitments: Uint8Array[]): Uint8Array {
  commitmentRoot(commitments); // checks the shape
  const out = template();
  for (const [at, index] of SLOTS) out.set(commitments[index], at);
  return out;
}

/**
 * The 154 commitments embedded in a PQB-v1 script, in root order. Throws unless
 * the script is the template apart from its commitments.
 */
export function commitmentsFromScript(script: Uint8Array): Uint8Array[] {
  if (script.length !== SCRIPT_LEN) throw new Error("Not a PQB-v1 script: wrong length.");
  const commitments: Uint8Array[] = new Array(COMMITMENTS);
  const masked = script.slice();
  for (const [at, index] of SLOTS) {
    commitments[index] = script.slice(at, at + 20);
    masked.fill(0, at, at + 20);
  }
  if (!equalBytes(masked, template())) throw new Error("Not a PQB-v1 script: template mismatch.");
  return commitments;
}

export const scriptHash = (script: Uint8Array): Uint8Array => sha256(script);

/**
 * Legacy SIGHASH_ALL digest of the only input of `t` (scriptSig empty, no
 * witness), with `scriptCode` as the script code: the co-signature's message z.
 */
export function legacySighashAll(t: Uint8Array, scriptCode: Uint8Array): Uint8Array {
  const tx = parseTx(t);
  if (tx.segwit || tx.inputs.length !== 1 || tx.inputs[0].scriptSig.length !== 0)
    throw new Error("Not a single-input transaction with an empty scriptSig.");
  const withCode = serializeTx({ ...tx, inputs: [{ ...tx.inputs[0], scriptSig: scriptCode }] });
  return sha256(sha256(concat(withCode, u32le(SIGHASH_ALL))));
}

/** What a withdrawal discloses: table indices per round and one menu pick per stage. */
export type DisclosureRequest = { round0: number[]; round1: number[]; picks: [number, number, number] };

/** Throws unless the request satisfies the BIP's cardinality, range, order and disjointness rules. */
export function checkRequest({ round0, round1, picks }: DisclosureRequest): void {
  const ascending = (xs: number[], n: number, name: string) => {
    if (!Array.isArray(xs) || xs.length !== n) throw new Error(`${name} needs exactly ${n} indices.`);
    xs.forEach((x, i) => {
      if (!Number.isInteger(x) || x < 0 || x >= TABLE) throw new Error(`${name} index out of range: ${x}`);
      if (i > 0 && x <= xs[i - 1]) throw new Error(`${name} indices must be strictly ascending.`);
    });
  };
  ascending(round0, ROUND0, "round0");
  ascending(round1, ROUND1, "round1");
  if (round0.some((x) => round1.includes(x))) throw new Error("An index appears in both rounds.");
  if (!Array.isArray(picks) || picks.length !== 3) throw new Error("Need one menu pick per stage.");
  picks.forEach((p, k) => {
    if (!Number.isInteger(p) || p < 0 || p >= MENU_WIDTHS[k]) throw new Error(`Menu pick ${k} out of range: ${p}`);
  });
}

/** D = SHA256("PQB-v1/reveal" || round0 || round1 || p0 || p1 || p2 || B), B = SHA256(T). */
export function disclosureDigest(request: DisclosureRequest, binding: Uint8Array): Uint8Array {
  checkRequest(request);
  if (binding.length !== 32) throw new Error("B must be 32 bytes.");
  return sha256(
    concat(enc.encode(`${PROFILE}/reveal`), Uint8Array.from(request.round0), Uint8Array.from(request.round1), Uint8Array.from(request.picks), binding),
  );
}

/** The withdrawal transaction's fields; `prevTxid` in internal (serialization) order. */
export type Withdrawal = {
  version: number;
  prevTxid: Uint8Array;
  vout: number;
  sequence: number;
  lockTime: number;
  outputs: TxOutput[];
};

/** T: the withdrawal with an empty scriptSig and no witness. */
export function withdrawalTx(w: Withdrawal): Uint8Array {
  if (w.prevTxid.length !== 32) throw new Error("prevTxid must be 32 bytes.");
  return serializeTx({
    version: w.version,
    inputs: [{ txid: w.prevTxid, vout: w.vout, scriptSig: new Uint8Array(), sequence: w.sequence }],
    outputs: w.outputs,
    lockTime: w.lockTime,
  });
}

/** What REVEAL_READ returns, parsed. Spending-sensitive: keep it out of logs. */
export type DisclosureResponse = {
  /** s[j] for each round-0 index (20 bytes each). */
  round0Preimages: Uint8Array[];
  /** w[j] for each round-1 index (32 bytes each). */
  round1Preimages: Uint8Array[];
  /** g[p0], g[p1], g[p2]: DER || 0x01. */
  menuSignatures: [Uint8Array, Uint8Array, Uint8Array];
  /** The co-signature, DER || 0x01. */
  cosignature: Uint8Array;
  /** The co-signing public key, compressed. */
  Q: Uint8Array;
};

/** Parse REVEAL_READ chunks 0..4 into a DisclosureResponse. */
export function parseReveal(chunks: Uint8Array[]): DisclosureResponse {
  if (chunks.length !== 5) throw new Error("Expected 5 REVEAL_READ chunks.");
  const split = (b: Uint8Array, size: number, n: number, what: string) => {
    if (b.length !== size * n) throw new Error(`Unexpected ${what} length.`);
    return Array.from({ length: n }, (_, i) => b.slice(i * size, (i + 1) * size));
  };
  const lengthPrefixed = (b: Uint8Array, n: number, what: string) => {
    const out: Uint8Array[] = [];
    let pos = 0;
    for (let i = 0; i < n; i++) {
      if (pos >= b.length || pos + 1 + b[pos] > b.length) throw new Error(`Truncated ${what}.`);
      out.push(b.slice(pos + 1, pos + 1 + b[pos]));
      pos += 1 + b[pos];
    }
    return { out, rest: b.subarray(pos) };
  };
  const round0Preimages = split(chunks[0], 20, 8, "round-0 chunk");
  const round1Preimages = [...split(chunks[1], 32, 5, "round-1 chunk"), ...split(chunks[2], 32, 4, "round-1 chunk")];
  const menu = lengthPrefixed(chunks[3], 3, "menu signatures");
  if (menu.rest.length !== 0) throw new Error("Trailing bytes after menu signatures.");
  const cos = lengthPrefixed(chunks[4], 1, "co-signature");
  if (cos.rest.length !== 33) throw new Error("Unexpected Q length.");
  return {
    round0Preimages,
    round1Preimages,
    menuSignatures: menu.out as [Uint8Array, Uint8Array, Uint8Array],
    cosignature: cos.out[0],
    Q: cos.rest.slice(),
  };
}

/** BIP 66 strict DER, without the hash type byte. */
export function isStrictDer(sig: Uint8Array): boolean {
  if (sig.length < 8 || sig.length > 72) return false;
  if (sig[0] !== 0x30 || sig[1] !== sig.length - 2) return false;
  const lenR = sig[3];
  if (5 + lenR >= sig.length) return false;
  const lenS = sig[5 + lenR];
  if (lenR + lenS + 6 !== sig.length) return false;
  if (sig[2] !== 0x02 || lenR === 0 || sig[4] & 0x80) return false;
  if (lenR > 1 && sig[4] === 0 && !(sig[5] & 0x80)) return false;
  if (sig[lenR + 4] !== 0x02 || lenS === 0 || sig[lenR + 6] & 0x80) return false;
  if (lenS > 1 && sig[lenR + 6] === 0 && !(sig[lenR + 7] & 0x80)) return false;
  return true;
}

/** The checks verifyDisclosure applies, by name, in the order applied. */
export class DisclosureError extends Error {}

/**
 * Check a disclosure against the vault's commitments (root order) and T:
 * HASH160(s) = c[j], RIPEMD160(w) = c[j], SHA1(g) = m_stage[p], HASH160(Q) = q,
 * and the co-signature is strict DER, low S, SIGHASH_ALL and valid over z with
 * Q, z the legacy sighash of T with the vault script as script code. Throws a
 * DisclosureError naming the first failure.
 */
export function verifyDisclosure(
  commitments: Uint8Array[],
  request: DisclosureRequest,
  t: Uint8Array,
  response: DisclosureResponse,
): void {
  checkRequest(request);
  const script = vaultScript(commitments);
  const fail = (why: string) => {
    throw new DisclosureError(why);
  };
  if (response.round0Preimages.length !== ROUND0 || response.round1Preimages.length !== ROUND1)
    fail("Wrong number of preimages.");
  request.round0.forEach((j, i) => {
    const s = response.round0Preimages[i];
    if (s.length !== 20 || !equalBytes(hash160(s), commitments[j])) fail(`Round-0 preimage for index ${j} doesn't match c[${j}].`);
  });
  request.round1.forEach((j, i) => {
    const w = response.round1Preimages[i];
    if (w.length !== 32 || !equalBytes(ripemd160(w), commitments[j])) fail(`Round-1 preimage for index ${j} doesn't match c[${j}].`);
  });
  request.picks.forEach((p, k) => {
    const g = response.menuSignatures[k];
    if (!g || !equalBytes(sha1(g), commitments[MENU_OFFSETS[k] + p])) fail(`Menu signature of stage ${k} doesn't match m[${p}].`);
  });
  if (response.Q.length !== 33 || !equalBytes(hash160(response.Q), commitments[Q_INDEX])) fail("Q doesn't match q.");
  const sig = response.cosignature;
  if (sig[sig.length - 1] !== SIGHASH_ALL) fail("Co-signature hash type is not SIGHASH_ALL.");
  const der = sig.subarray(0, -1);
  if (!isStrictDer(der)) fail("Co-signature is not strict DER.");
  const z = legacySighashAll(t, script);
  let valid = false;
  try {
    valid = secp256k1.verify(der, z, response.Q, { format: "der", prehash: false, lowS: true });
  } catch {
    valid = false;
  }
  if (!valid) fail("Co-signature does not verify over z with Q (or has a high S).");
}

// ---- device records ----------------------------------------------------------

/** GET_STATE summary. */
export type StateSummary = {
  walletId: Uint8Array;
  /** 0 none, 1 fresh, 2 unknown. */
  namespace: number;
  nextV: number;
  records: number;
  capacity: number;
};

export const RECORD_STATES = { 1: "allocated", 2: "exposed", 3: "retired", 4: "unknown" } as const;
export type RecordState = (typeof RECORD_STATES)[keyof typeof RECORD_STATES];
export const RECORD_FLAGS = { FUNDED: 0x01, DISCLOSED: 0x02, EMERGENCY: 0x04 } as const;
/** As the device sends it (docs/apdu.md GET_STATE, P1 = 0x01). webapp-ledger-qsb: upstream has 256. */
export const RECORD_LEN = 251;

/** One vault record as the device stores it (GET_STATE, P1 = 0x01). */
export type VaultRecord = {
  walletId: Uint8Array;
  v: number;
  state: RecordState;
  flags: number;
  root: Uint8Array;
  scriptHash: Uint8Array;
  /** Present when flags has FUNDED. txid in internal order. */
  funding: { txid: Uint8Array; vout: number; value: bigint } | null;
  /** The recorded sweep's first input (txid internal || vout LE), 36 bytes. */
  sweepInput: Uint8Array;
  /** Present when flags has DISCLOSED. */
  disclosure: (DisclosureRequest & { binding: Uint8Array; digest: Uint8Array }) | null;
};

export function parseRecord(b: Uint8Array): VaultRecord {
  if (b.length !== RECORD_LEN || b[0] !== 0x01) throw new Error("Unexpected record layout.");
  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const state = RECORD_STATES[b[21] as keyof typeof RECORD_STATES];
  if (!state) throw new Error(`Unknown record state ${b[21]}.`);
  const flags = b[22];
  const at = (o: number, n: number) => b.slice(o, o + n);
  return {
    walletId: at(1, 16),
    v: view.getUint32(17),
    state,
    flags,
    root: at(23, 32),
    scriptHash: at(55, 32),
    funding: flags & RECORD_FLAGS.FUNDED ? { txid: at(87, 32), vout: view.getUint32(119, true), value: view.getBigUint64(123, true) } : null,
    sweepInput: at(131, 36),
    disclosure:
      flags & RECORD_FLAGS.DISCLOSED
        ? {
            round0: Array.from(at(167, 8)),
            round1: Array.from(at(175, 9)),
            picks: Array.from(at(184, 3)) as [number, number, number],
            binding: at(187, 32),
            digest: at(219, 32),
          }
        : null,
  };
}
