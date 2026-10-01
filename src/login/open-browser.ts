import { Command, CommandExecutor } from "@effect/platform";
import { Config, Effect } from "effect";

// What opens the login page: `open` on macOS, `xdg-open` elsewhere,
// overridable for tests.
const openBin = Config.string("PROOFBOX_OPEN").pipe(
  Config.withDefault(process.platform === "darwin" ? "open" : "xdg-open"),
);

// `true` when the opener accepted the url (exit 0); a non-zero exit, a
// spawn error, or a bad config is `false` — it never fails.
export const openBrowser = Effect.fn("openBrowser.openBrowser")(function* (
  url: string,
) {
  const executor = yield* CommandExecutor.CommandExecutor;
  const bin = yield* Effect.orDie(openBin);
  return yield* Command.exitCode(Command.make(bin, url)).pipe(
    Effect.provideService(CommandExecutor.CommandExecutor, executor),
    Effect.map((code) => code === 0),
    Effect.catchAll(() => Effect.succeed(false)),
  );
});
