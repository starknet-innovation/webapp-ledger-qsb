// Browser port of app-qsb's clients/js/src/signer.ts: the Ledger as the QSB SDK's `Signer`.
import * as btc from "@scure/btc-signer";
import { base64, hex } from "@scure/base";
import { QsbApp, type TxKind, type UnsignedTx } from "./qsbApp";

const opts = { allowUnknownInputs: true, allowUnknownOutputs: true };

/** One address that signs in, funds the deposit and provides the withdrawal's helper input. */
export interface WalletSigner {
  readonly address: string;
  readonly publicKey: string;
  signMessage(address: string, message: string): Promise<string>;
  signPsbt(address: string, psbt: string, inputs: number[]): Promise<string>;
  /** Shows the address on the device and resolves once the user confirms it. */
  showAddress(): Promise<void>;
}

export class LedgerQsbSigner implements WalletSigner {
  private constructor(
    private readonly app: QsbApp,
    readonly path: string,
    readonly address: string,
    readonly publicKey: string,
  ) {}

  static async connect(app: QsbApp, path: string): Promise<LedgerQsbSigner> {
    const { publicKey, address } = await app.getWalletAddress(path);
    return new LedgerQsbSigner(app, path, address, hex.encode(publicKey));
  }

  private own(address: string) {
    if (address !== this.address) throw new Error(`This Ledger holds ${this.address}, not ${address}.`);
  }

  async showAddress(): Promise<void> {
    const shown = await this.app.getWalletAddress(this.path, true);
    this.own(shown.address);
  }

  /** BIP-322 "simple" signature (base64) of a QSB sign-in challenge. */
  async signMessage(address: string, message: string): Promise<string> {
    this.own(address);
    const signature = await this.app.signIn(this.path, message);
    const pubkey = hex.decode(this.publicKey);
    return base64.encode(new Uint8Array([2, signature.length, ...signature, pubkey.length, ...pubkey]));
  }

  /** Sign `inputs` of a QSB deposit or withdrawal PSBT (base64); returns it with partial signatures. Never broadcasts. */
  async signPsbt(address: string, psbt: string, inputs: number[]): Promise<string> {
    this.own(address);
    const tx = btc.Transaction.fromPSBT(base64.decode(psbt), opts);
    const kind = psbtKind(tx, inputs);
    const unsigned: UnsignedTx = { version: tx.version, lockTime: tx.lockTime, inputs: [], outputs: [] };
    for (let i = 0; i < tx.inputsLength; i++) {
      const input = tx.getInput(i);
      if (inputs.includes(i) && input.sighashType !== undefined && input.sighashType !== btc.SigHash.ALL)
        throw new Error(`Input ${i} asks for a sighash other than SIGHASH_ALL.`);
      if (!input.txid || input.index === undefined || !input.nonWitnessUtxo)
        throw new Error(`Input ${i} lacks its previous transaction.`);
      unsigned.inputs.push({
        txid: hex.encode(input.txid),
        vout: input.index,
        sequence: input.sequence ?? 0xffffffff,
        previousTx: btc.RawTx.encode(input.nonWitnessUtxo),
      });
    }
    for (let i = 0; i < tx.outputsLength; i++) {
      const output = tx.getOutput(i);
      if (output.amount === undefined || !output.script) throw new Error(`Output ${i} is incomplete.`);
      unsigned.outputs.push({ amount: output.amount, script: output.script });
    }
    const signatures = await this.app.signTransaction(kind, this.path, unsigned, inputs);
    const pubkey = hex.decode(this.publicKey);
    for (const [index, signature] of signatures) tx.updateInput(index, { partialSig: [[pubkey, signature]] }, true);
    return base64.encode(tx.toPSBT());
  }
}

/** A withdrawal is two inputs, one output, input 1 already authorized; it signs input 0. Anything else is a deposit. */
function psbtKind(tx: btc.Transaction, inputs: number[]): TxKind {
  if (tx.inputsLength === 2 && tx.outputsLength === 1 && !!tx.getInput(1).finalScriptSig?.length) {
    if (inputs.length !== 1 || inputs[0] !== 0) throw new Error("A QSB withdrawal signs input 0 only.");
    return "withdrawal";
  }
  const all = Array.from({ length: tx.inputsLength }, (_, i) => i);
  if (inputs.length !== all.length || !all.every((i) => inputs.includes(i)))
    throw new Error("A QSB deposit signs every input.");
  return "deposit";
}
