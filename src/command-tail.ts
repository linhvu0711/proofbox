import { Effect, Stream } from "effect";
import type {
  ProviderError,
  UploadFailedError,
  WorkFileGrewError,
} from "./errors.ts";
import { KeeperClient } from "./keeper/keeper-client.ts";

const KEEP_LINES = 50;

export const runKeepingTail = Effect.fn("commandTail.runKeepingTail")(
  function* (
    rawId: string,
    argv: ReadonlyArray<string>,
    stdin?: Stream.Stream<
      Uint8Array,
      ProviderError | UploadFailedError | WorkFileGrewError
    >,
  ) {
    const keeper = yield* KeeperClient;
    const lines: Array<string> = [];
    let pending = "";
    const decoder = new TextDecoder();
    const keep = (chunk: Uint8Array) => {
      pending += decoder.decode(chunk, { stream: true });
      let newline = pending.indexOf("\n");
      while (newline !== -1) {
        lines.push(pending.slice(0, newline + 1));
        if (lines.length > KEEP_LINES) lines.shift();
        pending = pending.slice(newline + 1);
        newline = pending.indexOf("\n");
      }
      // Bound a runaway line without dropping complete lines mid-chunk.
      if (pending.length > 65_536) pending = pending.slice(-65_536);
    };
    const ran = yield* keeper.exec(
      rawId,
      argv,
      stdin === undefined ? undefined : { stdin },
    );
    let code = 0;
    yield* ran.pipe(
      Stream.runForEach((event) => {
        switch (event._tag) {
          case "Stdout":
          case "Stderr":
            return Effect.sync(() => keep(event.bytes));
          case "Exit":
            return Effect.sync(() => {
              code = event.code;
            });
        }
      }),
    );
    pending += decoder.decode();
    if (pending !== "") {
      lines.push(`${pending}\n`);
      if (lines.length > KEEP_LINES) lines.shift();
    }
    return { code, lines } as const;
  },
);
