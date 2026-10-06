import { posix } from "node:path";
import { Effect, Stream } from "effect";
import { KeeperClient } from "./keeper/keeper-client.ts";
import type { Os, Provider } from "./provider.ts";

// Where proofbox keeps each of its own files in a Sandbox. A Provider
// gives only its folders; a new Sandbox file joins this list.
export interface SandboxFiles {
  readonly setupScript: string;
  readonly setupEnvRaw: string;
  readonly setupEnv: string;
  readonly hashList: string;
  readonly secrets: string;
}

export const sandboxFiles = (
  provider: Provider,
  name: string,
  os: Os,
): SandboxFiles => {
  const folders = provider.sandboxFolders(name, os);
  return {
    setupScript: posix.join(folders.state, "setup"),
    // What the Setup script writes to $PROOFBOX_ENV, and the checked copy
    // every exec loads (ADR 0023).
    setupEnvRaw: posix.join(folders.state, "setup-env-raw"),
    setupEnv: posix.join(folders.state, "setup-env"),
    hashList: posix.join(folders.state, "work-hashes.json"),
    secrets: posix.join(folders.secrets, "env"),
  };
};

export const writeSandboxFile = Effect.fn("sandboxFile.writeSandboxFile")(
  function* (
    rawId: string,
    path: string,
    bytes: Uint8Array,
    options: { readonly executable: boolean },
  ) {
    const keeper = yield* KeeperClient;
    const written = yield* keeper.exec(
      rawId,
      [
        "sh",
        "-c",
        `umask 077; cat > "$1"${options.executable ? ' && chmod 700 "$1"' : ""}`,
        "sh",
        path,
      ],
      { stdin: Stream.make(bytes) },
    );
    let code = 0;
    yield* written.pipe(
      Stream.runForEach((event) =>
        event._tag === "Exit"
          ? Effect.sync(() => {
              code = event.code;
            })
          : Effect.void,
      ),
    );
    return code;
  },
);

// A missing file reads as empty text with code 0.
export const readSandboxFile = Effect.fn("sandboxFile.readSandboxFile")(
  function* (rawId: string, path: string) {
    const keeper = yield* KeeperClient;
    const read = yield* keeper.exec(rawId, [
      "sh",
      "-c",
      'if [ -f "$1" ]; then cat "$1"; fi',
      "sh",
      path,
    ]);
    const decoder = new TextDecoder();
    let text = "";
    let code = 0;
    yield* read.pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout":
            return Effect.sync(() => {
              text += decoder.decode(event.bytes, { stream: true });
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
    text += decoder.decode();
    return { code, text };
  },
);

// Every exec loads the Setup env, then the Secrets; a missing file is
// skipped, so a Sandbox without one runs the command as it is.
export const withSandboxEnv = (
  files: Pick<SandboxFiles, "setupEnv" | "secrets">,
  argv: ReadonlyArray<string>,
): ReadonlyArray<string> => [
  "sh",
  "-c",
  'set +x; if [ -r "$1" ]; then . "$1"; fi; if [ -r "$2" ]; then . "$2"; fi; shift 2; exec "$@"',
  "sh",
  files.setupEnv,
  files.secrets,
  ...argv,
];
