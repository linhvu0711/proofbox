import { dirname, resolve } from "node:path";
import { Effect, Schema, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { withDeadlinePush } from "../deadline.ts";
import {
  type ProviderError,
  UploadFailedError,
  WorkFolderTooBigError,
} from "../errors.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { Progress } from "../progress.ts";
import { Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";
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

const runInSandbox = (
  keeper: KeeperClient,
  rawId: string,
  argv: ReadonlyArray<string>,
  stdin?: Stream.Stream<Uint8Array, ProviderError | UploadFailedError>,
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
) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* Effect.die(
        new Error(`Provider ${id.provider} passed parsing but is unknown`),
      );
    }
    const progress = yield* Progress;
    const output = yield* CliOutput;
    const keeper = yield* KeeperClient;
    const info = yield* provider.get(id.name);
    const listPath = hashListPath(provider.stateDir(id.name));
    const diff = yield* progress.step(
      "uploading Work folder",
      withDeadlinePush(
        provider,
        id.name,
        info,
      )(
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
          const diff = diffHashList(old, files);
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
            yield* runInSandbox(
              keeper,
              rawId,
              [
                "xargs",
                "-0",
                "-I{}",
                "sh",
                "-c",
                '[ -L "$1" ] && rm -f -- "$1" || :',
                "sh",
                "{}",
              ],
              Stream.make(new TextEncoder().encode([...ancestors].join("\0"))),
            );
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
              packFiles(folder, rawId, diff.send),
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
    const files = yield* readWorkFolder(
      args.folder,
      args.maxSize ?? MAX_SIZE_DEFAULT,
    );
    yield* sendWorkFolder(args.id, args.folder, files);
  }).pipe(Effect.scoped);
