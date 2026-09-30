import { dirname, join, resolve } from "node:path";
import { Duration, Effect, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { withDeadlinePush } from "../deadline.ts";
import {
  ProviderError,
  UploadFailedError,
  type WorkFileGrewError,
  WorkFolderTooBigError,
} from "../errors.ts";
import { withFileLock } from "../file-lock.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import { Providers } from "../provider.ts";
import { resolveSandboxId } from "../sandbox-id.ts";
import {
  diffHashList,
  HashList,
  hashListPath,
  toHashList,
} from "../upload/hash-list.ts";
import { MAX_SIZE_DEFAULT } from "../upload/max-size.ts";
import { packFiles } from "../upload/pack.ts";
import { listWorkFiles, type WorkFile } from "../upload/work-files.ts";

export const readWorkFolder = (folder: string, maxSize: number) =>
  Effect.gen(function* () {
    const files = yield* listWorkFiles(resolve(folder));
    const bytes = files.reduce((total, file) => total + file.size, 0);
    if (bytes > maxSize) {
      return yield* new WorkFolderTooBigError({ bytes, limit: maxSize });
    }
    return files;
  });

// A saved list lives in the Sandbox; check paths before they reach rm
// and tar so a tampered one cannot point the sync outside the Work
// folder.
const pathOutsideWork = (path: string) =>
  path === "" ||
  path.startsWith("/") ||
  path.includes("\0") ||
  path.split("/").includes("..");

// Two uploads at once could interleave rm, tar, and the list write;
// a lock dir in the runtime folder serializes them on the Caller.
const withUploadLock = <A, E, R>(
  provider: string,
  name: string,
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E | ProviderError, R> =>
  Effect.gen(function* () {
    const paths = yield* keeperPaths({ provider, name });
    const lockDir = join(paths.dir, `upload-${name}.lock`);
    const reason = `another upload to ${name} is in flight; delete ${lockDir} if it is stale`;
    return yield* withFileLock({
      dir: lockDir,
      wait: Duration.minutes(1),
      busy: () => new ProviderError({ provider, reason }),
      failed: (cause) =>
        new ProviderError({
          provider,
          reason: cause instanceof Error ? cause.message : String(cause),
        }),
    })(effect);
  });

const runInSandbox = (
  keeper: KeeperClient,
  rawId: string,
  argv: ReadonlyArray<string>,
  stdin?: Stream.Stream<
    Uint8Array,
    ProviderError | UploadFailedError | WorkFileGrewError
  >,
) =>
  Effect.gen(function* () {
    const events = yield* keeper.exec(
      rawId,
      argv,
      stdin === undefined ? undefined : { stdin },
    );
    const out: Array<Uint8Array> = [];
    let code = 0;
    yield* events.pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout":
            return Effect.sync(() => {
              out.push(event.bytes);
            });
          case "Stderr":
            return Effect.void;
          case "Exit":
            return Effect.sync(() => {
              code = event.code;
            });
        }
      }),
    );
    if (code !== 0) {
      return yield* new UploadFailedError({
        id: rawId,
        command: argv[0] ?? "",
        code,
      });
    }
    return Buffer.concat([...out].map((chunk) => Buffer.from(chunk))).toString(
      "utf8",
    );
  });

export const sendWorkFolder = (
  rawId: string,
  folder: string,
  files: ReadonlyArray<WorkFile>,
  maxSize: number,
) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* resolveSandboxId(rawId, providers);
    const provider = id.provider;
    const progress = yield* Progress;
    const output = yield* CliOutput;
    const keeper = yield* KeeperClient;
    const info = yield* provider.get(id);
    const listPath = hashListPath(provider.stateDir(id.name));
    const diff = yield* progress.step(
      "uploading Work folder",
      withDeadlinePush(
        provider,
        id,
        info,
      )(
        withUploadLock(
          id.prefix,
          id.name,
          Effect.gen(function* () {
            const old = yield* runInSandbox(keeper, rawId, [
              "cat",
              listPath,
            ]).pipe(
              Effect.flatMap((raw) =>
                Schema.decodeUnknown(Schema.parseJson(HashList))(raw),
              ),
              Effect.catchAll(() => Effect.succeed(undefined)),
            );
            let diff = diffHashList(old, files);
            if (
              [...diff.send, ...diff.remove].some((path) =>
                pathOutsideWork(path),
              )
            ) {
              return yield* new ProviderError({
                provider: id.provider.name,
                reason:
                  "a Work file path is absolute or escapes the Work folder; delete the hash list in the state dir to reset",
              });
            }
            if (diff.send.length !== 0 || diff.remove.length !== 0) {
              yield* runInSandbox(keeper, rawId, ["rm", "-f", listPath]);
            }
            // A symlinked ancestor carries a remove or an extract outside the
            // Work folder; drop any the Sandbox holds before touching paths
            // under them. A tracked link that gets dropped is resent anyway,
            // since a kind change puts it in the send list.
            const ancestors = new Set<string>();
            for (const path of [...diff.send, ...diff.remove]) {
              for (let dir = dirname(path); dir !== "."; dir = dirname(dir)) {
                ancestors.add(dir);
              }
            }
            if (ancestors.size !== 0) {
              const cleared = yield* runInSandbox(
                keeper,
                rawId,
                [
                  "xargs",
                  "-0",
                  "-I{}",
                  "sh",
                  "-c",
                  '[ -L "$1" ] && { printf "%s\\0" "$1"; rm -f -- "$1"; } || :',
                  "sh",
                  "{}",
                ],
                Stream.make(
                  new TextEncoder().encode([...ancestors].join("\0")),
                ),
              );
              // A cleared dir took every uploaded file under it; siblings
              // that did not change are not in the send list, so add the
              // Caller's own files below each cleared path.
              if (cleared !== "") {
                const dropped = cleared.split("\0").filter((dir) => dir !== "");
                const send = new Set(diff.send);
                for (const file of files) {
                  if (
                    !send.has(file.path) &&
                    dropped.some((dir) => file.path.startsWith(`${dir}/`))
                  ) {
                    send.add(file.path);
                  }
                }
                diff = { send: [...send].sort(), remove: diff.remove };
              }
            }
            // Removal runs before extraction: a path that changed kind (a
            // folder that became a file, or the reverse) blocks tar, and the
            // old entry must be gone first. -rf also clears folder members of
            // removed paths that the Caller never listed.
            if (diff.remove.length !== 0) {
              yield* runInSandbox(
                keeper,
                rawId,
                ["xargs", "-0", "rm", "-rf", "--"],
                Stream.make(new TextEncoder().encode(diff.remove.join("\0"))),
              );
            }
            if (diff.send.length !== 0) {
              yield* runInSandbox(
                keeper,
                rawId,
                ["tar", "-x", "-f", "-"],
                packFiles(folder, rawId, diff.send, maxSize),
              );
            }
            if (
              diff.send.length !== 0 ||
              diff.remove.length !== 0 ||
              old === undefined
            ) {
              const list = new TextEncoder().encode(
                JSON.stringify(Schema.encodeSync(HashList)(toHashList(files))),
              );
              yield* runInSandbox(
                keeper,
                rawId,
                [
                  "sh",
                  "-c",
                  'cat > "$1.tmp" && mv "$1.tmp" "$1"',
                  "sh",
                  listPath,
                ],
                Stream.make(list),
              );
            }
            return diff;
          }),
        ),
      ),
    );
    yield* output.err(
      `proofbox: sent ${diff.send.length} ${diff.send.length === 1 ? "file" : "files"}, removed ${diff.remove.length} ${diff.remove.length === 1 ? "file" : "files"}\n`,
    );
  });

export const uploadWorkFolder = (args: {
  id: string;
  folder: string;
  maxSize?: number | undefined;
}) =>
  Effect.gen(function* () {
    const maxSize = args.maxSize ?? MAX_SIZE_DEFAULT;
    const files = yield* readWorkFolder(args.folder, maxSize);
    yield* sendWorkFolder(args.id, args.folder, files, maxSize);
  }).pipe(Effect.scoped);
