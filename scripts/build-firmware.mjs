// Builds the QSB Ledger app (github.com/starknet-innovation/app-qsb) for every device that can
// take a sideloaded app, with Ledger's builder image, and writes the install files the web app
// serves: public/firmware/<device>.apdu and public/firmware/manifest.json. Needs Docker.
// Usage: npm run firmware            (clones app-qsb at APP_QSB_REF)
//        npm run firmware -- <path>  (uses an existing checkout as it is)
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** The app-qsb commit that gets installed on users' devices. Bump it deliberately. */
const APP_QSB_REF = "e8fc8ea68292d4c7dcda2f848d8caf3d4edfb028";
/** Ledger's builder image, by digest, so the same sources give the same toolchain. */
const BUILDER =
  "ghcr.io/ledgerhq/ledger-app-builder/ledger-app-dev-tools@sha256:96fff93c04aa73e97588e1616d4162bed7c12b643b429e4c34ec90494a81695b";
/** Nano X is left out: Ledger doesn't let it take apps from outside its catalog. */
const DEVICES = { nanosplus: "Nano S Plus", stax: "Stax", flex: "Flex", apex_p: "Apex P" };

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const out = path.join(root, "public", "firmware");
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

let checkout = process.argv[2] && path.resolve(process.argv[2]);
if (!checkout) {
  checkout = path.join(mkdtempSync(path.join(tmpdir(), "app-qsb-")), "app-qsb");
  execFileSync("git", ["clone", "--quiet", "https://github.com/starknet-innovation/app-qsb.git", checkout], { stdio: "inherit" });
  git(checkout, "checkout", "--quiet", APP_QSB_REF);
}
const commit = git(checkout, "rev-parse", "HEAD");
const dirty = git(checkout, "status", "--porcelain", "--untracked-files=no") !== "";

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
const manifest = { app: "QSB", source: "https://github.com/starknet-innovation/app-qsb", commit, dirty, builder: BUILDER, devices: {} };

for (const [device, label] of Object.entries(DEVICES)) {
  console.log(`Building for ${label}…`);
  const log = execFileSync(
    "docker",
    ["run", "--rm", "-v", `${checkout}:/app`, "-w", "/app/app", BUILDER, "cargo", "ledger", "build", device],
    { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 << 20 },
  );
  const info = /app_version: "([^"]+)", api_level: "(\d+)", app_flags: "[^"]+", target_id: "(0x[0-9a-fA-F]{8})"/.exec(log);
  if (!info) throw new Error(`Couldn't read the build's app infos for ${device}:\n${log.slice(-2000)}`);
  const release = path.join(checkout, "app", "target", device, "release");
  const script = readFileSync(path.join(release, "app-qsb.apdu"));
  copyFileSync(path.join(release, "app-qsb.apdu"), path.join(out, `${device}.apdu`));
  manifest.version = info[1];
  manifest.devices[info[3].toLowerCase()] = {
    device,
    label,
    file: `${device}.apdu`,
    apiLevel: Number(info[2]),
    /** SHA-256 of the install file, checked by the web app before it sends anything. */
    sha256: createHash("sha256").update(script).digest("hex"),
    /** The app's own hash, which the device shows as "Identifier" before installing. */
    appHash: readFileSync(path.join(release, "app-qsb.sha256"), "utf8").trim(),
  };
}
writeFileSync(path.join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Wrote ${path.relative(root, out)}/ for ${Object.keys(manifest.devices).length} devices from app-qsb ${commit.slice(0, 7)}.`);
