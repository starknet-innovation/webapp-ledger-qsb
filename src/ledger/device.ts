// The Ledger, through Ledger's Device Management Kit over WebHID.
import {
  DeviceActionStatus,
  DeviceManagementKitBuilder,
  InstallAppDeviceAction,
  OpenAppDeviceAction,
  UserInteractionRequired,
  type DeviceManagementKit,
} from "@ledgerhq/device-management-kit";
import { webHidIdentifier, webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import { firstValueFrom } from "rxjs";
import { config } from "../env";
import { QsbApp } from "./qsbApp";
import { LedgerQsbSigner, type WalletSigner } from "./signer";

/** Tells the user what to do on the device right now; "" clears it. */
export type Say = (hint: string) => void;

export interface Device {
  readonly name: string;
  /** Opens the QSB app. False when it isn't installed. */
  openApp(say: Say): Promise<boolean>;
  /** Installs the QSB app through Ledger's secure channel. `progress` goes from 0 to 1. */
  install(progress: (fraction: number) => void, say: Say): Promise<void>;
  /** The wallet inside the QSB app. The app must be open. */
  signer(): Promise<WalletSigner>;
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
  [UserInteractionRequired.ConfirmOpenApp]: "On your Ledger, confirm opening QSB.",
};

const text = (error: unknown) => {
  if (error instanceof Error) return error.message;
  const e = error as { message?: unknown; originalError?: { message?: unknown }; _tag?: unknown };
  return [e?._tag, e?.message, e?.originalError?.message].filter((x) => typeof x === "string").join(" ");
};

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

  const app = new QsbApp(async (apdu) => {
    const r = await sdk.sendApdu({ sessionId, apdu });
    return { sw: (r.statusCode[0] << 8) | r.statusCode[1], data: r.data };
  });

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
        await run(new InstallAppDeviceAction({ input: { appName: config.appName, unlockTimeout: 120_000 } }) as Action, say, progress);
      } catch (error) {
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
    async signer() {
      return LedgerQsbSigner.connect(app, config.path);
    },
    async disconnect() {
      await sdk.disconnect({ sessionId }).catch(() => {});
    },
  };
}
