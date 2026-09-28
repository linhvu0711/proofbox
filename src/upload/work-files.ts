import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "@effect/platform";
import { Effect, Stream } from "effect";
import { NotGitFolderError, ProviderError } from "../errors.ts";

export interface WorkFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
  readonly executable: boolean;
}

const local = (cause: unknown) =>
  new ProviderError({
    provider: "local",
    reason: cause instanceof Error ? cause.message : String(cause),
  });

const hasCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const hashFile = (path: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<string>((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("error", reject);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
      }),
    catch: local,
  });

const hashLink = (path: string) =>
  Effect.tryPromise({
    try: async () =>
      createHash("sha256")
        .update(`link:${await readlink(path)}`)
        .digest("hex"),
    catch: local,
  });

const workFile = (folder: string, path: string) =>
  Effect.gen(function* () {
    const full = join(folder, path);
    const stat = yield* Effect.tryPromise({
      try: () => lstat(full),
      catch: (cause) => cause,
    }).pipe(
      Effect.catchAll((cause) =>
        hasCode(cause, "ENOENT")
          ? Effect.succeed(undefined)
          : Effect.fail(local(cause)),
      ),
    );
    if (stat === undefined || stat.isDirectory()) {
      return undefined;
    }
    const sha256 = stat.isSymbolicLink()
      ? yield* hashLink(full)
      : stat.isFile()
        ? yield* hashFile(full)
        : undefined;
    if (sha256 === undefined) {
      return undefined;
    }
    return {
      path,
      size: stat.size,
      sha256,
      executable: (stat.mode & 0o111) !== 0,
    } satisfies WorkFile;
  });

export const listWorkFiles = (folder: string) =>
  Effect.gen(function* () {
    const process = yield* Command.start(
      Command.make(
        "git",
        "ls-files",
        "-z",
        "--cached",
        "--others",
        "--exclude-standard",
      ).pipe(Command.workingDirectory(folder)),
    ).pipe(Effect.mapError(local));
    const [bytes, code] = yield* Effect.all(
      [
        Stream.runCollect(process.stdout),
        process.exitCode,
        Stream.runDrain(process.stderr),
      ],
      { concurrency: 3 },
    ).pipe(Effect.mapError(local));
    if (code !== 0) {
      return yield* new NotGitFolderError({ folder });
    }
    const text = Buffer.concat(
      [...bytes].map((chunk) => Buffer.from(chunk)),
    ).toString("utf8");
    const paths = [
      ...new Set(text.split("\0").filter((path) => path !== "")),
    ].sort();
    const files = yield* Effect.forEach(
      paths,
      (path) => workFile(folder, path),
      { concurrency: 8 },
    );
    return files.filter((file): file is WorkFile => file !== undefined);
  });
