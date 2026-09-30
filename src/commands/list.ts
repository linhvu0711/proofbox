import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { formatTime } from "../format-time.ts";
import { Providers } from "../provider.ts";

export const listSandboxes = (options: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const found = yield* Effect.forEach(
      [...providers.entries()],
      ([, provider]) =>
        provider.list.pipe(
          Effect.map((result) => ({
            unreached: result.unreached,
            sandboxes: result.infos.map((info) => ({
              id: `${provider.idPrefix}:${info.name}`,
              info,
            })),
          })),
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
