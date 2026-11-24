// The real backend's pure parts: the sweep's fee, the deposit signer, the browser stores and the
// step mapping. No network, no device.
import assert from "node:assert/strict";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { base64 } from "@scure/base";
import { NETWORK, Transaction, p2wpkh } from "@scure/btc-signer";

process.env.QSB_NETWORK ??= "mainnet";
const { feeRateText, localJournal, localPendingDeposits, minerRate, sweepQuote, sweepSigner, sweepVsize, vaultStep } = await import(
  "../src/qsb/ledgerBackend.ts"
);
const { shellLock } = await import("../src/qsb/deviceVault.ts");
const { Plain } = await import("../src/ledger/session.ts");

const SCRIPT_LEN = shellLock().script.length;
const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };

test("the PQB v1 vault script is 4,696 bytes", () => {
  assert.equal(SCRIPT_LEN, 4696);
});

test("sweep vsize and fee match the SDK's no-change funding estimate", () => {
  // fundingVsize(n, nested = false, 4696, change = false):
  // outputs = 8 + 3 + 4696 = 4707; base = 4 + 1 + 41n + 1 + 4707 + 4; witness = 2 + 108n.
  assert.equal(sweepVsize(1, SCRIPT_LEN), Math.ceil(((4 + 1 + 41 + 1 + 4707 + 4) * 4 + 2 + 108) / 4));
  assert.equal(sweepVsize(1, SCRIPT_LEN), 4786);
  assert.equal(sweepVsize(3, SCRIPT_LEN), 4922);

  // 1.5 sat/vB: fee = ceil(4786 * 1.5) = 7179, and everything else goes to the vault.
  const one = sweepQuote([100_000n], SCRIPT_LEN, 1500n);
  assert.deepEqual(one, { total: 100_000n, fee: 7179n, vsize: 4786, amount: 92_821n });
  const three = sweepQuote([50_000n, 30_000n, 20_000n], SCRIPT_LEN, 2000n);
  assert.deepEqual(three, { total: 100_000n, fee: 9844n, vsize: 4922, amount: 90_156n });
  // Millisat rounding goes up, as the SDK's (vsize * rate + 999) / 1000.
  assert.equal(sweepQuote([100_000n], SCRIPT_LEN, 1001n).fee, 4791n);
});

test("the estimate is an upper bound on a real signed sweep", () => {
  for (const n of [1, 3, 8]) {
    const keys = Array.from({ length: n }, () => secp256k1.utils.randomSecretKey());
    const tx = new Transaction(opts);
    for (const [i, key] of keys.entries()) {
      const pay = p2wpkh(secp256k1.getPublicKey(key, true), NETWORK);
      tx.addInput({ txid: sha256(Uint8Array.of(i)), index: 0, witnessUtxo: { amount: 10_000n, script: pay.script } });
    }
    tx.addOutput({ amount: 1_000n, script: new Uint8Array(SCRIPT_LEN).fill(0x51) });
    keys.forEach((key, i) => tx.signIdx(key, i));
    tx.finalize();
    assert.ok(tx.vsize <= sweepVsize(n, SCRIPT_LEN), `${n} inputs: ${tx.vsize} > ${sweepVsize(n, SCRIPT_LEN)}`);
    assert.ok(sweepVsize(n, SCRIPT_LEN) - tx.vsize <= n, "the bound is tight within a byte per input");
  }
});

test("the miner rate is MARA's minimum, rounded up to millisats", () => {
  assert.equal(minerRate({ submit_fee_rate: 1 }), 1000n);
  assert.equal(minerRate({ submit_fee_rate: 1, market_rate: 4.03 }), 4030n);
  assert.equal(minerRate({ submit_fee_rate: 2.5, market_rate: 1 }), 2500n);
  assert.equal(minerRate({ submit_fee_rate: 0 }), 1000n);
  assert.equal(feeRateText(4030n), "4.03");
  assert.equal(feeRateText(2000n), "2");
});

// ---- The signer. ----

const key = secp256k1.utils.randomSecretKey();
const publicKey = secp256k1.getPublicKey(key, true);
const deposit = { address: p2wpkh(publicKey, NETWORK).address!, publicKey };

function previousTx(value: bigint, salt: number) {
  const prev = new Transaction(opts);
  prev.addInput({ txid: sha256(Uint8Array.of(salt)), index: 0 });
  prev.addOutputAddress(deposit.address, value, NETWORK);
  return prev;
}

function sweepPsbt(outputs: number, values = [40_000n, 60_000n]) {
  const tx = new Transaction({ ...opts, version: 2 });
  values.forEach((value, i) => {
    const prev = previousTx(value, i);
    tx.addInput({
      txid: prev.id,
      index: 0,
      sequence: 0xfffffffe,
      nonWitnessUtxo: prev.unsignedTx,
      witnessUtxo: { amount: value, script: p2wpkh(publicKey, NETWORK).script },
    });
  });
  for (let i = 0; i < outputs; i++) tx.addOutput({ amount: 1_000n, script: new Uint8Array(SCRIPT_LEN).fill(0x51) });
  return base64.encode(tx.toPSBT());
}

const derSig = (i: number) => {
  const sig = secp256k1.sign(sha256(Uint8Array.of(i)), key, { prehash: false, format: "der" });
  return Uint8Array.of(...sig, 0x01);
};

function fakeDevice() {
  const calls: { hint: string; v: number; unsigned: Uint8Array; previous: Uint8Array[] }[] = [];
  const hints: string[] = [];
  const device = {
    async use<T>(hint: string, say: (h: string) => void, work: (app: never) => Promise<T>) {
      say(hint);
      const app = {
        async signSweep(v: number, unsigned: Uint8Array, previous: Uint8Array[]) {
          calls.push({ hint, v, unsigned, previous });
          return previous.map((_, i) => derSig(i));
        },
      };
      return work(app as never);
    },
  };
  return { device, calls, say: () => (h: string) => hints.push(h), hints };
}

test("the signer refuses a deposit with more than one output", async () => {
  const { device, calls, say } = fakeDevice();
  const signer = sweepSigner(device as never, 3, deposit, say);
  await assert.rejects(signer.signPsbt(deposit.address, sweepPsbt(2), [0, 1]), Plain);
  assert.equal(calls.length, 0, "the Ledger is never asked");
});

test("the signer refuses another address or a partial set of inputs", async () => {
  const { device, say } = fakeDevice();
  const signer = sweepSigner(device as never, 3, deposit, say);
  await assert.rejects(signer.signPsbt("bc1qother", sweepPsbt(1), [0, 1]));
  await assert.rejects(signer.signPsbt(deposit.address, sweepPsbt(1), [0]));
});

test("the signer has the Ledger sign the sweep and adds one partial signature per input", async () => {
  const { device, calls, say, hints } = fakeDevice();
  const signer = sweepSigner(device as never, 3, deposit, say);
  assert.equal(signer.publicKey, Buffer.from(publicKey).toString("hex"));
  const psbt = sweepPsbt(1);
  const out = Transaction.fromPSBT(base64.decode(await signer.signPsbt(deposit.address, psbt, [0, 1])), opts);
  const original = Transaction.fromPSBT(base64.decode(psbt), opts);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].v, 3);
  assert.deepEqual(calls[0].unsigned, original.unsignedTx);
  assert.equal(calls[0].previous.length, 2);
  assert.deepEqual(hints, ["Check the deposit on your Ledger, then approve."]);
  for (let i = 0; i < 2; i++) {
    const prev = Transaction.fromRaw(calls[0].previous[i], opts);
    assert.deepEqual(prev.id, original.getInput(i).txid && Buffer.from(original.getInput(i).txid!).toString("hex"));
    assert.deepEqual(out.getInput(i).partialSig, [[publicKey, derSig(i)]]);
  }
  assert.deepEqual(out.unsignedTx, original.unsignedTx, "the transaction is unchanged");
});

// ---- The browser stores. ----

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    map,
    storage: () => ({
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
    }),
  };
}

test("the journal claims once: same value again is fine, a different one throws", async () => {
  const { map, storage } = memoryStorage();
  const journal = localJournal(storage);
  assert.equal(await journal.get("qsb-intent:mainnet:ab"), undefined);
  await journal.claim("qsb-intent:mainnet:ab", "one");
  assert.equal(map.get("qsb-journal:qsb-intent:mainnet:ab"), "one");
  await journal.claim("qsb-intent:mainnet:ab", "one");
  await assert.rejects(journal.claim("qsb-intent:mainnet:ab", "two"), Plain);
  assert.equal(await journal.get("qsb-intent:mainnet:ab"), "one", "never overwritten");
});

test("the journal refuses to claim when the browser can't store", async () => {
  const broken = () => ({
    getItem: () => null,
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {},
  });
  await assert.rejects(localJournal(broken).claim("k", "v"), Plain);
  await assert.rejects(localJournal(() => undefined).get("k"), Plain);
});

test("pending deposits round-trip and survive a storage failure in memory", async () => {
  const { map, storage } = memoryStorage();
  const pending = localPendingDeposits(storage);
  const deposit = { txid: "aa".repeat(32), amount: "1000", rawTxHex: "0200" };
  await pending.set("vault", deposit);
  assert.deepEqual(JSON.parse(map.get("qsb-pending:vault")!), deposit);
  assert.deepEqual(await pending.get("vault"), deposit);
  await pending.delete("vault");
  assert.equal(await pending.get("vault"), undefined);

  const memoryOnly = localPendingDeposits(() => {
    throw new Error("SecurityError");
  });
  await memoryOnly.set("vault", deposit);
  assert.deepEqual(await memoryOnly.get("vault"), deposit);
});

// ---- Steps. ----

test("vault steps follow the vault, the deposit address and the newest withdrawal", () => {
  const step = (input: Parameters<typeof vaultStep>[0]) => vaultStep(input).step;
  assert.equal(step({ vault: null, waitingSats: 0n }), "awaiting-bitcoin");
  assert.equal(step({ vault: { status: "unfunded" }, waitingSats: 0n }), "awaiting-bitcoin");
  assert.equal(step({ vault: { status: "unfunded" }, waitingSats: 5n }), "ready-to-deposit");
  assert.equal(step({ vault: null, waitingSats: 5n }), "ready-to-deposit");
  assert.equal(step({ vault: { status: "unfunded" }, pendingDeposit: true, waitingSats: 5n }), "depositing");
  assert.equal(step({ vault: { status: "submitted" }, waitingSats: 0n }), "depositing");
  assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n }), "in-vault");
  for (const status of ["queued", "searching"])
    assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status } }), "searching");
  assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status: "awaiting_authorization" } }), "ready-to-approve");
  assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status: "awaiting_authorization" }, feeTooLow: true }), "waiting-for-fees");
  assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n, savedIntent: true }), "withdrawal-not-started");
  assert.equal(step({ vault: { status: "confirmed" }, waitingSats: 0n, fundingMismatch: true }), "failed");
  assert.equal(step({ vault: { status: "spent" }, waitingSats: 0n, job: { status: "confirmed" } }), "sent");
  assert.equal(step({ vault: { status: "spent" }, waitingSats: 0n }), "sent");

  const failed = vaultStep({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status: "failed", error: "GPU budget exhausted" } });
  assert.equal(failed.step, "failed");
  assert.match(failed.detail ?? "", /operator/);
  assert.doesNotMatch(failed.detail ?? "", /start the withdrawal again|try again/i, "a failed withdrawal can't be retried");
  assert.ok(vaultStep({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status: "failed" } }).detail);
});

test("a submitted withdrawal is sent only once QSB has it, and finished only once confirmed", () => {
  const submitted = { vault: { status: "confirmed" as const }, waitingSats: 0n, job: { status: "submitted" } };
  assert.equal(vaultStep(submitted).step, "checking-send", "nothing observed yet: not claimed as sent");
  assert.equal(vaultStep({ ...submitted, submission: { status: "uncertain" } }).step, "checking-send");
  assert.equal(vaultStep({ ...submitted, submission: { status: "submitted" } }).step, "sending");
  assert.equal(vaultStep({ ...submitted, submission: { status: "confirmed" } }).step, "sent");
  assert.equal(vaultStep({ ...submitted, submission: { status: "conflict" } }).step, "failed");
  assert.equal(vaultStep({ ...submitted, submission: { status: "submitted", alert: "foreign spend" } }).step, "failed");
  assert.equal(vaultStep({ ...submitted, job: { status: "confirmed" } }).step, "sent");
});

test("a paused search: the owner continues a plain or deployment pause, the operator handles the rest", () => {
  const paused = (error?: string) => vaultStep({ vault: { status: "confirmed" }, waitingSats: 0n, job: { status: "paused", error } });
  assert.deepEqual([paused().step, paused().canResume], ["paused", true]);
  assert.equal(paused("Mainnet disabled by deployment.").canResume, true);
  assert.equal(paused("Wallet is not allowed by deployment configuration.").canResume, true);
  for (const error of [
    "Submission outcome unknown. Reconcile compute provider before resuming.",
    "Mainnet disabled by deployment. Submission outcome unknown. Reconcile compute provider before resuming.",
    "Search range exhausted; a reviewed new range is required.",
    "GPU candidates failed independent CPU verification.",
    "Incomplete work unit. Resume repeats this bounded range; it has not been skipped.",
    "Owner GPU-time budget reached",
  ]) {
    const p = paused(error);
    assert.equal(p.step, "paused");
    assert.equal(p.canResume, false, error);
    assert.match(p.detail ?? "", /operator/);
  }
});

test("a refused deposit is shown on the deposit screen", () => {
  const s = vaultStep({ vault: { status: "unfunded" }, waitingSats: 100_000n, minimumSats: 50_000n, depositRejected: "fee too low" });
  assert.equal(s.step, "ready-to-deposit");
  assert.match(s.detail ?? "", /wasn't accepted \(fee too low\)/);
});

test("a deposit must leave a vault that can pay its withdrawal fee", async () => {
  const { minimumDeposit, withdrawalReserve, WITHDRAWAL_VSIZE, vaultStep: step } = await import("../src/qsb/ledgerBackend.ts");
  const { SCRIPT_LEN: len } = await import("../src/vendor/pqb-ledger/pqb.ts");
  // At 2 sat/vB the floor of 20 sat/vB applies: 1,695 × 20 + dust + the one-input sweep fee.
  const sweepFee = BigInt(Math.ceil(((4 + 1 + 41 + 1 + 8 + 3 + len + 4) * 4 + 2 + 108) / 4)) * 2n;
  assert.equal(withdrawalReserve(2_000n), BigInt(WITHDRAWAL_VSIZE) * 20n + 546n);
  assert.equal(minimumDeposit(len, 2_000n), BigInt(WITHDRAWAL_VSIZE) * 20n + 546n + sweepFee);
  // More inputs, a bigger sweep fee.
  assert.equal(minimumDeposit(len, 2_000n, 3) - minimumDeposit(len, 2_000n), sweepQuote([0n, 0n, 0n], len, 2_000n).fee - sweepFee);
  // At 10 sat/vB the margin applies: five times today's rate.
  assert.ok(minimumDeposit(len, 10_000n) > BigInt(WITHDRAWAL_VSIZE) * 50n);
  const minimumSats = minimumDeposit(len, 2_000n);
  assert.deepEqual(step({ vault: { status: "unfunded" }, waitingSats: minimumSats - 1n, minimumSats }).step, "awaiting-bitcoin");
  assert.match(step({ vault: { status: "unfunded" }, waitingSats: minimumSats - 1n, minimumSats }).detail ?? "", /not enough/);
  assert.equal(step({ vault: { status: "unfunded" }, waitingSats: minimumSats, minimumSats }).step, "ready-to-deposit");
  // What one sweep can take decides, not everything at the address.
  assert.equal(step({ vault: { status: "unfunded" }, waitingSats: minimumSats, sweepableSats: minimumSats - 1n, minimumSats }).step, "awaiting-bitcoin");
});

test("a withdrawal is quoted above MARA's floor: max(2 × floor, floor + 2 sat/vB), unless the vault can't pay it", async () => {
  const { withdrawalRate, withdrawalQuoteRate, intentRate, withdrawalVsizeFor, WITHDRAWAL_VSIZE } = await import("../src/qsb/ledgerBackend.ts");
  assert.equal(withdrawalRate(1_000n), 3_000n);
  assert.equal(withdrawalRate(2_000n), 4_000n);
  assert.equal(withdrawalRate(5_000n), 10_000n);
  assert.equal(withdrawalRate(500n), 3_000n, "never below 1 sat/vB");
  assert.equal(withdrawalVsizeFor(34), WITHDRAWAL_VSIZE);
  assert.equal(withdrawalVsizeFor(22), WITHDRAWAL_VSIZE - 12);
  assert.equal(withdrawalQuoteRate(5_000n, 1_000_000n, 22), 10_000n);
  assert.equal(withdrawalQuoteRate(5_000n, 15_000n, 22), 5_000n, "falls back to the floor");
  // The SDK's fee is ceil(vsize × rate): the intent's rate reads back at least the quoted rate.
  const fee = (BigInt(withdrawalVsizeFor(22)) * 4_321n + 999n) / 1000n;
  assert.ok(intentRate({ fee: fee.toString(), outputScript: "00".repeat(22) }) >= 4_321n);
});

// ---- Flows: the backend with a fake Ledger and a fake SDK client. ----

const { ledgerBackend, canonicalIntent, intentKey, reclaimProblem, withdrawalVsizeFor } = await import("../src/qsb/ledgerBackend.ts");
const { hex } = await import("@scure/base");

const BROADCAST_URL = "https://broadcast.test/api/tx";
const VAULT_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const SCRIPT_HASH = new Uint8Array(32).fill(0xab);
const FUNDING_TXID_INTERNAL = Uint8Array.from({ length: 32 }, (_, i) => i);
/** The service writes txids in display order: the reverse of the bytes. */
const FUNDING = { txid: hex.encode(Uint8Array.from(FUNDING_TXID_INTERNAL).reverse()), vout: 0, value: "500000" };
const DESTINATION = p2wpkh(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), NETWORK).address!;
const DEST_SCRIPT = hex.encode(p2wpkh(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), NETWORK).script);

type Flow = ReturnType<typeof flow>;

/** A manifest in an order the service might store it (DynamoDB keeps no key order). */
function manifestFor(feeRateMilli: bigint, overrides: Record<string, unknown> = {}) {
  const fee = (BigInt(withdrawalVsizeFor(22)) * feeRateMilli + 999n) / 1000n;
  return {
    fee: fee.toString(),
    idempotencyKey: JOB_ID,
    costAccepted: true as const,
    destination: DESTINATION,
    funding: { value: FUNDING.value, vout: FUNDING.vout, txid: FUNDING.txid },
    outputScript: DEST_SCRIPT,
    outputValue: (BigInt(FUNDING.value) - fee).toString(),
    solverReleaseId: "pqb-release-1",
    vaultId: VAULT_ID,
    ...overrides,
  };
}

/** The SDK's manifestHash: SHA-256 of the withdrawalSchema-ordered JSON, written out by hand here. */
function schemaOrderedJson(m: ReturnType<typeof manifestFor>) {
  return JSON.stringify({
    vaultId: m.vaultId,
    funding: { txid: m.funding.txid, vout: m.funding.vout, value: m.funding.value },
    destination: m.destination,
    outputScript: m.outputScript,
    outputValue: m.outputValue,
    fee: m.fee,
    idempotencyKey: m.idempotencyKey,
    costAccepted: m.costAccepted,
    solverReleaseId: m.solverReleaseId,
  });
}
const hashOf = (text: string) => hex.encode(sha256(new TextEncoder().encode(text)));

function flow(setup: {
  record?: { state?: "allocated" | "exposed" | "unknown"; funding?: { txid: Uint8Array; vout: number; value: bigint } | null };
  vault?: Record<string, unknown> | null;
  job?: Record<string, unknown> | null;
  rates?: { submit_fee_rate: number; market_rate?: number };
  utxos?: { txid: string; vout: number; value: string }[];
  status?: Record<string, unknown>;
  /** Previous transactions the service returns for /payment-input, by txid. */
  previous?: Map<string, Uint8Array>;
  /** The broadcast endpoint's answer to a raw transaction. */
  broadcast?: (rawHex: string) => Response;
}) {
  const { map, storage } = memoryStorage();
  const log: string[] = [];
  const hints: string[] = [];
  let signIns = 0;
  let persisted = 0;
  const record = {
    walletId: new Uint8Array(16),
    v: 0,
    state: setup.record?.state ?? "allocated",
    flags: 1,
    root: new Uint8Array(32).fill(7),
    scriptHash: SCRIPT_HASH,
    funding: setup.record?.funding === undefined ? { txid: FUNDING_TXID_INTERNAL, vout: 0, value: 500_000n } : setup.record.funding,
    sweepInput: new Uint8Array(36),
    disclosure: null,
  };
  const refundCalls: { v: number; unsigned: Uint8Array; previous: Uint8Array[] }[] = [];
  const broadcasts: string[] = [];
  const app = {
    async getRecords() {
      return [record];
    },
    async getDepositAddress() {
      return deposit;
    },
    // A Ledger holding the deposit key: real BIP-143 signatures over the streamed transaction.
    async signRefund(v: number, unsigned: Uint8Array, previous: Uint8Array[]) {
      refundCalls.push({ v, unsigned, previous });
      const tx = Transaction.fromRaw(unsigned, opts);
      for (let i = 0; i < tx.inputsLength; i++) {
        const input = tx.getInput(i);
        const prev = previous.map((raw) => Transaction.fromRaw(raw, opts)).find((p) => p.id === hex.encode(input.txid!))!;
        tx.updateInput(i, { witnessUtxo: prev.getOutput(input.index!) as { script: Uint8Array; amount: bigint } });
        tx.signIdx(key, i);
      }
      return Array.from({ length: tx.inputsLength }, (_, i) => tx.getInput(i).partialSig![0][1]);
    },
  };
  const device = {
    name: "fake",
    async use<T>(hint: string, _say: unknown, work: (a: never) => Promise<T>) {
      hints.push(hint);
      return work(app as never);
    },
    async signIn() {
      signIns++;
      // Slow enough that a second request would start its own sign-in without single-flight.
      await new Promise((r) => setTimeout(r, 5));
      return { address: deposit.address, signature: "sig" };
    },
  };
  const fetch = (async (url: string, init?: RequestInit) => {
    if (String(url) === BROADCAST_URL) {
      broadcasts.push(String(init?.body));
      return setup.broadcast ? setup.broadcast(String(init?.body)) : new Response(Transaction.fromRaw(hex.decode(String(init?.body)), opts).id);
    }
    if (String(url).endsWith("/payment-input")) {
      const headers = init?.headers as Record<string, string>;
      assert.equal(headers["X-Qsb-Authorization"], `Bearer ${"t".repeat(43)}`);
      const point = JSON.parse(String(init?.body));
      const raw = setup.previous?.get(point.txid);
      return raw ? new Response(JSON.stringify({ previousTxHex: hex.encode(raw) })) : new Response("{}", { status: 404 });
    }
    const body = String(url).endsWith("/auth/challenge") ? { id: "c", message: "sign me" } : { token: "t".repeat(43) };
    return new Response(JSON.stringify(body), { status: 200 });
  }) as unknown as typeof globalThis.fetch;
  const vault =
    setup.vault === null
      ? null
      : { id: VAULT_ID, config: "PQB", scriptHash: hex.encode(SCRIPT_HASH), scriptHex: "51".repeat(SCRIPT_LEN), status: "confirmed", funding: FUNDING, ...setup.vault };
  const job = setup.job === null || setup.job === undefined ? undefined : { id: JOB_ID, vaultId: VAULT_ID, createdAt: "2026-11-01T00:00:00Z", ...setup.job };
  const backend = ledgerBackend(device as never, {
    api: "https://qsb.test",
    broadcastUrl: BROADCAST_URL,
    storage,
    fetch,
    persist: () => void persisted++,
    client: (o) => {
      const auth = () => o.credentials.get();
      return {
        async utxos() {
          await auth();
          return setup.utxos ?? [];
        },
        async rates() {
          return setup.rates ?? { submit_fee_rate: 5 };
        },
        vaults: {
          async list() {
            await auth();
            return { vaults: vault ? [vault] : [] };
          },
        },
        deposits: {
          async resubmit() {
            log.push("resubmit");
            return { vault: { ...vault, status: "unfunded", funding: undefined }, submission: "rejected", reason: "fee too low" };
          },
        },
        withdrawals: {
          async list() {
            await auth();
            return job ? [job] : [];
          },
          async create(input: unknown) {
            log.push(`create ${JSON.stringify(input)}`);
            return { job: {} };
          },
          async status() {
            log.push("status");
            return setup.status ?? { job };
          },
          async resume() {
            log.push("resume");
            return { job };
          },
          async assemble() {
            log.push("assemble");
            // The real SDK checks the journal holds the exact intent before asking the Ledger.
            const saved = map.get(`qsb-journal:${intentKey(hex.encode(SCRIPT_HASH))}`);
            assert.equal(saved, job && canonicalIntent(job.manifest as never));
            return { jobId: JOB_ID, txid: "f".repeat(64) };
          },
          async submit(_signed: unknown, input: { approve: (r: { txid: string }) => string }) {
            log.push("submit");
            assert.equal(input.approve({ txid: "f".repeat(64) }), "f".repeat(64));
            // The service records the intent as submitted before its POST to the miner.
            Object.assign(job!, { status: "submitted", txid: "f".repeat(64) });
            return { txid: "f".repeat(64), status: "uncertain" };
          },
        },
      } as never;
    },
  });
  const journalKey = `qsb-journal:${intentKey(hex.encode(SCRIPT_HASH))}`;
  return { backend, map, log, hints, journalKey, refundCalls, broadcasts, signIns: () => signIns, persisted: () => persisted };
}
const quiet = () => {};
const withdrawHint = "Check the withdrawal on your Ledger, then approve.";

test("M1: a snapshot signs in once, though two requests need the session at the same time", async () => {
  const f = flow({ vault: { status: "unfunded", funding: undefined }, utxos: [{ txid: "aa".repeat(32), vout: 0, value: "1000" }] });
  await f.backend.snapshot(quiet);
  assert.equal(f.signIns(), 1);
  await f.backend.snapshot(quiet);
  assert.equal(f.signIns(), 1, "the session is reused");
});

test("H2: a saved intent is resumed with the vault only, never with a new destination or fee", async () => {
  const f = flow({ job: null });
  const m = manifestFor(10_000n);
  f.map.set(f.journalKey, schemaOrderedJson(m));
  const view = (await f.backend.snapshot(quiet)).vault!;
  assert.equal(view.step, "withdrawal-not-started");
  assert.equal(view.destination, DESTINATION);

  await f.backend.withdraw(DESTINATION, quiet);
  assert.deepEqual(f.log, [`create ${JSON.stringify({ vaultId: VAULT_ID, costAccepted: true })}`]);

  f.log.length = 0;
  const other = p2wpkh(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true), NETWORK).address!;
  await assert.rejects(f.backend.withdraw(other, quiet), /already set to withdraw to/);
  assert.deepEqual(f.log, [], "nothing is created for another address");
});

test("a new withdrawal is quoted at the margin rate, after the funding check", async () => {
  const f = flow({ job: null, rates: { submit_fee_rate: 5 } });
  await f.backend.withdraw(DESTINATION, quiet);
  assert.deepEqual(f.log, [`create ${JSON.stringify({ vaultId: VAULT_ID, destination: DESTINATION, feeRate: "10", costAccepted: true })}`]);
});

test("H2: a failed withdrawal isn't restarted: it needs the operator", async () => {
  const f = flow({ job: { status: "failed", error: "Search range exhausted", manifest: manifestFor(10_000n) } });
  assert.equal((await f.backend.snapshot(quiet)).vault!.step, "failed");
  await assert.rejects(f.backend.withdraw(DESTINATION, quiet), /operator/);
  assert.ok(!f.log.some((l) => l.startsWith("create")));
});

test("M2: below MARA's floor, the Ledger is never asked and the screen waits for fees", async () => {
  const m = manifestFor(3_000n);
  const f = flow({ job: { status: "awaiting_authorization", manifest: m, manifestHash: hashOf(schemaOrderedJson(m)) }, rates: { submit_fee_rate: 5 } });
  f.map.set(f.journalKey, schemaOrderedJson(m));
  assert.equal((await f.backend.snapshot(quiet)).vault!.step, "waiting-for-fees");
  await assert.rejects(f.backend.finishWithdrawal(quiet), /fees drop/);
  assert.deepEqual(f.log, [], "no assembly, no submission");
  assert.ok(!f.hints.includes(withdrawHint), "no Ledger approval");
});

test("M5: a deposit the Ledger didn't record stops before any search or approval", async () => {
  const other = { txid: new Uint8Array(32).fill(9), vout: 0, value: 500_000n };
  const fresh = flow({ job: null, record: { funding: other } });
  assert.equal((await fresh.backend.snapshot(quiet)).vault!.step, "failed");
  await assert.rejects(fresh.backend.withdraw(DESTINATION, quiet), /isn't the one your Ledger recorded/);
  assert.deepEqual(fresh.log, [], "no withdrawals.create");

  const m = manifestFor(10_000n);
  const ready = flow({ job: { status: "awaiting_authorization", manifest: m, manifestHash: hashOf(schemaOrderedJson(m)) }, record: { funding: other } });
  ready.map.set(ready.journalKey, schemaOrderedJson(m));
  await assert.rejects(ready.backend.finishWithdrawal(quiet), /isn't the one your Ledger recorded/);
  assert.deepEqual(ready.log, [], "no withdrawals.assemble");
});

test("H1: a withdrawal started elsewhere is taken back exactly from QSB's job, then approved", async () => {
  const m = manifestFor(10_000n);
  const f = flow({ job: { status: "awaiting_authorization", manifest: m, manifestHash: hashOf(schemaOrderedJson(m)) } });
  const view = (await f.backend.snapshot(quiet)).vault!;
  assert.equal(view.step, "ready-to-approve");
  assert.equal(view.fromElsewhere, true);
  assert.equal(view.destination, DESTINATION);

  await f.backend.finishWithdrawal(quiet);
  assert.equal(f.map.get(f.journalKey), schemaOrderedJson(m), "the SDK's exact journal value");
  assert.equal(f.persisted(), 1, "the browser is asked to keep the journal");
  assert.deepEqual(f.log, ["assemble", "submit"]);
  // Submit said "uncertain": the screen doesn't claim it was sent.
  assert.equal((await f.backend.snapshot(quiet)).vault!.step, "checking-send");
});

test("H1: a job that doesn't check out is never taken back", async () => {
  const m = manifestFor(10_000n);
  const tampered = flow({ job: { status: "awaiting_authorization", manifest: { ...m, destination: DESTINATION }, manifestHash: "00".repeat(32) } });
  assert.equal((await tampered.backend.snapshot(quiet)).vault!.step, "failed");
  await assert.rejects(tampered.backend.finishWithdrawal(quiet), /another browser/);
  assert.equal(tampered.map.get(tampered.journalKey), undefined);
  assert.deepEqual(tampered.log, []);

  const job = { id: JOB_ID, manifest: m, manifestHash: hashOf(schemaOrderedJson(m)) };
  const vault = { id: VAULT_ID, funding: FUNDING };
  const allocated = { state: "allocated" as const, funding: { txid: FUNDING_TXID_INTERNAL, vout: 0, value: 500_000n } };
  assert.equal(reclaimProblem(allocated, vault, job), undefined);
  assert.equal(reclaimProblem({ state: "allocated", funding: null }, vault, job), undefined);
  assert.equal(reclaimProblem({ ...allocated, state: "exposed" }, vault, job), undefined);
  assert.ok(reclaimProblem({ state: "exposed", funding: null }, vault, job), "exposed needs the same recorded funding");
  assert.ok(reclaimProblem({ ...allocated, state: "unknown" }, vault, job));
  assert.ok(reclaimProblem({ ...allocated, state: "retired" }, vault, job));
  assert.ok(reclaimProblem(allocated, { id: VAULT_ID, funding: { ...FUNDING, vout: 1 } }, job), "QSB's vault funding must match");
  assert.ok(reclaimProblem(allocated, vault, { ...job, id: "33333333-3333-4333-8333-333333333333" }));
});

test("canonicalIntent rebuilds the SDK's schema-ordered JSON from any key order", () => {
  const m = manifestFor(10_000n);
  assert.equal(canonicalIntent(m as never), schemaOrderedJson(m));
  const { solverReleaseId: _, ...noRelease } = m;
  assert.equal(canonicalIntent(noRelease as never), schemaOrderedJson(m).replace(',"solverReleaseId":"pqb-release-1"', ""));
});

test("M3: a submitted withdrawal follows QSB's status, and only confirmation finishes the vault", async () => {
  const m = manifestFor(10_000n);
  const base = { status: "submitted", manifest: m, manifestHash: hashOf(schemaOrderedJson(m)), txid: "f".repeat(64) };
  const uncertain = flow({ job: base, status: { job: base, submissionStatus: "uncertain" } });
  assert.equal((await uncertain.backend.snapshot(quiet)).vault!.step, "checking-send");
  const sending = flow({ job: base, status: { job: base, submissionStatus: "submitted" } });
  const view = (await sending.backend.snapshot(quiet)).vault!;
  assert.equal(view.step, "sending");
  assert.equal(view.txid, "f".repeat(64));
  const confirmed = flow({ job: base, status: { job: { ...base, status: "confirmed" }, includedTxid: "f".repeat(64) } });
  assert.equal((await confirmed.backend.snapshot(quiet)).vault!.step, "sent");
  // Checked at most once a minute.
  await sending.backend.snapshot(quiet);
  assert.deepEqual(sending.log, ["status"]);
});

test("M4: a paused search can be continued", async () => {
  const f = flow({ job: { status: "paused", manifest: manifestFor(10_000n) } });
  const view = (await f.backend.snapshot(quiet)).vault!;
  assert.deepEqual([view.step, view.canResume], ["paused", true]);
  await f.backend.resumeWithdrawal(quiet);
  assert.deepEqual(f.log, ["resume"]);

  const stuck = flow({ job: { status: "paused", error: "Submission outcome unknown. Reconcile compute provider before resuming.", manifest: manifestFor(10_000n) } });
  assert.equal((await stuck.backend.snapshot(quiet)).vault!.canResume, false);
  await assert.rejects(stuck.backend.resumeWithdrawal(quiet), /operator/);
  assert.deepEqual(stuck.log, []);
});

test("L2: a pending deposit is resent once per session, and a refusal is shown", async () => {
  const f = flow({ vault: { status: "unfunded", funding: undefined }, utxos: [{ txid: "aa".repeat(32), vout: 0, value: "500000" }] });
  f.map.set(`qsb-pending:${VAULT_ID}`, JSON.stringify({ txid: "aa".repeat(32), amount: "1000", rawTxHex: "02" }));
  const view = (await f.backend.snapshot(quiet)).vault!;
  assert.deepEqual(f.log, ["resubmit"]);
  // The fake's resubmit doesn't clear the pending copy (the SDK does on "rejected"); the refusal still shows.
  f.map.delete(`qsb-pending:${VAULT_ID}`);
  await f.backend.snapshot(quiet);
  assert.deepEqual(f.log, ["resubmit"], "not resent again");
  assert.equal(view.step, "depositing");
  const after = (await f.backend.snapshot(quiet)).vault!;
  assert.equal(after.step, "ready-to-deposit");
  assert.match(after.detail ?? "", /fee too low/);
});

test("M6: bitcoin left at the deposit address after the deposit is shown", async () => {
  const f = flow({ job: null, utxos: [{ txid: "cc".repeat(32), vout: 1, value: "12000" }] });
  assert.equal((await f.backend.snapshot(quiet)).vault!.leftoverSats, 12_000n);
  const none = flow({ job: null });
  assert.equal((await none.backend.snapshot(quiet)).vault!.leftoverSats, undefined);
});

// ---- Refunds. ----

const { refundVsize, refundQuote, refundableUtxos, refundScript, verifyRefund } = await import("../src/qsb/ledgerBackend.ts");
const { p2tr, p2pkh, Address, OutScript } = await import("@scure/btc-signer");
const P2TR_DESTINATION = p2tr(secp256k1.getPublicKey(secp256k1.utils.randomSecretKey(), true).subarray(1), undefined, NETWORK).address!;

test("a refund's vsize and fee: P2WPKH inputs, one output sized by the destination", () => {
  // n = 1 to P2WPKH (22-byte script): base = 4 + 1 + 41 + 1 + 8 + 1 + 22 + 4 = 82, witness = 2 + 108.
  assert.equal(refundVsize(1, 22), Math.ceil((82 * 4 + 110) / 4));
  assert.equal(refundVsize(1, 22), 110);
  // To P2TR (34-byte script): 12 bytes more.
  assert.equal(refundVsize(1, 34), 122);
  // Three inputs to P2TR: base = 4 + 1 + 123 + 1 + 8 + 1 + 34 + 4 = 176, witness = 2 + 324.
  assert.equal(refundVsize(3, 34), Math.ceil((176 * 4 + 326) / 4));
  assert.deepEqual(refundQuote([40_000n, 60_000n], 22, 2_500n), { total: 100_000n, fee: 445n, vsize: 178, amount: 99_555n });
  // n = 2 to P2WPKH: base = 4 + 1 + 82 + 1 + 8 + 1 + 22 + 4 = 123, witness = 2 + 216: ceil(710 / 4) = 178; 178 × 2.5 = 445.

  // An upper bound on a real signed refund, within a byte per input.
  for (const [n, to] of [[1, DESTINATION], [3, P2TR_DESTINATION], [8, DESTINATION]] as const) {
    const tx = new Transaction(opts);
    for (let i = 0; i < n; i++)
      tx.addInput({ txid: sha256(Uint8Array.of(i)), index: 0, witnessUtxo: { amount: 10_000n, script: p2wpkh(publicKey, NETWORK).script } });
    tx.addOutputAddress(to, 1_000n, NETWORK);
    for (let i = 0; i < n; i++) tx.signIdx(key, i);
    tx.finalize();
    const scriptLength = tx.getOutput(0).script!.length;
    assert.ok(tx.vsize <= refundVsize(n, scriptLength), `${n} inputs`);
    assert.ok(refundVsize(n, scriptLength) - tx.vsize <= n);
  }
});

test("a refund goes only to another valid mainnet address", () => {
  const own = { depositScript: p2wpkh(publicKey, NETWORK).script, vaultScript: new Uint8Array(SCRIPT_LEN).fill(0x51) };
  assert.equal(refundScript(DESTINATION, own).length, 22);
  assert.equal(refundScript(P2TR_DESTINATION, own).length, 34);
  assert.throws(() => refundScript(deposit.address, own), /own address/);
  for (const bad of ["", "bc1qnotanaddress", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx", "1BoatSLRHtKNngkdXEeobR76b53LETtpyX"])
    assert.throws(() => refundScript(bad, own), Plain, bad);
});

test("what's refundable leaves out a pending deposit's inputs, and keeps the 8 largest", () => {
  const utxos = Array.from({ length: 10 }, (_, i) => ({ txid: hex.encode(sha256(Uint8Array.of(i))), vout: i % 2, value: String((i + 1) * 1000) }));
  const picked = refundableUtxos(utxos, [{ txid: utxos[9].txid.toUpperCase(), vout: 1 }]);
  assert.equal(picked.length, 8);
  assert.ok(!picked.includes(utxos[9]), "the reserved output is left out");
  assert.deepEqual(picked.map((u) => u.value), ["9000", "8000", "7000", "6000", "5000", "4000", "3000", "2000"]);
});

/** Outputs at the deposit address, with the previous transactions the service holds for them. */
function depositOutputs(values: bigint[]) {
  const previous = new Map<string, Uint8Array>();
  const utxos = values.map((value, i) => {
    const prev = previousTx(value, 100 + i);
    previous.set(prev.id, prev.toBytes(true, true));
    return { txid: prev.id, vout: 0, value: value.toString() };
  });
  return { utxos, previous };
}

/** A signed deposit spending `inputs`, as the SDK keeps it. */
function pendingDepositSpending(inputs: { txid: string; vout: number }[]) {
  const tx = new Transaction({ ...opts, version: 2 });
  for (const i of inputs) tx.addInput({ txid: i.txid, index: i.vout });
  tx.addOutput({ amount: 1_000n, script: new Uint8Array(SCRIPT_LEN).fill(0x51) });
  return JSON.stringify({ txid: tx.id, amount: "1000", rawTxHex: hex.encode(tx.unsignedTx) });
}

test("nothing is refundable while a deposit is pending; a pending deposit's inputs are never refunded", async () => {
  const { utxos, previous } = depositOutputs([200_000n, 50_000n]);
  const depositing = flow({ vault: { status: "unfunded", funding: undefined }, record: { funding: null }, utxos, previous });
  depositing.map.set(`qsb-pending:${VAULT_ID}`, pendingDepositSpending([utxos[0]]));
  const view = (await depositing.backend.snapshot(quiet)).vault!;
  assert.equal(view.step, "depositing");
  assert.equal(view.refundableSats, undefined);
  depositing.map.set(`qsb-pending:${VAULT_ID}`, pendingDepositSpending([utxos[0]]));
  await assert.rejects(depositing.backend.refund(DESTINATION, quiet), /deposit is on its way/);
  assert.equal(depositing.refundCalls.length, 0);

  // A funded vault whose browser still holds the old deposit: its input stays out of a refund.
  const funded = flow({ job: null, utxos, previous });
  funded.map.set(`qsb-pending:${VAULT_ID}`, pendingDepositSpending([utxos[0]]));
  assert.equal((await funded.backend.snapshot(quiet)).vault!.refundableSats, 50_000n);
  await funded.backend.refund(DESTINATION, quiet);
  assert.deepEqual(Transaction.fromRaw(funded.refundCalls[0].unsigned, opts).getInput(0).txid, hex.decode(utxos[1].txid));

  // Before funding, with no deposit pending, everything there can go back.
  const unfunded = flow({ vault: { status: "unfunded", funding: undefined }, record: { funding: null }, utxos, previous });
  const ready = (await unfunded.backend.snapshot(quiet)).vault!;
  assert.equal(ready.refundableSats, 250_000n);
  // Dust after the fee: not offered.
  const dust = flow({ job: null, ...depositOutputs([700n]) });
  assert.equal((await dust.backend.snapshot(quiet)).vault!.refundableSats, undefined);
  await assert.rejects(dust.backend.refund(DESTINATION, quiet), /too little/);
});

test("a refund to the deposit address or a bad address never reaches the Ledger", async () => {
  const f = flow({ job: null, ...depositOutputs([100_000n]) });
  await assert.rejects(f.backend.refund(deposit.address, quiet), /own address/);
  await assert.rejects(f.backend.refund("bc1qnope", quiet), /isn't a Bitcoin address/);
  assert.equal(f.refundCalls.length, 0);
  assert.equal(f.broadcasts.length, 0);
});

test("a refund is signed on the Ledger, verified, broadcast, and shown until it confirms", async () => {
  const { utxos, previous } = depositOutputs([30_000n, 80_000n]);
  const f = flow({ job: null, utxos, previous, rates: { submit_fee_rate: 1, market_rate: 3.5 } });
  const { txid } = await f.backend.refund(P2TR_DESTINATION, quiet);
  assert.ok(f.hints.includes("Check the address and amount on your Ledger, then approve."));
  assert.equal(f.refundCalls.length, 1);
  assert.equal(f.broadcasts.length, 1);

  const tx = Transaction.fromRaw(hex.decode(f.broadcasts[0]), opts);
  assert.equal(tx.id, txid);
  assert.equal(tx.version, 2);
  assert.equal(tx.lockTime, 0);
  assert.equal(tx.inputsLength, 2);
  assert.equal(tx.outputsLength, 1);
  // Largest first; fee at the market rate (3.5 sat/vB) on the P2TR estimate.
  const fee = (BigInt(refundVsize(2, 34)) * 3_500n + 999n) / 1000n;
  assert.equal(tx.getOutput(0).amount, 110_000n - fee);
  assert.equal(hex.encode(tx.getOutput(0).script!), hex.encode(OutScript.encode(Address(NETWORK).decode(P2TR_DESTINATION))));
  for (let i = 0; i < 2; i++) {
    const input = tx.getInput(i);
    assert.equal(input.sequence, 0xfffffffd);
    const [signature, witnessKey] = input.finalScriptWitness!;
    assert.deepEqual(witnessKey, publicKey);
    const amount = BigInt(utxos.find((u) => u.txid === hex.encode(input.txid!))!.value);
    // BIP-143 over the P2PKH scriptCode, SIGHASH_ALL.
    const digest = tx.preimageWitnessV0(i, p2pkh(publicKey, NETWORK).script, 1, amount);
    assert.ok(secp256k1.verify(signature.subarray(0, -1), digest, publicKey, { prehash: false, format: "der" }), `input ${i}`);
  }
  assert.ok(f.map.has(`qsb-refund:${deposit.address}`), "kept in localStorage");

  // Until it confirms, the snapshot shows it and nothing else is refundable or waiting.
  const view = (await f.backend.snapshot(quiet)).vault!;
  assert.equal(view.refundTxid, txid);
  assert.equal(view.refundableSats, undefined);
  assert.equal(view.leftoverSats, undefined);
  await assert.rejects(f.backend.refund(P2TR_DESTINATION, quiet), /already sent back/);

  // Confirmed: its inputs left the deposit address, and it's forgotten.
  utxos.length = 0;
  const after = (await f.backend.snapshot(quiet)).vault!;
  assert.equal(after.refundTxid, undefined);
  assert.ok(!f.map.has(`qsb-refund:${deposit.address}`));
});

test("a failed broadcast is retried with the same bytes, without asking the Ledger again", async () => {
  let fail = true;
  const { utxos, previous } = depositOutputs([100_000n]);
  const f = flow({
    job: null,
    utxos,
    previous,
    broadcast: (raw) => (fail ? new Response("Service Unavailable", { status: 503 }) : new Response(Transaction.fromRaw(hex.decode(raw), opts).id)),
  });
  await assert.rejects(f.backend.refund(DESTINATION, quiet), (e: Error) => e instanceof Plain && /same transaction is resent/.test(e.message) && !!e.cause);
  assert.equal((await f.backend.snapshot(quiet)).vault!.refundTxid, undefined, "not shown as sent");
  await assert.rejects(f.backend.refund(P2TR_DESTINATION, quiet), /already approved sending it back to/);
  fail = false;
  const { txid } = await f.backend.refund(DESTINATION, quiet);
  assert.equal(f.refundCalls.length, 1, "one Ledger approval");
  assert.equal(f.broadcasts.length, 2);
  assert.equal(f.broadcasts[1], f.broadcasts[0], "identical bytes");
  assert.equal((await f.backend.snapshot(quiet)).vault!.refundTxid, txid);
});

test("a broadcast that answers another txid is refused", async () => {
  const f = flow({ job: null, ...depositOutputs([100_000n]), broadcast: () => new Response("ab".repeat(32)) });
  await assert.rejects(f.backend.refund(DESTINATION, quiet), /different transaction/);
  assert.equal((await f.backend.snapshot(quiet)).vault!.refundTxid, undefined);
});

test("verifyRefund refuses a signature by another key", () => {
  const tx = new Transaction(opts);
  tx.addInput({ txid: sha256(Uint8Array.of(1)), index: 0, witnessUtxo: { amount: 10_000n, script: p2wpkh(publicKey, NETWORK).script } });
  tx.addOutputAddress(DESTINATION, 9_000n, NETWORK);
  const signed = Transaction.fromRaw(tx.unsignedTx, opts);
  signed.updateInput(0, { witnessUtxo: { amount: 10_000n, script: p2wpkh(publicKey, NETWORK).script } });
  signed.signIdx(key, 0);
  const good = signed.getInput(0).partialSig![0][1];
  verifyRefund(tx, publicKey, [good]);
  const other = secp256k1.utils.randomSecretKey();
  const forged = Transaction.fromRaw(tx.unsignedTx, opts);
  forged.updateInput(0, { witnessUtxo: { amount: 10_000n, script: p2wpkh(secp256k1.getPublicKey(other, true), NETWORK).script } });
  forged.signIdx(other, 0);
  assert.throws(() => verifyRefund(tx, publicKey, [forged.getInput(0).partialSig![0][1]]), /doesn't verify/);
});
