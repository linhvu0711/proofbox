import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackTempDir } from "./cli.ts";

// An executable `open` stand-in: `script` runs with the url as `$1`, so a
// test can fake a browser that clicks (curl the url) or one that is not
// there at all (`exit 1`).
export const makeFakeOpen = (script: string): string => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-open-"));
  trackTempDir(dir);
  const path = join(dir, "open");
  writeFileSync(path, `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  return path;
};
