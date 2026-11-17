// Only the SDK's Config A (QSB v1) runtime reads files. This front end uses v2 vaults.
export async function readFile(): Promise<never> {
  throw new Error("QSB v1 vaults aren't supported in the browser.");
}
