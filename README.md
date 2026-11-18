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

## How it's built

| Path | What it does |
| --- | --- |
| [src/App.tsx](src/App.tsx) | The three steps and the vault screens. |
| [src/ledger/device.ts](src/ledger/device.ts) | Ledger Device Management Kit over WebHID: connect, install, `OpenAppDeviceAction`, raw APDUs. |
| [src/ledger/sideload.ts](src/ledger/sideload.ts) | The loader that installs this site's own build of the QSB app. |
| [src/ledger/pqbApp.ts](src/ledger/pqbApp.ts) | The read-only commands of [app-qsb](https://github.com/starknet-innovation/app-qsb) this site uses: version and vault count. |
| [src/qsb/real.ts](src/qsb/real.ts) | Deposits and withdrawals through the QSB SDK's `QsbClient`. Not reachable today (see below). |
| [src/qsb/custody.ts](src/qsb/custody.ts) | The SDK's custody and journal hooks. Not reachable today. |
| [src/qsb/demo.ts](src/qsb/demo.ts) | The simulated Ledger and service behind `?demo`. |

## What works and what doesn't

Tested: typecheck, production build, the loader's unit tests (`npm test`), and the whole flow in
`?demo`. Nothing has run on a physical Ledger.

With a real Ledger the site connects, installs the app, opens it and reads its version and vault
count. It stops there: **deposits and withdrawals only work in `?demo`**. The reason is a mismatch
between the Ledger app and the QSB service, which this repository can't settle:

| | Ledger app (app-qsb 0.2.0, "PQB") | QSB SDK and service (qsb-app) |
| --- | --- | --- |
| Sign-in | No sign-in command | A BIP-322 signature from the wallet address opens every session |
| Deposit | Each vault has its own deposit address; the device signs one sweep from it into the vault | The wallet address pays the vault, with change back to the wallet |
| Withdrawal | One input, the vault output; the device builds the transaction itself | Two inputs: a helper input from the wallet, then the vault |
| Puzzle search | Exports menu points for pqb's solver | Its own coordinator and public problem format |

So [src/qsb/real.ts](src/qsb/real.ts) and [src/qsb/custody.ts](src/qsb/custody.ts), written against
the SDK, are kept but not reachable: nothing can implement the SDK's `Signer` on this app. A vault
flow for this app needs, outside this repository: a way to send the deposit sweep to a miner (the
vault output is a bare 4,696-byte script, which ordinary nodes don't relay), and a solver that
produces one-input withdrawals for the device to authorize.

Also open:

- **Installing is untested on hardware** (see [Installing the QSB app](#installing-the-qsb-app)).
- **An app update erases the app's records on the Ledger.** After that the device has no history
  for the seed and only its emergency withdrawal path remains. Reinstalling from this page is an
  app update.
- **Custody conformance needs a host this site doesn't have.** Since `59538d9` app-qsb claims only
  derivation compatibility with the BIP draft 0.2.0; the rest (vault directory and journal, chain
  checks before allocating and withdrawing, restoration) is the host's job, and no client
  implements it yet.
- **The QSB service's CORS** allows the Pages origin in qsb-app's source since `5874874`; whether
  the deployed service has it was not re-checked.
