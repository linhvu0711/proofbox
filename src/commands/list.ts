import { Clock, Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { formatTime } from "../format-time.ts";
import { Providers } from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";

// Whole minutes, so the line reads the same for the few seconds a
// command takes.
const startedAgo = (millis: number) => {
  const minutes = Math.floor(millis / 60_000);
  return minutes < 1 ? "under 1 min ago" : `${minutes} min ago`;
};

export const listSandboxes = Effect.fn("list.listSandboxes")(
  function* (options: { readonly json: boolean }) {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const found = yield* Effect.forEach([...providers.entries()], ([, entry]) =>
      Effect.flatMap(entry.load, (provider) =>
        provider.list.pipe(
          Effect.map((result) => ({
            unreached: result.unreached,
            unfinished: result.unfinished.map((machine) => ({
              id: formatSandboxId({
                provider: provider.idPrefix,
                region: machine.region,
                name: machine.name,
              }),
              provider: provider.name,
              machine,
            })),
            sandboxes: result.infos.map((info) => ({
              id: formatSandboxId({
                provider: provider.idPrefix,
                region: info.region,
                name: info.name,
              }),
              info,
            })),
          })),
          // A Provider that cannot be reached at all must not hide the
          // Sandboxes of the rest: it is named like an unreached region
          // and the others still list. Any other failure (auth, a corrupt
          // file) still fails the command.
          Effect.catchTag("ProviderUnavailableError", (error) =>
            Effect.succeed({
              unreached: [{ where: provider.name, reason: error.message }],
              unfinished: [],
              sandboxes: [],
            }),
          ),
        ),
      ),
    );
    for (const { unreached } of found) {
      for (const miss of unreached) {
        yield* output.err(
          `Could not list Sandboxes in ${miss.where}: ${miss.reason}\n`,
        );
      }
    }
    // An Unfinished Sandbox still uses quota but is not a Sandbox yet, so
    // it is named on stderr only, oldest first, with how to delete it.
    const nowMillis = yield* Clock.currentTimeMillis;
    const unfinished = found
      .flatMap((entry) => entry.unfinished)
      .sort(
        (a, b) =>
          (a.machine.createdAt?.getTime() ?? nowMillis) -
          (b.machine.createdAt?.getTime() ?? nowMillis),
      );
    for (const { id, provider, machine } of unfinished) {
      const started =
        machine.createdAt === undefined
          ? ""
          : `, started ${startedAgo(nowMillis - machine.createdAt.getTime())}`;
      yield* output.err(
        `Unfinished Sandbox ${id} (${machine.os}${started}): a create may still be making it, or one stopped part way. It counts against your ${provider} quota until you delete it. Run: proofbox delete ${id}\n`,
      );
    }
    const sandboxes = found
      .flatMap((entry) => entry.sandboxes)
      .sort((a, b) => a.info.createdAt.getTime() - b.info.createdAt.getTime());
    if (options.json) {
      yield* output.out(
        `${JSON.stringify(
          sandboxes.map(({ id, info }) => ({
            id,
            os: info.os,
            ...(info.base === undefined ? {} : { base: info.base }),
            deadline: formatTime(info.deadline),
            maxLife: formatTime(info.maxLifeAt),
          })),
        )}\n`,
      );
      return;
    }
    if (sandboxes.length === 0) {
      yield* output.err("No live Sandboxes\n");
      return;
    }
    for (const { id, info } of sandboxes) {
      yield* output.out(
        `${id}  ${info.os}  ${info.base === undefined ? "" : `base ${info.base}  `}deadline ${formatTime(info.deadline)}  max life ${formatTime(
          info.maxLifeAt,
        )}\n`,
      );
    }
  },
);
