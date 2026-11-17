// The Ledger, through Ledger's Device Management Kit over WebHID.
import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  GetOsVersionCommand,
  GoToDashboardDeviceAction,
  InstallAppDeviceAction,
  OpenAppDeviceAction,
  UserInteractionRequired,
  isSuccessCommandResult,
  type DeviceManagementKit,
} from "@ledgerhq/device-management-kit";
import { webHidIdentifier, webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import { firstValueFrom } from "rxjs";
import { config } from "../env";
import { PqbApp, type AppStatus } from "./pqbApp";
import { LoaderError, parseScript, sideload, type Send } from "./sideload";

/** Tells the user what to do on the device right now; "" clears it. */
export type Say = (hint: string) => void;

export interface Device {
  readonly name: string;
  /** Opens the app. False when it isn't installed. */
  openApp(say: Say): Promise<boolean>;
  /**
   * Installs the QSB app: from Ledger's catalog when `config.install` is "catalog", otherwise by
   * loading the build this site serves. `progress` goes from 0 to 1.
   */
  install(progress: (fraction: number) => void, say: Say): Promise<void>;
  /** What the open app says about itself. The app must be open. */
  status(): Promise<AppStatus>;
  disconnect(): Promise<void>;
}

/** An error whose message is already written for the user. */
export class Plain extends Error {}

export const ledgerSupported = () => typeof navigator !== "undefined" && "hid" in navigator;

let kit: DeviceManagementKit | undefined;
function dmk() {
  if (!kit) {
    kit = new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build();
    if (config.provider !== undefined) kit.setProvider(config.provider);
  }
  return kit;
}

const hints: Partial<Record<UserInteractionRequired, string>> = {
  [UserInteractionRequired.UnlockDevice]: "Unlock your Ledger.",
  [UserInteractionRequired.AllowSecureConnection]: "On your Ledger, allow Ledger Manager.",
  [UserInteractionRequired.ConfirmOpenApp]: `On your Ledger, confirm opening ${config.appName}.`,
};

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
async function firmwareFor(targetId: number) {
  const base = `${import.meta.env.BASE_URL}firmware/`;
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

/** Opens the browser's device picker (needs a click) and connects to the chosen Ledger. */
export async function connectLedger(): Promise<Device> {
  if (!ledgerSupported()) throw new Plain("This browser can't talk to a Ledger. Use Chrome, Edge or Brave on a computer.");
  const sdk = dmk();
  let sessionId: string;
  try {
    const found = await firstValueFrom(sdk.startDiscovering({ transport: webHidIdentifier }));
    sessionId = await sdk.connect({ device: found });
  } catch (error) {
    throw new Plain(
      /no device|NoAccessibleDevice|empty/i.test(text(error))
        ? "No Ledger was chosen. Plug it in, unlock it and try again."
        : "Couldn't connect. Close Ledger Live (it keeps the Ledger busy), then try again.",
    );
  } finally {
    void sdk.stopDiscovering();
  }
  const { name, modelId } = sdk.getConnectedDevice({ sessionId });

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
  const app = new PqbApp(send);

  /** Loads the QSB build served next to this page, for apps Ledger's catalog doesn't carry. */
  const loadFromSite = async (progress: (fraction: number) => void, say: Say) => {
    await run(new GoToDashboardDeviceAction({ input: { unlockTimeout: 120_000 } }) as Action, say);
    const os = await sdk.sendCommand({ sessionId, command: new GetOsVersionCommand() });
    if (!isSuccessCommandResult(os)) throw new Plain("Couldn't read your Ledger's model. Unplug it, plug it back in and try again.");
    const script = await firmwareFor(os.data.targetId);
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
        await run(new OpenAppDeviceAction({ input: { appName: config.appName, unlockTimeout: 120_000 } }) as Action, say);
        return true;
      } catch (error) {
        if (/locked/i.test(text(error))) throw new Plain("Your Ledger is locked. Unlock it and try again.");
        return false;
      }
    },
    async install(progress, say) {
      try {
        if (config.install === "catalog")
          await run(new InstallAppDeviceAction({ input: { appName: config.appName, unlockTimeout: 120_000 } }) as Action, say, progress);
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
        return await app.status();
      } catch {
        throw new Plain("The app on your Ledger is out of date. Install it again from this page.");
      }
    },
    async disconnect() {
      await sdk.disconnect({ sessionId }).catch(() => {});
    },
  };
}
