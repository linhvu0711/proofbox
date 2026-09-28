import { createHash } from "node:crypto";
import type { WorkFile } from "./upload/work-files.ts";

// A lockfile has one of these names, in any folder of the Work folder.
export const LOCKFILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "deno.lock",
  "Cargo.lock",
  "go.sum",
  "poetry.lock",
  "uv.lock",
  "Pipfile.lock",
  "Gemfile.lock",
  "composer.lock",
  "mix.lock",
  "pubspec.lock",
  "Package.resolved",
  "Podfile.lock",
  "gradle.lockfile",
]);

const isLockfile = (path: string) =>
  LOCKFILES.has(path.slice(path.lastIndexOf("/") + 1));

// The Fingerprint names a Snapshot: the Base image version, the Setup
// script, and every lockfile. Any other Work file leaves it the same.
export const fingerprint = (input: {
  readonly baseVersion: string;
  readonly script: Uint8Array;
  readonly files: ReadonlyArray<WorkFile>;
}): string => {
  const hash = createHash("sha256");
  hash.update(`base\0${input.baseVersion}\0`);
  const script = createHash("sha256").update(input.script).digest("hex");
  hash.update(`setup\0${script}\0`);
  const lockfiles = input.files
    .filter((file) => isLockfile(file.path))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of lockfiles) {
    hash.update(`lock\0${file.path}\0${file.sha256}\0`);
  }
  return hash.digest("hex").slice(0, 12);
};
