// Runs test/speculos.e2e.ts against Speculos, once per device, with the app binaries from
// `npm run firmware` (build/firmware/<device>.elf) and the seed in SPECULOS_SEED.
//
// The seed is passed to Docker by name (`-e SPECULOS_SEED`), so it never appears on a command line,
// and it is masked in any Speculos log this script prints. Speculos's public default seed is refused:
// whatever it controls on mainnet, anyone can take.
//
// When nanosplus is among the devices, it then runs test/speculos-vault.e2e.ts (vault creation,
// sweep and disclosure) on Nano S Plus, in a separate Speculos with a fresh random mnemonic made for
// that run: those tests must never see SPECULOS_SEED (see the end of this file).
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

async function waitForSpeculos(name, hide = mask) {
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
  throw new Error(`Speculos didn't start.\n${hide(logs).slice(-3000)}`);
}

/**
 * Starts Speculos for `device` with the seed in env `seedVar` (passed to Docker by name), runs the
 * test `file` against it, and stops it. `hide` masks seeds in anything printed. True if it passed.
 */
async function pass({ device, file, seedVar, hide, env = {} }) {
  const name = `qsb-speculos-${device}-${process.pid}`;
  docker(
    "run", "-d", "--rm", "--name", name,
    "-p", `127.0.0.1:${PORT}:5000`,
    "-e", seedVar,
    "-v", `${path.join(root, "build", "firmware")}:/fw:ro`,
    IMAGE,
    "bash", "-c",
    `exec speculos --model ${MODELS[device]} --display headless --api-port 5000 --apdu-port 0 --seed "$${seedVar}" /fw/${device}.elf`,
  );
  try {
    await waitForSpeculos(name, hide);
    const code = await new Promise((resolve) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", "--import", "./test/ledger-cjs.mjs", "--test", "--test-reporter=spec", file],
        {
          cwd: root,
          stdio: "inherit",
          // The test gets the URL and device, never a seed.
          env: { ...process.env, SPECULOS_SEED: "", [seedVar]: "", SPECULOS_URL: `http://127.0.0.1:${PORT}`, SPECULOS_DEVICE: device, ...env },
        },
      );
      child.on("exit", resolve);
    });
    if (code === 0) return true;
    try {
      console.error(`Speculos log (seed masked):\n${hide(docker("logs", name)).slice(-3000)}`);
    } catch {}
    return false;
  } catch (error) {
    console.error(hide(String(error?.message ?? error)));
    return false;
  } finally {
    try {
      docker("stop", "-t", "2", name);
    } catch {}
  }
}

let failed = false;
for (const device of devices) {
  console.log(`\n▶ ${device} on Speculos (${MODELS[device]})`);
  if (!(await pass({ device, file: "test/speculos.e2e.ts", seedVar: "SPECULOS_SEED", hide: mask }))) failed = true;
}

// Vaults (test/speculos-vault.e2e.ts): allocate, sweep, disclose. NEVER with SPECULOS_SEED: a
// disclosure releases one-time secrets of that seed's vault, and the emulator's record of it is
// thrown away, so a real Ledger with the same seed wouldn't know. They run on a fresh random
// mnemonic generated per run inside the builder image, passed to Docker by name, never printed,
// and forgotten with this process. Nano S Plus only: the approval automation drives its buttons.
if (devices.includes("nanosplus")) {
  console.log("\n▶ nanosplus vault tests on Speculos (fresh disposable seed)");
  let disposable = "";
  try {
    disposable = docker("run", "--rm", IMAGE, "python3", "-c", "from mnemonic import Mnemonic; print(Mnemonic('english').generate(256))")
      .replace(/\s+/g, " ")
      .trim();
  } catch (error) {
    // Whatever it printed could be the mnemonic: report only that it failed.
    console.error(`Couldn't generate a disposable seed (docker exit status ${error?.status ?? "?"}).`);
  }
  const hide = (text) => mask(disposable ? text.split(disposable).join("[disposable seed]") : text);
  if (disposable.split(" ").length !== 24 || disposable === seed || disposable.toLowerCase() === DEFAULT_SEED) {
    if (disposable) console.error("The disposable seed didn't come out as a fresh 24-word mnemonic.");
    failed = true;
  } else {
    process.env.SPECULOS_DISPOSABLE_MNEMONIC = disposable;
    try {
      const ok = await pass({
        device: "nanosplus",
        file: "test/speculos-vault.e2e.ts",
        seedVar: "SPECULOS_DISPOSABLE_MNEMONIC",
        hide,
        // The vault tests refuse to run without this flag; only this pass sets it.
        env: { SPECULOS_DISPOSABLE_SEED: "1" },
      });
      if (!ok) failed = true;
    } finally {
      process.env.SPECULOS_DISPOSABLE_MNEMONIC = "";
    }
  }
}
process.exit(failed ? 1 : 0);
