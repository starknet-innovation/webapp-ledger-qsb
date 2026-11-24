# Vendored code

Copied from other repositories so the browser can build and verify device-held PQB vaults.
Each directory keeps its upstream licence.

## pqb-core

From [qsb-app](https://github.com/starknet-innovation/qsb-app) `src/pqb-core` at
`29fd868`, which vendors [fireblocks-labs/pqb](https://github.com/fireblocks-labs/pqb) at
`82c7cba` (MIT; see `LICENSE`, `THIRD_PARTY_NOTICES.md` and `provenance.json`, which lists
qsb-app's own adaptations).

One more adaptation here, in `spend.ts`: `assemble` takes an optional `cosign(z)` that returns
the co-signature instead of signing with the lock's private key. A device-held vault has no key
in the browser; the Ledger signs, and the caller checks that signature before using it.

## pqb-ledger

From [app-qsb](https://github.com/starknet-innovation/app-qsb) `clients/js/src` at `ae20b41`
(Apache-2.0; see `LICENSE`): the PQB Ledger app's client. Adaptations:

- `app.ts`: the transport takes and returns `Uint8Array` instead of Node's `Buffer`, and the
  BIP-322 signature is base64-encoded with `btoa`, so it runs in a browser.
- `pqb.ts`: `RECORD_LEN` is 251, the length the app sends for a vault record (`docs/apdu.md`
  GET_STATE, `app/src/handlers/vault.rs`). Upstream's 256 makes `getRecords()` fail against the
  real app; found by this repository's Speculos test.
