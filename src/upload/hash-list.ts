import { posix } from "node:path";
import { Schema } from "effect";
import type { WorkFile } from "./work-files.ts";

export const HashList = Schema.Struct({
  version: Schema.Literal(1),
  files: Schema.Record({
    key: Schema.String,
    value: Schema.Struct({
      sha256: Schema.String,
      executable: Schema.Boolean,
    }),
  }),
});
export type HashList = typeof HashList.Type;

export const hashListPath = (stateDir: string) =>
  posix.join(stateDir, "work-hashes.json");

export const toHashList = (files: ReadonlyArray<WorkFile>): HashList => ({
  version: 1 as const,
  files: Object.fromEntries(
    files.map((file) => [
      file.path,
      { sha256: file.sha256, executable: file.executable },
    ]),
  ),
});
