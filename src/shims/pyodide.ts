export async function loadPyodide(): Promise<never> {
  throw new Error("QSB v1 vaults aren't supported in the browser.");
}
