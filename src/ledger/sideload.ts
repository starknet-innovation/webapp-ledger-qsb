// Installs an app that isn't in Ledger's catalog, by speaking the device's own loader protocol.
//
// A TypeScript port of the host side of Ledger's Python tool ledgerblue 0.1.58 (Apache-2.0):
// `deployed.py` getDeployedSecretV2 (the secure-channel handshake) and `hexLoader.py`
// scp_derive_key / scpWrap / scpUnwrap (SCP v3 encryption and MAC). The load itself is not
// re-implemented: Ledger's builder (`cargo ledger build`) already writes the cleartext loader
// commands to `<app>.apdu` (ledgerblue's `--offline` output), and this file encrypts and sends them.
//
// The host signs the channel with a throwaway key, so the device asks its owner to allow an
// "unsafe manager" and marks the app as not verified by Ledger.
//
// This module imports only npm packages, so `node --test` can load it directly.
import { cbc } from "@noble/ciphers/aes.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";

/** Sends one raw APDU and returns the status word and the data before it. */
export type Send = (apdu: Uint8Array) => Promise<{ sw: number; data: Uint8Array }>;

export type Stage = "channel" | "load";

/** The device answered with an error status word. */
export class LoaderError extends Error {
  readonly statusWord: number;
  readonly stage: Stage;
  constructor(statusWord: number, stage: Stage) {
    super(`The Ledger refused (0x${statusWord.toString(16).padStart(4, "0")}).`);
    this.statusWord = statusWord;
    this.stage = stage;
  }
}

const SW_OK = 0x9000;
const MAC_LENGTH = 14;
const ZERO_IV = new Uint8Array(16);

const concat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
};
const u32be = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n >>> 0);
  return out;
};
const equal = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);
const lv = (value: Uint8Array) => concat(Uint8Array.of(value.length), value);
const apdu = (ins: number, p1: number, data: Uint8Array = new Uint8Array()) =>
  concat(Uint8Array.of(0xe0, ins, p1, 0x00, data.length), data);
const aes = (key: Uint8Array, iv: Uint8Array) => cbc(key, iv, { disablePadding: true });
/** DER ECDSA over sha256(message), low S, as the device expects on certificates. */
const sign = (message: Uint8Array, secretKey: Uint8Array) => secp256k1.sign(message, secretKey, { format: "der" });

/**
 * ledgerblue's scp_derive_key (SCP v3 with an ECDH secret): d = sha256(index ‖ retry ‖ secret),
 * retried until it is a valid scalar; the key is the first 16 bytes of sha256(d·G, uncompressed).
 */
export function deriveKey(secret: Uint8Array, index: number): Uint8Array {
  for (let retry = 0; ; retry++) {
    const d = sha256(concat(u32be(index), Uint8Array.of(retry), secret));
    if (!secp256k1.utils.isValidSecretKey(d)) continue;
    return sha256(secp256k1.getPublicKey(d, false)).subarray(0, 16);
  }
}

/** SCP v3: AES-CBC encryption and a truncated AES-CBC MAC, each with an IV chained across messages. */
export class SecureChannel {
  private readonly encKey: Uint8Array;
  private readonly macKey: Uint8Array;
  private encIv = ZERO_IV;
  private macIv = ZERO_IV;

  constructor(secret: Uint8Array) {
    this.encKey = deriveKey(secret, 0);
    this.macKey = deriveKey(secret, 1);
  }

  wrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    const padded = new Uint8Array(Math.ceil((data.length + 1) / 16) * 16);
    padded.set(data);
    padded[data.length] = 0x80;
    const encrypted = aes(this.encKey, this.encIv).encrypt(padded);
    this.encIv = encrypted.slice(-16);
    this.macIv = aes(this.macKey, this.macIv).encrypt(encrypted).slice(-16);
    return concat(encrypted, this.macIv.subarray(16 - MAC_LENGTH));
  }

  unwrap(data: Uint8Array): Uint8Array {
    if (data.length === 0) return data;
    const encrypted = data.subarray(0, data.length - MAC_LENGTH);
    if (data.length <= MAC_LENGTH || encrypted.length % 16 !== 0) throw new Error("Malformed answer from the Ledger.");
    this.macIv = aes(this.macKey, this.macIv).encrypt(encrypted).slice(-16);
    if (!equal(this.macIv.subarray(16 - MAC_LENGTH), data.subarray(data.length - MAC_LENGTH)))
      throw new Error("The Ledger's answer failed its integrity check.");
    const decrypted = aes(this.encKey, this.encIv).decrypt(encrypted);
    this.encIv = encrypted.slice(-16);
    const end = decrypted.lastIndexOf(0x80);
    if (end < 0) throw new Error("Malformed answer from the Ledger.");
    return decrypted.subarray(0, end);
  }
}

/** Reads `length ‖ value` fields one after another. */
function fields(data: Uint8Array, count: number): Uint8Array[] {
  const out: Uint8Array[] = [];
  let offset = 0;
  for (let i = 0; i < count; i++) {
    const length = data[offset];
    if (length === undefined || offset + 1 + length > data.length) throw new Error("Malformed certificate from the Ledger.");
    out.push(data.subarray(offset + 1, offset + 1 + length));
    offset += 1 + length;
  }
  return out;
}

/**
 * The mutual-authentication handshake (ledgerblue getDeployedSecretV2). The device asks its owner
 * to allow this host while it handles the ephemeral certificate, so that exchange can take a while.
 * `random` is injectable for tests.
 */
export async function openChannel(
  send: Send,
  targetId: number,
  random: (length: number) => Uint8Array = (n) => crypto.getRandomValues(new Uint8Array(n)),
): Promise<SecureChannel> {
  if ((targetId & 0xf) < 3) throw new Error("This Ledger model is too old for this installer.");
  const ask = async (ins: number, p1: number, data?: Uint8Array) => {
    const answer = await send(apdu(ins, p1, data));
    if (answer.sw !== SW_OK) throw new LoaderError(answer.sw, "channel");
    return answer.data;
  };
  const secretKey = () => {
    for (;;) {
      const key = random(32);
      if (secp256k1.utils.isValidSecretKey(key)) return key;
    }
  };

  await ask(0x04, 0x00, u32be(targetId));

  const nonce = random(8);
  const info = await ask(0x50, 0x00, nonce);
  if (info.length < 12) throw new Error("Unexpected answer from the Ledger.");
  const deviceNonce = info.subarray(4, 12);

  // A throwaway signer: its self-signed certificate, then the ephemeral key it vouches for.
  const master = secretKey();
  const masterPublic = secp256k1.getPublicKey(master, false);
  await ask(0x51, 0x00, concat(lv(masterPublic), lv(sign(concat(Uint8Array.of(0x01), masterPublic), master))));

  const ephemeral = secretKey();
  const ephemeralPublic = secp256k1.getPublicKey(ephemeral, false);
  await ask(
    0x51,
    0x80,
    concat(lv(ephemeralPublic), lv(sign(concat(Uint8Array.of(0x11), nonce, deviceNonce, ephemeralPublic), master))),
  );

  // The device's certificate, then its ephemeral key signed by the device key.
  const [, devicePublic] = fields(await ask(0x52, 0x00), 3);
  const [, deviceEphemeral, signature] = fields(await ask(0x52, 0x80), 3);
  const signed = concat(Uint8Array.of(0x12), deviceNonce, nonce, deviceEphemeral);
  if (!secp256k1.verify(signature, signed, devicePublic, { format: "der", lowS: false }))
    throw new Error("The Ledger's key exchange didn't verify.");

  await ask(0x53, 0x00);
  // libsecp256k1's ECDH: sha256 of the compressed shared point.
  return new SecureChannel(sha256(secp256k1.getSharedSecret(ephemeral, deviceEphemeral, true)));
}

/**
 * The cleartext loader commands of a `.apdu` file: one hex APDU per line, each `E0 00 00 00 Lc data`.
 * Returns each command's data.
 */
export function parseScript(text: string): Uint8Array[] {
  const commands = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, i) => {
      if (!/^e0000000([0-9a-f]{2})+$/i.test(line)) throw new Error(`Line ${i + 1} isn't a loader command.`);
      const bytes = Uint8Array.from(line.match(/../g)!.map((b) => parseInt(b, 16)));
      const data = bytes.subarray(5);
      // Encryption adds up to 16 bytes of padding and the MAC; the result must fit one APDU.
      if (bytes[4] !== data.length || data.length === 0 || data.length > 224) throw new Error(`Line ${i + 1} has a bad length.`);
      return data;
    });
  if (commands.length === 0) throw new Error("The install file is empty.");
  return commands;
}

/** Opens the secure channel, then sends every loader command, encrypted. `progress` goes from 0 to 1. */
export async function sideload(
  send: Send,
  targetId: number,
  script: Uint8Array[],
  progress: (fraction: number) => void = () => {},
): Promise<void> {
  const channel = await openChannel(send, targetId);
  for (let i = 0; i < script.length; i++) {
    const answer = await send(apdu(0x00, 0x00, channel.wrap(script[i])));
    if (answer.sw !== SW_OK) throw new LoaderError(answer.sw, "load");
    channel.unwrap(answer.data);
    progress((i + 1) / script.length);
  }
}
