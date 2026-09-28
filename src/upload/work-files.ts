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
        // ENOTDIR too: a listed path's parent may have become a plain file
        hasCode(cause, "ENOENT") || hasCode(cause, "ENOTDIR")
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
    const raw = Buffer.concat([...bytes].map((chunk) => Buffer.from(chunk)));
    const segments: Array<Buffer> = [];
    let start = 0;
    for (let i = 0; i <= raw.length; i += 1) {
      if (i === raw.length || raw[i] === 0) {
        if (i > start) {
          segments.push(raw.subarray(start, i));
        }
        start = i + 1;
      }
    }
    const paths = yield* Effect.forEach(
      segments,
      (segment) => {
        const path = segment.toString("utf8");
        // A name that does not round-trip UTF-8 would silently vanish from
        // the upload; refuse it instead of sending a partial Work folder.
        return Buffer.from(path, "utf8").equals(segment)
          ? Effect.succeed(path)
          : Effect.fail(
              local(
                `a Work file name is not valid UTF-8 (0x${segment.toString("hex")}); rename it or git-ignore it`,
              ),
            );
      },
      { concurrency: 8 },
    );
    const unique = [...new Set(paths)].sort();
    const files = yield* Effect.forEach(
      unique,
      (path) => workFile(folder, path),
      { concurrency: 8 },
    );
    return files.filter((file): file is WorkFile => file !== undefined);
  });
