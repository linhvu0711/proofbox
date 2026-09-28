import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chunk, Clock, Duration, Effect, Stream } from "effect";
import { sandboxInfoFromLabels } from "../docker/docker-provider.ts";
import {
  ProviderError,
  SandboxGoneError,
  TokenExposedError,
  ToolBundleHashError,
} from "../errors.ts";
import { Progress } from "../progress.ts";
import { type ExecOptions, SandboxInfo } from "../provider.ts";
import { shellJoin } from "../shell.ts";
import { formatSize, type Size } from "../size.ts";
import { TOOL_BUNDLE } from "../tool-bundle.ts";
import type { Link } from "./ssh-link.ts";

// proofbox's own Mac files: the input helper and the Pixel script.
export const MACOS_DIR = fileURLToPath(
  new URL("../../images/macos/", import.meta.url),
);

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

// Sends a file of this repo to `remote` on the Mac, executable.
const sendFile = (link: Link, local: string, remote: string) =>
  Effect.gen(function* () {
    const bytes = yield* Effect.tryPromise({
      try: () => readFile(local),
      catch: (cause) =>
        fail(cause instanceof Error ? cause.message : String(cause)),
    });
    const events = yield* link
      .stream(
        `cat > ${shellJoin([remote])} && chmod 755 ${shellJoin([remote])}`,
        { stdin: Stream.make(new Uint8Array(bytes)) },
      )
      .pipe(Stream.runCollect);
    const exit = Chunk.findLast(events, (event) => event._tag === "Exit");
    if (
      exit._tag === "None" ||
      exit.value._tag !== "Exit" ||
      exit.value.code !== 0
    ) {
      return yield* fail(`sending ${remote} to the Mac failed`);
    }
  });

// The macOS Tool bundle: downloads come through Namespace's cache with the
// workload token (so this runs before the token goes), proofbox's own files
// over the link; then every file is hashed on the Mac. No Homebrew.
const installTools = (link: Link, id: string) =>
  Effect.gen(function* () {
    const tools = TOOL_BUNDLE.flatMap((tool) =>
      tool.macos === undefined
        ? []
        : [{ name: tool.name, path: tool.path, source: tool.macos.arm64 }],
    );
    for (const tool of tools) {
      if ("url" in tool.source) {
        yield* step(
          link,
          `fetching ${tool.name}`,
          `cd /tmp && rm -rf proofbox-tool && mkdir proofbox-tool && /opt/nsc/bin/nsc artifact cache-url ${shellJoin([tool.source.url])} --out proofbox-tool/archive.zip && unzip -o -q proofbox-tool/archive.zip -d proofbox-tool && mv proofbox-tool/${tool.name} ${shellJoin([tool.path])} && chmod 755 ${shellJoin([tool.path])}`,
        );
      } else {
        yield* sendFile(link, join(MACOS_DIR, tool.source.file), tool.path);
      }
    }
    const sums = yield* step(
      link,
      "checking the Tool bundle",
      `shasum -a 256 ${shellJoin(tools.map((tool) => tool.path))}`,
    );
    for (const tool of tools) {
      const line = sums.stdout
        .split("\n")
        .find((entry) => entry.endsWith(`  ${tool.path}`));
      if (line?.split("  ")[0] !== tool.source.sha256) {
        return yield* new ToolBundleHashError({
          file: tool.path,
          sandboxId: `ns:${id}`,
        });
      }
    }
  });

// `runner` has passwordless sudo, so the workload token must be gone before
// any user code runs (ADR 0009); then each way to it is checked.
const dropToken = (link: Link, id: string) =>
  Effect.gen(function* () {
    yield* step(
      link,
      "deleting the workload token",
      "sudo -n rm -f /var/run/nsc/token.json /Users/runner/.docker/config.json",
    );
    const checks = [
      ["test ! -e /var/run/nsc/token.json", "the token file"],
      [
        "test ! -e /Users/runner/.docker/config.json",
        "the Docker config token",
      ],
      [
        "! curl -s -m 3 -o /dev/null http://169.254.169.42/",
        "the token service",
      ],
    ] as const;
    for (const [commandLine, what] of checks) {
      const result = yield* link.run(commandLine);
      if (result.exitCode !== 0) {
        return yield* new TokenExposedError({ id: `ns:${id}`, what });
      }
    }
  });

// Everything a Mac needs before user code arrives, in order.
export const prepareMac = (
  link: Link,
  req: Parameters<typeof writeMacState>[1],
) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const info = yield* writeMacState(link, req);
    yield* progress.step(
      "installing the Tool bundle",
      installTools(link, req.id),
    );
    yield* progress.step(
      "checking the Namespace token is out of reach",
      dropToken(link, req.id),
    );
    return info;
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
