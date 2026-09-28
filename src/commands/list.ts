import { Effect } from "effect";
import { CliOutput } from "../cli-output.ts";
import { Providers, type SandboxInfo } from "../provider.ts";

const formatTime = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, "Z");

export const listSandboxes = (options: { readonly json: boolean }) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const output = yield* CliOutput;
    const found = yield* Effect.forEach(
      [...providers.entries()],
      ([providerName, provider]) =>
        provider.list.pipe(
          Effect.map((infos) =>
            infos.map((info) => ({ id: `${providerName}:${info.name}`, info })),
          ),
        ),
    );
    const sandboxes = found
      .flat()
      .sort((a, b) => a.info.createdAt.getTime() - b.info.createdAt.getTime());
    if (options.json) {
      yield* output.out(
        `${JSON.stringify(
          sandboxes.map(({ id, info }) => ({
            id,
            os: info.os,
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
        `${id}  ${info.os}  deadline ${formatTime(info.deadline)}  max life ${formatTime(
          info.maxLifeAt,
        )}\n`,
      );
    }
  });
