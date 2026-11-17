/**
 * The wallet the QSB SDK expects: one address that signs in to the QSB service (BIP-322), funds
 * the deposit and provides the withdrawal's helper input.
 *
 * The Ledger app no longer has such a wallet. Since app-qsb 0.2.0 (the PQB app) each vault has its
 * own deposit key that signs only a sweep into that vault, and there is no sign-in command. So
 * nothing implements this interface today, and `src/qsb/real.ts` is not reachable.
 */
export interface WalletSigner {
  readonly address: string;
  readonly publicKey: string;
  signMessage(address: string, message: string): Promise<string>;
  signPsbt(address: string, psbt: string, inputs: number[]): Promise<string>;
  /** Shows the address on the device and resolves once the user confirms it. */
  showAddress(): Promise<void>;
}
