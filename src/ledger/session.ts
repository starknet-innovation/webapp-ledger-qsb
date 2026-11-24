// One connected Ledger, whatever the transport: WebHID in the browser, Speculos in tests.
// Imports no browser-only module, so Node can run it (tests load it with tsx).
import {
  DeviceActionStatus,
  GetOsVersionCommand,
  GoToDashboardDeviceAction,
  InstallAppDeviceAction,
  OpenAppDeviceAction,
  UserInteractionRequired,
  isSuccessCommandResult,
  type DeviceManagementKit,
} from "@ledgerhq/device-management-kit";
import { PqbApp, PqbStatusError } from "../vendor/pqb-ledger/app.ts";
import { LoaderError, parseScript, sideload, type Send } from "./sideload.ts";

/** Tells the user what to do on the device right now; "" clears it. */
export type Say = (hint: string) => void;

/** The PQB Ledger app's client (app-qsb clients/js, vendored in src/vendor/pqb-ledger). */
export type { PqbApp };
export { PqbStatusError };

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

/** The app doesn't know the instruction: it predates it. */
const SW_UNKNOWN_INS = 0x6d00;
/** The user rejected on the device. */
const SW_DENY = 0x6985;

export interface Device {
  readonly name: string;
  /** Opens the app. False when it isn't installed. */
  openApp(say: Say): Promise<boolean>;
  /**
   * Installs the app: from Ledger's catalog when `install` is "catalog", otherwise by loading the
   * build served at `firmwareBase`. `progress` goes from 0 to 1.
   */
  install(progress: (fraction: number) => void, say: Say): Promise<void>;
  /** What the open app says about itself. The app must be open. */
  status(): Promise<AppStatus>;
  /** Vault `v`'s deposit address. Read-only, no approval. The app must be open. */
  depositAddress(v: number): Promise<{ address: string }>;
  /**
   * Runs `work` with the PQB app's client while the kit's background polling is paused, showing
   * `hint` (what to do on the Ledger) until it finishes. A rejection on the device becomes a
   * Plain "You declined" error, an app without the command a Plain "out of date" one; other
   * errors pass through. The app must be open.
   */
  use<T>(hint: string, say: Say, work: (app: PqbApp) => Promise<T>): Promise<T>;
  /**
   * Signs the QSB service's sign-in challenge as vault `v`'s deposit address, after the user
   * approves it on the Ledger. Returns the address and the BIP-322 signature. The app must be open.
   */
  signIn(v: number, message: string, say: Say): Promise<{ address: string; signature: string }>;
  disconnect(): Promise<void>;
}

export type SessionOptions = {
  /** The app's name on the Ledger. */
  appName: string;
  install: "catalog" | "sideload";
  /** Where `manifest.json` and the install files are served, ending with "/". */
  firmwareBase: string;
};

/** An error whose message is already written for the user. */
export class Plain extends Error {}

const text = (error: unknown) => {
  if (error instanceof Error) return error.message;
  const e = error as { message?: unknown; originalError?: { message?: unknown }; _tag?: unknown };
  return [e?._tag, e?.message, e?.originalError?.message].filter((x) => typeof x === "string").join(" ");
};

/** What a loader status word means for the user. Codes as Ledger Live names them. */
function refusal(statusWord: number): string {
  switch (statusWord) {
    case 0x5501:
    case 0x6985:
      return "You declined on your Ledger. Try again when you're ready.";
    case 0x5515:
    case 0x6982:
      return "Your Ledger is locked. Unlock it and try again.";
    case 0x5102:
    case 0x5103:
    case 0x6a84:
    case 0x6a85:
      return "Your Ledger is full. Remove an app you don't use (your funds stay safe), then try again.";
    default:
      return `Your Ledger didn't accept the QSB app (code ${statusWord.toString(16)}). Update your Ledger in Ledger Live, then try again.`;
  }
}

type Manifest = { devices: Record<string, { file: string; sha256: string }> };

/** The install commands for this Ledger model, from the build served with the site. */
async function firmwareFor(base: string, targetId: number) {
  const get = async (name: string) => {
    const response = await fetch(base + name, { cache: "no-cache" }).catch(() => undefined);
    if (!response?.ok) throw new Plain("Couldn't download the QSB app. Check your internet connection and try again.");
    return response;
  };
  const manifest = (await (await get("manifest.json")).json()) as Manifest;
  const entry = manifest.devices[`0x${targetId.toString(16).padStart(8, "0")}`];
  if (!entry) throw new Plain("The QSB app isn't available for this Ledger model yet.");
  const bytes = new Uint8Array(await (await get(entry.file)).arrayBuffer());
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  if (Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("") !== entry.sha256)
    throw new Plain("The QSB app download was damaged. Try again.");
  return parseScript(new TextDecoder().decode(bytes));
}

/** Wraps a connected session. */
export function openSession(sdk: DeviceManagementKit, sessionId: string, options: SessionOptions): Device {
  const { name, modelId } = sdk.getConnectedDevice({ sessionId });
  const hints: Partial<Record<UserInteractionRequired, string>> = {
    [UserInteractionRequired.UnlockDevice]: "Unlock your Ledger.",
    [UserInteractionRequired.AllowSecureConnection]: "On your Ledger, allow Ledger Manager.",
    [UserInteractionRequired.ConfirmOpenApp]: `On your Ledger, confirm opening ${options.appName}.`,
  };

  type Action = Parameters<typeof sdk.executeDeviceAction>[0]["deviceAction"];
  const run = (deviceAction: Action, say: Say, progress?: (fraction: number) => void) =>
    new Promise<void>((resolve, reject) => {
      const { observable } = sdk.executeDeviceAction({ sessionId, deviceAction });
      observable.subscribe({
        next: (state) => {
          if (state.status === DeviceActionStatus.Pending) {
            const value = state.intermediateValue as { requiredUserInteraction?: UserInteractionRequired; progress?: number };
            say((value.requiredUserInteraction && hints[value.requiredUserInteraction]) || "");
            if (typeof value.progress === "number") progress?.(value.progress);
          } else if (state.status === DeviceActionStatus.Completed) resolve();
          else if (state.status === DeviceActionStatus.Error) reject(state.error);
        },
        error: reject,
      });
    }).finally(() => say(""));

  const send: Send = async (apdu) => {
    const r = await sdk.sendApdu({ sessionId, apdu });
    return { sw: (r.statusCode[0] << 8) | r.statusCode[1], data: r.data };
  };
  const app = new PqbApp({
    async send(cla, ins, p1, p2, data = new Uint8Array()) {
      const apdu = new Uint8Array(5 + data.length);
      apdu.set([cla, ins, p1, p2, data.length]);
      apdu.set(data, 5);
      const { sw, data: response } = await send(apdu);
      const out = new Uint8Array(response.length + 2);
      out.set(response);
      out.set([sw >> 8, sw & 0xff], response.length);
      return out;
    },
  });

  const use = async <T>(hint: string, say: Say, work: (app: PqbApp) => Promise<T>): Promise<T> => {
    const resume = sdk.disableDeviceSessionRefresher({ sessionId, blockerId: "qsb-app" });
    say(hint);
    try {
      return await work(app);
    } catch (error) {
      if (error instanceof PqbStatusError && error.statusWord === SW_UNKNOWN_INS)
        throw new Plain("The app on your Ledger is out of date. Install it again from this page.");
      if (error instanceof PqbStatusError && error.statusWord === SW_DENY)
        throw new Plain("You declined on your Ledger. Try again when you're ready.");
      throw error;
    } finally {
      say("");
      resume();
    }
  };

  /** Loads the QSB build served next to this page, for apps Ledger's catalog doesn't carry. */
  const loadFromSite = async (progress: (fraction: number) => void, say: Say) => {
    await run(new GoToDashboardDeviceAction({ input: { unlockTimeout: 120_000 } }) as Action, say);
    const os = await sdk.sendCommand({ sessionId, command: new GetOsVersionCommand() });
    if (!isSuccessCommandResult(os)) throw new Plain("Couldn't read your Ledger's model. Unplug it, plug it back in and try again.");
    const script = await firmwareFor(options.firmwareBase, os.data.targetId);
    // The kit polls the device in the background; keep it quiet while the loader's session is open.
    const resume = sdk.disableDeviceSessionRefresher({ sessionId, blockerId: "qsb-install" });
    // An answer that takes more than a moment means the Ledger is waiting for its owner.
    const patient: Send = async (apdu) => {
      const timer = setTimeout(() => say("Look at your Ledger and approve the request."), 1200);
      try {
        return await send(apdu);
      } finally {
        clearTimeout(timer);
        say("");
      }
    };
    try {
      await sideload(patient, os.data.targetId, script, progress);
    } finally {
      resume();
    }
  };

  return {
    name: name || String(modelId),
    async openApp(say) {
      try {
        await run(new OpenAppDeviceAction({ input: { appName: options.appName, unlockTimeout: 120_000 } }) as Action, say);
        return true;
      } catch (error) {
        if (/locked/i.test(text(error))) throw new Plain("Your Ledger is locked. Unlock it and try again.");
        return false;
      }
    },
    async install(progress, say) {
      try {
        if (options.install === "catalog")
          await run(new InstallAppDeviceAction({ input: { appName: options.appName, unlockTimeout: 120_000 } }) as Action, say, progress);
        else await loadFromSite(progress, say);
      } catch (error) {
        if (error instanceof Plain) throw error;
        if (error instanceof LoaderError) throw new Plain(refusal(error.statusWord));
        const message = text(error);
        throw new Plain(
          /not found in manager api/i.test(message)
            ? "Ledger doesn't offer the QSB app for this device yet."
            : /locked/i.test(message)
              ? "Your Ledger is locked. Unlock it and try again."
              : /refus|denied|reject|5501|6985/i.test(message)
                ? "You declined on your Ledger. Try again when you're ready."
                : /space|6a84|6a85/i.test(message)
                  ? "Your Ledger is full. Remove an app you don't use (your funds stay safe), then try again."
                  : "The install didn't finish. Check your internet connection and try again.",
        );
      }
    },
    async status() {
      try {
        const { version, profile } = await app.getVersion();
        const state = await app.getState();
        // A continuation with no first chunk: an app with SIGN_IN refuses it as out of order
        // (0xB001) without showing anything; an older one doesn't know the instruction.
        let signIn = true;
        try {
          await app.exchange(0x31, 0x80, Uint8Array.of(0));
        } catch (error) {
          if (!(error instanceof PqbStatusError)) throw error;
          signIn = error.statusWord !== SW_UNKNOWN_INS;
        }
        return { version, profile, vaults: state.records, signIn };
      } catch {
        throw new Plain("The app on your Ledger is out of date. Install it again from this page.");
      }
    },
    async depositAddress(v) {
      return { address: (await app.getDepositAddress(v)).address };
    },
    use,
    async signIn(v, message, say) {
      const { address, bip322 } = await use("Check the details on your Ledger, then approve the sign-in.", say, (a) => a.signIn(v, message));
      return { address, signature: bip322 };
    },
    async disconnect() {
      await sdk.disconnect({ sessionId }).catch(() => {});
    },
  };
}
