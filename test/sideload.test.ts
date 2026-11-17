// Run with: npm test
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { LoaderError, SecureChannel, deriveKey, openChannel, parseScript, sideload, type Send } from "../src/ledger/sideload.ts";

const here = (name: string) => new URL(name, import.meta.url);
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");
const bytes = (h: string) => Uint8Array.from(Buffer.from(h, "hex"));
const concat = (...parts: Uint8Array[]) => Uint8Array.from(Buffer.concat(parts));

// Vectors written by ledgerblue's own HexLoader (test/make-scp-vectors.py).
const vectors = JSON.parse(readFileSync(here("scp-vectors.json"), "utf8")) as {
  ledgerblue: string;
  cases: { secret: string; encKey: string; macKey: string; steps: { command: string; wrapped: string; answer?: string; wrappedAnswer?: string }[] }[];
};

test("key derivation matches ledgerblue", () => {
  for (const c of vectors.cases) {
    assert.equal(hex(deriveKey(bytes(c.secret), 0)), c.encKey);
    assert.equal(hex(deriveKey(bytes(c.secret), 1)), c.macKey);
  }
});

test("wrap and unwrap match ledgerblue across a chained session", () => {
  for (const c of vectors.cases) {
    const channel = new SecureChannel(bytes(c.secret));
    for (const step of c.steps) {
      assert.equal(hex(channel.wrap(bytes(step.command))), step.wrapped);
      if (step.wrappedAnswer) assert.equal(hex(channel.unwrap(bytes(step.wrappedAnswer))), step.answer);
    }
  }
});

test("a tampered answer is refused", () => {
  const c = vectors.cases[0];
  const channel = new SecureChannel(bytes(c.secret));
  channel.wrap(bytes(c.steps[0].command));
  channel.wrap(bytes(c.steps[1].command));
  const answer = bytes(c.steps[1].wrappedAnswer!);
  answer[0] ^= 1;
  assert.throws(() => channel.unwrap(answer), /integrity/);
});

/**
 * The device's half of the handshake and loader, written from ledgerblue's deployed.py: it checks
 * what a device checks (target, certificate roles and signatures) and decrypts what it is sent.
 */
function fakeDevice(targetId: number, options: { refuseAt?: number } = {}) {
  const deviceKey = secp256k1.utils.randomSecretKey();
  const ephemeral = secp256k1.utils.randomSecretKey();
  const deviceNonce = crypto.getRandomValues(new Uint8Array(8));
  const lv = (v: Uint8Array) => concat(Uint8Array.of(v.length), v);
  const sign = (m: Uint8Array, k: Uint8Array) => secp256k1.sign(m, k, { format: "der" });
  let nonce: Uint8Array | undefined, master: Uint8Array | undefined, hostEphemeral: Uint8Array | undefined;
  let channel: SecureChannel | undefined;
  const received: Uint8Array[] = [];
  const ok = (data: Uint8Array = new Uint8Array()) => ({ sw: 0x9000, data });
  const send: Send = async (apdu) => {
    assert.equal(apdu[0], 0xe0);
    assert.equal(apdu[4], apdu.length - 5);
    const [ins, p1] = [apdu[1], apdu[2]];
    const data = apdu.subarray(5);
    if (ins === 0x04) return new DataView(data.buffer, data.byteOffset).getUint32(0) === targetId ? ok() : { sw: 0x6a84, data: new Uint8Array() };
    if (ins === 0x50) {
      nonce = data.slice();
      return ok(concat(new Uint8Array(4), deviceNonce));
    }
    if (ins === 0x51) {
      const key = data.subarray(1, 1 + data[0]);
      const signature = data.subarray(2 + data[0]);
      assert.equal(signature.length, data[1 + data[0]]);
      if (p1 === 0x00) {
        assert.ok(secp256k1.verify(signature, concat(Uint8Array.of(0x01), key), key, { format: "der" }));
        master = key.slice();
      } else {
        assert.equal(p1, 0x80);
        assert.ok(secp256k1.verify(signature, concat(Uint8Array.of(0x11), nonce!, deviceNonce, key), master!, { format: "der" }));
        hostEphemeral = key.slice();
      }
      return ok();
    }
    if (ins === 0x52) {
      const header = Uint8Array.of(0x02, 0, 0, 0, 0);
      if (p1 === 0x00) {
        const pub = secp256k1.getPublicKey(deviceKey, false);
        return ok(concat(lv(header), lv(pub), lv(sign(concat(Uint8Array.of(0x02), header, pub), deviceKey))));
      }
      const pub = secp256k1.getPublicKey(ephemeral, false);
      return ok(concat(lv(new Uint8Array()), lv(pub), lv(sign(concat(Uint8Array.of(0x12), deviceNonce, nonce!, pub), deviceKey))));
    }
    if (ins === 0x53) {
      channel = new SecureChannel(sha256(secp256k1.getSharedSecret(ephemeral, hostEphemeral!, true)));
      return ok();
    }
    assert.equal(ins, 0x00);
    if (received.length === options.refuseAt) return { sw: 0x5501, data: new Uint8Array() };
    received.push(channel!.unwrap(data).slice());
    return ok();
  };
  return { send, received };
}

test("the handshake and load deliver the builder's commands to the device unchanged", async () => {
  const text = readFileSync(here("nanosplus.apdu"), "utf8");
  const script = parseScript(text);
  const device = fakeDevice(0x33100004);
  const seen: number[] = [];
  await sideload(device.send, 0x33100004, script, (f) => seen.push(f));
  assert.deepEqual(device.received.map(hex), text.trim().split("\n").map((line) => line.slice(10)));
  assert.equal(seen.at(-1), 1);
  assert.equal(hex(script[0]), "0c03505142"); // delete any installed "PQB" first
  assert.equal(script[1][0], 0x0b); // create app
  assert.equal(hex(script.at(-1)!), "09"); // commit
});

test("a refusal surfaces the status word and stage", async () => {
  const script = parseScript(readFileSync(here("nanosplus.apdu"), "utf8"));
  await assert.rejects(sideload(fakeDevice(0x33200004).send, 0x33100004, script), (e) => e instanceof LoaderError && e.statusWord === 0x6a84 && e.stage === "channel");
  await assert.rejects(sideload(fakeDevice(0x33100004, { refuseAt: 1 }).send, 0x33100004, script), (e) => e instanceof LoaderError && e.statusWord === 0x5501 && e.stage === "load");
});

test("the channel refuses a key exchange the device key didn't sign", async () => {
  const device = fakeDevice(0x33100004);
  const send: Send = async (apdu) => {
    const answer = await device.send(apdu);
    if (apdu[1] === 0x52 && apdu[2] === 0x80) answer.data[answer.data.length - 3] ^= 1;
    return answer;
  };
  await assert.rejects(openChannel(send, 0x33100004), /verify|DER|signature/i);
});

test("parseScript rejects anything that isn't a loader command", () => {
  assert.throws(() => parseScript("e0010000020102"), /loader command/);
  assert.throws(() => parseScript("e000000003aabb"), /length/);
  assert.throws(() => parseScript(""), /empty/);
});
