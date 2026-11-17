// The QSB SDK reads its network from process.env when it loads. QSB runs on Bitcoin mainnet only.
const g = globalThis as { process?: { env: Record<string, string | undefined> } };
g.process ??= { env: {} };
g.process.env.QSB_NETWORK = "mainnet";

export const config = {
  /** Simulated Ledger and service, to walk through the screens without hardware. */
  demo: new URLSearchParams(location.search).has("demo"),
  /** Name of the app in Ledger's catalog. */
  appName: import.meta.env.VITE_LEDGER_APP_NAME || "QSB",
  /** Ledger Manager provider that lists the app; unset means Ledger's public catalog. */
  provider: import.meta.env.VITE_LEDGER_PROVIDER ? Number(import.meta.env.VITE_LEDGER_PROVIDER) : undefined,
  /**
   * How the QSB app gets onto the Ledger: "catalog" (Ledger's servers, once Ledger lists the app)
   * or "sideload" (this site's own build; the Ledger warns that Ledger hasn't verified it).
   */
  install: (import.meta.env.VITE_LEDGER_INSTALL || (import.meta.env.VITE_LEDGER_PROVIDER ? "catalog" : "sideload")) as
    | "catalog"
    | "sideload",
  /** Origin of the QSB service; defaults to the page's own origin. */
  api: import.meta.env.VITE_QSB_API || location.origin,
  path: "m/84'/0'/0'/0/0",
};
