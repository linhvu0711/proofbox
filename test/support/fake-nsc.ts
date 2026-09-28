import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTempDir } from "./cli.ts";

// An executable shell script standing in for the nsc binary: every call is
// appended to <log> as one line, then `script` runs with the call's argv.
export const makeFakeNsc = (script: string): { path: string; log: string } => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-nsc-"));
  trackTempDir(dir);
  const path = join(dir, "nsc");
  const log = join(dir, "log");
  writeFileSync(path, `#!/bin/sh\necho "$*" >> "${log}"\n${script}\n`, {
    mode: 0o755,
  });
  return { path, log };
};
