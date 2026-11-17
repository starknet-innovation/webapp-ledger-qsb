// Where a vault's secrets live. This front end works only with a Ledger, so the only acceptable
// answer is "on the Ledger": nothing here may generate, hold or import a vault seed in the browser.
//
// QSB v2 vaults use the PQB scheme. The QSB Ledger app (app-qsb 0.1.0) only knows v1 (Config A)
// vault scripts and has no commands to derive v2 vault material or to authorize a v2 withdrawal.
// Until it does, `createVault` and `authorizeWithdrawal` stop with a plain message. When app-qsb
// gains those commands, implement the three methods below over `QsbApp`; nothing else changes.
import type { AuthorizationStore, ExternalCustody, VaultDescriptor } from "@starknet-innovation/qsb-sdk";
import { Plain } from "../ledger/device";

export interface VaultCustody extends ExternalCustody {
  /** A new vault's public descriptor, with its secrets derived and kept on the Ledger. */
  createVault(): Promise<VaultDescriptor>;
}

const NOT_YET =
  "Your Ledger's QSB app can't open a vault yet. It needs an update that isn't out. Nothing was sent and your bitcoin hasn't moved.";

export const ledgerCustody: VaultCustody = {
  async createVault() {
    throw new Plain(NOT_YET);
  },
  async confirmVault() {
    throw new Plain(NOT_YET);
  },
  async authorizeWithdrawal() {
    throw new Plain(NOT_YET);
  },
};

/**
 * The SDK's one-time journal, in this browser's localStorage. The SDK asks for a store that is
 * durable and shared by every device using the vault; localStorage is neither (another browser,
 * or cleared site data, starts empty). The Ledger must enforce one authorization per vault itself.
 */
export const browserJournal: AuthorizationStore = {
  async get(key) {
    return localStorage.getItem(`qsb-journal:${key}`) ?? undefined;
  },
  async claim(key, value) {
    const existing = localStorage.getItem(`qsb-journal:${key}`);
    if (existing !== null && existing !== value)
      throw new Plain("This vault was already used for a different withdrawal. Continue that one instead.");
    localStorage.setItem(`qsb-journal:${key}`, value);
    if (localStorage.getItem(`qsb-journal:${key}`) !== value) throw new Error("The browser didn't save the record.");
  },
};
