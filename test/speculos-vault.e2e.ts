// End-to-end against Speculos for a vault held on the Ledger: allocate, read it the way the site
// does, export the solver data, sign a sweep into it, then disclose for a withdrawal and retry.
//
// DISPOSABLE SEEDS ONLY. These tests create a vault, sign a sweep and disclose its one-time
// secrets (WITHDRAW). The emulator's record of that disclosure is thrown away with the container,
// so a real Ledger with the same seed would not know the vault is exposed. `npm run test:speculos`
// runs this file last, on Nano S Plus only, in its own Speculos started with a fresh random
// mnemonic, and sets SPECULOS_DISPOSABLE_SEED=1 for that run only. Without it this file refuses.
//
// Approvals are automated through Speculos's API (screen text and buttons), as in speculos.e2e.ts.
// The tests share one Speculos and run in order: each builds on the state the previous one left.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { DeviceManagementKitBuilder, DeviceModelId, type DeviceManagementKit } from "@ledgerhq/device-management-kit";
import { speculosIdentifier, speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { p2wpkh } from "@scure/btc-signer";
import { firstValueFrom, timeout } from "rxjs";
import { assembleDisclosed, descriptorFor, readDeviceVault, type DeviceVault } from "../src/qsb/deviceVault.ts";
import { openSession, type Device } from "../src/ledger/session.ts";
import { hex } from "../src/vendor/pqb-core/primitives.ts";
import { pinFields } from "../src/vendor/pqb-core/spend.ts";
import { serializeTx as serializeCoreTx, type Tx as CoreTx } from "../src/vendor/pqb-core/tx.ts";
import { INS, PqbStatusError, STATUS, type PqbApp, type WithdrawResult } from "../src/vendor/pqb-ledger/app.ts";
import { concat, serializeOutputs, serializeTx, txidInternal, u32le, u64le, type TxOutput } from "../src/vendor/pqb-ledger/tx.ts";

const url = process.env.SPECULOS_URL;
const device = process.env.SPECULOS_DEVICE ?? "nanosplus";
const disposable = process.env.SPECULOS_DISPOSABLE_SEED === "1";
const manifest = JSON.parse(readFileSync(new URL("../public/firmware/manifest.json", import.meta.url), "utf8")) as { app: string };

let sdk: DeviceManagementKit;
let ledger: Device;

before(async () => {
  // Refuse before connecting: nothing here may run against a seed anyone keeps.
  assert.ok(
    disposable,
    "Refusing to run: these tests disclose a vault's one-time secrets. Run them through npm run test:speculos, " +
      "which starts a Speculos with a fresh random seed for them (SPECULOS_DISPOSABLE_SEED=1).",
  );
  assert.equal(device, "nanosplus", "The approval automation is for Nano S Plus.");
  assert.ok(url, "Set SPECULOS_URL, or run npm run test:speculos.");
  sdk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(url, true, DeviceModelId.NANO_SP)).build();
  const found = await firstValueFrom(sdk.startDiscovering({ transport: speculosIdentifier }).pipe(timeout(15_000)));
  await sdk.stopDiscovering();
  const sessionId = await sdk.connect({ device: found });
  ledger = openSession(sdk, sessionId, { appName: manifest.app, install: "sideload", firmwareBase: "" });
  assert.equal(await ledger.openApp(() => {}), true);
});

after(async () => {
  await ledger?.disconnect();
  sdk?.close();
});

// ---- Speculos: screen text and buttons ------------------------------------------------------

const speculos = (path: string, body?: unknown) =>
  fetch(url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
/** The current screen's text, one entry per text event (roughly one per line). */
const lines = async () =>
  ((await (await speculos("/events?stream=false&currentscreenonly=true")).json()) as { events: { text: string }[] }).events.map((e) => e.text);
const press = (button: "right" | "both") => speculos(`/button/${button}`, { action: "press-and-release" });
const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Waits for a page whose text matches `start` (never pressing anything on the home screen), then
 * scrolls right until a line matches `target` and presses both buttons on it.
 */
async function answer(start: RegExp, target: RegExp, waitMs = 60_000) {
  const seen: string[] = [];
  const note = (text: string) => seen.at(-1) !== text && seen.push(text);
  const deadline = Date.now() + waitMs;
  for (;;) {
    const now = await lines();
    note(now.join(" | "));
    if (start.test(now.join(" ")) || now.some((l) => target.test(l))) break;
    if (Date.now() > deadline) throw new Error(`Never saw ${start} on the device. Screens: ${seen.join(" / ")}`);
    await pause(200);
  }
  for (let i = 0; i < 60; i++) {
    const now = await lines();
    note(now.join(" | "));
    if (now.some((l) => target.test(l))) {
      await press("both");
      // Disposable seed only: its fingerprints and addresses are safe to show.
      if (process.env.SPECULOS_SHOW_SCREENS) console.log(`screens: ${seen.join(" / ")}`);
      return seen;
    }
    await press("right");
    await pause(250);
  }
  throw new Error(`Never reached ${target} on the device. Screens: ${seen.join(" / ")}`);
}

/** The NBGL Nano screens these tests answer (app-qsb app/src/ui.rs). */
const SCREENS = {
  firstUse: [/First PQB vault/, /^Yes, first use$/],
  create: [/Create PQB vault/, /^Create$/],
  exportPoints: [/Export solver data/, /^Export$/],
  sweep: [/Review transaction/, /^Sign transaction/],
  withdraw: [/Withdraw from/, /^Disclose$/],
  // An action page with one button ("Back"): both buttons as soon as it shows.
  conflict: [/already/, /already/],
} as const satisfies Record<string, readonly [RegExp, RegExp]>;
const on = (screen: keyof typeof SCREENS) => answer(...SCREENS[screen]);

const run = <T>(work: (app: PqbApp) => Promise<T>) => ledger.use("", () => {}, work);

/** This seed's records, through the client the site uses (251 bytes each, per docs/apdu.md). */
const records = () => run((app) => app.getRecords());

// ---- Bitcoin helpers ------------------------------------------------------------------------

const hash256 = (b: Uint8Array) => sha256(sha256(b));
const p2wpkhScript = (publicKey: Uint8Array) => p2wpkh(publicKey).script;

/** BIP-143 SIGHASH_ALL digest of input `i` spending a P2WPKH output of `amount` by `publicKey`. */
function bip143(tx: { version: number; inputs: { txid: Uint8Array; vout: number; sequence: number }[]; outputs: TxOutput[]; lockTime: number },
  i: number, publicKey: Uint8Array, amount: bigint) {
  const outpoint = (x: { txid: Uint8Array; vout: number }) => concat(x.txid, u32le(x.vout));
  const pkh = p2wpkhScript(publicKey).subarray(2);
  const scriptCode = concat(Uint8Array.of(0x19, 0x76, 0xa9, 0x14), pkh, Uint8Array.of(0x88, 0xac));
  const input = tx.inputs[i];
  return hash256(
    concat(
      u32le(tx.version),
      hash256(concat(...tx.inputs.map(outpoint))),
      hash256(concat(...tx.inputs.map((x) => u32le(x.sequence)))),
      outpoint(input),
      scriptCode,
      u64le(amount),
      u32le(input.sequence),
      hash256(serializeOutputs(tx.outputs)),
      u32le(tx.lockTime),
      u32le(1),
    ),
  );
}

// ---- The vault's life, in order ---------------------------------------------------------------

let v: number;
let vault: DeviceVault;
let deposit: { publicKey: Uint8Array; address: string };
/** The signed sweep's bytes (witness-free; the device hashes it to its txid) and its vault output. */
let sweep: { raw: Uint8Array; value: bigint };
const DEPOSIT_VALUE = 100_000n;
const SWEEP_FEE = 1_000n;
const WITHDRAW_FEE = 2_000n;

test("ALLOCATE on a fresh seed: first use, then create", async () => {
  const before = await run((app) => app.getState());
  assert.equal(before.records, 0, "a fresh Speculos holds no vault records");
  const [allocated] = await Promise.all([
    run((app) => app.allocate()),
    (async () => {
      await on("firstUse");
      await on("create");
    })(),
  ]);
  // next_v starts at 0 in a fresh namespace; an index failing the DER screen would be skipped.
  assert.ok(Number.isInteger(allocated.v) && allocated.v >= 0 && allocated.v < 4, `v = ${allocated.v}`);
  v = allocated.v;
  const held = await records();
  assert.equal(held.length, 1);
  assert.equal(held[0].v, v);
  assert.equal(held[0].state, "allocated");
  assert.equal(hex(held[0].root), hex(allocated.root));
  assert.equal(hex(held[0].scriptHash), hex(allocated.scriptHash));
  const info = await run((app) => app.getVault(v));
  assert.equal(info.status, "allocated");
  assert.equal(info.funded, false);
});

test("readDeviceVault reproduces the real app's script byte for byte", async () => {
  // The site's pqb shell with the device's 154 commitments swapped in must equal GET_SCRIPT, and
  // the script hash and root must match GET_VAULT; readDeviceVault throws otherwise.
  vault = await run((app) => readDeviceVault(app, v));
  assert.equal(vault.v, v);
  assert.equal(vault.commitments.length, 154);
  assert.equal(vault.script.length, 4696);
  const info = await run((app) => app.getVault(v));
  assert.equal(hex(sha256(vault.script)), hex(info.scriptHash));
  assert.equal(vault.lock.sha256, hex(info.scriptHash));
});

test("menu points: authorized on the device, then the descriptor qsb-app registers", async () => {
  // Without the authorization the points are refused.
  await assert.rejects(
    run((app) => app.getMenuPoints(v, 0, 0)),
    (e) => e instanceof PqbStatusError && e.statusWord === STATUS.MENU_POINTS_UNAUTHORIZED,
  );
  await Promise.all([run((app) => app.authorizeMenuPoints(v)), on("exportPoints")]);
  const descriptor = await run((app) => descriptorFor(app, vault));
  assert.equal(descriptor.config, "PQB");
  assert.equal(descriptor.scriptHex, hex(vault.script));
  assert.equal(descriptor.scriptHash, hex(sha256(vault.script)));
  const state = JSON.parse(descriptor.publicStateJson) as {
    config: string;
    version: string;
    full_script_hex: string;
    round_table: string[];
    stages: { menu: { r_inv: string; variants: { add_n: boolean; odd: boolean; points: string[] }[] } }[];
  };
  assert.equal(state.config, "PQB");
  assert.equal(state.version, "v1");
  assert.equal(state.full_script_hex, hex(vault.script));
  assert.equal(state.round_table.length, 109);
  assert.equal(state.stages.length, 3);
  assert.deepEqual(state.stages.map((s) => s.menu.variants.length), [2, 4, 4]);
  for (const [i, width] of [12, 16, 16].entries()) {
    for (const variant of state.stages[i].menu.variants) {
      assert.equal(variant.points.length, width);
      // Uncompressed, on the curve.
      for (const p of variant.points) secp256k1.Point.fromHex(p).assertValidity();
    }
    assert.ok(BigInt(state.stages[i].menu.r_inv) > 0n);
  }
});

test("SIGN_DEPOSIT: a sweep into the vault, approved, verifies under the deposit key", async () => {
  deposit = await run((app) => app.getDepositAddress(v));
  assert.match(deposit.address, /^bc1q[02-9ac-hj-np-z]{38}$/, "a mainnet P2WPKH address");
  assert.equal(p2wpkh(deposit.publicKey).address, deposit.address);

  // A synthetic payment to the deposit address, from an outpoint that never existed.
  const prev = serializeTx({
    version: 2,
    inputs: [{ txid: sha256(Uint8Array.of(0x51, v)), vout: 1, scriptSig: new Uint8Array(), sequence: 0xfffffffd }],
    outputs: [{ amount: DEPOSIT_VALUE, script: p2wpkhScript(deposit.publicKey) }],
    lockTime: 0,
  });
  const unsigned = {
    version: 2,
    inputs: [{ txid: txidInternal(prev), vout: 0, scriptSig: new Uint8Array(), sequence: 0xfffffffd }],
    outputs: [{ amount: DEPOSIT_VALUE - SWEEP_FEE, script: vault.script }],
    lockTime: 0,
  };
  const raw = serializeTx(unsigned);
  const [signatures] = await Promise.all([run((app) => app.signSweep(v, raw, [prev])), on("sweep")]);
  assert.equal(signatures.length, 1);
  const signature = signatures[0];
  assert.equal(signature.at(-1), 0x01, "SIGHASH_ALL");
  const digest = bip143(unsigned, 0, deposit.publicKey, DEPOSIT_VALUE);
  assert.ok(secp256k1.verify(signature.subarray(0, -1), digest, deposit.publicKey, { format: "der", prehash: false, lowS: true }));
  // Not over another amount: the device proved it from the previous transaction.
  assert.ok(!secp256k1.verify(signature.subarray(0, -1), bip143(unsigned, 0, deposit.publicKey, DEPOSIT_VALUE + 1n), deposit.publicKey, { format: "der", prehash: false }));
  sweep = { raw, value: DEPOSIT_VALUE - SWEEP_FEE };

  const info = await run((app) => app.getVault(v));
  assert.equal(info.funded, true);
  const [record] = await records();
  assert.equal(hex(record.funding!.txid), hex(txidInternal(raw)));
  assert.equal(record.funding!.value, sweep.value);
});

// The withdrawal: any valid selection and picks. Nothing is solved, so the script won't accept it.
const ROUND0 = [2, 7, 19, 30, 44, 61, 85, 104];
const ROUND1 = [0, 5, 13, 26, 39, 52, 70, 91, 108];
const PICKS: [number, number, number] = [6, 13, 2];
const PIN_NONCE = 987_654_321n;
let first: WithdrawResult;

function withdrawal(round0 = ROUND0, round1 = ROUND1) {
  const [lockTime, sequence] = pinFields(PIN_NONCE);
  const output = { amount: sweep.value - WITHDRAW_FEE, script: p2wpkhScript(deposit.publicKey) };
  const request = { round0, round1, picks: PICKS, prevTx: sweep.raw, vout: 0, version: 1, sequence, lockTime, outputs: [output] };
  // The same T in pqb-core's form, for the assembler.
  const tx: CoreTx = {
    version: 1,
    locktime: lockTime,
    vin: [{ txid: hex(txidInternal(sweep.raw).reverse()), vout: 0, sequence, scriptSig: new Uint8Array() }],
    vout: [{ value: output.amount, script: output.script }],
  };
  return { request, tx };
}

test("WITHDRAW: the disclosure verifies and assembles into the vault's scriptSig", async () => {
  const { request, tx } = withdrawal();
  // app.withdraw checks every disclosed item against the commitments before returning.
  let screens: string[];
  [first, screens] = await Promise.all([run((app) => app.withdraw(v, request, vault.commitments)), on("withdraw")]);
  assert.ok(screens.some((s) => /Final: no fee bump/.test(s)), "reviewed as a first disclosure");
  assert.equal(hex(first.transaction), hex(serializeCoreTx(tx)));

  const plan = {
    pinNonce: PIN_NONCE, selection: [ROUND0, ROUND1], menuPick: { pin: PICKS[0], "0": PICKS[1], "1": PICKS[2] },
    hashPick: {}, puzzleKeys: {}, complete: true, stages: 3,
  };
  // Throws unless the co-signature signs this transaction under the disclosed Q.
  const out = assembleDisclosed(vault, tx, plan as Parameters<typeof assembleDisclosed>[2], PICKS, first);
  assert.ok(out.tx.vin[0].scriptSig.length > 0, "input 0 has the vault's scriptSig");
  assert.ok(out.scriptSig.length > 0);
  // No puzzle was solved (the selection, picks and pin are arbitrary), so this is not a valid
  // withdrawal on chain. But pqb's simulator treats OP_CHECKSIG/OP_CHECKMULTISIG as passing
  // (src/vendor/pqb-core/sim.ts) and checks everything else, so a clean run means every disclosed
  // preimage and menu signature sits where the script hashes it and matches its commitment.
  assert.equal(out.simError, null);

  const info = await run((app) => app.getVault(v));
  assert.equal(info.status, "exposed");
  const [record] = await records();
  assert.equal(record.state, "exposed");
  assert.deepEqual(record.disclosure?.round0, ROUND0);
  assert.deepEqual(record.disclosure?.round1, ROUND1);
  assert.deepEqual(record.disclosure?.picks, PICKS);
  assert.equal(hex(record.disclosure!.binding), hex(first.binding));
  assert.equal(hex(record.disclosure!.digest), hex(first.digest));
});

test("WITHDRAW again: other indices are refused, the exact request is a retry", async () => {
  const other = withdrawal([1, 7, 19, 30, 44, 61, 85, 104], [0, 5, 13, 26, 39, 52, 70, 91, 107]);
  const [refused] = await Promise.allSettled([run((app) => app.withdraw(v, other.request, vault.commitments)), on("conflict")]);
  assert.equal(refused.status, "rejected");
  assert.ok(refused.reason instanceof PqbStatusError && refused.reason.statusWord === STATUS.CONFLICT, String(refused.reason));

  // The exact request: approved again, the same release.
  const { request } = withdrawal();
  const [again, screens] = await Promise.all([run((app) => app.withdraw(v, request, vault.commitments)), on("withdraw")]);
  assert.ok(screens.some((s) => /Retry of the recorded/.test(s)), "reviewed as a retry");
  assert.deepEqual(again, first);
  assert.equal((await run((app) => app.getVault(v))).status, "exposed");
});
