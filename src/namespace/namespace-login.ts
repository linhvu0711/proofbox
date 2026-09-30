import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { extractClaims } from "@namespacelabs/sdk/auth";
import { Clock, Effect, Redacted } from "effect";
import { ProviderError } from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { loginFor } from "../login/provider-login.ts";
import { issueTenantToken } from "./namespace-signin.ts";

// A tenant token lasts about an hour: mint one per session, reuse it
// for the rest of the process, and keep it in the runtime dir so later
// processes reuse it while its `exp` claim is more than five minutes
// out. `list` calls for its two regions at once, so the in-flight
// trade is single-flight per file — else each caller would mint its own.
const issued = new Map<string, string>();
const locks = new Map<string, Effect.Semaphore>();
const lockFor = (path: string) => {
  const lock = locks.get(path);
  if (lock !== undefined) {
    return lock;
  }
  const made = Effect.unsafeMakeSemaphore(1);
  locks.set(path, made);
  return made;
};

const tenantTokenFor = (session: Redacted.Redacted<string>) =>
  Effect.gen(function* () {
    const fail = (reason: string) =>
      new ProviderError({ provider: "namespace", reason });
    const text = Redacted.value(session);
    const hash = createHash("sha256").update(text).digest("hex").slice(0, 16);
    const dir = (yield* keeperPaths({ provider: "ns", name: "__probe__" })).dir;
    const path = join(dir, `ns-tenant-${hash}.json`);
    return yield* lockFor(path).withPermits(1)(
      Effect.gen(function* () {
        const memoed = issued.get(path);
        if (memoed !== undefined) {
          return Redacted.make(memoed);
        }
        const stored = yield* Effect.promise(() =>
          readFile(path, "utf8").then(
            (file) => file.trim(),
            () => undefined,
          ),
        );
        if (stored !== undefined) {
          const exp = extractClaims(stored)?.exp;
          const now = yield* Clock.currentTimeMillis;
          if (typeof exp === "number" && exp * 1000 - now > 5 * 60 * 1000) {
            issued.set(path, stored);
            return Redacted.make(stored);
          }
        }
        const token = yield* issueTenantToken(text);
        yield* Effect.tryPromise({
          try: () => writeFile(path, token, { mode: 0o600 }),
          catch: (cause) =>
            fail(cause instanceof Error ? cause.message : String(cause)),
        });
        issued.set(path, token);
        // Keep only this session's tenant token file in the runtime dir.
        yield* Effect.promise(() =>
          readdir(dir)
            .then((entries) =>
              Promise.all(
                entries
                  .filter(
                    (entry) =>
                      /^ns-tenant-[0-9a-f]{16}\.json$/.test(entry) &&
                      entry !== basename(path),
                  )
                  .map((entry) => rm(join(dir, entry), { force: true })),
              ),
            )
            .catch(() => {}),
        );
        return Redacted.make(token);
      }),
    );
  });

// The saved Namespace login the Compute calls run on: a browser session
// traded for a short tenant token.
export const namespaceLogin = loginFor("namespace", tenantTokenFor);
