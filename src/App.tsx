import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { config } from "./env";
import { connectLedger, ledgerSupported, type Device } from "./ledger/device";
import type { AppStatus } from "./ledger/session";
import { btc, type Backend, type Snapshot, type VaultView } from "./qsb/backend";
import { demoBackend, demoDevice } from "./qsb/demo";

// The real backend, loaded only when the vault flow is on, so the demo bundle doesn't carry it.
// A glob rather than import(): the app still builds while the file doesn't exist.
const ledgerBackendModule = import.meta.glob<typeof import("./qsb/ledgerBackend")>("./qsb/ledgerBackend.ts");

type Step = "connect" | "install" | "vault";
const STEPS: { id: Step; label: string }[] = [
  { id: "connect", label: "Connect" },
  { id: "install", label: "Install" },
  { id: "vault", label: "Your vault" },
];

const message = (error: unknown) => (error instanceof Error && error.message ? error.message : "Something went wrong. Try again.");

/** Runs one action at a time and keeps its busy state, Ledger hint and error for the screen. */
function useAction() {
  const [busy, setBusy] = useState(false);
  const [hint, setHint] = useState("");
  const [error, setError] = useState("");
  const run = useCallback(async (action: (say: (hint: string) => void) => Promise<void>) => {
    setBusy(true);
    setError("");
    try {
      await action(setHint);
    } catch (e) {
      setError(message(e));
    } finally {
      setBusy(false);
      setHint("");
    }
  }, []);
  return { busy, hint, error, run };
}

function Feedback({ hint, error }: { hint: string; error: string }) {
  return (
    <>
      {hint && (
        <p className="hint" role="status">
          <span className="pulse" aria-hidden /> {hint}
        </p>
      )}
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
    </>
  );
}

export function App() {
  const [step, setStep] = useState<Step>("connect");
  const [device, setDevice] = useState<Device>();
  const [backend, setBackend] = useState<Backend>();
  const [status, setStatus] = useState<AppStatus>();
  const action = useAction();
  const [progress, setProgress] = useState<number>();

  const openVault = async (d: Device, say: (hint: string) => void) => {
    if (!(await d.openApp(say))) return setStep("install");
    if (config.demo) setBackend(demoBackend());
    else {
      const current = await d.status();
      setStatus(current);
      // An app from before sign-in reports the same version; replace it.
      if (!current.signIn) return setStep("install");
      // The real vault flow stays off until VITE_VAULT_FLOW=on; see `vaultFlow` in env.ts.
      if (config.vaultFlow) {
        const load = ledgerBackendModule["./qsb/ledgerBackend.ts"];
        if (!load) throw new Error("This build can't open vaults yet.");
        const { ledgerBackend } = await load();
        setBackend(ledgerBackend(d));
      }
    }
    setStep("vault");
  };

  const connect = () =>
    action.run(async (say) => {
      const d = config.demo ? demoDevice : await connectLedger();
      setDevice(d);
      await openVault(d, say);
    });

  const install = () =>
    action.run(async (say) => {
      setProgress(0);
      try {
        await device!.install(setProgress, say);
      } finally {
        setProgress(undefined);
      }
      await openVault(device!, say);
    });

  const current = STEPS.findIndex((s) => s.id === step);
  return (
    <main>
      <header>
        <strong className="brand">QSB Vault</strong>
        <span className="tagline">Quantum-safe bitcoin, on your Ledger</span>
      </header>
      {config.demo && <p className="demo">Demo: nothing here is real. No Ledger, no bitcoin.</p>}
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.id} className={i < current ? "done" : i === current ? "now" : ""} aria-current={i === current ? "step" : undefined}>
            <span className="dot">{i < current ? "✓" : i + 1}</span> {s.label}
          </li>
        ))}
      </ol>

      <section className="card">
        {step === "connect" && (
          <>
            <h1>Connect your Ledger</h1>
            {config.demo || ledgerSupported() ? (
              <>
                <p>Plug it in with its cable and unlock it.</p>
                <button className="primary" onClick={connect} disabled={action.busy}>
                  {action.busy ? "Connecting…" : "Connect Ledger"}
                </button>
              </>
            ) : (
              <p className="error">This browser can't talk to a Ledger. Open this page in Chrome, Edge or Brave on a computer.</p>
            )}
            <Feedback {...action} />
            <p className="small">QSB Vault works only with a Ledger. Your keys never leave it.</p>
          </>
        )}

        {step === "install" && (
          <>
            <h1>{status ? "Update the QSB app on your Ledger" : "Add the QSB app to your Ledger"}</h1>
            <p>It takes about a minute. Your other apps and your funds aren't touched.</p>
            {status && status.vaults > 0 && (
              <p className="error">
                Updating erases the app's record of your {status.vaults} vault{status.vaults === 1 ? "" : "s"}. Withdraw
                from them first, or ask for help before you update.
              </p>
            )}
            {config.install === "sideload" && (
              <p className="note">
                Your Ledger will say this app isn't verified by Ledger and ask you to allow it. That's expected: it is
                research software that Ledger hasn't reviewed. On your Ledger the app is called{" "}
                <strong>{config.appName}</strong>.
              </p>
            )}
            {progress === undefined ? (
              <button className="primary" onClick={install} disabled={action.busy}>
                {action.busy ? "Opening the app…" : "Install QSB app"}
              </button>
            ) : (
              <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
                <div style={{ width: `${Math.round(progress * 100)}%` }} />
                <span>{progress > 0 ? `Installing… ${Math.round(progress * 100)}%` : "Getting ready…"}</span>
              </div>
            )}
            <Feedback {...action} />
            <p className="small">Keep your Ledger plugged in until it's done.</p>
          </>
        )}

        {step === "vault" && backend && <Vault backend={backend} />}
        {step === "vault" && !backend && status && (
          <>
            <h1>Your Ledger is ready</h1>
            <p>
              The app is installed and working (version {status.version}).{" "}
              {status.vaults === 0
                ? "This Ledger has no vault yet."
                : `This Ledger holds ${status.vaults} vault${status.vaults === 1 ? "" : "s"}.`}
            </p>
            <p className="note">
              You can't deposit or withdraw from this page yet. That part is still being built. Don't send bitcoin to
              a vault from here.
            </p>
            <p className="small">Nothing on your Ledger changed apart from the new app.</p>
          </>
        )}
      </section>

      <footer>
        Research software, not audited. Only use amounts you can afford to lose.
        {device && step !== "connect" && <> · Connected: {device.name}</>}
      </footer>
    </main>
  );
}

type Say = (hint: string) => void;

function Vault({ backend }: { backend: Backend }) {
  const [snap, setSnap] = useState<Snapshot>();
  const [loadError, setLoadError] = useState("");
  const [loadHint, setLoadHint] = useState("");
  const action = useAction();
  // No polling while an action or another read is running: both may need the Ledger.
  const working = useRef(false);
  const reading = useRef(false);

  const refresh = useCallback(async () => {
    if (reading.current) return;
    reading.current = true;
    try {
      setSnap(await backend.snapshot(setLoadHint));
      setLoadError("");
    } catch (e) {
      setLoadError(message(e));
    } finally {
      reading.current = false;
      setLoadHint("");
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => !working.current && void refresh(), config.demo ? 2000 : 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = (work: (say: Say) => Promise<void>) =>
    action.run(async (say) => {
      working.current = true;
      try {
        await work(say);
      } finally {
        working.current = false;
      }
      await refresh();
    });

  if (!snap)
    return loadError ? (
      <>
        <h1>Couldn't open your vault</h1>
        <p className="error">{loadError}</p>
        <button className="primary" onClick={refresh}>
          Try again
        </button>
      </>
    ) : (
      <>
        <h1>Opening your vault…</h1>
        <p className="hint" role="status">
          <span className="pulse" aria-hidden /> {loadHint || "Checking your Ledger…"}
        </p>
      </>
    );

  // A Ledger prompt from a background check, or a failed check, shows under the screen.
  const feedback = <Feedback hint={action.hint || loadHint} error={action.error || (loadError && `Couldn't check for updates: ${loadError}`)} />;
  const busy = action.busy;
  const { vault } = snap;

  if (!vault)
    return (
      <>
        <h1>Create your vault</h1>
        <p>Your vault keeps your bitcoin safe, even from future quantum computers. Only your Ledger can open it.</p>
        <button className="primary" disabled={busy} onClick={() => act((say) => backend.createVault(say))}>
          {busy ? "Waiting for your Ledger…" : "Create my vault"}
        </button>
        {feedback}
        <p className="small">Your Ledger will ask you to approve three times.</p>
      </>
    );

  return <VaultStepScreen vault={vault} backend={backend} busy={busy} act={act} feedback={feedback} />;
}

function VaultStepScreen(props: {
  vault: VaultView;
  backend: Backend;
  busy: boolean;
  act: (work: (say: Say) => Promise<void>) => Promise<void>;
  feedback: ReactNode;
}) {
  const { vault } = props;
  // Bitcoin that reached the deposit address after the deposit, or didn't fit in it, isn't in the vault.
  return (
    <>
      <StepScreen {...props} />
      {vault.leftoverSats !== undefined && vault.leftoverSats > 0n && (
        <p className="note">
          {btc(vault.leftoverSats)} is still at your deposit address. It isn't in your vault, and this page can't move it
          yet.
        </p>
      )}
    </>
  );
}

function StepScreen(props: {
  vault: VaultView;
  backend: Backend;
  busy: boolean;
  act: (work: (say: Say) => Promise<void>) => Promise<void>;
  feedback: ReactNode;
}) {
  const { vault, backend, busy, act, feedback } = props;
  const amount = vault.vaultSats ?? vault.waitingSats;
  const reference = vault.reference && <p className="small meta">Reference: {vault.reference}</p>;
  switch (vault.step) {
    case "awaiting-bitcoin":
      return (
        <>
          <h1>Send bitcoin to your vault's deposit address</h1>
          <p>
            Send the amount you want to protect, from any wallet, to this address
            {vault.minimumSats !== undefined ? <> (at least {btc(vault.minimumSats)})</> : null}:
          </p>
          <Mono copy>{vault.depositAddress}</Mono>
          {vault.detail && vault.waitingSats > 0n && (
            <p className="error">
              {btc(vault.waitingSats)} has arrived. {vault.detail}
            </p>
          )}
          <button className="secondary" disabled={busy} onClick={() => act((say) => backend.showDepositAddress(say))}>
            {busy ? "Compare it with your Ledger's screen…" : "Check this address on my Ledger"}
          </button>
          {feedback}
          <p className="small">This page updates by itself once the bitcoin is confirmed.</p>
          <p className="small meta">
            Vault #{vault.v} · fingerprint {vault.fingerprint}
          </p>
        </>
      );

    case "ready-to-deposit":
      return (
        <>
          <h1>Your bitcoin has arrived</h1>
          <p className="amount">{btc(vault.waitingSats)}</p>
          <p>It's waiting at your deposit address. Move it into your vault to protect it.</p>
          {vault.detail && <p className="error">{vault.detail}</p>}
          <button className="primary" disabled={busy} onClick={() => act((say) => backend.deposit(say))}>
            {busy ? "Waiting for your Ledger…" : "Move it into your vault"}
          </button>
          {feedback}
          <p className="small">You'll confirm the amount on your Ledger. A vault takes one deposit.</p>
        </>
      );

    case "depositing":
      return (
        <>
          <h1>Your deposit is on its way</h1>
          <p className="amount">{btc(amount)}</p>
          <p>Waiting for the Bitcoin network to confirm it, usually within an hour. You can close this page.</p>
          {vault.txid && <TxLink txid={vault.txid} />}
          {feedback}
          <p className="small">This page updates by itself.</p>
        </>
      );

    case "in-vault":
      return (
        <Withdraw sats={vault.vaultSats} busy={busy} onSubmit={(destination) => act((say) => backend.withdraw(destination, say))}>
          {feedback}
        </Withdraw>
      );

    case "withdrawal-not-started":
      return (
        <>
          <h1>Your withdrawal hasn't started yet</h1>
          <p>QSB didn't receive it last time. It's set to send everything in your vault to:</p>
          {vault.destination && <Mono>{vault.destination}</Mono>}
          <button
            className="primary"
            disabled={busy || !vault.destination}
            onClick={() => act((say) => backend.withdraw(vault.destination!, say))}
          >
            {busy ? "Starting…" : "Start the withdrawal"}
          </button>
          {feedback}
          <p className="small">It can't be changed now: this vault is already set to this address.</p>
        </>
      );

    case "searching":
      return (
        <>
          <h1>Your withdrawal is being prepared</h1>
          <p>This takes several hours. You can close this page. Come back with your Ledger to approve the last step.</p>
          {vault.destination && (
            <>
              <p>Going to:</p>
              <Mono>{vault.destination}</Mono>
            </>
          )}
          {feedback}
          <p className="small">This page checks by itself.</p>
        </>
      );

    case "paused":
      return (
        <>
          <h1>Your withdrawal is paused</h1>
          <p>{vault.detail || "The search is paused. Your bitcoin is safe in the vault."}</p>
          {vault.destination && (
            <>
              <p>Going to:</p>
              <Mono>{vault.destination}</Mono>
            </>
          )}
          {vault.canResume && (
            <button className="primary" disabled={busy} onClick={() => act((say) => backend.resumeWithdrawal(say))}>
              {busy ? "Continuing…" : "Continue the search"}
            </button>
          )}
          {feedback}
          {!vault.canResume && reference}
          <p className="small">This page checks by itself.</p>
        </>
      );

    case "waiting-for-fees":
      return (
        <>
          <h1>Waiting for network fees to drop</h1>
          <p>
            Your withdrawal is ready, but network fees are higher right now than it pays. It can be sent once they drop.
            Your bitcoin is safe in the vault.
          </p>
          {vault.destination && (
            <>
              <p>Going to:</p>
              <Mono>{vault.destination}</Mono>
            </>
          )}
          {feedback}
          <p className="small">This page checks by itself. You'll approve on your Ledger once it can be sent.</p>
        </>
      );

    case "ready-to-approve":
      return (
        <>
          <h1>Your withdrawal is ready</h1>
          {vault.fromElsewhere && (
            <p className="note">This withdrawal was started from another browser. Make sure this address is yours before you approve.</p>
          )}
          <p>Approve it on your Ledger to send your bitcoin to:</p>
          {vault.destination && <Mono>{vault.destination}</Mono>}
          <button className="primary" disabled={busy} onClick={() => act((say) => backend.finishWithdrawal(say))}>
            {busy ? "Waiting for your Ledger…" : "Approve on Ledger"}
          </button>
          {feedback}
          <p className="small">Check that the address on your Ledger matches this one.</p>
        </>
      );

    case "sending":
      return (
        <>
          <h1>Your withdrawal is on its way</h1>
          <p>It was sent. Waiting for the Bitcoin network to confirm it, usually within an hour. You can close this page.</p>
          {vault.destination && (
            <>
              <p>Going to:</p>
              <Mono>{vault.destination}</Mono>
            </>
          )}
          {vault.txid && <TxLink txid={vault.txid} />}
          {feedback}
          <p className="small">This page updates by itself.</p>
        </>
      );

    case "checking-send":
      return (
        <>
          <h1>Checking your withdrawal</h1>
          <p>
            It may have been sent, but that isn't confirmed yet. QSB is checking, and this page will update by itself.
            Nothing is needed from you now.
          </p>
          {vault.destination && (
            <>
              <p>Going to:</p>
              <Mono>{vault.destination}</Mono>
            </>
          )}
          {vault.txid && <TxLink txid={vault.txid} />}
          {feedback}
          {reference}
        </>
      );

    case "sent":
      return (
        <>
          <h1>Withdrawal complete</h1>
          <p>Your bitcoin was sent to:</p>
          {vault.destination && <Mono>{vault.destination}</Mono>}
          {vault.txid && <TxLink txid={vault.txid} />}
          <p>This vault is finished. To protect more bitcoin, create a new one.</p>
          <button className="primary" disabled={busy} onClick={() => act((say) => backend.createVault(say))}>
            {busy ? "Waiting for your Ledger…" : "Create a new vault"}
          </button>
          {feedback}
          <p className="small">Your Ledger will ask you to approve three times.</p>
        </>
      );

    case "failed":
      return (
        <>
          <h1>Your vault needs help from QSB</h1>
          <p className="error">{vault.detail || "Something stopped this vault. Your bitcoin is still in it."}</p>
          {vault.vaultSats !== undefined && <p>{btc(vault.vaultSats)} is in your vault.</p>}
          {feedback}
          {reference}
        </>
      );
  }
}

/** A Bitcoin mainnet address, roughly: bech32 (bc1…) or legacy (1… / 3…). Bech32 may be all caps. */
const bitcoinAddress = (input: string) => {
  const address = /^BC1[A-Z0-9]+$/.test(input) ? input.toLowerCase() : input;
  return /^(bc1[02-9ac-hj-np-z]{11,87}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address) ? address : undefined;
};

function Withdraw(props: { sats?: bigint; busy: boolean; onSubmit: (destination: string) => void; children: ReactNode }) {
  const [destination, setDestination] = useState("");
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = bitcoinAddress(destination.trim());
    if (!address) return setProblem("That doesn't look like a Bitcoin address. It should start with bc1, 1 or 3.");
    setProblem("");
    props.onSubmit(address);
  };
  return (
    <form onSubmit={submit} noValidate>
      <h1>{props.sats !== undefined ? `${btc(props.sats)} is in your vault` : "Your bitcoin is in your vault"}</h1>
      <label htmlFor="destination">Withdraw everything to this Bitcoin address</label>
      <input
        id="destination"
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        placeholder="bc1…"
        value={destination}
        onChange={(e) => setDestination(e.target.value)}
        disabled={props.busy}
        aria-invalid={problem ? true : undefined}
      />
      {problem && <p className="error">{problem}</p>}
      <button className="primary" disabled={props.busy}>
        {props.busy ? "Starting…" : "Withdraw"}
      </button>
      {props.children}
      <p className="small">
        A withdrawal empties the vault and takes several hours. Check the address: it can't be changed once started.
        You'll approve it on your Ledger at the end.
      </p>
    </form>
  );
}

function Mono({ children, copy }: { children: string; copy?: boolean }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mono">
      <code>{children}</code>
      {copy && (
        <button
          type="button"
          className="secondary"
          onClick={async () => {
            await navigator.clipboard.writeText(children);
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      )}
    </div>
  );
}

const TxLink = ({ txid }: { txid: string }) => (
  <p>
    <a href={`https://mempool.space/tx/${txid}`} target="_blank" rel="noreferrer">
      View the transaction
    </a>
  </p>
);
