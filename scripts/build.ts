import { globSync, rmSync } from "node:fs";
import { build } from "esbuild";
import { buildCommit } from "./build-commit.ts";

// Bundles src/ into dist/. Loading one bundle is about 4x faster than the
// ~1,300 files `effect` and its packages spread over (ADR 0017).

// Every process proofbox spawns is its own entry, so entryPath() finds
// dist/<path>-main.js.
const entryPoints = ["src/main.ts", ...globSync("src/**/*-main.ts")];

// `proofbox --version` names the commit (src/version.ts).
const commit = buildCommit(".");

rmSync("dist", { recursive: true, force: true });
const result = await build({
  entryPoints,
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node24",
  splitting: true,
  outdir: "dist",
  outbase: "src",
  entryNames: "[dir]/[name]",
  // Some dependencies are CommonJS and call `require` for Node built-ins,
  // which an ES module has no binding for.
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
  define:
    commit === undefined ? {} : { PROOFBOX_COMMIT: JSON.stringify(commit) },
  metafile: true,
});

const entryFile = Object.entries(result.metafile.outputs).find(
  ([, output]) => "src/entry.ts" in output.inputs,
)?.[0];
if (entryFile === undefined || entryFile.includes("/", "dist/".length)) {
  throw new Error(
    "src/entry.ts must build into a file directly in dist/: entryPath() and packagePath() resolve from it",
  );
}
