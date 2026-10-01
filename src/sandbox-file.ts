import { Effect, Stream } from "effect";
import { KeeperClient } from "./keeper/keeper-client.ts";

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
