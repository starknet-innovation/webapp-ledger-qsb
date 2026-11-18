// The Ledger in the browser: Ledger's Device Management Kit over WebHID, with this site's settings.
import { DeviceManagementKitBuilder, type DeviceManagementKit } from "@ledgerhq/device-management-kit";
import { webHidIdentifier, webHidTransportFactory } from "@ledgerhq/device-transport-kit-web-hid";
import { firstValueFrom } from "rxjs";
import { config } from "../env";
import { Plain, openSession, type Device } from "./session.ts";

export { Plain, type Device, type Say } from "./session.ts";

export const ledgerSupported = () => typeof navigator !== "undefined" && "hid" in navigator;

let kit: DeviceManagementKit | undefined;
function dmk() {
  if (!kit) {
    kit = new DeviceManagementKitBuilder().addTransport(webHidTransportFactory).build();
    if (config.provider !== undefined) kit.setProvider(config.provider);
  }
  return kit;
}

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
  return openSession(sdk, sessionId, {
    appName: config.appName,
    install: config.install,
    firmwareBase: `${import.meta.env.BASE_URL}firmware/`,
  });
}
