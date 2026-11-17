import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from "react";
import { config } from "./env";
import { connectLedger, ledgerSupported, type Device } from "./ledger/device";
import type { AppStatus } from "./ledger/pqbApp";
import { btc, parseBtc, type Backend, type Snapshot } from "./qsb/backend";
import { demoBackend, demoDevice } from "./qsb/demo";

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
    // Only the demo has a working vault flow today; see "What has to exist" in the README.
    if (config.demo) setBackend(demoBackend());
    else setStatus(await d.status());
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
            <h1>Add the QSB app to your Ledger</h1>
            <p>It takes about a minute. Your other apps and your funds aren't touched.</p>
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

function Vault({ backend }: { backend: Backend }) {
  const [snap, setSnap] = useState<Snapshot>();
  const [loadError, setLoadError] = useState("");
  const [fresh, setFresh] = useState(false); // after a finished withdrawal: start over with a new deposit
  const action = useAction();
  const busy = useRef(false);
  busy.current = action.busy;

  const refresh = useCallback(async () => {
    try {
      setSnap(await backend.snapshot());
      setLoadError("");
    } catch (e) {
      setLoadError(message(e));
    }
  }, [backend]);

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => !busy.current && void refresh(), config.demo ? 2000 : 20000);
    return () => clearInterval(timer);
  }, [refresh]);

  const act = (work: (say: (hint: string) => void) => Promise<void>) =>
    action.run(async (say) => {
      await work(say);
      await refresh();
    });

  if (!snap)
    return loadError ? (
      <>
        <h1>Couldn't load your vault</h1>
        <p className="error">{loadError}</p>
        <button className="primary" onClick={refresh}>
          Try again
        </button>
      </>
    ) : (
      <>
        <h1>Opening your vault…</h1>
        <p className="hint">
          <span className="pulse" aria-hidden /> Approve the sign-in on your Ledger.
        </p>
      </>
    );

  const { vault, withdrawal } = snap;
  const feedback = <Feedback {...action} />;

  if (!fresh && withdrawal?.state === "sent")
    return (
      <>
        <h1>Withdrawal sent</h1>
        <p>Your bitcoin is on its way to:</p>
        <Mono>{withdrawal.destination}</Mono>
        {withdrawal.txid && <TxLink txid={withdrawal.txid} />}
        <button className="primary" onClick={() => setFresh(true)}>
          Make a new deposit
        </button>
      </>
    );

  if (!fresh && withdrawal?.state === "ready")
    return (
      <>
        <h1>Your withdrawal is ready</h1>
        <p>Approve it on your Ledger to send your bitcoin to:</p>
        <Mono>{withdrawal.destination}</Mono>
        <button className="primary" disabled={action.busy} onClick={() => act((say) => backend.finishWithdrawal(say))}>
          {action.busy ? "Waiting for your Ledger…" : "Approve on Ledger"}
        </button>
        {feedback}
      </>
    );

  if (!fresh && withdrawal?.state === "searching")
    return (
      <>
        <h1>Your withdrawal is being prepared</h1>
        <p>
          This takes several hours. You can close this page. Come back with your Ledger to approve the last step.
        </p>
        <p>Going to:</p>
        <Mono>{withdrawal.destination}</Mono>
        <p className="small">This page checks by itself.</p>
      </>
    );

  if (!fresh && vault && vault.status === "submitted")
    return (
      <>
        <h1>Your deposit is on its way</h1>
        <p className="amount">{btc(vault.sats)}</p>
        <p>Waiting for the Bitcoin network to confirm it, usually within an hour. You can close this page.</p>
        <TxLink txid={vault.txid} />
      </>
    );

  if (!fresh && vault && vault.status === "confirmed")
    return (
      <Withdraw
        sats={vault.sats}
        failed={withdrawal?.state === "failed" ? withdrawal.detail || "The last withdrawal didn't finish." : ""}
        busy={action.busy}
        onSubmit={(destination) => act((say) => backend.withdraw(destination, say))}
      >
        {feedback}
      </Withdraw>
    );

  if (snap.walletSats === 0n)
    return (
      <>
        <h1>First, send bitcoin to your Ledger</h1>
        <p>Send the amount you want to protect, plus a little for network fees, to this address:</p>
        <Mono copy>{snap.address}</Mono>
        <button className="secondary" disabled={action.busy} onClick={() => act(() => backend.showAddress())}>
          {action.busy ? "Compare it with your Ledger's screen…" : "Check this address on my Ledger"}
        </button>
        {feedback}
        <p className="small">This page updates by itself once the bitcoin is confirmed.</p>
      </>
    );

  return (
    <Deposit
      available={snap.walletSats}
      busy={action.busy}
      onSubmit={(sats) =>
        act(async (say) => {
          await backend.deposit(sats, say);
          setFresh(false);
        })
      }
    >
      {feedback}
    </Deposit>
  );
}

function Deposit(props: { available: bigint; busy: boolean; onSubmit: (sats: bigint) => void; children: ReactNode }) {
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const sats = parseBtc(amount);
    if (!sats) return setProblem("Enter an amount in BTC, like 0.001.");
    if (sats >= props.available) return setProblem(`You have ${btc(props.available)}. Leave a little for the network fee.`);
    setProblem("");
    props.onSubmit(sats);
  };
  return (
    <form onSubmit={submit}>
      <h1>Deposit into your vault</h1>
      <label htmlFor="amount">Amount in BTC</label>
      <input id="amount" inputMode="decimal" autoComplete="off" placeholder="0.001" value={amount} onChange={(e) => setAmount(e.target.value)} disabled={props.busy} autoFocus />
      <p className="small">You have {btc(props.available)} on your Ledger's QSB address.</p>
      {problem && <p className="error">{problem}</p>}
      <button className="primary" disabled={props.busy}>
        {props.busy ? "Waiting for your Ledger…" : "Deposit"}
      </button>
      {props.children}
      <p className="small">A vault takes one deposit. You'll confirm the amount on your Ledger.</p>
    </form>
  );
}

function Withdraw(props: { sats: bigint; failed: string; busy: boolean; onSubmit: (destination: string) => void; children: ReactNode }) {
  const [destination, setDestination] = useState("");
  const [problem, setProblem] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const address = destination.trim();
    if (!/^(bc1[a-z0-9]{20,90}|[13][a-km-zA-HJ-NP-Z1-9]{25,34})$/.test(address))
      return setProblem("That doesn't look like a Bitcoin address.");
    setProblem("");
    props.onSubmit(address);
  };
  return (
    <form onSubmit={submit}>
      <h1>{btc(props.sats)} is in your vault</h1>
      {props.failed && <p className="error">{props.failed}</p>}
      <label htmlFor="destination">Withdraw everything to this Bitcoin address</label>
      <input id="destination" autoComplete="off" spellCheck={false} placeholder="bc1…" value={destination} onChange={(e) => setDestination(e.target.value)} disabled={props.busy} />
      {problem && <p className="error">{problem}</p>}
      <button className="primary" disabled={props.busy}>
        {props.busy ? "Starting…" : "Withdraw"}
      </button>
      {props.children}
      <p className="small">A withdrawal empties the vault and takes several hours. You'll approve it on your Ledger at the end.</p>
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
