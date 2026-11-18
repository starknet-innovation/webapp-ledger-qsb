// Node can't load the ESM build of Ledger's Device Management Kit packages (it uses directory
// imports), so tests load their CommonJS build instead: node --import ./test/ledger-cjs.mjs …
import { registerHooks } from "node:module";

registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith("@ledgerhq/"))
      return next(specifier, { ...context, conditions: context.conditions.filter((c) => c !== "import").concat("require") });
    return next(specifier, context);
  },
});
