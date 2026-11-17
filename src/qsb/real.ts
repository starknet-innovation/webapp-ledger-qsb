// QSB through the SDK (github.com/starknet-innovation/qsb-app, sdk/), with the Ledger as wallet and custody.
import { ApiRequestError, QsbClient, type SignedWithdrawal } from "@starknet-innovation/qsb-sdk";
import { config } from "../env";
import { Plain } from "../ledger/device";
import type { WalletSigner } from "../ledger/signer";
import type { Backend, Snapshot } from "./backend";
import { browserJournal, ledgerCustody } from "./custody";

const ON_LEDGER = "Check the details on your Ledger, then approve.";

export function realBackend(signer: WalletSigner): Backend {
  const base = `${config.api.replace(/\/$/, "")}/v1`;
  let session: { token: string; at: number } | undefined;
  let signedWithdrawal: SignedWithdrawal | undefined;

  const post = async <T>(path: string, body: unknown): Promise<T> => {
    const json = JSON.stringify(body);
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(json));
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        // CloudFront needs the body's hash on every POST to the QSB service.
        "x-amz-content-sha256": Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join(""),
      },
      body: json,
    });
    if (!response.ok) throw new Plain("Couldn't sign in to QSB. Try again in a moment.");
    return response.json() as Promise<T>;
  };

  /** A session lasts an hour; sign in again (one approval on the Ledger) a little before that. */
  const credentials = {
    async get() {
      if (session && Date.now() - session.at < 50 * 60_000) return session.token;
      const challenge = await post<{ id: string; message: string }>("/auth/challenge", { address: signer.address });
      const signature = await signer.signMessage(signer.address, challenge.message);
      const { token } = await post<{ token: string }>("/auth/verify", { id: challenge.id, signature });
      session = { token, at: Date.now() };
      return token;
    },
  };

  const qsb = new QsbClient({ baseUrl: config.api, signer, custody: ledgerCustody, authorizations: browserJournal, credentials });

  const plain = (error: unknown): never => {
    if (error instanceof Plain) throw error;
    if (error instanceof ApiRequestError && error.code === "auth_required") session = undefined;
    throw new Plain(error instanceof Error && error.message ? error.message : "Something went wrong. Try again.");
  };

  /** This front end keeps to one vault at a time: the newest one that isn't finished, else the newest. */
  const currentVault = async () => {
    const { vaults } = await qsb.vaults.list();
    const v2 = vaults.filter((v) => v.config === "PQB").sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return v2.find((v) => v.status !== "spent") ?? v2[0];
  };
  const currentJob = async (vaultId: string) =>
    (await qsb.withdrawals.list())
      .filter((j) => j.vaultId === vaultId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const feeRate = async () => String((await qsb.rates()).submit_fee_rate);

  return {
    async snapshot(): Promise<Snapshot> {
      try {
        const [utxos, vault] = await Promise.all([qsb.utxos(), currentVault()]);
        const walletSats = utxos.reduce((sum, u) => sum + BigInt(u.value), 0n);
        const job = vault && vault.status !== "unfunded" ? await currentJob(vault.id) : undefined;
        return {
          address: signer.address,
          walletSats,
          vault: !vault
            ? null
            : vault.status === "unfunded" || !vault.funding
              ? { status: "unfunded" }
              : { status: vault.status, sats: BigInt(vault.funding.value), txid: vault.funding.txid },
          withdrawal: !job
            ? null
            : {
                destination: job.manifest.destination,
                txid: job.txid,
                detail: job.error,
                state:
                  job.status === "awaiting_authorization"
                    ? "ready"
                    : job.status === "submitted" || job.status === "confirmed"
                      ? "sent"
                      : job.status === "failed"
                        ? "failed"
                        : "searching",
              },
        };
      } catch (error) {
        return plain(error);
      }
    },

    showAddress: () => signer.showAddress(),

    async deposit(sats, say) {
      try {
        say("Approve the sign-in on your Ledger.");
        let vault = await currentVault();
        if (!vault || vault.status === "spent") {
          const descriptor = await ledgerCustody.createVault();
          ({ vault } = await qsb.vaults.create({ name: `Vault ${new Date().toISOString().slice(0, 10)}`, descriptor }));
        }
        const utxos = await qsb.utxos();
        const prepared = await qsb.deposits.prepare(vault.id, { amount: sats, feeRate: await feeRate(), utxos });
        say(ON_LEDGER);
        const signed = await signer.signPsbt(signer.address, prepared.psbt, prepared.signInputs);
        say("");
        const sent = await qsb.deposits.submit(prepared, signed, { costAccepted: true });
        if (sent.submission === "rejected") throw new Plain(`The deposit wasn't accepted${sent.reason ? `: ${sent.reason}` : "."}`);
      } catch (error) {
        plain(error);
      } finally {
        say("");
      }
    },

    async withdraw(destination, say) {
      try {
        say("Approve the sign-in on your Ledger.");
        const vault = await currentVault();
        if (!vault) throw new Plain("There's no vault to withdraw from.");
        // The helper input pays the network fee from the Ledger's wallet address.
        const helper = (await qsb.utxos()).sort((a, b) => Number(BigInt(b.value) - BigInt(a.value)))[0];
        if (!helper) throw new Plain("Your Ledger's QSB address needs a little bitcoin to pay the network fee.");
        await qsb.withdrawals.create({
          vaultId: vault.id,
          helper: { txid: helper.txid, vout: helper.vout },
          destination,
          feeRate: await feeRate(),
          costAccepted: true,
        });
      } catch (error) {
        plain(error);
      } finally {
        say("");
      }
    },

    async finishWithdrawal(say) {
      try {
        const vault = await currentVault();
        const job = vault && (await currentJob(vault.id));
        if (!job) throw new Plain("There's no withdrawal to finish.");
        say(ON_LEDGER);
        // Kept so that a retry after a failed send resends the same bytes instead of asking the Ledger again.
        signedWithdrawal ??= await qsb.withdrawals.assemble(job.id);
        say("");
        // The user approved this exact transaction on the Ledger's screen.
        await qsb.withdrawals.submit(signedWithdrawal, { approve: (review) => review.txid });
        signedWithdrawal = undefined;
      } catch (error) {
        plain(error);
      } finally {
        say("");
      }
    },
  };
}
