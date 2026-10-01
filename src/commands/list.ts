import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { formatTime } from "../format-time.ts";
import { Providers } from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";

export const listSandboxes = (options: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const found = yield* Effect.forEach([...providers.entries()], ([, entry]) =>
      Effect.flatMap(entry.load, (provider) =>
        provider.list.pipe(
          Effect.map((result) => ({
            unreached: result.unreached,
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
  });
