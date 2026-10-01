import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Chunk, Clock, Duration, Effect, Stream } from "effect";
import type { ChecksShell } from "../command-checks.ts";
import { sandboxInfoFromLabels } from "../docker/docker-provider.ts";
import { packagePath } from "../entry.ts";
import {
  MacPrepareError,
  ProviderError,
  SandboxGoneError,
  TokenExposedError,
  ToolBundleHashError,
} from "../errors.ts";
import { keeperPaths } from "../keeper/paths.ts";
import { Progress } from "../progress.ts";
import { SandboxInfo, type SandboxRef } from "../provider.ts";
import { formatSandboxId } from "../sandbox-id.ts";
import { shellJoin } from "../shell.ts";
import { formatSize, type Size } from "../size.ts";
import { TOOL_BUNDLE } from "../tool-bundle.ts";
import type { Link } from "./ssh-link.ts";

// proofbox's own Mac files: the input helper and the Pixel script.
export const MACOS_DIR = packagePath("images/macos/");

// A Namespace Mac has no container: the Sandbox is the Mac itself, and
// every login lands as `runner` (uid 501) with passwordless sudo. The
// state the Linux Sandbox keeps in container labels lives in this folder.
export const MAC_STATE_DIR = "/var/lib/proofbox";
export const MAC_WORK_DIR = "/Users/runner/work";
// The Secrets folder is an hfs volume on RAM: a Secret never lands on the
// Mac's disk.
export const MAC_SECRETS_DIR = "/var/run/proofbox-secrets";
const LABELS = `${MAC_STATE_DIR}/labels.json`;
const DEADLINE = `${MAC_STATE_DIR}/deadline`;
// Root's folder, not MAC_STATE_DIR: runner owns that one and could swap
// the log for one with made-up kills.
const MEMORY_KILLS = "/var/log/proofbox-memory-kills.log";

const fail = (reason: string) =>
  new ProviderError({ provider: "namespace", reason });

const sandboxId = (ref: SandboxRef) =>
  formatSandboxId({ provider: "ns", region: ref.region, name: ref.name });

const brandFor = (ref: SandboxRef) => ({
  provider: "namespace",
  id: () => sandboxId(ref),
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

interface MacRequest {
  readonly ref: SandboxRef;
  readonly idle: Duration.Duration;
  readonly maxLifeAt: Date;
  readonly size: Size;
}

const makeMacFolders = (link: Link) =>
  step(
    link,
    "making the proofbox folders",
    `sudo -n mkdir -p ${MAC_STATE_DIR} ${MAC_STATE_DIR}/recordings /opt/proofbox/tools ${MAC_WORK_DIR} && sudo -n touch ${MAC_STATE_DIR}/action-log.jsonl && sudo -n chown -R runner:staff ${MAC_STATE_DIR} /opt/proofbox ${MAC_WORK_DIR}`,
  );

// The labels and the first Deadline, as the Docker Provider writes them for
// a container, so `sandboxInfoFromLabels` reads both. Written last: until
// they exist, `get` finds no Sandbox, so no command reaches a Mac that
// still has its workload token. The Deadline counts from now, as create's
// keepalive has held the host up through a prepare of any length.
const writeMacState = (link: Link, req: MacRequest, createdAt: Date) =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const deadline = Math.floor(
      Math.min(
        now + Duration.toMillis(req.idle) + 60_000,
        req.maxLifeAt.getTime(),
      ) / 1000,
    );
    const labels = JSON.stringify({
      "proofbox.name": req.ref.name,
      "proofbox.os": "macos",
      "proofbox.created-at": createdAt.toISOString(),
      "proofbox.idle-seconds": String(Duration.toSeconds(req.idle)),
      "proofbox.max-life-at": req.maxLifeAt.toISOString(),
      "proofbox.size": formatSize(req.size),
    });
    yield* step(
      link,
      "saving the Sandbox state",
      `printf '%s\\n' ${shellJoin([labels])} > ${LABELS} && printf '%s\\n' ${deadline} > ${DEADLINE}`,
    );
    return new SandboxInfo({
      name: req.ref.name,
      region: req.ref.region,
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
const installTools = (link: Link, ref: SandboxRef) =>
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
    yield* sendFile(link, join(MACOS_DIR, "record.sh"), "/opt/proofbox/record");
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
          sandboxId: sandboxId(ref),
        });
      }
    }
  });

// `runner` has passwordless sudo, so the workload token must be gone before
// any user code runs (ADR 0009); then each way to it is checked.
const dropToken = (link: Link, ref: SandboxRef) =>
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
        return yield* new TokenExposedError({ id: sandboxId(ref), what });
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
// fails and never starts the command. Its pid goes where only root writes.
const MEMORY_WATCH_PID = "/var/run/proofbox-memory-watch.pid";
const startMemoryWatcher = `sudo -n sh -c ${shellJoin([
  `trap "" HUP; /usr/bin/log stream --style compact --predicate 'sender == "kernel" AND eventMessage BEGINSWITH "memorystatus: killing_"' >> ${MEMORY_KILLS} 2>/dev/null < /dev/null & echo $! > ${MEMORY_WATCH_PID}`,
])}`;

const watchMemory = (link: Link) =>
  step(link, "starting the memory watcher", startMemoryWatcher);

// One hfs volume on 8 MiB of RAM, mounted mode 700 for runner alone. A
// non-zero exit is a MacPrepareError so create deletes the Mac before any
// Secret is sent.
const makeSecretsDisk = (link: Link, ref: SandboxRef) =>
  Effect.gen(function* () {
    const made = yield* link.run(
      `sudo -n sh -c ${shellJoin([
        `dev=$(hdiutil attach -nomount ram://16384 | awk '{print $1}') && newfs_hfs -v proofbox-secrets -U 501 -G 20 -M 700 "$dev" >/dev/null && mkdir -p ${MAC_SECRETS_DIR} && mount -t hfs -o nobrowse,nosuid,nodev "$dev" ${MAC_SECRETS_DIR} && chown runner:staff ${MAC_SECRETS_DIR} && chmod 700 ${MAC_SECRETS_DIR}`,
      ])}`,
    );
    if (made.exitCode !== 0) {
      return yield* new MacPrepareError({
        id: sandboxId(ref),
        what: "the Secrets RAM disk cannot be made",
      });
    }
  });

// The shell that counts kills of real work in the watcher's log: macOS
// also kills idle daemons under pressure, and those are not the command.
export const macKillCount = (log: string) =>
  `grep -E 'memorystatus: killing_[[:alnum:]_]+ pid [0-9]+' ${log} 2>/dev/null | grep -vc killing_idle_process`;

// The checks around a command on a Mac (ADR 0015): the Deadline file
// `readMac` reads; the kill count, with the watcher started again if it
// stopped, so the command is watched; and the command in the `runner`
// desktop session, through a login shell so PATH is the one ssh gives, in
// the Work folder.
export const macChecks = (): ChecksShell => ({
  push: `tmp=${MAC_STATE_DIR}/.deadline.$$; printf "%s\\n" "$d" > "$tmp" && mv "$tmp" ${DEADLINE}`,
  kills: `ps -p "$(cat ${MEMORY_WATCH_PID} 2>/dev/null)" >/dev/null 2>&1 || ${startMemoryWatcher}; ${macKillCount(MEMORY_KILLS)}`,
  run: `sudo -n launchctl asuser 501 sudo -n -u runner -H /bin/zsh -lc ${shellJoin([`cd ${MAC_WORK_DIR} && exec "$@"`])} zsh "$@"`,
});

// The screen as it is now, saved next to the host's other files, so a
// failed prepare shows what was in the way. No path when the screen could
// not be captured either.
const saveScreen = (link: Link, ref: SandboxRef) =>
  Effect.gen(function* () {
    const events = Chunk.toReadonlyArray(
      yield* link
        .stream(
          `${GUI} /usr/sbin/screencapture -x -t png /tmp/proofbox-fail.png && cat /tmp/proofbox-fail.png`,
        )
        .pipe(Stream.runCollect),
    );
    const bytes = Buffer.concat(
      events.flatMap((event) => (event._tag === "Stdout" ? [event.bytes] : [])),
    );
    const exit = events.at(-1);
    if (exit?._tag !== "Exit" || exit.code !== 0 || bytes.length === 0) {
      return undefined;
    }
    const path = join(
      (yield* keeperPaths({ provider: "ns", name: ref.name })).dir,
      `ns-${ref.name}-prepare.png`,
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
const checkScreen = (link: Link, ref: SandboxRef) =>
  Effect.gen(function* () {
    const shot = yield* link.run(
      `${GUI} /usr/sbin/screencapture -x -t png /tmp/proofbox-test.png && test -s /tmp/proofbox-test.png`,
    );
    if (shot.exitCode !== 0) {
      return yield* new MacPrepareError({
        id: sandboxId(ref),
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
      const screenshot = yield* saveScreen(link, ref);
      return yield* new MacPrepareError({
        id: sandboxId(ref),
        what:
          capture.exitCode === 0 || capture.exitCode === 137
            ? "an alert is on screen"
            : "the test capture is blocked",
        screenshot,
      });
    }
  });

// Everything a Mac needs before user code arrives, in order.
export const prepareMac = (link: Link, req: MacRequest) =>
  Effect.gen(function* () {
    const progress = yield* Progress;
    const createdAt = new Date(yield* Clock.currentTimeMillis);
    yield* makeMacFolders(link);
    yield* progress.step(
      "installing the Tool bundle",
      installTools(link, req.ref),
    );
    yield* progress.step(
      "checking the Namespace token is out of reach",
      dropToken(link, req.ref),
    );
    yield* progress.step(
      "setting up screen access",
      grantPrivacy(link).pipe(Effect.zipRight(watchMemory(link))),
    );
    yield* progress.step(
      "making the Secrets RAM disk",
      makeSecretsDisk(link, req.ref),
    );
    yield* progress.step(
      "taking a test screenshot and capture",
      checkScreen(link, req.ref),
    );
    return yield* writeMacState(link, req, createdAt);
  });

export const readMac = (link: Link, ref: SandboxRef) =>
  Effect.gen(function* () {
    const result = yield* link.run(`cat ${LABELS} && cat ${DEADLINE}`);
    if (result.exitCode !== 0) {
      // No state file: the create never finished, so there is no Sandbox.
      if (result.stderr.includes("No such file")) {
        return yield* new SandboxGoneError({ id: sandboxId(ref) });
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
    return yield* sandboxInfoFromLabels(
      brandFor(ref),
      ref.name,
      labels,
      seconds,
      ref.region,
    );
  });

export const writeMacDeadline = (link: Link, seconds: number) =>
  link.run(
    `tmp=${MAC_STATE_DIR}/.deadline.$$; printf "%s\\n" "$(( $(date +%s) + ${seconds} ))" > "$tmp" && mv "$tmp" ${DEADLINE}`,
  );
