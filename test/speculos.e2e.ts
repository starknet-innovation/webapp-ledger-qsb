// End-to-end against Speculos: the same session code the site uses, over Ledger's Speculos
// transport instead of WebHID. Run it with `npm run test:speculos`, which starts Speculos with the
// built app and the seed from SPECULOS_SEED; this file only needs SPECULOS_URL and SPECULOS_DEVICE.
// It never reads the seed and never prints anything derived from it.
//
// Approving on the device is automated through Speculos's own API (screen text and buttons), so
// the sign-in approval tests run on Nano S Plus only; the touch models get the refusal test.
// With QSB_API set (e.g. https://d1pjwwq89sze3g.cloudfront.net) it also signs in to that QSB
// service for real: a session for vault 0's deposit address, nothing else.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, before, test } from "node:test";
import { DeviceManagementKitBuilder, DeviceModelId, type DeviceManagementKit } from "@ledgerhq/device-management-kit";
import { speculosIdentifier, speculosTransportFactory } from "@ledgerhq/device-transport-kit-speculos";
import { firstValueFrom, timeout } from "rxjs";
import { Verifier } from "bip322-js";
import { PqbStatusError } from "../src/vendor/pqb-ledger/app.ts";
import { Plain, openSession, type Device } from "../src/ledger/session.ts";

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
  assert.equal(status.signIn, true, "the installed build has SIGN_IN");
  assert.ok(Number.isInteger(status.vaults) && status.vaults >= 0, "vault count is a non-negative integer");
});

// ---- Sign-in (SIGN_IN) --------------------------------------------------------------------

/** The challenge qsb-app's server issues (server/app.ts), for `address`. */
const challenge = (address: string, origin = "https://qsb.example.org") =>
  [
    "QSB Vault sign-in",
    `Origin: ${origin}`,
    `Address: ${address}`,
    "Network: bitcoin-mainnet",
    `Nonce: ${crypto.randomUUID()}`,
    `Expires: ${new Date(Date.now() + 5 * 60_000).toISOString()}`,
    "This signature authorizes this session only. It does not authorize a Bitcoin transaction.",
  ].join("\n");

const speculos = async (path: string, body?: unknown) =>
  fetch(url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const screen = async () =>
  ((await (await speculos("/events?stream=false&currentscreenonly=true")).json()) as { events: { text: string }[] }).events
    .map((e) => e.text)
    .join(" ");
const press = (button: "right" | "both") => speculos(`/button/${button}`, { action: "press-and-release" });

/** On a Nano, scrolls the review until a screen starts with `target`, then presses both buttons. */
async function choose(target: RegExp) {
  const seen: string[] = [];
  for (let i = 0; i < 40; i++) {
    await new Promise((r) => setTimeout(r, 300));
    const text = await screen();
    if (seen.at(-1) !== text) seen.push(text);
    if (target.test(text)) return press("both");
    if (seen.length > 1 || /Review|Origin|Vault|Fingerprint|Address|Expires|Sign message/.test(text)) await press("right");
  }
  throw new Error(`Never reached ${target} on the device. Screens: ${seen.join(" / ")}`);
}

const nano = device === "nanosplus";
/** Vault 0's deposit address, read through the session as the site reads it. */
const depositAddress = () => ledger.depositAddress(0);

test(`${device}: the app refuses to sign anything but the QSB challenge`, async () => {
  for (const message of ["Hello World", challenge("bc1qnotthisvaultsaddress0000000000000000000")]) {
    await assert.rejects(ledger.signIn(0, message, () => {}), (e) => e instanceof PqbStatusError && e.statusWord === 0x6a80);
  }
});

test(`${device}: a sign-in approved on the device verifies with qsb-app's verifier`, { skip: !nano && "approval automation is Nano-only" }, async () => {
  const { address } = await depositAddress();
  const message = challenge(address);
  const [signed] = await Promise.all([ledger.signIn(0, message, () => {}), choose(/^Sign message/)]);
  assert.equal(signed.address, address);
  // qsb-app's server: bip322-js 4.0.0, Verifier.verifySignature(address, message, signature, true).
  assert.ok(Verifier.verifySignature(address, message, signed.signature, true));
  assert.ok(!Verifier.verifySignature(address, message.replace("bitcoin-mainnet", "bitcoin-testnet"), signed.signature, true));
});

test(`${device}: declining on the device is reported as declined`, { skip: !nano && "approval automation is Nano-only" }, async () => {
  const { address } = await depositAddress();
  const [result] = await Promise.allSettled([ledger.signIn(0, challenge(address), () => {}), choose(/^Reject/)]);
  assert.equal(result.status, "rejected");
  assert.ok(result.reason instanceof Plain && /declined/.test(result.reason.message), String(result.reason));
});

test(`${device}: signs in to the live QSB service`, { skip: (!process.env.QSB_API && "set QSB_API to run") || (!nano && "approval automation is Nano-only") }, async () => {
  const api = `${process.env.QSB_API!.replace(/\/$/, "")}/v1`;
  const post = async (path: string, body: unknown) => {
    const json = JSON.stringify(body);
    const hash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json))).toString("hex");
    const response = await fetch(api + path, {
      method: "POST",
      redirect: "error",
      headers: { "content-type": "application/json", "x-amz-content-sha256": hash },
      body: json,
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  const { address } = await depositAddress();
  const issued = await post("/auth/challenge", { address });
  assert.equal(issued.status, 200, JSON.stringify(issued.body));
  const message = String(issued.body.message);
  const [signed] = await Promise.all([ledger.signIn(0, message, () => {}), choose(/^Sign message/)]);
  const verified = await post("/auth/verify", { id: issued.body.id, signature: signed.signature });
  assert.equal(verified.status, 200, JSON.stringify(verified.body));
  assert.match(String(verified.body.token), /^[A-Za-z0-9_-]{43}$/);
});

// Last: opening another app closes PQB, which ends the Speculos session.
test(`${device}: asking for an app that isn't there reports it missing`, async () => {
  const other = openSession(sdk, sdk.listConnectedDevices()[0].sessionId, {
    appName: "NotInstalled",
    install: "sideload",
    firmwareBase: "",
  });
  assert.equal(await other.openApp(() => {}), false);
});
