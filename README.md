# QSB Vault for Ledger

A small web front end for QSB quantum-safe Bitcoin vaults that works only with a Ledger.
Three steps, one decision per screen: connect the Ledger, install the QSB app on it, then
deposit into a vault and later withdraw. The last step works only in the demo so far.

"QSB" is the brand. Vaults use the PQB scheme (QSB v2). The Ledger app itself is named PQB, so the
UI says so once, where the user has to recognise it on the device.

**Research software, not audited. It targets Bitcoin mainnet.**

## Run

The QSB SDK isn't on npm, so build it once from
[qsb-app](https://github.com/starknet-innovation/qsb-app/tree/main/sdk) (needs the GitHub CLI):

```bash
npm run sdk
```

```bash
npm install
```

```bash
npm run dev
```

Add `?demo` to the address to walk through every screen with a simulated Ledger and service.
Settings are in [.env.example](.env.example). WebHID needs Chrome, Edge or Brave on a computer.

## Publish

Every push to `main` builds and publishes to GitHub Pages
([workflow](.github/workflows/pages.yml)). The build takes `VITE_QSB_API`, `VITE_LEDGER_PROVIDER`
and `VITE_LEDGER_APP_NAME` from the repository's Actions variables. Pages is a different origin
from the QSB service, so `VITE_QSB_API` must be set and the service must allow that origin.

## Installing the QSB app

The QSB Ledger app isn't in Ledger's catalog, so the Device Management Kit's `InstallAppDeviceAction`
can't find it. The kit has no way to load an app from a file, so the site does it itself over the
kit's raw APDU channel:

- `npm run firmware` (needs Docker) builds [app-qsb](https://github.com/starknet-innovation/app-qsb)
  at a pinned commit with Ledger's builder image, pinned by digest, for Nano S Plus, Stax, Flex and
  Apex P. It writes each device's install commands and a manifest to `public/firmware/`. The Pages
  workflow runs it on every publish.
- [src/ledger/sideload.ts](src/ledger/sideload.ts) is a port of the host side of Ledger's Python
  tool `ledgerblue` (secure-channel handshake and encryption). `npm test` checks it against vectors
  produced by `ledgerblue` itself ([test/make-scp-vectors.py](test/make-scp-vectors.py)) and
  against a simulated device.

What the user sees: the Ledger asks to allow an "unsafe manager", shows the app's identifier
(`appHash` in the manifest), and afterwards marks the app as not verified by Ledger. Nano X is left
out because Ledger doesn't let it take apps from outside the catalog (not re-checked against
Ledger's current documentation; Apex P support is likewise assumed, not confirmed).

Once Ledger lists the app, set `VITE_LEDGER_INSTALL=catalog` (or `VITE_LEDGER_PROVIDER`) and the
site installs it through Ledger's servers instead, with none of those warnings.

## Speculos test

`npm run test:speculos` starts Ledger's emulator, Speculos, with the app this site installs, once
for each of Nano S Plus, Stax, Flex and Apex P. On each it runs the site's own device session
([src/ledger/session.ts](src/ledger/session.ts)) over Ledger's Speculos transport. It checks that:

- the app opens and reports the manifest's version and profile, and that it has the sign-in command;
- the app refuses to sign anything but the QSB sign-in challenge for its own deposit address;
- on Nano S Plus, a sign-in approved on the device verifies with the verifier qsb-app's server uses
  (`bip322-js` 4.0.0, strict), and a declined one is reported as declined. The test approves by
  reading the screen and pressing buttons through Speculos's API; the touch models skip these two;
- a missing app is reported as missing.

With `QSB_API` set it also signs in to that QSB service for real, on Nano S Plus (vault 0's deposit
address gets a session; nothing else happens). Not run on publish. It needs Docker and
`npm run firmware` first.

```bash
SPECULOS_SEED="word1 … word24" npm run test:speculos
```

It runs on every publish, with the seed from the repository secret `SPECULOS_SEED`; without that
secret, publishing stops. The runner refuses Speculos's public default seed, passes the seed to
Docker by name rather than on a command line, and masks it in any log it prints. The test itself
never sees the seed.

A second pass runs [test/speculos-vault.e2e.ts](test/speculos-vault.e2e.ts) on Nano S Plus with a
fresh seed generated for that run and never printed, never the secret one: it creates a vault,
discloses its secrets and throws the emulator away. It checks that the site rebuilds the real app's
vault script byte for byte, builds the descriptor qsb-app registers after the export is approved,
gets a deposit sweep signed, and assembles a withdrawal from a real disclosure (and that a second,
different withdrawal is refused while the same one can be retried).

What it doesn't cover: installing (Speculos runs the app binary directly, not through the Ledger's
loader), approvals on the touch models, the QSB service, and anything on chain. No puzzle is solved:
the withdrawal test uses arbitrary indices, which the app doesn't check.

**Keep the seed a test seed.** It lives in a GitHub secret and on the machines that run this test.
Anything sent on mainnet to an address or vault derived from it is exposed to everyone who can read
that secret or those machines.

## How it's built

| Path | What it does |
| --- | --- |
| [src/App.tsx](src/App.tsx) | The three steps and the vault screens. |
| [src/ledger/device.ts](src/ledger/device.ts) | Ledger Device Management Kit over WebHID, with this site's settings. |
| [src/ledger/session.ts](src/ledger/session.ts) | One connected Ledger on any transport: open the app, install it, read its status. |
| [src/ledger/sideload.ts](src/ledger/sideload.ts) | The loader that installs this site's own build of the QSB app. |
| [src/qsb/deviceVault.ts](src/qsb/deviceVault.ts) | A vault held on the Ledger: its public descriptor, and a withdrawal assembled from what the device discloses. |
| [src/qsb/ledgerBackend.ts](src/qsb/ledgerBackend.ts) | The vault flow: the QSB SDK with the Ledger as signer, custody and sign-in. |
| [src/qsb/backend.ts](src/qsb/backend.ts) | What the vault screens need, in the user's terms. |
| [src/vendor](src/vendor/README.md) | pqb (from qsb-app) and the PQB Ledger app's client (from app-qsb), with their licences. |
| [src/qsb/demo.ts](src/qsb/demo.ts) | The simulated Ledger and service behind `?demo`. |

## What works and what doesn't

Tested: typecheck, production build, the unit tests (`npm test`), the Speculos tests below, and
the whole flow in `?demo`. On a physical Nano S Plus (18 November 2026), the published
site connected, sideloaded PQB 0.2.0 (app-qsb `59538d9`), opened it and read its status. Stax,
Flex and Apex P have only run on Speculos.

With a real Ledger the site connects, installs the app, opens it and reads its version and vault
count. **The vault flow (create, deposit, withdraw) is built but off** unless the site is built with
`VITE_VAULT_FLOW=on`: no one-input PQB withdrawal has been solved and spent on mainnet yet, so a
deposit isn't yet known to come back. `?demo` walks through every screen.

## The vault flow

A vault is created and held on the Ledger; the QSB service registers it, relays its deposit and runs
the withdrawal's search. Every step that moves or reveals something is approved on the device.

| Step | On the Ledger | With the QSB service (SDK) |
| --- | --- | --- |
| Create | ALLOCATE (the first time, it asks whether this seed held vaults before), then allow exporting the menu points | Sign in as the vault's deposit address (SIGN_IN), then `vaults.create` with the vault's public descriptor |
| Deposit | The user sends bitcoin to the vault's own deposit address; the device signs one sweep of all of it into the vault (SIGN_DEPOSIT) | `deposits.prepare` (no change) and `deposits.submit`, relayed to the miner |
| Withdraw | After the search, WITHDRAW: the device rebuilds the one-input transaction, shows destination, amount and fee, records the disclosure, then releases it | `withdrawals.create` without a helper, the GPU search, then `assemble` and `submit` |

[src/qsb/deviceVault.ts](src/qsb/deviceVault.ts) is the custody side. It follows app-qsb's Python
adapter: the vault's structure comes from pqb's public research lock of the same construction (`v1`)
with the device's 154 commitments swapped in, and the device's own script must come out byte for
byte. Its descriptor is the one qsb-app's server builds and validates for the same seed, and a
withdrawal assembled from the device's disclosure equals pqb's from the seed, byte for byte
([test/deviceVault.test.ts](test/deviceVault.test.ts)). The pqb code is qsb-app's vendored copy
([src/vendor](src/vendor/README.md)).

The SDK's one-time journal and pending deposits live in this browser's `localStorage` (the page
asks the browser to keep it). That isn't the durable store shared by every device that the SDK asks
for. If it's lost, the page rebuilds the withdrawal's journal entry from the service's job, but only
when its hash matches exactly, its funding is the vault's, and the Ledger's record agrees; the user
then confirms the destination. The Ledger itself refuses a second, different disclosure for a vault.

Other safeguards, from an independent review of this flow:

- **Minimum deposit:** a vault must be able to pay its own withdrawal fee later, at five times
  today's rate and at least 20 sat/vB.
- **Fees:** the withdrawal is quoted above the miner's floor. If fees rise anyway, the page waits
  and doesn't ask the Ledger to approve something the miner would refuse.
- **Funding check:** before a paid search and before the Ledger approves, the Ledger's recorded
  funding must match the service's.
- **Sending:** "Withdrawal complete" shows only once the withdrawal confirms. An uncertain send is
  shown as being checked.
- **Pauses and failures:** a paused search can be continued when the user may continue it, and
  otherwise points to the QSB operator, as does a failed one.

Not handled yet: bitcoin left at the deposit address after the deposit (the page shows it but can't
move it; the Ledger app has a refund command for this), and approvals on the touch Ledgers in tests.

Also open:

- **Installing is tested on one Nano S Plus only** (see [Installing the QSB app](#installing-the-qsb-app)).
  Stax, Flex and Apex P, and other OS versions, haven't been tried on hardware.
- **An app update erases the app's records on the Ledger.** After that the device has no history
  for the seed and only its emergency withdrawal path remains. Reinstalling from this page is an
  app update.
- **Custody conformance needs a host this site doesn't have.** Since `59538d9` app-qsb claims only
  derivation compatibility with the BIP draft 0.2.0; the rest (vault directory and journal, chain
  checks before allocating and withdrawing, restoration) is the host's job, and no client
  implements it yet.
- **The QSB service's CORS** allows the Pages origin in qsb-app's source since `5874874`; whether
  the deployed service has it was not re-checked.
