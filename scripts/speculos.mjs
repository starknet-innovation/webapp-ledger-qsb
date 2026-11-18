// Runs test/speculos.e2e.ts against Speculos, once per device, with the app binaries from
// `npm run firmware` (build/firmware/<device>.elf) and the seed in SPECULOS_SEED.
//
// The seed is passed to Docker by name (`-e SPECULOS_SEED`), so it never appears on a command line,
// and it is masked in any Speculos log this script prints. Speculos's public default seed is refused:
// whatever it controls on mainnet, anyone can take.
//
// Usage: SPECULOS_SEED="word1 … word24" npm run test:speculos [-- <device>…]
//        devices: nanosplus (default: all four), stax, flex, apex_p
import { execFileSync, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Ledger's builder image, by digest: the same one that builds the app (scripts/build-firmware.mjs). */
const IMAGE =
  "ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools@sha256:96fff93c04aa73e97588e1616d4162bed7c12b643b429e4c34ec90494a81695b";
const MODELS = { nanosplus: "nanosp", stax: "stax", flex: "flex", apex_p: "apex_p" };
/** Speculos's built-in seed (speculos/main.py DEFAULT_SEED). Public, so never used here. */
const DEFAULT_SEED =
  "glory promote mansion idle axis finger extra february uncover one trip resource lawn turtle enact monster seven myth punch hobby comfort wild raise skin";
/** Not 5000: on macOS AirPlay holds it. */
const PORT = 5055;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (message) => {
  console.error(message);
  process.exit(1);
};

const seed = (process.env.SPECULOS_SEED ?? "").trim().replace(/\s+/g, " ");
if (!seed) fail("Set SPECULOS_SEED to the test seed (a BIP39 mnemonic). It is never printed.");
if (seed.toLowerCase() === DEFAULT_SEED) fail("SPECULOS_SEED is Speculos's public default seed. Use your own.");
if (![12, 15, 18, 21, 24].includes(seed.split(" ").length) && !seed.startsWith("hex:"))
  fail('SPECULOS_SEED should be a 12–24 word BIP39 mnemonic (or "hex:…").');
process.env.SPECULOS_SEED = seed;
const mask = (text) => text.split(seed).join("[seed]");

const devices = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(MODELS);
for (const device of devices) {
  if (!MODELS[device]) fail(`Unknown device ${device}. Use: ${Object.keys(MODELS).join(", ")}.`);
  if (!existsSync(path.join(root, "build", "firmware", `${device}.elf`))) fail(`No build/firmware/${device}.elf. Run npm run firmware first.`);
}

const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

async function waitForSpeculos(name) {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/events?stream=false`)).ok) return;
    } catch {}
    try {
      if (docker("inspect", "-f", "{{.State.Running}}", name) !== "true") break;
    } catch {
      break;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let logs = "";
  try {
    logs = docker("logs", name);
  } catch {}
  throw new Error(`Speculos didn't start.\n${mask(logs).slice(-3000)}`);
}

let failed = false;
for (const device of devices) {
  const name = `qsb-speculos-${device}-${process.pid}`;
  console.log(`\n▶ ${device} on Speculos (${MODELS[device]})`);
  docker(
    "run", "-d", "--rm", "--name", name,
    "-p", `127.0.0.1:${PORT}:5000`,
    "-e", "SPECULOS_SEED",
    "-v", `${path.join(root, "build", "firmware")}:/fw:ro`,
    IMAGE,
    "bash", "-c",
    `exec speculos --model ${MODELS[device]} --display headless --api-port 5000 --apdu-port 0 --seed "$SPECULOS_SEED" /fw/${device}.elf`,
  );
  try {
    await waitForSpeculos(name);
    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "./test/ledger-cjs.mjs", "--test", "--test-reporter=spec", "test/speculos.e2e.ts"],
        {
          cwd: root,
          stdio: "inherit",
          // The test gets the URL and device, not the seed.
          env: { ...process.env, SPECULOS_SEED: "", SPECULOS_URL: `http://127.0.0.1:${PORT}`, SPECULOS_DEVICE: device },
        },
      );
      child.on("exit", resolve);
    });
    if (code !== 0) {
      failed = true;
      try {
        console.error(`Speculos log (seed masked):\n${mask(docker("logs", name)).slice(-3000)}`);
      } catch {}
    }
  } catch (error) {
    failed = true;
    console.error(mask(String(error?.message ?? error)));
  } finally {
    try {
      docker("stop", "-t", "2", name);
    } catch {}
  }
}
process.exit(failed ? 1 : 0);
