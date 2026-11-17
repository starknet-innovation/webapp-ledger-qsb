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

## How it's built

| Path | What it does |
| --- | --- |
| [src/App.tsx](src/App.tsx) | The three steps and the vault screens. |
| [src/ledger/device.ts](src/ledger/device.ts) | Ledger Device Management Kit over WebHID: connect, `InstallAppDeviceAction`, `OpenAppDeviceAction`, raw APDUs. |
| [src/ledger/qsbApp.ts](src/ledger/qsbApp.ts), [signer.ts](src/ledger/signer.ts) | Browser port of [app-qsb](https://github.com/starknet-innovation/app-qsb)'s `clients/js`: the Ledger as the SDK's `Signer`. |
| [src/qsb/real.ts](src/qsb/real.ts) | Deposits and withdrawals through the QSB SDK's `QsbClient`; sign-in is a BIP-322 challenge approved on the Ledger. |
| [src/qsb/custody.ts](src/qsb/custody.ts) | Where vault secrets live: on the Ledger, or nowhere. |
| [src/qsb/demo.ts](src/qsb/demo.ts) | The simulated Ledger and service behind `?demo`. |

## What has to exist before this works with a real Ledger

Tested so far: typecheck, production build, and the whole flow in `?demo`. Not tested with a
Ledger or against a QSB service. Three things outside this repository are missing:

1. **The QSB Ledger app must be in Ledger's catalog.** `InstallAppDeviceAction` looks the app up
   by name in Ledger's Manager API and Ledger's servers push the signed binary. app-qsb isn't
   submitted to Ledger, so today the install step ends with "Ledger doesn't offer the QSB app for
   this device yet". Once Ledger hosts it (possibly under a private provider), set
   `VITE_LEDGER_PROVIDER`.
2. **The QSB Ledger app must support v2 (PQB) vaults.** app-qsb 0.1.0 only recognises v1
   (Config A) vault scripts, so it refuses to sign a v2 deposit, and it has no commands to derive
   v2 vault material or authorize a v2 withdrawal. This front end never creates or holds a vault
   seed in the browser, so "create vault" stops with a plain message until the app gains those
   commands; they plug into `src/qsb/custody.ts`.
3. **A QSB service that serves v2 and accepts this origin.** The deployed service serves
   Config A. The sign-in challenge names the service's own app origin, and its CORS must allow
   this front end (or serve it from the same origin; in development set `QSB_API_ORIGIN`).

Also open: the SDK's one-time journal is kept in this browser's `localStorage`, which is not the
durable, shared store the SDK asks for; and the withdrawal is approved on the Ledger's screen
only (the SDK's `approve` callback accepts the transaction the Ledger signed).
