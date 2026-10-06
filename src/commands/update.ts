import { Command, CommandExecutor } from "@effect/platform";
import { Config, Effect, type Option, Stream } from "effect";
import { CliOutput } from "../cli-output.ts";
import { commandEvents } from "../command-events.ts";
import { UpdateError } from "../errors.ts";
import { Progress } from "../progress.ts";

const REPO = "linhvu0711/proofbox";

// The GitHub REST API base, overridable for tests.
const githubApi = Config.string("PROOFBOX_GITHUB_API_URL").pipe(
  Config.withDefault("https://api.github.com"),
);

// The full commit of `ref` (a branch or a short or full hash): with this
// Accept header the commits API answers the bare hash as text.
const lookUpCommit = Effect.fn("update.lookUpCommit")(function* (ref: string) {
  const base = yield* githubApi.pipe(
    Effect.mapError((error) => new UpdateError({ reason: error.message })),
  );
  const reply = yield* Effect.tryPromise({
    try: async () => {
      const res = await fetch(`${base}/repos/${REPO}/commits/${ref}`, {
        headers: { accept: "application/vnd.github.sha" },
      });
      return { status: res.status, body: (await res.text()).trim() };
    },
    catch: () =>
      new UpdateError({
        reason: `Could not reach GitHub to look up ${ref}. Check the network and try again.`,
      }),
  });
  return reply.body;
});

// pnpm 12 builds a git package only when --allow-build names it by its
// resolved key, the codeload URL with the full commit.
const installArgs = (full: string) => [
  "add",
  "-g",
  `--allow-build=proofbox@https://codeload.github.com/${REPO}/tar.gz/${full}`,
  `github:${REPO}#${full}`,
];

export const updateProofbox = Effect.fn("update.updateProofbox")(
  function* (_options: { readonly commit: Option.Option<string> }) {
    const output = yield* CliOutput;
    const progress = yield* Progress;
    const executor = yield* CommandExecutor.CommandExecutor;
    const full = yield* lookUpCommit("main");
    const short = full.slice(0, 7);
    yield* progress.note(`installing proofbox ${short} from GitHub`);
    // No stdin, so pnpm never asks which packages to build. Its output is
    // progress, not the result, so all of it goes to stderr.
    yield* commandEvents(
      executor,
      Command.make("pnpm", ...installArgs(full)),
      undefined,
      {
        spawn: (error) => new UpdateError({ reason: error.message }),
        fail: (reason) => new UpdateError({ reason }),
      },
    ).pipe(
      Stream.runForEach((event) =>
        event._tag === "Exit" ? Effect.void : output.err(event.bytes),
      ),
    );
    yield* output.out(`${short}\n`);
  },
);
