// A PQB vault whose secrets stay on the Ledger (the PQB app, app-qsb), for the QSB SDK.
//
// The approach is app-qsb's Python adapter (clients/python/src/pqb_ledger/adapter.py), in
// TypeScript on qsb-app's vendored pqb: the vault's structure comes from a public "shell" lock of
// the same construction, with the device's 154 commitments swapped in. The device's own script must
// come out byte for byte, so a construction mismatch is refused before anything is registered or
// funded. A withdrawal fills in only what the device discloses, after checking it.
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import type { VaultDescriptor, WithdrawalSigningRequest } from "@starknet-innovation/qsb-sdk";
import { evaluate, parseHit, solves, stagesFromLock, witnessPlan, type Packet, type SolvedStage } from "../vendor/pqb-core/grind";
import type { Lock } from "../vendor/pqb-core/lock";
import { buildLock } from "../vendor/pqb-core/lock";
import { fromHex, hex } from "../vendor/pqb-core/primitives";
import { assemble, pinFields, pinNonceOf } from "../vendor/pqb-core/spend";
import { serializeTx, type Tx } from "../vendor/pqb-core/tx";
import type { PqbApp } from "../vendor/pqb-ledger/app";
import { commitmentRoot } from "../vendor/pqb-ledger/pqb";

/** The construction the PQB Ledger app derives (pqb `82c7cba`, BIP profile PQB-v1). */
export const CONSTRUCTION = "v1";

type Withdrawal = WithdrawalSigningRequest["solved"]["manifest"];
type Solution = WithdrawalSigningRequest["solved"]["solution"];
type Bytes = Uint8Array;

const equal = (a: Bytes, b: Bytes) => a.length === b.length && a.every((x, i) => x === b[i]);
const HALF_N = secp256k1.Point.CURVE().n >> 1n;

/**
 * What the vendored pqb builds for construction v1 from its public research seed, at pqb 82c7cba
 * (vendored from qsb-app 29fd868): the script, and the public structure a descriptor carries besides
 * the commitments (dummy-signature table, menu r, recovery-point variants and widths). A pqb bump
 * that changes either must be checked against the Ledger app before these are updated: a wrong
 * descriptor would only show up as a withdrawal that can't be solved, after funding.
 */
const SHELL_SCRIPT_SHA256 = "8fc23c6979def70bca6cf84b1a7fe9843ea11fe073d6767a2c42ef01769ede92";
const SHELL_STRUCTURE_SHA256 = "88bfe2ba981d8aa468c7d60d84ab29efbce4b222ac328b1aec9b41764ad3c0e1";

/** The public structure pinned by SHELL_STRUCTURE_SHA256. */
export function shellStructure(lock: Lock): string {
  return JSON.stringify({
    round_table: lock.detail.dsig.map(hex),
    stages: stagesFromLock(lock).map((st) => ({
      r: String((st.menuR as { r?: string }).r),
      r_inv: String(st.menuR!.r_inv),
      variants: st.menuR!.variants.map((v) => [v.add_n, v.odd, v.points.length]),
    })),
  });
}

let shell: Lock | undefined;
/** The construction's structure, built from pqb's public research seed: never funded, no secret of ours. */
export function shellLock(): Lock {
  if (!shell) {
    const built = buildLock("PQB", null, { allowPublicSeed: true, version: CONSTRUCTION });
    if (hex(sha256(built.script)) !== SHELL_SCRIPT_SHA256
      || hex(sha256(new TextEncoder().encode(shellStructure(built)))) !== SHELL_STRUCTURE_SHA256)
      throw new Error("This page's PQB code builds vaults differently from the version it was checked against.");
    shell = built;
  }
  return shell;
}

/** A build's 154 commitments in the device's root order: c[0..109], m_pin, m_round0, m_round1, q. */
function rootOrder(d: Lock["detail"]): Bytes[] {
  if (!d.menu || !d.rmenu[0] || !d.rmenu[1]) throw new Error("Not a PQB v1 structure.");
  return [...d.comm, ...d.menu.comm, ...d.rmenu[0].comm, ...d.rmenu[1].comm, d.cosig.h160];
}

/** `script` with each 20-byte push of a commitment in `from` replaced by its counterpart in `to`. */
function swapCommitments(script: Bytes, from: Bytes[], to: Bytes[]): Bytes {
  const out = script.slice();
  const findPush = (c: Bytes, start: number) => {
    for (let i = start; i + 21 <= script.length; i++)
      if (script[i] === 0x14 && equal(script.subarray(i + 1, i + 21), c)) return i;
    return -1;
  };
  from.forEach((c, k) => {
    const at = findPush(c, 0);
    if (at < 0 || findPush(c, at + 1) >= 0) throw new Error("A commitment isn't in the structure exactly once.");
    out.set(to[k], at + 1);
  });
  return out;
}

/** Vault `v` as the device holds it: its commitments, script and lock structure, with no secret. */
export type DeviceVault = { v: number; commitments: Bytes[]; script: Bytes; lock: Lock };

/** Reads vault `v` from the device and checks it is exactly this construction with the device's commitments. */
export async function readDeviceVault(app: PqbApp, v: number): Promise<DeviceVault> {
  const commitments = await app.getCommitments(v);
  const info = await app.getVault(v);
  const script = await app.getScript(v);
  if (commitments.length !== 154 || new Set(commitments.map(hex)).size !== 154)
    throw new Error("The Ledger returned an unexpected set of commitments.");
  const base = shellLock();
  const expected = swapCommitments(base.script, rootOrder(base.detail), commitments);
  if (!equal(expected, script))
    throw new Error("This Ledger's vault isn't the construction this page supports. Update the app or this page.");
  if (!equal(sha256(script), info.scriptHash)) throw new Error("The Ledger's script doesn't match its own script hash.");
  if (!equal(commitmentRoot(commitments), info.root)) throw new Error("The Ledger's commitments don't match its own root.");

  const detail = structuredClone(base.detail);
  detail.script = script;
  detail.comm = commitments.slice(0, 109);
  detail.menu!.comm = commitments.slice(109, 121);
  detail.rmenu[0]!.comm = commitments.slice(121, 137);
  detail.rmenu[1]!.comm = commitments.slice(137, 153);
  // The shell's secrets go: only a disclosure fills the few a withdrawal needs.
  detail.cosig = { ...detail.cosig, h160: commitments[153], pk: new Uint8Array(), d: 0n };
  detail.wit = detail.wit.map((row) => row.map(() => new Uint8Array()));
  for (const menu of [detail.menu!, detail.rmenu[0]!, detail.rmenu[1]!]) {
    menu.sigs = menu.sigs.map(() => new Uint8Array());
    menu.s = menu.s.map(() => 0n);
  }
  const lock: Lock = { ...base, script, sha256: hex(sha256(script)), detail };
  return { v, commitments, script, lock };
}

/**
 * The public descriptor qsb-app registers, as qsb-app's `publicState` writes it, with the menu
 * points from the device. Call `app.authorizeMenuPoints(v)` first: the user approves the export.
 */
export async function descriptorFor(app: PqbApp, vault: DeviceVault): Promise<VaultDescriptor> {
  const stages = stagesFromLock(shellLock());
  const menus = [vault.lock.detail.menu!, vault.lock.detail.rmenu[0]!, vault.lock.detail.rmenu[1]!];
  const out = [];
  for (const [i, stage] of stages.entries()) {
    if (!stage.menuR) throw new Error("Not a PQB v1 structure.");
    if ((await app.getMenuR(vault.v, i as 0 | 1 | 2)) !== menus[i].r) throw new Error(`The Ledger reports another r for stage ${i}.`);
    const variants = [];
    for (const variant of stage.menuR.variants) {
      const points = await app.getMenuPoints(vault.v, i as 0 | 1 | 2, (variant.add_n ? 2 : 0) | (variant.odd ? 1 : 0));
      if (points.length !== variant.points.length) throw new Error(`The Ledger returned the wrong number of points for stage ${i}.`);
      variants.push({ add_n: variant.add_n, odd: variant.odd, points: points.map((p) => secp256k1.Point.fromBytes(p).toHex(false)) });
    }
    out.push({ menu: { r_inv: String(stage.menuR.r_inv), variants } });
  }
  const publicStateJson = JSON.stringify({
    config: "PQB",
    version: CONSTRUCTION,
    full_script_hex: hex(vault.script),
    round_table: vault.lock.detail.dsig.map(hex),
    stages: out,
  });
  return { config: "PQB", scriptHex: hex(vault.script), scriptHash: hex(sha256(vault.script)), publicStateJson };
}

// ---- Withdrawal: qsb-app's pqbTransaction / pqbPacket / checkPqbHit (src/lib/pqb.ts), one input only.

function oneInputTransaction(m: Withdrawal, sequence: number, locktime: number): Tx {
  if (m.helper) throw new Error("A Ledger vault is withdrawn with one input; this withdrawal has a helper.");
  if (BigInt(m.funding.value) !== BigInt(m.outputValue) + BigInt(m.fee) || BigInt(m.outputValue) <= 0n || BigInt(m.fee) <= 0n)
    throw new Error("The withdrawal's amounts don't add up.");
  return {
    version: 1,
    locktime,
    vin: [{ txid: m.funding.txid, vout: m.funding.vout, sequence, scriptSig: new Uint8Array() }],
    vout: [{ value: BigInt(m.outputValue), script: fromHex(m.outputScript) }],
  };
}

type PublicState = { full_script_hex: string; round_table: string[]; stages: { menu: NonNullable<Packet["menu"]> }[] };

function packetFor(state: PublicState, m: Withdrawal, stage: number, solution: Solution): Packet {
  const nonce = stage ? pinNonceOf(solution.locktime, solution.sequence) : 0n;
  if (nonce === null) throw new Error("Invalid pinning nonce.");
  const [lt, seq] = pinFields(nonce);
  const used = stage === 2 ? solution.round1 : [];
  const live = Array.from({ length: 109 }, (_, j) => j).filter((j) => !used.includes(j));
  return {
    stage, kind: stage ? "round" : "pinning", predicate: "sha256", sha1_chain: false,
    scriptpubkey: state.full_script_hex, tx_template: hex(serializeTx(oneInputTransaction(m, seq, lt))),
    n_in: 0, hashtype: 1, only_33_byte_keys: stage === 2, ladder_levels: 0, verify_form: false,
    menu: state.stages[stage].menu,
    ...(stage ? { round_table: state.round_table, live_slots: live, used_slots: used, table_n: live.length,
      t: stage === 1 ? 8 : 9, deletions_before: [], pin_nonce: nonce.toString() } : {}),
  };
}

function checkHit(packet: Packet, line: string): SolvedStage {
  const parsed = parseHit(packet, line);
  const { digest, z } = evaluate(packet, parsed.nonce, parsed.variant, parsed.menuIndex, parsed.encoding, parsed.ladder);
  if (!digest || digest[0] !== 0x30 || digest[1] !== 0x1d || digest[2] !== 0x02 || !solves(packet, digest, z))
    throw new Error(`The solution for stage ${packet.stage} doesn't check out.`);
  return { ...parsed, stage: packet.stage, digest };
}

/** r and s of `DER || hashtype`. */
function derRs(sig: Bytes): [bigint, bigint] {
  const der = sig.subarray(0, -1);
  const rs = secp256k1.Signature.fromBytes(der, "der");
  return [rs.r, rs.s];
}

/**
 * The SDK's `authorizeWithdrawal` for a device-held vault: recheck the solution, have the device
 * build, show and authorize the withdrawal, verify everything it discloses, then assemble the
 * vault's scriptSig. Returns the complete transaction (the vault is its only input).
 */
export async function authorizeOnDevice(app: PqbApp, vault: DeviceVault, request: WithdrawalSigningRequest): Promise<string> {
  const { manifest: m, solution } = request.solved;
  const start = request.pqbStart;
  if (!start || !solution.pqb) throw new Error("This withdrawal has no PQB solution for a device.");
  if (request.vault.scriptHex !== hex(vault.script)) throw new Error("This withdrawal is for another vault.");
  const state = JSON.parse(request.vault.publicStateJson) as PublicState;
  const lines = [solution.pqb.pinning, solution.pqb.round0, solution.pqb.round1];
  const packets = new Map<number, Packet>();
  const solved = new Map<number, SolvedStage>();
  lines.forEach((line, stage) => {
    if (!line) throw new Error("The solution is incomplete.");
    const packet = packetFor(state, m, stage, solution);
    packets.set(stage, packet);
    solved.set(stage, checkHit(packet, line));
  });
  const plan = witnessPlan(vault.lock, packets, solved);
  const [locktime, sequence] = pinFields(plan.pinNonce!);
  const picks = [plan.menuPick.pin, plan.menuPick["0"], plan.menuPick["1"]] as [number, number, number];
  if (!plan.complete || sequence !== start.sequence || locktime !== start.locktime
    || JSON.stringify(plan.selection) !== JSON.stringify([start.round0, start.round1])
    || JSON.stringify(picks) !== JSON.stringify(start.picks))
    throw new Error("The solution doesn't match what the service asked the Ledger to sign.");

  const tx = oneInputTransaction(m, sequence, locktime);
  const unsigned = serializeTx(tx);
  if (hex(unsigned) !== request.transaction.toLowerCase()) throw new Error("The service's transaction isn't the one this solution signs.");

  // The device rebuilds the same T from these fields, shows it, records the disclosure, then releases it.
  const disclosure = await app.withdraw(
    vault.v,
    {
      round0: start.round0, round1: start.round1, picks,
      prevTx: fromHex(request.fundingPreviousTxHex), vout: m.funding.vout,
      version: tx.version, sequence, lockTime: locktime,
      outputs: tx.vout.map((o) => ({ amount: o.value, script: o.script })),
    },
    vault.commitments,
  );
  if (!equal(disclosure.transaction, unsigned)) throw new Error("The Ledger approved a different transaction.");

  const out = assembleDisclosed(vault, tx, { ...plan, pinNonce: plan.pinNonce! }, picks, disclosure);
  if (out.simError) throw new Error(`The withdrawal doesn't satisfy the vault script: ${out.simError}`);
  return out.hex;
}

type Plan = ReturnType<typeof witnessPlan> & { pinNonce: bigint };
type Disclosure = Awaited<ReturnType<PqbApp["withdraw"]>>;

/**
 * The vault's scriptSig from what the device disclosed: each item is put where pqb's assembler
 * expects it, and the co-signature is checked over the assembler's own sighash before it's used.
 * Exported for tests, which compare it with pqb's seed-based assembly.
 */
export function assembleDisclosed(vault: DeviceVault, tx: Tx, plan: Plan, picks: [number, number, number], disclosure: Disclosure) {
  const [round0, round1] = plan.selection;
  const detail = structuredClone(vault.lock.detail);
  round0.forEach((j, i) => (detail.wit[0][j] = disclosure.round0Preimages[i]));
  round1.forEach((j, i) => (detail.wit[1][j] = disclosure.round1Preimages[i]));
  [detail.menu!, detail.rmenu[0]!, detail.rmenu[1]!].forEach((menu, k) => {
    const g = disclosure.menuSignatures[k];
    const [r, s] = derRs(g);
    if (r !== menu.r) throw new Error(`The Ledger's menu signature for stage ${k} has the wrong r.`);
    menu.sigs[picks[k]] = g;
    menu.s[picks[k]] = s;
  });
  detail.cosig = { ...detail.cosig, pk: disclosure.Q };
  const filled: Lock = { ...vault.lock, detail };

  const cosign = (z: bigint) => {
    const sig = disclosure.cosignature;
    const [, s] = derRs(sig);
    const digest = fromHex(z.toString(16).padStart(64, "0"));
    if (sig[sig.length - 1] !== 0x01 || s > HALF_N
      || !secp256k1.verify(sig.subarray(0, -1), digest, disclosure.Q, { format: "der", prehash: false, lowS: true }))
      throw new Error("The Ledger's co-signature doesn't sign this transaction.");
    return sig;
  };
  const vin = tx.vin[0];
  return assemble(filled, { txid: vin.txid, vout: vin.vout, amount: 0 }, [], { ...plan, transaction: structuredClone(tx), inputIndex: 0, cosign });
}
