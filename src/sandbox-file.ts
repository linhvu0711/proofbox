import { posix } from "node:path";
import { Effect, Stream } from "effect";
import { KeeperClient } from "./keeper/keeper-client.ts";
import type { Os, Provider } from "./provider.ts";

// Where proofbox keeps each of its own files in a Sandbox. A Provider
// gives only its folders; a new Sandbox file joins this list.
export interface SandboxFiles {
  readonly setupScript: string;
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
