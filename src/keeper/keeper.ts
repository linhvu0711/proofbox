import { rm, writeFile } from "node:fs/promises";
import {
  createConnection,
  createServer,
  type Server,
  type Socket,
} from "node:net";
import type { CommandExecutor } from "@effect/platform";
import { Effect, Runtime, Schedule, Stream } from "effect";
import { ProviderError, UnknownProviderError } from "../errors.ts";
import type { ExecEvent } from "../provider.ts";
import { Providers } from "../provider.ts";
import { parseSandboxId } from "../sandbox-id.ts";
import { keeperPaths } from "./paths.ts";
import { decodeRequest } from "./protocol.ts";

const socketAnswers = (path: string) =>
  Effect.async<boolean>((resume) => {
    const probe = createConnection({ path }, () => {
      probe.destroy();
      resume(Effect.succeed(true));
    });
    probe.once("error", () => {
      probe.destroy();
      resume(Effect.succeed(false));
    });
  });

const writeFrame = (socket: Socket, frame: unknown) =>
  Effect.async<void, Error>((resume) => {
    socket.write(`${JSON.stringify(frame)}\n`, (error) =>
      resume(error ? Effect.fail(error) : Effect.void),
    );
  });

const frameOf = (event: ExecEvent) => {
  switch (event._tag) {
    case "Stdout":
      return { out: Buffer.from(event.bytes).toString("base64") };
    case "Stderr":
      return { err: Buffer.from(event.bytes).toString("base64") };
    case "Exit":
      return { exit: event.code };
  }
};

export const runKeeper = (rawId: string) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const id = yield* parseSandboxId(rawId, [...providers.keys()]);
    const provider = providers.get(id.provider);
    if (provider === undefined) {
      return yield* new UnknownProviderError({
        provider: id.provider,
        known: [...providers.keys()],
      });
    }
    const paths = yield* keeperPaths(id);
    if (yield* socketAnswers(paths.socket)) {
      return;
    }
    yield* Effect.promise(() =>
      rm(paths.socket, { force: true }).catch(() => {}),
    );

    const serve = Effect.scoped(
      Effect.gen(function* () {
        const connection = yield* provider.connect(id.name);
        const runtime =
          yield* Effect.runtime<CommandExecutor.CommandExecutor>();
        const handleClient = (socket: Socket) => {
          let pending = "";
          socket.on("data", (chunk) => {
            pending += chunk.toString("utf8");
            const newline = pending.indexOf("\n");
            if (newline === -1) {
              return;
            }
            const line = pending.slice(0, newline);
            socket.pause();
            void Runtime.runPromiseExit(runtime)(
              Effect.gen(function* () {
                const request = yield* Effect.try({
                  try: () => decodeRequest(JSON.parse(line)),
                  catch: () => new Error("bad request"),
                });
                yield* connection
                  .exec(request.exec)
                  .pipe(
                    Stream.runForEach((event) =>
                      writeFrame(socket, frameOf(event)),
                    ),
                  );
              }).pipe(
                Effect.catchAll((error) =>
                  writeFrame(socket, {
                    fail:
                      error instanceof Error ? error.message : String(error),
                  }).pipe(Effect.orElseSucceed(() => undefined)),
                ),
                Effect.ensuring(
                  Effect.sync(() => {
                    socket.end();
                    socket.destroy();
                  }),
                ),
              ),
            );
          });
        };
        yield* Effect.acquireRelease(
          Effect.async<Server, ProviderError>((resume) => {
            const server = createServer(handleClient);
            server.once("error", (error) =>
              resume(
                Effect.fail(
                  new ProviderError({
                    provider: id.provider,
                    reason: error.message,
                  }),
                ),
              ),
            );
            server.listen(paths.socket, () => resume(Effect.succeed(server)));
          }),
          (server) =>
            Effect.promise(
              () => new Promise<void>((done) => server.close(() => done())),
            ),
        );
        yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () => writeFile(paths.pid, `${process.pid}\n`),
            catch: (cause) =>
              new ProviderError({
                provider: id.provider,
                reason: cause instanceof Error ? cause.message : String(cause),
              }),
          }),
          () =>
            Effect.promise(() =>
              Promise.all([
                rm(paths.socket, { force: true }).catch(() => {}),
                rm(paths.pid, { force: true }).catch(() => {}),
              ]).then(() => {}),
            ),
        );
        yield* Effect.never;
      }),
    );

    const watchGone = Effect.repeat(
      provider.get(id.name),
      Schedule.spaced("2 seconds"),
    ).pipe(Effect.asVoid);

    yield* Effect.raceFirst(serve, watchGone);
  });
