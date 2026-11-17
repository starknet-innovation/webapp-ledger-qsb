import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

const shim = (name: string) => fileURLToPath(new URL(`./src/shims/${name}.ts`, import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  // In development, /v1 is forwarded to the QSB service so the browser stays same-origin.
  const proxy = env.QSB_API_ORIGIN
    ? { "/v1": { target: env.QSB_API_ORIGIN, changeOrigin: true } }
    : undefined;
  return {
    plugins: [react()],
    resolve: {
      // The QSB SDK is built for Node. These are the only Node pieces it imports.
      alias: {
        "node:crypto": shim("crypto"),
        "node:fs/promises": shim("fs"),
        pyodide: shim("pyodide"),
      },
    },
    server: { proxy },
  };
});
