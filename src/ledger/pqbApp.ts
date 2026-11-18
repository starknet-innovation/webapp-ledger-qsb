// The read-only part of the PQB Ledger app's protocol that this front end uses today.
// Protocol: https://github.com/starknet-innovation/app-qsb/blob/main/docs/apdu.md
// The full client (vault creation, deposit signing, withdrawals) is app-qsb's clients/js.
import type { Send } from "./sideload.ts";

const CLA = 0xe0;
const INS = { GET_VERSION: 0x03, GET_STATE: 0x14 } as const;
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
};

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

  async status(): Promise<AppStatus> {
    const version = await this.exchange(INS.GET_VERSION, 0);
    if (version.length < 4) throw new Error("Unexpected version answer from the device.");
    // wallet id (16) ‖ namespace (1) ‖ next_v (4) ‖ records (1) ‖ capacity (1)
    const state = await this.exchange(INS.GET_STATE, 0);
    if (state.length !== 23) throw new Error("Unexpected state answer from the device.");
    return {
      version: `${version[0]}.${version[1]}.${version[2]}`,
      profile: new TextDecoder().decode(version.subarray(3)),
      vaults: state[21],
    };
  }
}
