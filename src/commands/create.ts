import { resolve } from "node:path";
import { FileSystem } from "@effect/platform";
import { Effect, Option } from "effect";
import { CliOutput } from "../cli-output.ts";
import {
  idleDefault,
  MAX_LIFE_DEFAULT,
  parseSpan,
  withDeadlinePush,
} from "../deadline.ts";
import {
  HarnessError,
  HarnessVersionNeedsHarnessError,
  MissingCapabilityError,
  ProviderError,
  platformReason,
  SetupNeedsWorkError,
  SetupScriptMissingError,
  SizeNotOfferedError,
  UnknownProviderError,
} from "../errors.ts";
import { fingerprint } from "../fingerprint.ts";
import {
  checkHarnessCreate,
  cloneWorkFolder,
  copyHarnessProfile,
  installHarness,
} from "../harness-sandbox.ts";
import { KeeperClient } from "../keeper/keeper-client.ts";
import { withCreateMark } from "../local-sandboxes.ts";
import { Progress } from "../progress.ts";
import { lacksFeature, type Os, Providers } from "../provider.ts";
import { providerForOs } from "../provider-config.ts";
import { sandboxFiles, writeSandboxFile } from "../sandbox-file.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { readEnvFile, sendSecrets } from "../secrets.ts";
import { runSetupScript } from "../setup-script.ts";
import { formatSize, parseSize } from "../size.ts";
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
    readonly envFile?: string | undefined;
    readonly maxSize?: string | undefined;
    readonly size?: string | undefined;
    readonly harness?: string | undefined;
    readonly harnessVersion?: string | undefined;
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
    if (options.envFile !== undefined && !offer.features.has("secrets")) {
      return yield* lacksFeature(
        provider,
        options.os,
        "secrets",
        "nothing was created",
      );
    }
    if (options.harnessVersion !== undefined && options.harness === undefined) {
      return yield* new HarnessVersionNeedsHarnessError();
    }
    if (options.harness !== undefined && !offer.features.has("secrets")) {
      return yield* lacksFeature(
        provider,
        options.os,
        "secrets",
        "nothing was created",
      );
    }
    const check =
      options.harness === undefined
        ? undefined
        : yield* checkHarnessCreate(options.harness, options.work ?? ".");
    const harness = check === undefined ? undefined : yield* check.entry.load;
    const idle =
      options.idle === undefined
        ? idleDefault(options.os)
        : yield* parseSpan("idle", options.idle);
    const maxLife =
      options.maxLife === undefined
        ? MAX_LIFE_DEFAULT
        : yield* parseSpan("max-life", options.maxLife);
    const setupPath = options.setup;
    if (
      setupPath !== undefined &&
      options.work === undefined &&
      options.harness === undefined
    ) {
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
      options.envFile === undefined
        ? undefined
        : yield* readEnvFile(options.envFile);
    const folder = check?.repo.root ?? options.work;
    const files =
      folder === undefined
        ? undefined
        : yield* readWorkFolder(folder, workLimit);
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
          output.err(
            "proofbox: Keeper did not start; commands still work, only slower\n",
          ),
        ),
      );
    // A failed upload or Setup script must not leave the made Sandbox
    // behind; runSetupScript already deletes it for a non-zero script exit,
    // and this covers every other way the steps fail.
    yield* Effect.gen(function* () {
      if (
        harness !== undefined &&
        check !== undefined &&
        folder !== undefined &&
        files !== undefined
      ) {
        yield* cloneWorkFolder(
          id,
          resolve(folder),
          check.repo,
          check.githubToken,
          [harness.home, ...harness.homeEntries],
          reused,
          [...new Set(files.map((file) => file.path.split("/", 1).join("")))],
        );
      }
      if (folder !== undefined && files !== undefined) {
        yield* sendWorkFolder(
          id,
          resolve(folder),
          files,
          workLimit,
          check === undefined || reused
            ? undefined
            : { dirty: check.repo.dirty },
        );
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
      if (harness !== undefined) {
        yield* installHarness(
          id,
          harness,
          Option.fromNullable(options.harnessVersion),
        );
        yield* copyHarnessProfile(id, harness);
        const code = yield* writeSandboxFile(
          id,
          sandboxFiles(provider, sandbox.name, options.os).harness,
          new TextEncoder().encode(`${harness.name}\n`),
          { executable: false },
        );
        if (code !== 0) {
          return yield* new HarnessError({
            harness: harness.name,
            reason: `could not write the Harness name in the Sandbox (exit code ${code})`,
          });
        }
      }
      if (secrets !== undefined) {
        yield* sendSecrets(
          id,
          check === undefined
            ? secrets
            : [
                ...secrets,
                ...(check.entry.login._tag === "Env" &&
                check.harnessLogin._tag === "Env"
                  ? [
                      {
                        name: check.entry.login.envName,
                        value: check.harnessLogin.token,
                      },
                    ]
                  : []),
                { name: "GH_TOKEN", value: check.githubToken },
              ],
        );
      } else if (check !== undefined) {
        yield* sendSecrets(id, [
          ...(check.entry.login._tag === "Env" &&
          check.harnessLogin._tag === "Env"
            ? [
                {
                  name: check.entry.login.envName,
                  value: check.harnessLogin.token,
                },
              ]
            : []),
          { name: "GH_TOKEN", value: check.githubToken },
        ]);
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
