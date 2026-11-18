// End-to-end against Speculos: the same session code the site uses, over Ledger's Speculos
// transport instead of WebHID. Run it with `npm run test:speculos`, which starts Speculos with the
// built app and the seed from SPECULOS_SEED; this file only needs SPECULOS_URL and SPECULOS_DEVICE.
// It never reads the seed and never prints anything derived from it.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { DeviceManagementKitBuilder, DeviceModelId, type DeviceManagementKit } from "@ledgerhq/device-management-kit";
import { speculosIdentifier, speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { firstValueFrom, timeout } from "rxjs";
import { openSession, type Device } from "../src/ledger/session.ts";

const url = process.env.SPECULOS_URL;
const device = process.env.SPECULOS_DEVICE ?? "nanosplus";
const models: Record<string, DeviceModelId> = {
  nanosplus: DeviceModelId.NANO_SP,
  stax: DeviceModelId.STAX,
  flex: DeviceModelId.FLEX,
  apex_p: DeviceModelId.APEX,
};
const manifest = JSON.parse(readFileSync(new URL("../public/firmware/manifest.json", import.meta.url), "utf8")) as {
  app: string;
  version: string;
};

let sdk: DeviceManagementKit;
let ledger: Device;
const hints: string[] = [];

before(async () => {
  assert.ok(url, "Set SPECULOS_URL, or run npm run test:speculos.");
  assert.ok(models[device], `Unknown device ${device}.`);
  // isE2E: no background polling of Speculos for disconnects, so the process can exit.
  sdk = new DeviceManagementKitBuilder().addTransport(speculosTransportFactory(url, true, models[device])).build();
  const found = await firstValueFrom(sdk.startDiscovering({ transport: speculosIdentifier }).pipe(timeout(15_000)));
  await sdk.stopDiscovering();
  const sessionId = await sdk.connect({ device: found });
  ledger = openSession(sdk, sessionId, { appName: manifest.app, install: "sideload", firmwareBase: "" });
});

after(async () => {
  await ledger?.disconnect();
  sdk?.close();
});

test(`${device}: the session opens the app, which is already running`, async () => {
  assert.equal(await ledger.openApp((hint) => hint && hints.push(hint)), true);
  assert.deepEqual(hints, [], "Speculos needed no user action to open the app");
});

test(`${device}: the app reports the version and profile the site installs`, async () => {
  const status = await ledger.status();
  assert.equal(status.version, manifest.version);
  assert.equal(status.profile, "PQB-v1");
  assert.ok(Number.isInteger(status.vaults) && status.vaults >= 0, "vault count is a non-negative integer");
});

test(`${device}: asking for an app that isn't there reports it missing`, async () => {
  const other = openSession(sdk, sdk.listConnectedDevices()[0].sessionId, {
    appName: "NotInstalled",
    install: "sideload",
    firmwareBase: "",
  });
  assert.equal(await other.openApp(() => {}), false);
});
