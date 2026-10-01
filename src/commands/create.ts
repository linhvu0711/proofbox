import { readFile } from "node:fs/promises";
import { Effect, Option } from "effect";
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
  SetupNeedsWorkError,
  SetupScriptMissingError,
  SizeNotOfferedError,
  UnknownProviderError,
} from "../errors.ts";
import { fingerprint } from "../fingerprint.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { markCreate, unmarkCreate } from "../keeper/paths.ts";
import { withLoginsLock } from "../login/logins-file.ts";
import { envToken } from "../login/provider-login.ts";
import { Progress } from "../progress.ts";
import {
  lacksFeature,
  type Os,
  type Provider,
  Providers,
} from "../provider.ts";
import { providerForOs } from "../provider-config.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { readEnvFile, sendSecrets } from "../secrets.ts";
import { runSetupScript } from "../setup-script.ts";
import { formatSize, parseSize } from "../size.ts";
import { MAX_SIZE_DEFAULT, parseMaxSize } from "../upload/max-size.ts";
import { readWorkFolder, sendWorkFolder } from "./upload.ts";

// A create that may act with the saved login marks itself while the
// Provider makes the host, and writes the mark under the logins lock: a
// logout either waits for this create or has removed the login already,
// and then the Provider finds none (ADR 0016). The env token wins over the
// saved login, and logout never removes it, so a create with one needs no
// mark; nor does a Provider with no login, or a run with no HOME.
const markCreating = Effect.fn("create.markCreating")(function* (
  provider: Provider,
) {
  if (provider.login._tag === "None") {
    return Option.none<string>();
  }
  // A redacted string can never fail to load, so `option` yields None
  // for a missing variable and anything else is a defect.
  if (Option.isSome(yield* Effect.orDie(envToken(provider.name)))) {
    return Option.none<string>();
  }
  return yield* withLoginsLock(markCreate(provider.idPrefix)).pipe(
    Effect.map((mark) => Option.some(mark)),
    Effect.catchTag("ConfigError", () => Effect.succeed(Option.none<string>())),
  );
});

export const createSandbox = Effect.fn("create.createSandbox")(
  function* (options: {
    readonly os: Os;
    readonly provider?: string | undefined;
    readonly idle?: string | undefined;
    readonly maxLife?: string | undefined;
    readonly work?: string | undefined;
    readonly setup?: string | undefined;
    readonly envFile?: string | undefined;
    readonly maxSize?: string | undefined;
    readonly size?: string | undefined;
  }) {
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
    if (options.envFile !== undefined && !offer.features.has("secrets")) {
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
        : yield* Effect.tryPromise({
            try: () => readFile(setupPath),
            catch: (cause) =>
              typeof cause === "object" &&
              cause !== null &&
              "code" in cause &&
              cause.code === "ENOENT"
                ? new SetupScriptMissingError({ path: setupPath })
                : new ProviderError({
                    provider: "local",
                    reason:
                      cause instanceof Error ? cause.message : String(cause),
                  }),
          });
    const workLimit = maxSize ?? MAX_SIZE_DEFAULT;
    const secrets =
      options.envFile === undefined
        ? undefined
        : yield* readEnvFile(options.envFile);
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
    const info = yield* Effect.acquireUseRelease(
      markCreating(provider),
      () =>
        provider.create({
          os: options.os,
          idle,
          maxLife,
          size,
          snapshot: fp,
        }),
      (mark) =>
        Option.match(mark, { onNone: () => Effect.void, onSome: unmarkCreate }),
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
          output.err(
            "proofbox: Keeper did not start; commands still work, only slower\n",
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
        yield* output.err(`proofbox: Snapshot reused, Fingerprint ${fp}\n`);
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
            Effect.zipRight(
              output.err(`proofbox: Snapshot saved, Fingerprint ${fp}\n`),
            ),
            Effect.catchAll((error) =>
              output.err(
                `proofbox: could not save the Snapshot (${error.message}); the next create runs the Setup script again\n`,
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
  },
  Effect.scoped,
);
