// The part of the PQB Ledger app's protocol this front end uses: status, a vault's deposit
// address, and signing the QSB service's sign-in challenge as that address.
// Protocol: https://github.com/starknet-innovation/app-qsb/blob/main/docs/apdu.md
// The full client (vault creation, deposit signing, withdrawals) is app-qsb's clients/js.
import type { Send } from "./sideload.ts";

const CLA = 0xe0;
const INS = { GET_VERSION: 0x03, GET_DEPOSIT_ADDRESS: 0x13, GET_STATE: 0x14, SIGN_IN: 0x31 } as const;
const CHUNK = 255;
/** The longest sign-in challenge the app takes. */
const SIGN_IN_MAX = 512;
/** The app doesn't know the instruction: it predates SIGN_IN. */
export const SW_UNKNOWN_INS = 0x6d00;
const SW_OK = 0x9000;
/** The device was showing a status screen and didn't take the command; safe to resend. */
const SW_NOT_ACCEPTED = 0x6901;

export class PqbStatusError extends Error {
  readonly statusWord: number;
  constructor(statusWord: number) {
    super(`The app on your Ledger refused the request (0x${statusWord.toString(16).padStart(4, "0")}).`);
    this.statusWord = statusWord;
  }
}

export type AppStatus = {
  /** The app's version, e.g. "0.2.0". */
  version: string;
  /** The derivation profile it implements, e.g. "PQB-v1". */
  profile: string;
  /** Vault records this Ledger holds for its current seed. */
  vaults: number;
  /** The app can sign in to the QSB service (SIGN_IN, app-qsb after 0.2.0). */
  signIn: boolean;
};

const u32be = (n: number) => Uint8Array.of(n >>> 24, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff);

export class PqbApp {
  private readonly send: Send;
  constructor(send: Send) {
    this.send = send;
  }

  private async exchange(ins: number, p1: number, data: Uint8Array = new Uint8Array()): Promise<Uint8Array> {
    const apdu = new Uint8Array(5 + data.length);
    apdu.set([CLA, ins, p1, 0x00, data.length]);
    apdu.set(data, 5);
    for (let attempt = 0; ; attempt++) {
      const { sw, data: response } = await this.send(apdu);
      if (sw === SW_NOT_ACCEPTED && attempt < 20) {
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      if (sw !== SW_OK) throw new PqbStatusError(sw);
      return response;
    }
  }

  /** Vault `v`'s deposit address and its compressed public key. Read-only. */
  async depositAddress(v: number): Promise<{ address: string; publicKey: Uint8Array }> {
    const r = await this.exchange(INS.GET_DEPOSIT_ADDRESS, 0, u32be(v));
    if (r.length < 34 || r.length !== 34 + r[33]) throw new Error("Unexpected deposit address answer from the device.");
    return { publicKey: r.slice(0, 33), address: new TextDecoder().decode(r.subarray(34)) };
  }

  /**
   * Signs the QSB service's sign-in challenge as vault `v`'s deposit address, once the user
   * approves it on the device. Returns the address and the BIP-322 "simple" signature (base64) to
   * send to `/v1/auth/verify`. The app signs only that challenge, for that address.
   */
  async signIn(v: number, message: string): Promise<{ address: string; signature: string }> {
    const bytes = new TextEncoder().encode(message);
    if (bytes.length < 1 || bytes.length > SIGN_IN_MAX) throw new Error("That isn't a QSB sign-in challenge.");
    const { address, publicKey } = await this.depositAddress(v);
    const data = new Uint8Array(6 + bytes.length);
    data.set(u32be(v));
    data.set([bytes.length >> 8, bytes.length & 0xff], 4);
    data.set(bytes, 6);
    let signature: Uint8Array = new Uint8Array();
    for (let i = 0; i < data.length; i += CHUNK)
      signature = await this.exchange(INS.SIGN_IN, i === 0 ? 0x00 : 0x80, data.subarray(i, i + CHUNK));
    if (signature.length < 9 || signature.length > 73 || signature[0] !== 0x30 || signature[signature.length - 1] !== 0x01)
      throw new Error("Malformed signature from the device.");
    // BIP-322 "simple": the witness [signature, public key], serialized.
    const witness = new Uint8Array([2, signature.length, ...signature, publicKey.length, ...publicKey]);
    return { address, signature: btoa(String.fromCharCode(...witness)) };
  }

  async status(): Promise<AppStatus> {
    const version = await this.exchange(INS.GET_VERSION, 0);
    if (version.length < 4) throw new Error("Unexpected version answer from the device.");
    // wallet id (16) ‖ namespace (1) ‖ next_v (4) ‖ records (1) ‖ capacity (1)
    const state = await this.exchange(INS.GET_STATE, 0);
    if (state.length !== 23) throw new Error("Unexpected state answer from the device.");
    // A continuation with no first chunk: an app with SIGN_IN refuses it as out of order (0xB001)
    // without showing anything; an older one doesn't know the instruction (0x6D00).
    let signIn = true;
    try {
      await this.exchange(INS.SIGN_IN, 0x80, Uint8Array.of(0));
    } catch (error) {
      if (!(error instanceof PqbStatusError)) throw error;
      signIn = error.statusWord !== SW_UNKNOWN_INS;
    }
    return {
      signIn,
      version: `${version[0]}.${version[1]}.${version[2]}`,
      profile: new TextDecoder().decode(version.subarray(3)),
      vaults: state[21],
    };
  }
}
