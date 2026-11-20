import { join } from "node:path";
import { Command, CommandExecutor, FileSystem } from "@effect/platform";
import {
  Cause,
  Clock,
  Config,
  Duration,
  Effect,
  Option,
  Ref,
  Schedule,
} from "effect";
import { captureCommand } from "../command-events.ts";
import { deadlineText, firstDeadline, parseSpan } from "../deadline.ts";
import {
  type ProviderError,
  ProviderLimitError,
  ProviderUnavailableError,
  platformReason,
  UnknownRegionError,
} from "../errors.ts";
import { formatWait } from "../format-time.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import type { Provider, ProviderLogin, SandboxRef } from "../provider.ts";
import { fileStem, makeSandboxName } from "../sandbox-id.ts";
import { formatSize, type Size } from "../size.ts";
import type { NamespaceApi } from "./namespace-api.ts";
import { fail, type NamespaceHost } from "./namespace-host.ts";
import { DEFAULT_REGION, KNOWN_REGIONS } from "./regions.ts";
import type { OpenLink } from "./ssh-link.ts";

export const makeNamespaceCreate = (deps: {
  readonly api: NamespaceApi;
  readonly executor: CommandExecutor.CommandExecutor;
  readonly fs: FileSystem.FileSystem;
  readonly login: ProviderLogin;
  readonly openLink: OpenLink;
  readonly spawnDetached: (
    provider: string,
    rel: string,
    args: ReadonlyArray<string>,
  ) => Effect.Effect<void, ProviderError>;
  readonly hostFor: (os: string | undefined) => NamespaceHost;
}) => {
  const api = deps.api;
  const hostFor = deps.hostFor;
  const paths = (name: string) =>
    keeperPaths({ provider: "ns", name }).pipe(
      Effect.provideService(FileSystem.FileSystem, deps.fs),
    );
  const refPaths = (ref: SandboxRef) => paths(fileStem(ref));

  // create+wait can hang; bound the wait, then sweep whatever it
  // half-made.
  const createTimeout = Config.string("PROOFBOX_NS_CREATE_TIMEOUT").pipe(
    Config.withDefault("60s"),
  );

  // Host prep can stall on any host command; bound the whole part, then
  // delete the host, so a stall never holds the host's quota (#261).
  const prepareTimeout = Config.string("PROOFBOX_NS_PREPARE_TIMEOUT").pipe(
    Config.withDefault("15m"),
  );

  // A destroy frees the host's quota a moment after it returns, so a
  // create right behind a delete can land on a full-looking account:
  // give a plan-limit refusal this long to lift before reporting it.
  const limitWait = Config.string("PROOFBOX_NS_LIMIT_WAIT").pipe(
    Config.withDefault("45s"),
  );

  const create = Effect.fn("namespaceCreate.create")(function* (req: {
    readonly os: Parameters<Provider["create"]>[0]["os"];
    readonly idle: Duration.Duration;
    readonly maxLife: Duration.Duration;
    readonly size?: Size | undefined;
    readonly name?: string | undefined;
    readonly snapshot?: string | undefined;
  }) {
    const login = yield* deps.login;
    const region = Option.getOrElse(login.region, () => DEFAULT_REGION);
    if (!KNOWN_REGIONS.includes(region)) {
      return yield* new UnknownRegionError({
        provider: "namespace",
        region,
        known: KNOWN_REGIONS,
      });
    }
    const host = hostFor(req.os);
    const size = req.size ?? host.defaultSize;
    const staged = yield* paths(`new-${process.pid}`);
    const keyBase = join(staged.dir, `ns-new-${process.pid}.key`);
    // Whatever part of the make is left — key files, the host — leaves
    // nothing behind on a failed create.
    const createToken = makeSandboxName();
    let hostRef: SandboxRef | undefined;
    // Set once the prep timeout has deleted the host, so cleanup does not
    // delete it again.
    let hostDeleted = false;
    const cleanup = Effect.gen(function* () {
      yield* Effect.all(
        [
          deps.fs.remove(keyBase, { force: true }).pipe(Effect.ignore),
          deps.fs.remove(`${keyBase}.pub`, { force: true }).pipe(Effect.ignore),
        ],
        { concurrency: "unbounded" },
      );
      if (hostRef !== undefined) {
        const hostPaths = yield* refPaths(hostRef);
        yield* Effect.all(
          [
            deps.fs.remove(hostPaths.key, { force: true }).pipe(Effect.ignore),
            deps.fs
              .remove(`${hostPaths.key}.pub`, { force: true })
              .pipe(Effect.ignore),
            deps.fs
              .remove(hostPaths.maxLife, { force: true })
              .pipe(Effect.ignore),
            deps.fs.remove(hostPaths.os, { force: true }).pipe(Effect.ignore),
            deps.fs
              .remove(hostPaths.sshdKnownHosts, { force: true })
              .pipe(Effect.ignore),
          ],
          { concurrency: "unbounded" },
        );
        if (!hostDeleted) {
          yield* api
            .destroy(hostRef.region ?? "", hostRef.name)
            .pipe(Effect.orElseSucceed(() => {}));
        }
      }
    });
    return yield* Effect.gen(function* () {
      const progress = yield* Progress;
      const keygen = yield* captureCommand(
        Command.make(
          "ssh-keygen",
          "-q",
          "-t",
          "ed25519",
          "-N",
          "",
          "-C",
          "proofbox",
          "-f",
          keyBase,
        ),
      ).pipe(
        Effect.provideService(CommandExecutor.CommandExecutor, deps.executor),
        Effect.mapError((error) =>
          error._tag === "SystemError" && error.reason === "NotFound"
            ? fail("ssh-keygen failed: spawn ssh-keygen ENOENT")
            : fail(`ssh-keygen failed: ${error.message}`),
        ),
      );
      if (keygen.exitCode !== 0) {
        return yield* fail(
          `ssh-keygen failed: exit ${keygen.exitCode}: ${keygen.stderr.trim()}`,
        );
      }
      // Max life counts from the create call, so the Sandbox's
      // maxLifeAt, the host-cap file the detached pushes read, and the
      // provisioning keepalive all stop at the same instant — anchor it
      // before the host is created, not after. Whole seconds, since the
      // Max life file holds whole seconds.
      const startedAt = yield* Clock.currentTimeMillis;
      const maxLifeAt = new Date(
        Math.floor((startedAt + Duration.toMillis(req.maxLife)) / 1000) * 1000,
      );
      const sshKey = (yield* deps.fs
        .readFileString(`${keyBase}.pub`)
        .pipe(
          Effect.mapError((error) =>
            fail(`could not read the host key: ${platformReason(error)}`),
          ),
        )).trim();
      const spanText = yield* createTimeout.pipe(
        Effect.mapError((error) => fail(error.message)),
      );
      const span = yield* parseSpan(
        "PROOFBOX_NS_CREATE_TIMEOUT",
        spanText,
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const prepSpan = yield* parseSpan(
        "PROOFBOX_NS_PREPARE_TIMEOUT",
        yield* prepareTimeout.pipe(
          Effect.mapError((error) => fail(error.message)),
        ),
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const limitSpan = yield* parseSpan(
        "PROOFBOX_NS_LIMIT_WAIT",
        yield* limitWait.pipe(Effect.mapError((error) => fail(error.message))),
        {
          units: ["ms", "s", "m"],
          zero: true,
          example: "45s",
        },
      ).pipe(Effect.mapError((error) => fail(error.message)));
      const { instanceId, deadline } = yield* Effect.timeoutOption(
        Effect.gen(function* () {
          const now = new Date(yield* Clock.currentTimeMillis);
          const deadline = firstDeadline({ now, idle: req.idle, maxLifeAt });
          const made = yield* api
            .create(region, {
              shape: {
                os: req.os,
                machineArch: host.machine.arch,
                virtualCpu: size.cpu,
                memoryMegabytes: size.ramGb * 1024,
                selectors: host.machine.selectors,
              },
              labels: [
                { name: "proofbox.os", value: req.os },
                { name: "proofbox.region", value: region },
                { name: "proofbox.size", value: formatSize(size) },
                { name: "proofbox.create-token", value: createToken },
              ],
              deadline,
              authorizedSshKeys: [sshKey],
            })
            .pipe(
              Effect.retry({
                while: (error) => error instanceof ProviderLimitError,
                schedule: Schedule.spaced(Duration.seconds(5)).pipe(
                  Schedule.upTo(limitSpan),
                ),
              }),
            );
          yield* api.wait(region, made);
          return { instanceId: made, deadline };
        }),
        span,
      ).pipe(
        Effect.flatMap((made) =>
          Option.isNone(made)
            ? Effect.fail(
                new ProviderUnavailableError({
                  provider: "namespace",
                  reason: `Namespace did not make the host in ${formatWait(span)}; deleted any half-made host. Try again`,
                }),
              )
            : Effect.succeed(made.value),
        ),
        // A failed or interrupted create can leave a half-made host (a
        // timed-out call may have registered it, and Ctrl-C can land
        // before the host id is known). A limit makes nothing, so skip
        // the sweep there. A plain failure already has its one error
        // line; once a Ctrl-C is in the cause there may be none, so a
        // sweep that cannot finish says where to look.
        Effect.onError((cause) =>
          Option.exists(
            Cause.failureOption(cause),
            (error) => error instanceof ProviderLimitError,
          )
            ? Effect.void
            : Effect.gen(function* () {
                const left = yield* api.list(region, [
                  { name: "proofbox.create-token", value: createToken },
                ]);
                yield* Effect.validateAll(
                  left,
                  (instance) =>
                    api
                      .destroy(region, instance.id)
                      .pipe(
                        Effect.catchTag("SandboxGoneError", () => Effect.void),
                      ),
                  { discard: true },
                );
              }).pipe(
                Effect.catchAll(() =>
                  Cause.isInterrupted(cause)
                    ? progress.warn(
                        "could not delete the host this create started; it may be left. Run: proofbox list",
                      )
                    : Effect.void,
                ),
              ),
        ),
      );
      const ref: SandboxRef = { name: instanceId, region };
      hostRef = ref;
      if (maxLifeAt.getTime() <= (yield* Clock.currentTimeMillis)) {
        return yield* fail(
          "making the host took the whole Max life; try a larger --max-life",
        );
      }
      const hostPaths = yield* refPaths(ref);
      yield* Effect.gen(function* () {
        yield* deps.fs.rename(keyBase, hostPaths.key);
        yield* deps.fs.rename(`${keyBase}.pub`, `${hostPaths.key}.pub`);
        yield* deps.fs.writeFileString(
          hostPaths.maxLife,
          String(Math.floor(maxLifeAt.getTime() / 1000)),
          { mode: 0o600 },
        );
        yield* deps.fs.writeFileString(
          hostPaths.deadline,
          deadlineText(deadline),
          { mode: 0o600 },
        );
        yield* deps.fs.writeFileString(hostPaths.os, req.os, { mode: 0o600 });
      }).pipe(
        Effect.mapError((error) =>
          fail(`could not store the host key: ${platformReason(error)}`),
        ),
      );
      // The host's own Deadline starts when Namespace finishes creating it, so
      // it can sit later than the Max life; a detached process destroys
      // the host at the absolute Max life.
      yield* deps.spawnDetached("namespace", "namespace/expire-main", [
        region,
        instanceId,
        String(Math.floor(maxLifeAt.getTime() / 1000)),
      ]);
      // The step host prep is in, for the timeout message: Progress keeps
      // the running label only when the output is live.
      const stuckAt = yield* Ref.make("opening the link to the host");
      const tracked = new Progress({
        ...progress,
        step: (label, effect) =>
          Ref.set(stuckAt, label).pipe(
            Effect.zipRight(progress.step(label, effect)),
          ),
      });
      // The extend loop lives in this scope, so it stops when the limit
      // runs out, before the host is deleted.
      const prepared = yield* Effect.scoped(
        Effect.gen(function* () {
          // Provisioning can outlast the create duration (a cold image
          // build): keep the host's own Deadline ahead until the Sandbox
          // takes over, but never past the Max life. The recorded Deadline
          // moves with it — otherwise the host-expiry destroys a host that
          // is still being prepared once its initial allowance runs out.
          yield* Effect.forkScoped(
            Effect.repeat(
              Effect.gen(function* () {
                const now = new Date(yield* Clock.currentTimeMillis);
                if (now < maxLifeAt) {
                  const pushed = firstDeadline({
                    now,
                    idle: req.idle,
                    maxLifeAt,
                  });
                  yield* deps.fs
                    .writeFileString(hostPaths.deadline, deadlineText(pushed), {
                      mode: 0o600,
                    })
                    .pipe(Effect.ignore);
                  yield* api
                    .extend(
                      region,
                      instanceId,
                      Math.ceil((pushed.getTime() - now.getTime()) / 1000),
                    )
                    .pipe(Effect.ignore);
                }
              }),
              Schedule.spaced(Duration.seconds(15)),
            ),
          );
          // The host is deleted when the limit runs out, so cleanup on it,
          // such as a `docker rm -f` on a stuck Docker, must not hold the
          // limit up: it ends in the background.
          return yield* Effect.timeoutOption(
            Effect.disconnect(
              Effect.scoped(
                Effect.gen(function* () {
                  const link = yield* deps.openLink(ref, hostPaths, "cli", {
                    to: "gateway",
                  });
                  return yield* host
                    .make(link, {
                      req,
                      ref,
                      paths: hostPaths,
                      size,
                      maxLifeAt,
                    })
                    .pipe(Effect.provideService(Progress, tracked));
                }),
              ),
            ),
            prepSpan,
          );
        }),
      );
      if (Option.isSome(prepared)) {
        return prepared.value;
      }
      const label = yield* Ref.get(stuckAt);
      const deleted = yield* api.destroy(region, instanceId).pipe(
        Effect.catchTag("SandboxGoneError", () => Effect.void),
        Effect.as(true),
        Effect.catchAll(() =>
          progress
            .warn(
              "could not delete the host this create started; it may be left. Run: proofbox list",
            )
            .pipe(Effect.as(false)),
        ),
      );
      // Only once the delete has ended: a Ctrl-C during it leaves cleanup
      // to send it again.
      hostDeleted = true;
      return yield* new ProviderUnavailableError({
        provider: "namespace",
        reason: `Namespace did not prepare the host in ${formatWait(prepSpan)} (stuck at: ${label})${deleted ? "; deleted the host" : ""}. Try again`,
      });
    }).pipe(
      // A host that vanishes or drops its link mid-create is a Provider
      // error, not a gone Sandbox — the id was never handed out.
      Effect.catchTag("SandboxGoneError", "LinkDroppedError", (error) =>
        Effect.fail(fail(error.message)),
      ),
      Effect.onError(() => Effect.ignoreLogged(cleanup)),
    );
  }, Effect.scoped);

  return create;
};
