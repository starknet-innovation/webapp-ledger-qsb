// The device path (src/qsb/deviceVault.ts) against pqb's own seed-based path, byte for byte.
// A fake device answers from a full pqb lock built from a random seed, the way the PQB Ledger app
// derives a vault; the device path never sees that lock's secrets except what a disclosure carries.
// Run with: npm test
import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { CONSTRUCTION, assembleDisclosed, descriptorFor, readDeviceVault } from "../src/qsb/deviceVault.ts";
import { stagesFromLock } from "../src/vendor/pqb-core/grind.ts";
import { buildLock, type Lock } from "../src/vendor/pqb-core/lock.ts";
import { hex } from "../src/vendor/pqb-core/primitives.ts";
import { assemble, cosigSign, pinFields } from "../src/vendor/pqb-core/spend.ts";
import { serializeTx, type Tx } from "../src/vendor/pqb-core/tx.ts";
import type { PqbApp } from "../src/vendor/pqb-ledger/app.ts";
import { commitmentRoot, legacySighashAll, verifyDisclosure, withdrawalTx } from "../src/vendor/pqb-ledger/pqb.ts";

const seed = crypto.getRandomValues(new Uint8Array(32));
const full = buildLock("PQB", seed, { version: CONSTRUCTION });
const d = full.detail;
const menus = [d.menu!, d.rmenu[0]!, d.rmenu[1]!];
const commitments = [...d.comm, ...d.menu!.comm, ...d.rmenu[0]!.comm, ...d.rmenu[1]!.comm, d.cosig.h160];

/** Answers like the PQB Ledger app for vault 7 of this seed. */
const device = {
  async getCommitments() {
    return commitments.map((c) => c.slice());
  },
  async getVault() {
    return { root: commitmentRoot(commitments), scriptHash: sha256(full.script), status: "allocated", funded: false };
  },
  async getScript() {
    return full.script.slice();
  },
  async getMenuR(_v: number, stage: number) {
    return menus[stage].r;
  },
  async getMenuPoints(_v: number, stage: number, variant: number) {
    const st = stagesFromLock(full)[stage];
    const found = st.menuR!.variants.find((x) => ((x.add_n ? 2 : 0) | (x.odd ? 1 : 0)) === variant)!;
    return found.points.map((p) => secp256k1.Point.fromHex(p).toBytes(true));
  },
} as unknown as PqbApp;

/** What qsb-app registers for this seed: src/lib/pqb.ts publicState(lock). */
function qsbAppPublicState(lock: Lock) {
  return JSON.stringify({
    config: "PQB",
    version: lock.version,
    full_script_hex: hex(lock.script),
    round_table: lock.detail.dsig.map(hex),
    stages: stagesFromLock(lock).map((st) => ({
      menu: { r_inv: st.menuR!.r_inv.toString(), variants: st.menuR!.variants.map((v) => ({ add_n: v.add_n, odd: v.odd, points: v.points })) },
    })),
  });
}

test("the device's vault is this construction with its commitments swapped in", async () => {
  const vault = await readDeviceVault(device, 7);
  assert.equal(hex(vault.script), hex(full.script));
  assert.equal(vault.lock.sha256, full.sha256);
  // No secret of the seed made it into the device-path lock.
  assert.equal(vault.lock.detail.cosig.d, 0n);
  assert.ok(vault.lock.detail.wit.flat().every((w) => w.length === 0));
});

test("the descriptor is the one qsb-app builds from the seed", async () => {
  const vault = await readDeviceVault(device, 7);
  const descriptor = await descriptorFor(device, vault);
  assert.equal(descriptor.config, "PQB");
  assert.equal(descriptor.scriptHex, hex(full.script));
  assert.equal(descriptor.scriptHash, full.sha256);
  assert.equal(descriptor.publicStateJson, qsbAppPublicState(full));
});

test("a script from another construction is refused", async () => {
  const other = buildLock("PQB", seed, { version: "v0" });
  const wrong = { ...device, getScript: async () => other.script, getVault: async () => ({ root: commitmentRoot(commitments), scriptHash: sha256(other.script) }) } as unknown as PqbApp;
  await assert.rejects(readDeviceVault(wrong, 7), /construction/);
});

test("the withdrawal assembled from a disclosure equals pqb's from the seed", async () => {
  const vault = await readDeviceVault(device, 7);
  // Any selection, picks and pin: this checks the assembly, not a solved puzzle.
  const round0 = [3, 11, 20, 33, 47, 58, 70, 99];
  const round1 = [0, 5, 18, 26, 41, 66, 80, 91, 108];
  const picks: [number, number, number] = [4, 9, 15];
  const pinNonce = 123456789n;
  const [locktime, sequence] = pinFields(pinNonce);
  const tx: Tx = {
    version: 1, locktime,
    vin: [{ txid: "ab".repeat(32), vout: 1, sequence, scriptSig: new Uint8Array() }],
    vout: [{ value: 90_000n, script: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(7)) }],
  };
  const plan = {
    pinNonce, selection: [round0, round1], menuPick: { pin: picks[0], "0": picks[1], "1": picks[2] },
    hashPick: {}, puzzleKeys: {}, complete: true, stages: 3,
  };

  // The device's T and disclosure, as the app computes them.
  const t = withdrawalTx({
    version: 1, prevTxid: Uint8Array.from(Buffer.from("ab".repeat(32), "hex")).reverse(), vout: 1, sequence, lockTime: locktime,
    outputs: [{ amount: 90_000n, script: tx.vout[0].script }],
  });
  assert.equal(hex(t), hex(serializeTx(tx)));
  const z = BigInt("0x" + hex(legacySighashAll(t, full.script)));
  const disclosure = {
    round0Preimages: round0.map((j) => d.wit[0][j]),
    round1Preimages: round1.map((j) => d.wit[1][j]),
    menuSignatures: menus.map((m, k) => m.sigs[picks[k]]) as [Uint8Array, Uint8Array, Uint8Array],
    cosignature: cosigSign(d.cosig.d, z),
    Q: d.cosig.pk,
    transaction: t, binding: sha256(t), digest: new Uint8Array(32),
  };
  verifyDisclosure(commitments, { round0, round1, picks }, t, disclosure);

  const ours = assembleDisclosed(vault, tx, plan, picks, disclosure);
  const theirs = assemble(full, { txid: "ab".repeat(32), vout: 1, amount: 0 }, [], { ...plan, transaction: structuredClone(tx), inputIndex: 0 });
  assert.equal(ours.hex, theirs.hex);
  assert.equal(ours.simError, theirs.simError);
});

test("a co-signature over another transaction is refused", async () => {
  const vault = await readDeviceVault(device, 7);
  const round0 = [0, 1, 2, 3, 4, 5, 6, 7];
  const round1 = [8, 9, 10, 11, 12, 13, 14, 15, 16];
  const picks: [number, number, number] = [0, 0, 0];
  const [locktime, sequence] = pinFields(1n);
  const tx: Tx = { version: 1, locktime, vin: [{ txid: "cd".repeat(32), vout: 0, sequence, scriptSig: new Uint8Array() }],
    vout: [{ value: 1000n, script: Uint8Array.of(0x00, 0x14, ...new Uint8Array(20).fill(1)) }] };
  const disclosure = {
    round0Preimages: round0.map((j) => d.wit[0][j]), round1Preimages: round1.map((j) => d.wit[1][j]),
    menuSignatures: menus.map((m) => m.sigs[0]) as [Uint8Array, Uint8Array, Uint8Array],
    cosignature: cosigSign(d.cosig.d, 42n), Q: d.cosig.pk,
    transaction: new Uint8Array(), binding: new Uint8Array(), digest: new Uint8Array(),
  };
  assert.throws(
    () => assembleDisclosed(vault, tx, { pinNonce: 1n, selection: [round0, round1], menuPick: { pin: 0, "0": 0, "1": 0 }, hashPick: {}, puzzleKeys: {}, complete: true, stages: 3 }, picks, disclosure),
    /co-signature/,
  );
});
