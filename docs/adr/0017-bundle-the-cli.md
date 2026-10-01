# `pnpm build` bundles the CLI with esbuild

Each proofbox command spent about 0.75 s opening about 1,340 module files before it did any work, and a Caller in a look-decide-act loop pays that on every call. Most of the files come from `effect`, `@effect/cli`, and `@effect/platform-node`, which every command needs: alone they take about 0.58 s. So `pnpm build` bundles `src/` with esbuild into a few chunks, with one entry for `src/main.ts` and one for each `*-main.ts` helper that proofbox spawns, and `--help` now starts in about 0.2 s. `entryPath()` and `packagePath()` resolve from the file that holds `src/entry.ts`, so that file must sit directly in `dist/`; the build fails when it does not. Each Provider also loads only when a command asks for it, so a fake or Docker command never loads the Namespace libraries.

## Considered options

- Lazy imports only, no bundle: about 0.66 s, because the Effect packages still load file by file.
- Node's compile cache: no gain without a bundle, since the time goes to opening files, not compiling them.
- One single-file bundle: the detached helpers then have no file to spawn, and the Keeper never starts.
