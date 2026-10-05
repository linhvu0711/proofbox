// Checks by hand that the newest version of each registered Harness still
// works with proofbox: one tiny real Turn per Harness on Docker. It reads
// the maintainer's saved Harness logins and spends real Harness tokens, so
// `pnpm test` leaves it out; run it with `pnpm test:harness`.

import { NodeContext } from "@effect/platform-node";
import { ConfigProvider, Effect, Either, Option, Redacted } from "effect";
import { afterEach, expect, it } from "vitest";
import { Harnesses } from "../src/harness.ts";
import { HarnessesLive } from "../src/harness-registry.ts";
import {
  lastRefreshOf,
  readHarnessLoginFile,
  readHarnessLogins,
  saveHarnessLoginFile,
} from "../src/login/logins-file.ts";
import { cleanupEnvs, runCli } from "./support/cli.ts";
import { containers, docker, fixture } from "./support/harness.ts";

const PROMPT =
  "Create a file named proofbox-check.txt that holds the line ok, then commit it with git. Do not push.";

const registered = await Effect.runPromise(
  Effect.gen(function* () {
    const harnesses = yield* Harnesses;
    const logins = yield* readHarnessLogins;
    const now = Date.now();
    return yield* Effect.forEach([...harnesses.values()], (entry) =>
      Effect.gen(function* () {
        const loaded = yield* Effect.either(entry.load);
        const saved = logins[entry.name];
        const login: Option.Option<{ token: string } | { file: string }> =
          entry.login._tag === "File"
            ? Option.map(
                yield* readHarnessLoginFile(entry.name, entry.login.file),
                (file) => ({ file }),
              )
            : saved === undefined ||
                (saved.expiresAt !== undefined &&
                  saved.expiresAt.getTime() < now)
              ? Option.none()
              : Option.some({ token: Redacted.value(saved.token) });
        return { entry, loaded, login };
      }),
    );
  }).pipe(Effect.provide(HarnessesLive), Effect.provide(NodeContext.layer)),
);

const copyBackFileLogin = Effect.fn("harnessLive.copyBackFileLogin")(function* (
  name: string,
  file: string,
  home: string,
) {
  const fixture = yield* readHarnessLoginFile(name, file).pipe(
    Effect.withConfigProvider(
      ConfigProvider.fromMap(new Map([["HOME", home]])),
    ),
  );
  const real = yield* readHarnessLoginFile(name, file);
  if (Option.isNone(fixture) || Option.isNone(real)) return;
  const newer = lastRefreshOf(fixture.value);
  const older = lastRefreshOf(real.value);
  if (
    Option.isSome(newer) &&
    Option.isSome(older) &&
    newer.value.getTime() > older.value.getTime()
  )
    yield* saveHarnessLoginFile(name, file, fixture.value);
});

afterEach(() => {
  for (const container of containers.splice(0)) docker("rm", "-f", container);
  cleanupEnvs();
});

for (const { entry, loaded, login } of registered) {
  const name = entry.name;
  it(`a real Turn on ${name} ends done`, async (ctx) => {
    if (Either.isLeft(loaded)) {
      const line = `${name}: proofbox cannot run it yet: ${loaded.left.reason}`;
      console.warn(line);
      return ctx.skip(line);
    }
    if (Option.isNone(login)) {
      const command =
        entry.login._tag === "Env"
          ? `echo ${entry.login.placeholder} | proofbox harness login ${name}`
          : `proofbox harness login ${name}`;
      const line = `${name}: no Harness login; run: ${command}. ${entry.login.howToMake}.`;
      console.warn(line);
      return ctx.skip(line);
    }
    // Given
    const { env, settings, create } = fixture(name, login.value);
    try {
      const created = await create();
      if (created.exitCode !== 0) throw new Error(created.stderr);
      const id = created.stdout.trim();
      // When
      const prompt = await runCli(
        env,
        ["harness", "prompt", id, PROMPT],
        settings,
      );
      if (prompt.exitCode !== 0) throw new Error(prompt.stderr);
      const wait = await runCli(
        env,
        ["harness", "wait", id, "--timeout", "10m"],
        settings,
      );
      // Then
      expect({
        firstLine: wait.stdout.split("\n")[0],
        code: wait.exitCode,
      }).toEqual({ firstLine: "done", code: 0 });
    } finally {
      if (entry.login._tag === "File")
        await Effect.runPromise(
          copyBackFileLogin(name, entry.login.file, settings.set.HOME).pipe(
            Effect.provide(NodeContext.layer),
          ),
        );
    }
  });
}
