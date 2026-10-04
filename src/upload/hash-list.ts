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

export const toHashList = (files: ReadonlyArray<WorkFile>): HashList => ({
  version: 1 as const,
  files: Object.fromEntries(
    files.map((file) => [
      file.path,
      { sha256: file.sha256, executable: file.executable },
    ]),
  ),
});

export interface HashDiff {
  readonly send: ReadonlyArray<string>;
  readonly remove: ReadonlyArray<string>;
}

export const hashListAfterCheckout = (
  old: HashList | undefined,
  files: ReadonlyArray<WorkFile>,
  dirty: ReadonlyArray<string>,
): HashList => {
  const baseline = { ...old?.files };
  const changed = new Set(dirty);
  const present = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (!changed.has(file.path)) {
      baseline[file.path] = {
        sha256: file.sha256,
        executable: file.executable,
      };
    }
  }
  for (const path of dirty) {
    delete baseline[path];
    if (!present.has(path)) baseline[path] = { sha256: "", executable: false };
  }
  return { version: 1, files: baseline };
};

export const diffHashList = (
  old: HashList | undefined,
  files: ReadonlyArray<WorkFile>,
): HashDiff => {
  const send: Array<string> = [];
  for (const file of files) {
    const known = old?.files[file.path];
    if (
      known === undefined ||
      known.sha256 !== file.sha256 ||
      known.executable !== file.executable
    ) {
      send.push(file.path);
    }
  }
  const remove: Array<string> = [];
  if (old !== undefined) {
    const present = new Set(files.map((file) => file.path));
    for (const path of Object.keys(old.files)) {
      if (!present.has(path)) {
        remove.push(path);
      }
    }
  }
  send.sort();
  remove.sort();
  return { send, remove };
};
