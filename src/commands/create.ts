import { readFile } from "node:fs/promises";
import { Effect } from "effect";
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
import { Progress } from "../progress.ts";
import { type Os, Providers } from "../provider.ts";
import { providerForOs } from "../provider-config.ts";
import { readEnvFile, sendSecrets } from "../secrets.ts";
import { runSetupScript } from "../setup-script.ts";
import { formatSize, parseSize } from "../size.ts";
import { MAX_SIZE_DEFAULT, parseMaxSize } from "../upload/max-size.ts";
import { readWorkFolder, sendWorkFolder } from "./upload.ts";

export const createSandbox = (options: {
  readonly os: Os;
  readonly provider?: string | undefined;
  readonly idle?: string | undefined;
  readonly maxLife?: string | undefined;
  readonly work?: string | undefined;
  readonly setup?: string | undefined;
  readonly envFile?: string | undefined;
  readonly maxSize?: string | undefined;
  readonly size?: string | undefined;
}) =>
  Effect.gen(function* () {
    const providers = yield* Providers;
    const providerName = options.provider ?? (yield* providerForOs(options.os));
    const provider = providers.get(providerName);
    if (provider === undefined) {
      return yield* new UnknownProviderError({
        provider: providerName,
        known: [...providers.keys()],
      });
    }
    const capability = `os:${options.os}` as const;
    if (!provider.capabilities.has(capability)) {
      return yield* new MissingCapabilityError({
        provider: provider.name,
        capability,
        outcome: "nothing was created",
      });
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
    const snapshots = provider.snapshots;
    const fp =
      script !== undefined &&
      files !== undefined &&
      provider.capabilities.has("snapshot") &&
      snapshots !== undefined
        ? yield* snapshots.baseVersion.pipe(
            Effect.map((baseVersion) =>
              fingerprint({ baseVersion, script, files }),
            ),
          )
        : undefined;
    const size =
      options.size === undefined ? undefined : yield* parseSize(options.size);
    if (size !== undefined && provider.sizes !== "any") {
      const offered = provider.sizes.some(
        (listed) => listed.cpu === size.cpu && listed.ramGb === size.ramGb,
      );
      if (!offered) {
        return yield* new SizeNotOfferedError({
          provider: provider.name,
          size: formatSize(size),
          offered: provider.sizes.map(formatSize),
        });
      }
    }
    const info = yield* provider.create({
      os: options.os,
      idle,
      maxLife,
      size,
      snapshot: fp,
    });
    const output = yield* CliOutput;
    const id = `${provider.idPrefix}:${info.name}`;
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
      if (script !== undefined) {
        yield* runSetupScript(id, script);
      }
      if (fp !== undefined && snapshots !== undefined) {
        yield* progress.step(
          "saving the Snapshot",
          withDeadlinePush(provider, info.name, info)(
            snapshots.save(info.name, fp),
          ),
        );
        yield* output.err(`proofbox: Snapshot saved, Fingerprint ${fp}\n`);
      }
      if (secrets !== undefined) {
        yield* sendSecrets(id, secrets);
      }
    }).pipe(
      Effect.tapError(() =>
        provider.delete(info.name).pipe(
          Effect.zipRight(keeper.stop(id)),
          Effect.catchAll(() => Effect.void),
        ),
      ),
    );
    yield* output.out(`${id}\n`);
  }).pipe(Effect.scoped);
