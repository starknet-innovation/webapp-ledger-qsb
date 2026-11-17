# QSB Vault for Ledger

A small web front end for QSB quantum-safe Bitcoin vaults that works only with a Ledger.
Three steps, one decision per screen: connect the Ledger, install the QSB app on it, then
deposit into a vault and later withdraw.

"QSB" is the brand. New vaults use the PQB scheme (QSB v2); the name PQB never appears in the UI.

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
| [src/ledger/qsbApp.ts](src/ledger/qsbApp.ts), [signer.ts](src/ledger/signer.ts) | Browser port of [app-qsb](https://github.com/starknet-innovation/app-qsb)'s `clients/js`: the Ledger as the SDK's `Signer`. |
| [src/qsb/real.ts](src/qsb/real.ts) | Deposits and withdrawals through the QSB SDK's `QsbClient`; sign-in is a BIP-322 challenge approved on the Ledger. |
| [src/qsb/custody.ts](src/qsb/custody.ts) | Where vault secrets live: on the Ledger, or nowhere. |
| [src/qsb/demo.ts](src/qsb/demo.ts) | The simulated Ledger and service behind `?demo`. |

## What has to exist before this works with a real Ledger

Tested so far: typecheck, production build, the loader's unit tests (`npm test`), and the whole
flow in `?demo`. Not tested with a
Ledger or against a QSB service. Three things are open:

1. **Installing the app is untested on hardware.** app-qsb isn't in Ledger's catalog, so by
   default the site loads its own build onto the Ledger (see [Installing the QSB app](#installing-the-qsb-app)).
   The loader passes its tests against Ledger's Python tool, but no physical device has run it.
2. **The QSB Ledger app must support v2 (PQB) vaults.** app-qsb 0.1.0 only recognises v1
   (Config A) vault scripts, so it refuses to sign a v2 deposit, and it has no commands to derive
   v2 vault material or authorize a v2 withdrawal. This front end never creates or holds a vault
   seed in the browser, so "create vault" stops with a plain message until the app gains those
   commands; they plug into `src/qsb/custody.ts`.
3. **The QSB service must accept this origin.** The published site points at a service that
   serves v2 (`VITE_QSB_API`), but its CORS doesn't allow the Pages origin, so the browser blocks
   every call. Allow the origin on the service, or serve this front end from the service's own
   origin (in development set `QSB_API_ORIGIN`). The sign-in challenge names the service's origin.

Also open: the SDK's one-time journal is kept in this browser's `localStorage`, which is not the
durable, shared store the SDK asks for; and the withdrawal is approved on the Ledger's screen
only (the SDK's `approve` callback accepts the transaction the Ledger signed).
