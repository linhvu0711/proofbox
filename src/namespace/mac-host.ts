import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Chunk, Clock, Duration, Effect, Stream } from "effect";
import { sandboxInfoFromLabels } from "../docker/docker-provider.ts";
import {
  MacPrepareError,
  ProviderError,
  SandboxGoneError,
  TokenExposedError,
  ToolBundleHashError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
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
const MEMORY_KILLS = `${MAC_STATE_DIR}/memory-kills.log`;

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
    yield* sendFile(link, join(MACOS_DIR, "pixel.sh"), "/opt/proofbox/pixel");
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

// Screen and input commands only work in the desktop session of `runner`.
const GUI = "sudo -n launchctl asuser 501 sudo -n -u runner";
const VMGUEST = "/opt/namespace/vmguest";
const TCC_DB = "/Library/Application Support/com.apple.TCC/TCC.db";
const REPLAYD =
  "/Users/runner/Library/Group Containers/group.com.apple.replayd/ScreenCaptureApprovals.plist";
const REPLAYD_HINT = "4000-01-01T00:00:00Z";

// ADR 0012: grant screen and input to vmguest in the system TCC.db, and
// pre-answer replayd's "bypass the private window picker" alert.
const grantPrivacy = (link: Link) =>
  Effect.gen(function* () {
    const rows = [
      "kTCCServiceScreenCapture",
      "kTCCServiceAccessibility",
      "kTCCServicePostEvent",
    ]
      .map(
        (service) =>
          `('${service}', '${VMGUEST}', 1, 2, 4, 1, 'UNUSED', 0, CAST(strftime('%s','now') AS INTEGER))`,
      )
      .join(", ");
    yield* step(
      link,
      "granting screen and input access",
      `sudo -n sqlite3 ${shellJoin([TCC_DB])} ${shellJoin([
        `INSERT OR REPLACE INTO access (service, client, client_type, auth_value, auth_reason, auth_version, indirect_object_identifier, flags, last_modified) VALUES ${rows}`,
      ])}`,
    );
    // replayd keeps the approvals in memory, saves them over the file on a
    // normal stop, and alerts on an entry without its dates; so the full
    // entry goes in, then `kill -9` makes it read the file again.
    const plist = shellJoin([REPLAYD]);
    const entry = `${VMGUEST}.kScreenCapture`;
    yield* step(
      link,
      "pre-answering the screen capture alert",
      `now=$(date -u +%Y-%m-%dT%H:%M:%SZ) && mkdir -p "$(dirname ${plist})" && { [ -e ${plist} ] || plutil -create xml1 ${plist}; } && { plutil -remove ${VMGUEST} ${plist} 2>/dev/null; plutil -insert ${VMGUEST} -dictionary ${plist} && plutil -insert ${entry}PrivacyHintDate -date ${REPLAYD_HINT} ${plist} && plutil -insert ${entry}PrivacyHintPolicy -integer 999999999 ${plist} && plutil -insert ${entry}ApprovalLastAlerted -date "$now" ${plist} && plutil -insert ${entry}ApprovalLastUsed -date "$now" ${plist} && plutil -insert ${entry}AlertableUsageCount -integer 1 ${plist}; } && { killall -9 replayd 2>/dev/null; true; }`,
    );
  });

// The kernel's jetsam kills, logged from create on; `log show` per exec
// would cost about 2 s twice. Not `nohup`: without a terminal, macOS nohup
// fails and never starts the command.
const watchMemory = (link: Link) =>
  step(
    link,
    "starting the memory watcher",
    `sudo -n sh -c ${shellJoin([
      `trap "" HUP; /usr/bin/log stream --style compact --predicate 'sender == "kernel" AND eventMessage BEGINSWITH "memorystatus: killing_"' >> ${MEMORY_KILLS} 2>/dev/null < /dev/null &`,
    ])}`,
  );

// Kills of real work: macOS also kills idle daemons under pressure, and
// those are not the command.
export const countMemoryKills = (text: string): number =>
  text
    .split("\n")
    .filter(
      (line) =>
        /memorystatus: killing_\w+ pid \d+/.test(line) &&
        !line.includes("killing_idle_process"),
    ).length;

export const readMemoryKills = (link: Link) =>
  link
    .run(`grep 'memorystatus: killing_' ${MEMORY_KILLS} 2>/dev/null; true`)
    .pipe(Effect.map((result) => countMemoryKills(result.stdout)));

// The screen as it is now, saved next to the host's other files, so a
// failed prepare shows what was in the way.
const saveScreen = (link: Link, id: string) =>
  Effect.gen(function* () {
    const events = yield* link
      .stream(
        `${GUI} /usr/sbin/screencapture -x -t png /tmp/proofbox-fail.png && cat /tmp/proofbox-fail.png`,
      )
      .pipe(Stream.runCollect);
    const bytes = Buffer.concat(
      Chunk.toReadonlyArray(events).flatMap((event) =>
        event._tag === "Stdout" ? [event.bytes] : [],
      ),
    );
    const path = join(
      (yield* keeperPaths({ provider: "ns", name: id })).dir,
      `ns-${id}-prepare.png`,
    );
    yield* Effect.tryPromise({
      try: () => writeFile(path, bytes, { mode: 0o600 }),
      catch: (cause) =>
        fail(cause instanceof Error ? cause.message : String(cause)),
    });
    return path;
  });

// A test screenshot, then a 1 s capture. A capture its 15 s timer kills
// (137), or a replayd alert (the capture itself does not wait on that one),
// means an alert is on screen.
const checkScreen = (link: Link, id: string) =>
  Effect.gen(function* () {
    const shot = yield* link.run(
      `${GUI} /usr/sbin/screencapture -x -t png /tmp/proofbox-test.png && test -s /tmp/proofbox-test.png`,
    );
    if (shot.exitCode !== 0) {
      return yield* new MacPrepareError({
        id: `ns:${id}`,
        what: "the test screenshot is blocked",
      });
    }
    const capture = yield* link.run(
      `${GUI} /opt/proofbox/tools/ffmpeg -loglevel error -f avfoundation -i 'Capture screen 0' -t 1 -y /tmp/proofbox-test.mov & p=$!; (sleep 15; kill -9 $p 2>/dev/null; pkill -9 -x ffmpeg) & w=$!; wait $p; rc=$?; kill $w 2>/dev/null; exit $rc`,
    );
    // The capture does not wait on replayd's alert; replayd moving the hint
    // date away from the one proofbox wrote is the sign it showed one.
    const hint = yield* link.run(
      `plutil -extract ${shellJoin([`${VMGUEST}.kScreenCapturePrivacyHintDate`])} raw ${shellJoin([REPLAYD])}`,
    );
    const alerted = hint.stdout.trim() !== REPLAYD_HINT;
    if (capture.exitCode !== 0 || alerted) {
      const screenshot = yield* saveScreen(link, id);
      return yield* new MacPrepareError({
        id: `ns:${id}`,
        what:
          capture.exitCode === 0 || capture.exitCode === 137
            ? "an alert is on screen"
            : "the test capture is blocked",
        screenshot,
      });
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
    yield* progress.step(
      "setting up screen access",
      grantPrivacy(link).pipe(Effect.zipRight(watchMemory(link))),
    );
    yield* progress.step(
      "taking a test screenshot and capture",
      checkScreen(link, req.id),
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
