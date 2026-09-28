import { createHash } from "node:crypto";
import type { WorkFile } from "./upload/work-files.ts";

export const LOCKFILES: ReadonlyArray<string> = [
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
];

export const fingerprint = (input: {
  readonly baseVersion: string;
  readonly script: Uint8Array;
  readonly files: ReadonlyArray<WorkFile>;
}): string => {
  const hash = createHash("sha256");
  hash.update(`base\0${input.baseVersion}\0`);
  hash.update(
    `setup\0${createHash("sha256").update(input.script).digest("hex")}\0`,
  );
  const locks = input.files
    .filter((file) =>
      LOCKFILES.includes(file.path.slice(file.path.lastIndexOf("/") + 1)),
    )
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  for (const file of locks) {
    hash.update(`lock\0${file.path}\0${file.sha256}\0`);
  }
  return hash.digest("hex").slice(0, 12);
};
