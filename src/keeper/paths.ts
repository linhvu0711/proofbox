import { execFile } from "node:child_process";
import { chmod, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config, Effect } from "effect";
import { ProviderError } from "../errors.ts";

export interface KeeperPaths {
  readonly dir: string;
  readonly socket: string;
  readonly pid: string;
  // Held by a Keeper from its socket check until it listens.
  readonly startLock: string;
  readonly key: string;
  // The host keys the Namespace SSH gateway pinned for the host.
  readonly knownHosts: string;
  readonly sshdKnownHosts: string;
  readonly control: string;
  readonly maxLife: string;
  // The Sandbox's own Deadline as the detached host-expiry reads it: the
  // host dies at this instant even when use of it kept its own Deadline
  // further out.
  readonly deadline: string;
  // The OS of a host made by a Provider with more than one OS.
  readonly os: string;
}

export const keeperPaths = Effect.fn("paths.keeperPaths")(function* (id: {
  readonly provider: string;
  readonly name: string;
}) {
  const dir = yield* Config.string("PROOFBOX_RUNTIME_DIR").pipe(
    Config.withDefault(join(tmpdir(), `proofbox-${process.getuid?.() ?? 0}`)),
    Effect.mapError(
      (cause) =>
        new ProviderError({
          provider: id.provider,
          reason: String(cause),
        }),
    ),
  );
  yield* Effect.tryPromise({
    try: async () => {
      await mkdir(dir, { recursive: true, mode: 0o700 });
      // mkdir's mode only applies to a new dir; the socket must stay
      // unreachable by other local users even for a preexisting dir.
      await chmod(dir, 0o700);
    },
    catch: (cause) =>
      new ProviderError({
        provider: id.provider,
        reason: cause instanceof Error ? cause.message : String(cause),
      }),
  });
  const stem = `${id.provider}-${id.name}`;
  return {
    dir,
    socket: join(dir, `${stem}.sock`),
    pid: join(dir, `${stem}.pid`),
    startLock: join(dir, `${stem}.start-lock`),
    log: join(dir, `${stem}.log`),
    key: join(dir, `${stem}.key`),
    knownHosts: join(dir, `${stem}.known-hosts`),
    sshdKnownHosts: join(dir, `${stem}.sshd-known-hosts`),
    control: join(dir, `${stem}.ctl`),
    maxLife: join(dir, `${stem}.max-life`),
    deadline: join(dir, `${stem}.deadline`),
    os: join(dir, `${stem}.os`),
  };
});

// When a process started: on Linux its start tick in /proc, which every
// Linux has, else the text of /bin/ps, which macOS always has. Gone means
// the process is not there; Unknown means neither could say.
type ProcessStart =
  | { readonly _tag: "Started"; readonly at: string }
  | { readonly _tag: "Gone" }
  | { readonly _tag: "Unknown" };

const hasErrorCode = (cause: unknown, code: string) =>
  typeof cause === "object" &&
  cause !== null &&
  "code" in cause &&
  cause.code === code;

const startOf = (pid: number): Effect.Effect<ProcessStart> =>
  Effect.promise(() =>
    process.platform === "linux"
      ? readFile(`/proc/${pid}/stat`, "utf8").then(
          (stat): ProcessStart => {
            // Field 22, counted past the parenthesized name, which may
            // hold spaces.
            const at = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
            return at === undefined
              ? { _tag: "Unknown" }
              : { _tag: "Started", at };
          },
          (cause): ProcessStart =>
            hasErrorCode(cause, "ENOENT")
              ? { _tag: "Gone" }
              : { _tag: "Unknown" },
        )
      : new Promise<ProcessStart>((resolve) => {
          // The C locale keeps the text the same in every process.
          execFile(
            "/bin/ps",
            ["-o", "lstart=", "-p", String(pid)],
            { env: { LC_ALL: "C" } },
            (error, stdout) => {
              const at = stdout.trim();
              resolve(
                at !== ""
                  ? { _tag: "Started", at }
                  : error !== null && typeof error.code === "number"
                    ? { _tag: "Gone" }
                    : { _tag: "Unknown" },
              );
            },
          );
        }),
  );

// Whether this user runs a process with this id. A create mark sits in
// this user's runtime dir, so its create ran as this user: EPERM is some
// other user's process, which cannot be that create.
const runsAsMe = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// This process's start time, as `stillRuns` compares it; empty when it
// cannot be told.
export const ownStart = Effect.map(startOf(process.pid), (own) =>
  own._tag === "Started" ? own.at : "",
);

// Whether process `pid` still runs and is the one that started at
// `started`, so an id reused by some other process does not pass for it.
// With no start time to compare, a process id this user runs counts.
export const stillRuns = Effect.fn("paths.stillRuns")(function* (
  pid: number,
  started: string,
) {
  const now = yield* startOf(pid);
  return now._tag === "Started"
    ? started === ""
      ? runsAsMe(pid)
      : started === now.at
    : now._tag === "Unknown" && runsAsMe(pid);
});
