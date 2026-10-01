import { appendFileSync } from "node:fs";
import { registerHooks } from "node:module";

// Loaded with NODE_OPTIONS=--import=...: when the process exits, appends
// the URL of every module it resolved to the file in PROOFBOX_TEST_LOADS.
const out = process.env.PROOFBOX_TEST_LOADS;
if (out !== undefined) {
  const urls: Array<string> = [];
  registerHooks({
    resolve: (specifier, context, nextResolve) => {
      const result = nextResolve(specifier, context);
      urls.push(result.url);
      return result;
    },
  });
  process.on("exit", () => {
    appendFileSync(out, `${urls.join("\n")}\n`);
  });
}
