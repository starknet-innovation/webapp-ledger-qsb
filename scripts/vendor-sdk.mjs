// Builds the QSB SDK from a qsb-app checkout into vendor/. The SDK isn't published to npm.
// Usage: npm run sdk            (clones starknet-innovation/qsb-app with the GitHub CLI)
//        npm run sdk -- <path>  (uses an existing checkout)
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const run = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, stdio: "inherit" });

let checkout = process.argv[2] && path.resolve(process.argv[2]);
if (!checkout) {
  checkout = path.join(mkdtempSync(path.join(tmpdir(), "qsb-app-")), "qsb-app");
  run("gh", ["repo", "clone", "starknet-innovation/qsb-app", checkout, "--", "--depth", "1"]);
}
run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], checkout);
run("npm", ["run", "build", "-w", "@starknet-innovation/qsb-sdk"], checkout);
run("npm", ["pack"], path.join(checkout, "sdk"));
const tarball = readdirSync(path.join(checkout, "sdk")).find((f) => f.endsWith(".tgz"));
mkdirSync(path.join(root, "vendor"), { recursive: true });
cpSync(path.join(checkout, "sdk", tarball), path.join(root, "vendor", tarball));
console.log(`vendor/${tarball} is ready. Run npm install.`);
