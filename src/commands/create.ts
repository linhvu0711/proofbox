import { FileSystem } from "@effect/platform";
import { Clock, Effect, Option } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  idleDefault,
  MAX_LIFE_DEFAULT,
  parseSpan,
  withDeadlinePush,
} from "../deadline.ts";
import {
  MissingCapabilityError,
  ProviderError,
  platformReason,
  SetupNeedsWorkError,
  SetupScriptMissingError,
  SizeNotOfferedError,
  UnknownProviderError,
} from "../errors.ts";
import { fingerprint } from "../fingerprint.ts";
import { formatClock } from "../format-time.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { withCreateMark } from "../local-sandboxes.ts";
import { Progress } from "../progress.ts";
import { lacksFeature, liveViewOn, type Os, Providers } from "../provider.ts";
import { providerForOs } from "../provider-config.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { readSecretsFile, sendSecrets } from "../secrets.ts";
import { runSetupScript } from "../setup-script.ts";
import { formatSize, parseSize } from "../size.ts";
import { Style } from "../style.ts";
import { MAX_SIZE_DEFAULT, parseMaxSize } from "../upload/max-size.ts";
import { readWorkFolder, sendWorkFolder } from "./upload.ts";

export const createSandbox = Effect.fn("create.createSandbox")(
  function* (options: {
    readonly os: Os;
    readonly provider?: string | undefined;
    readonly idle?: string | undefined;
    readonly maxLife?: string | undefined;
    readonly work?: string | undefined;
    readonly setup?: string | undefined;
    readonly secretsFile?: string | undefined;
    readonly maxSize?: string | undefined;
    readonly size?: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const providers = yield* Providers;
    const providerName = options.provider ?? (yield* providerForOs(options.os));
    const entry = providers.get(providerName);
    if (entry === undefined) {
      return yield* new UnknownProviderError({
        provider: providerName,
        known: [...providers.keys()],
      });
    }
    const provider = yield* entry.load;
    const offer = provider.offers[options.os];
    if (offer === undefined) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability: `os:${options.os}`,
        outcome: "nothing was created",
      });
    }
    if (options.secretsFile !== undefined && !offer.features.has("secrets")) {
      return yield* lacksFeature(
        provider,
        options.os,
        "secrets",
        "nothing was created",
      );
    }
    const idle =
      options.idle === undefined
        ? idleDefault(options.os)
        : yield* parseSpan("idle", options.idle);
    const maxLife =
      options.maxLife === undefined
        ? MAX_LIFE_DEFAULT
        : yield* parseSpan("max-life", options.maxLife);
    const setupPath = options.setup;
    if (setupPath !== undefined && options.work === undefined) {
      return yield* new SetupNeedsWorkError();
    }
    const maxSize =
      options.maxSize === undefined
        ? undefined
        : yield* parseMaxSize(options.maxSize);
    const script =
      setupPath === undefined
        ? undefined
        : yield* fs.readFile(setupPath).pipe(
            Effect.catchAll((error) =>
              Effect.fail(
                error._tag === "SystemError" && error.reason === "NotFound"
                  ? new SetupScriptMissingError({ path: setupPath })
                  : new ProviderError({
                      provider: "local",
                      reason: platformReason(error),
                    }),
              ),
            ),
          );
    const workLimit = maxSize ?? MAX_SIZE_DEFAULT;
    const secrets =
      options.secretsFile === undefined
        ? undefined
        : yield* readSecretsFile(options.secretsFile);
    const files =
      options.work === undefined
        ? undefined
        : yield* readWorkFolder(options.work, workLimit);
    const size =
      options.size === undefined ? undefined : yield* parseSize(options.size);
    if (size !== undefined && offer.sizes !== "any") {
      const offered = offer.sizes.some(
        (listed) => listed.cpu === size.cpu && listed.ramGb === size.ramGb,
      );
      if (!offered) {
        return yield* new SizeNotOfferedError({
          provider: provider.name,
          size: formatSize(size),
          offered: offer.sizes.map(formatSize),
        });
      }
    }
    const snapshots = offer.features.has("snapshot")
      ? provider.snapshots
      : undefined;
    const fp =
      script === undefined || files === undefined || snapshots === undefined
        ? undefined
        : fingerprint({
            baseVersion: yield* snapshots.baseVersion,
            script,
            files,
          });
    // The mark goes once the Max life file is there for logout to find.
    const info = yield* withCreateMark(
      provider,
      provider.create({
        os: options.os,
        idle,
        maxLife,
        size,
        snapshot: fp,
      }),
    );
    const sandbox = { name: info.name, region: info.region };
    // A Sandbox that started from the Snapshot already has the Setup
    // script's work in it.
    const reused = fp !== undefined && info.snapshot === fp;
    const output = yield* CliOutput;
    const id = formatSandboxId({
      provider: provider.idPrefix,
      region: info.region,
      name: info.name,
    });
    const keeper = yield* KeeperClient;
    const progress = yield* Progress;
    yield* progress
      .step("starting Keeper", keeper.start(id))
      .pipe(
        Effect.catchAll(() =>
          keeper.warnNotStarted(
            "Keeper did not start; commands still work, only slower",
          ),
        ),
      );
    // A failed upload or Setup script must not leave the made Sandbox
    // behind; runSetupScript already deletes it for a non-zero script exit,
    // and this covers every other way the steps fail.
    yield* Effect.gen(function* () {
      if (options.work !== undefined && files !== undefined) {
        yield* sendWorkFolder(id, options.work, files, workLimit);
      }
      if (reused) {
        yield* progress.note(`Snapshot reused, Fingerprint ${fp}`);
      } else if (script !== undefined) {
        yield* runSetupScript(id, script);
      }
      // The Snapshot is saved before the Secrets go in, so it holds none.
      if (!reused && fp !== undefined && snapshots !== undefined) {
        // A Snapshot only saves time later; a failed save must not fail
        // the create.
        yield* progress
          .step(
            "saving the Snapshot",
            withDeadlinePush(
              provider,
              sandbox,
              info,
            )(snapshots.save(sandbox, fp)),
          )
          .pipe(
            Effect.zipRight(progress.note(`Snapshot saved, Fingerprint ${fp}`)),
            Effect.catchAll((error) =>
              progress.warn(
                `could not save the Snapshot (${error.message}); the next create runs the Setup script again`,
              ),
            ),
          );
      }
      if (secrets !== undefined) {
        yield* sendSecrets(id, secrets);
      }
    }).pipe(
      Effect.tapError(() =>
        provider.delete(sandbox).pipe(
          Effect.zipRight(keeper.stop(id)),
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
    yield* output.out(`${id}\n`);
    // The hints are for a person only, and the end time costs a Provider
    // call, so a program pays for none of it.
    const style = yield* Style;
    if (!style.look) {
      return;
    }
    yield* progress.hint(`run a command: proofbox exec ${id} -- <command>`);
    if (liveViewOn(provider, options.os) !== undefined) {
      yield* progress.hint(`watch the screen: proofbox live ${id}`);
    }
    yield* progress.hint(`delete it: proofbox delete ${id}`);
    // The steps above push the Deadline past info.deadline, so the time it
    // ends if idle is the one the Provider holds now. A failed read leaves
    // out only that time.
    const now = new Date(yield* Clock.currentTimeMillis);
    const latest = formatClock(info.maxLifeAt, now);
    const current = yield* provider.get(sandbox).pipe(Effect.option);
    yield* progress.hint(
      Option.match(current, {
        onNone: () => `ends at ${latest} at the latest`,
        onSome: (held) =>
          `ends at ${formatClock(held.deadline, now)} if idle, at ${latest} at the latest`,
      }),
    );
  },
  Effect.scoped,
);
