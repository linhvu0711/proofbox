import { Clock, Duration, Effect } from "effect";
import { sandboxInfoFromLabels } from "../docker/docker-provider.ts";
import { ProviderError, SandboxGoneError } from "../errors.ts";
import { type ExecOptions, SandboxInfo } from "../provider.ts";
import { shellJoin } from "../shell.ts";
import { formatSize, type Size } from "../size.ts";
import type { Link } from "./ssh-link.ts";

// A Namespace Mac has no container: the Sandbox is the Mac itself, and
// every login lands as `runner` (uid 501) with passwordless sudo. The
// state the Linux Sandbox keeps in container labels lives in this folder.
export const MAC_STATE_DIR = "/var/lib/proofbox";
export const MAC_WORK_DIR = "/Users/runner/work";
const LABELS = `${MAC_STATE_DIR}/labels.json`;
const DEADLINE = `${MAC_STATE_DIR}/deadline`;

const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

const brandFor = (name: string) => ({
  provider: "namespace",
  id: () => `ns:${name}`,
});

// Runs one host step; a non-zero exit fails with the step's words.
const step = (link: Link, what: string, commandLine: string) =>
  Effect.gen(function* () {
    const result = yield* link.run(commandLine);
    if (result.exitCode !== 0) {
      return yield* fail(
        `${what} failed on the Mac: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    return result;
  });

// The labels and the first Deadline, as the Docker Provider writes them for
// a container, so `sandboxInfoFromLabels` reads both.
export const writeMacState = (
  link: Link,
  req: {
    readonly id: string;
    readonly idle: Duration.Duration;
    readonly maxLifeAt: Date;
    readonly size: Size;
  },
) =>
  Effect.gen(function* () {
    const createdAt = new Date(yield* Clock.currentTimeMillis);
    const deadline = Math.floor(
      Math.min(
        createdAt.getTime() + Duration.toMillis(req.idle) + 60_000,
        req.maxLifeAt.getTime(),
      ) / 1000,
    );
    const labels = JSON.stringify({
      "proofbox.name": req.id,
      "proofbox.os": "macos",
      "proofbox.created-at": createdAt.toISOString(),
      "proofbox.idle-seconds": String(Duration.toSeconds(req.idle)),
      "proofbox.max-life-at": req.maxLifeAt.toISOString(),
      "proofbox.size": formatSize(req.size),
    });
    yield* step(
      link,
      "making the proofbox folders",
      `sudo -n mkdir -p ${MAC_STATE_DIR} /opt/proofbox/tools ${MAC_WORK_DIR} && sudo -n chown -R runner:staff ${MAC_STATE_DIR} /opt/proofbox ${MAC_WORK_DIR} && printf '%s\\n' ${shellJoin([labels])} > ${LABELS} && printf '%s\\n' ${deadline} > ${DEADLINE}`,
    );
    return new SandboxInfo({
      name: req.id,
      os: "macos",
      createdAt,
      idleSeconds: Duration.toSeconds(req.idle),
      deadline: new Date(deadline * 1000),
      maxLifeAt: req.maxLifeAt,
      size: req.size,
    });
  });

export const readMac = (link: Link, name: string) =>
  Effect.gen(function* () {
    const result = yield* link.run(`cat ${LABELS} && cat ${DEADLINE}`);
    if (result.exitCode !== 0) {
      // No state file: the create never finished, so there is no Sandbox.
      if (result.stderr.includes("No such file")) {
        return yield* new SandboxGoneError({ id: `ns:${name}` });
      }
      return yield* fail(
        `could not read the Sandbox: ${(result.stderr || result.stdout).trim()}`,
      );
    }
    const [labelLine = "", deadlineLine = ""] = result.stdout
      .trim()
      .split("\n");
    const seconds = Number(deadlineLine);
    if (!Number.isFinite(seconds)) {
      return yield* fail(
        `could not read the Deadline: ${result.stdout.trim()}`,
      );
    }
    const labels = yield* Effect.try({
      try: () => JSON.parse(labelLine) as unknown,
      catch: (cause) =>
        fail(cause instanceof Error ? cause.message : String(cause)),
    });
    return yield* sandboxInfoFromLabels(brandFor(name), name, labels, seconds);
  });

export const writeMacDeadline = (link: Link, seconds: number) =>
  link.run(
    `tmp=${MAC_STATE_DIR}/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + ${seconds} ))" > "$tmp" && mv "$tmp" ${DEADLINE}`,
  );

// User code and Pixel actions run in the `runner` desktop session, through
// a login shell so PATH is the one ssh gives, in the Work folder.
export const macExec =
  (link: Link) => (argv: ReadonlyArray<string>, options?: ExecOptions) =>
    link.stream(
      shellJoin([
        "sudo",
        "-n",
        "launchctl",
        "asuser",
        "501",
        "sudo",
        "-n",
        "-u",
        "runner",
        "-H",
        "/bin/zsh",
        "-lc",
        `cd ${MAC_WORK_DIR} && exec "$@"`,
        "zsh",
        ...argv,
      ]),
      options,
    );
