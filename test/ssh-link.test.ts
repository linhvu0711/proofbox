import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import {
  ConfigProvider,
  Effect,
  Fiber,
  Ref,
  Schedule,
  type Scope,
  Stream,
} from "effect";
import { afterEach, describe, expect } from "vitest";
import { keeperPaths } from "../src/keeper/paths.ts";
import type {
  InstanceListed,
  NamespaceApi,
} from "../src/namespace/namespace-api.ts";
import { makeOpenLink, makeSshForward } from "../src/namespace/ssh-link.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";
import { fakeSshMaster, openKeeperLink } from "./support/fake-ssh.ts";
import { nodeFs } from "./support/node-fs.ts";

const PEM = Buffer.from(
  "-----BEGIN OPENSSH PRIVATE KEY-----\nZm9v\n-----END OPENSSH PRIVATE KEY-----\n",
);
const HOST_KEY = "ecdsa-sha2-nistp256 AAAAE2VjZHNhLXNoYTItbmlzdHAyNTY=";

// An `ssh` on PATH that answers every ctl probe with exit 0, so the link
// comes back without a real handshake.
const fakeSsh = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const path = join(binDir, "ssh");
  writeFileSync(path, "#!/bin/sh\nexit 0\n");
  chmodSync(path, 0o755);
  return { binDir, path };
};

// An `ssh` that logs its argv, reports a bound local port like a real
// `ssh -v -L` does on stderr, then stays up for the scope.
const fakeSshForward = (log: string) => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const path = join(binDir, "ssh");
  writeFileSync(
    path,
    `#!/bin/sh\nprintf '%s\\n' "$*" >> "${log}"\nprintf 'debug1: Local forwarding listening on 127.0.0.1 port 40022\\n' >&2\nsleep 60\n`,
  );
  chmodSync(path, 0o755);
  return { binDir, path };
};

// An `ssh` that answers every ctl probe (`-O`) with exit 0 and runs any
// other call as a remote command that reads one line of stdin.
const fakeSshReading = () => {
  const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
  trackTempDir(dir);
  const binDir = join(dir, "bin");
  mkdirSync(binDir);
  const path = join(binDir, "ssh");
  writeFileSync(
    path,
    `#!/bin/sh\ncase " $* " in *" -O "*) exit 0 ;; esac\nread x\necho "rc:$?"\n`,
  );
  chmodSync(path, 0o755);
  return { binDir, path };
};

describe("ssh link", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  it.effect(
    "the link dials the GetSSHConfig endpoint with its key and pinned host keys",
    () => {
      const fake = fakeSsh();
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      return Effect.gen(function* () {
        const asked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>(
          [],
        );
        const api: NamespaceApi = {
          create: () => Effect.die("unused"),
          wait: () => Effect.die("unused"),
          destroy: () => Effect.die("unused"),
          extend: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          checkToken: () => Effect.die("unused"),
          ensureImageExpiry: () => Effect.die("unused"),
          makeToken: () => Effect.die("unused"),
          sshConfig: (region, instanceId) =>
            Ref.update(asked, (all) => [
              ...all,
              [region, instanceId] as const,
            ]).pipe(
              Effect.as({
                username: "abc123def4567",
                endpoint: "ssh.iad4.namespace.so",
                privateKey: new Uint8Array(PEM),
                hostKeys: [HOST_KEY],
              }),
            ),
        };
        const executor = yield* CommandExecutor.CommandExecutor;
        const paths = yield* keeperPaths({
          provider: "ns",
          name: "abc123def4567",
        });
        // The gateway key lives next to the control socket under a name
        // with no .pub sibling — ssh would compare the ephemeral key to
        // the create-time local public key otherwise.
        const sshKey = `${paths.control.replace(/\.ctl$/, "")}.sshkey`;
        // When
        const link = yield* makeOpenLink(api, executor, nodeFs, fake.path)(
          { name: "abc123def4567", region: "us" },
          paths,
          "keeper",
          { to: "gateway" },
        );
        // Then: GetSSHConfig was asked in the id's region for its instance
        expect(yield* Ref.get(asked)).toEqual([["us", "abc123def4567"]]);
        // ... and the ssh argv holds the key, the pinned host keys, and the
        // endpoint target
        expect(link.ssh).toContain("-i");
        expect(link.ssh).toContain(sshKey);
        expect(link.ssh).toContain("abc123def4567@ssh.iad4.namespace.so");
        expect(link.ssh).toContain("StrictHostKeyChecking=yes");
        expect(link.ssh).toContain(`UserKnownHostsFile=${paths.knownHosts}`);
        expect(link.ssh).not.toContain("StrictHostKeyChecking=no");
        // The key file holds the returned key, owner-only
        expect(readFileSync(sshKey, "utf8")).toBe(PEM.toString("utf8"));
        expect(statSync(sshKey).mode & 0o777).toBe(0o600);
        // ... and the known_hosts file pins the returned host keys
        expect(readFileSync(paths.knownHosts, "utf8")).toBe(
          `ssh.iad4.namespace.so ${HOST_KEY}\n`,
        );
      }).pipe(
        Effect.scoped,
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );

  it.effect(
    "the forward dials the GetSSHConfig endpoint with ssh -L and its key",
    () => {
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      const log = join(runtime, "ssh.log");
      const fake = fakeSshForward(log);
      return Effect.gen(function* () {
        const asked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>(
          [],
        );
        const api: NamespaceApi = {
          create: () => Effect.die("unused"),
          wait: () => Effect.die("unused"),
          destroy: () => Effect.die("unused"),
          extend: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          checkToken: () => Effect.die("unused"),
          ensureImageExpiry: () => Effect.die("unused"),
          makeToken: () => Effect.die("unused"),
          sshConfig: (region, instanceId) =>
            Ref.update(asked, (all) => [
              ...all,
              [region, instanceId] as const,
            ]).pipe(
              Effect.as({
                username: "abc123def4567",
                endpoint: "ssh.iad4.namespace.so",
                privateKey: new Uint8Array(PEM),
                hostKeys: [HOST_KEY],
              }),
            ),
        };
        const executor = yield* CommandExecutor.CommandExecutor;
        // When
        const forward = yield* makeSshForward(
          api,
          executor,
          nodeFs,
          fake.path,
        )({ name: "abc123def4567", region: "us" }, 5900);
        // Then: GetSSHConfig was asked in the id's region for its instance
        expect(yield* Ref.get(asked)).toEqual([["us", "abc123def4567"]]);
        // ... and the reported port is the one ssh bound
        expect(forward.port).toBe(40022);
        // ... and ssh ran -N -L to the gateway with the key and pinned hosts
        const argv = readFileSync(log, "utf8");
        expect(argv).toContain("-N");
        expect(argv).toContain("-L");
        expect(argv).toContain(":5900");
        expect(argv).toContain("abc123def4567@ssh.iad4.namespace.so");
        expect(argv).toContain("StrictHostKeyChecking=yes");
        expect(argv).not.toContain("StrictHostKeyChecking=no");
      }).pipe(
        Effect.scoped,
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    },
  );

  it.effect("the Live view forward carries the link's keep-alive", () => {
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    const log = join(runtime, "ssh.log");
    const fake = fakeSshForward(log);
    return Effect.gen(function* () {
      // Given
      const api: NamespaceApi = {
        create: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        checkToken: () => Effect.die("unused"),
        ensureImageExpiry: () => Effect.die("unused"),
        makeToken: () => Effect.die("unused"),
        sshConfig: () =>
          Effect.succeed({
            username: "abc123def4567",
            endpoint: "ssh.iad4.namespace.so",
            privateKey: new Uint8Array(PEM),
            hostKeys: [HOST_KEY],
          }),
      };
      const executor = yield* CommandExecutor.CommandExecutor;
      // When
      yield* makeSshForward(
        api,
        executor,
        nodeFs,
        fake.path,
      )({ name: "abc123def4567", region: "us" }, 5900);
      // Then
      expect(readFileSync(log, "utf8")).toContain(
        "-o ServerAliveInterval=10 -o ServerAliveCountMax=3",
      );
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(NodeContext.layer),
    );
  });

  it.effect("the link's known_hosts file is owner-only", () => {
    const fake = fakeSsh();
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    return Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>(
        [],
      );
      const api: NamespaceApi = {
        create: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        checkToken: () => Effect.die("unused"),
        ensureImageExpiry: () => Effect.die("unused"),
        makeToken: () => Effect.die("unused"),
        sshConfig: (region, instanceId) =>
          Ref.update(asked, (all) => [
            ...all,
            [region, instanceId] as const,
          ]).pipe(
            Effect.as({
              username: "abc123def4567",
              endpoint: "ssh.iad4.namespace.so",
              privateKey: new Uint8Array(PEM),
              hostKeys: [HOST_KEY],
            }),
          ),
      };
      const executor = yield* CommandExecutor.CommandExecutor;
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "abc123def4567",
      });
      // The gateway key lives next to the control socket under a name
      // with no .pub sibling — ssh would compare the ephemeral key to
      // the create-time local public key otherwise.
      // When
      yield* makeOpenLink(api, executor, nodeFs, fake.path)(
        { name: "abc123def4567", region: "us" },
        paths,
        "keeper",
        { to: "gateway" },
      );
      // Then
      expect(statSync(paths.knownHosts).mode & 0o777).toBe(0o600);
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(NodeContext.layer),
    );
  });

  it.effect("the forward's key and known_hosts files are owner-only", () => {
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    const log = join(runtime, "ssh.log");
    const fake = fakeSshForward(log);
    return Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>(
        [],
      );
      const api: NamespaceApi = {
        create: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        checkToken: () => Effect.die("unused"),
        ensureImageExpiry: () => Effect.die("unused"),
        makeToken: () => Effect.die("unused"),
        sshConfig: (region, instanceId) =>
          Ref.update(asked, (all) => [
            ...all,
            [region, instanceId] as const,
          ]).pipe(
            Effect.as({
              username: "abc123def4567",
              endpoint: "ssh.iad4.namespace.so",
              privateKey: new Uint8Array(PEM),
              hostKeys: [HOST_KEY],
            }),
          ),
      };
      const executor = yield* CommandExecutor.CommandExecutor;
      // When
      yield* makeSshForward(
        api,
        executor,
        nodeFs,
        fake.path,
      )({ name: "abc123def4567", region: "us" }, 5900);
      // Then
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "abc123def4567",
      });
      const key = join(paths.dir, `ns-f${process.pid}-0.sshkey`);
      expect([
        statSync(key).mode & 0o777,
        statSync(`${key}.known-hosts`).mode & 0o777,
      ]).toEqual([0o600, 0o600]);
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(NodeContext.layer),
    );
  });

  it.live("a Live view forward to a deleted Sandbox fails gone", () => {
    const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
    trackTempDir(dir);
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    trackTempDir(runtime);
    const fake = fakeSshMaster(dir);
    return Effect.gen(function* () {
      // Given: the forward's ssh exits 255 at once, and the Namespace list
      // no longer holds the Sandbox
      writeFileSync(join(dir, "cut"), "");
      const api: NamespaceApi = {
        create: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        list: () => Effect.succeed([]),
        checkToken: () => Effect.die("unused"),
        ensureImageExpiry: () => Effect.die("unused"),
        makeToken: () => Effect.die("unused"),
        sshConfig: () =>
          Effect.succeed({
            username: "abc123def4567",
            endpoint: "ssh.iad4.namespace.so",
            privateKey: new Uint8Array(PEM),
            hostKeys: [HOST_KEY],
          }),
      };
      const executor = yield* CommandExecutor.CommandExecutor;
      // When
      const error = yield* Effect.flip(
        makeSshForward(
          api,
          executor,
          nodeFs,
          fake.path,
        )({ name: "abc123def4567", region: "us" }, 5900),
      );
      // Then
      expect({ _tag: error._tag, message: error.message }).toEqual({
        _tag: "SandboxGoneError",
        message: "Sandbox ns:us:abc123def4567 is gone",
      });
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(NodeContext.layer),
    );
  });

  it.live("run gives the remote command an empty stdin", () => {
    const fake = fakeSshReading();
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    trackTempDir(runtime);
    return Effect.gen(function* () {
      // Given
      const api: NamespaceApi = {
        create: () => Effect.die("unused"),
        wait: () => Effect.die("unused"),
        destroy: () => Effect.die("unused"),
        extend: () => Effect.die("unused"),
        list: () => Effect.die("unused"),
        checkToken: () => Effect.die("unused"),
        ensureImageExpiry: () => Effect.die("unused"),
        makeToken: () => Effect.die("unused"),
        sshConfig: () =>
          Effect.succeed({
            username: "abc123def4567",
            endpoint: "ssh.iad4.namespace.so",
            privateKey: new Uint8Array(PEM),
            hostKeys: [HOST_KEY],
          }),
      };
      const executor = yield* CommandExecutor.CommandExecutor;
      const paths = yield* keeperPaths({
        provider: "ns",
        name: "abc123def4567",
      });
      const link = yield* makeOpenLink(api, executor, nodeFs, fake.path)(
        { name: "abc123def4567", region: "us" },
        paths,
        "keeper",
        { to: "gateway" },
      );
      // When
      const result = yield* link.run("x").pipe(
        Effect.timeoutFail({
          duration: "5 seconds",
          onTimeout: () => "no end of input within 5 s",
        }),
      );
      // Then
      expect(result).toEqual({ exitCode: 0, stdout: "rc:1\n", stderr: "" });
    }).pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
      ),
      Effect.provide(NodeContext.layer),
    );
  });

  for (const [name, ride, user] of [
    [
      "a Mac link reaches runner@127.0.0.1 through the gateway with the Sandbox key and the pinned sshd host key",
      false,
      "runner",
    ],
    ["a CLI Mac link rides the Keeper's master over sshd", true, "runner"],
    [
      "a Linux link reaches root@127.0.0.1 through the gateway with the Sandbox key and the pinned sshd host key",
      false,
      "root",
    ],
  ] as const) {
    it.effect(name, () => {
      const fake = fakeSsh();
      const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
      trackTempDir(runtime);
      return Effect.gen(function* () {
        // Given
        const asked = yield* Ref.make<ReadonlyArray<readonly [string, string]>>(
          [],
        );
        const api: NamespaceApi = {
          create: () => Effect.die("unused"),
          wait: () => Effect.die("unused"),
          destroy: () => Effect.die("unused"),
          extend: () => Effect.die("unused"),
          list: () => Effect.die("unused"),
          checkToken: () => Effect.die("unused"),
          ensureImageExpiry: () => Effect.die("unused"),
          makeToken: () => Effect.die("unused"),
          sshConfig: (region, instanceId) =>
            Ref.update(asked, (all) => [
              ...all,
              [region, instanceId] as const,
            ]).pipe(
              Effect.as({
                username: "abc123def4567",
                endpoint: "ssh.iad4.namespace.so",
                privateKey: new Uint8Array(PEM),
                hostKeys: [HOST_KEY],
              }),
            ),
        };
        const executor = yield* CommandExecutor.CommandExecutor;
        const paths = yield* keeperPaths({
          provider: "ns",
          name: "abc123def4567",
        });
        const sshKey = `${paths.control.replace(/\.ctl$/, "")}.sshkey`;
        if (ride) {
          writeFileSync(
            `${paths.control.replace(/\.ctl$/, "")}.sshtarget`,
            "abc123def4567@ssh.iad4.namespace.so\n",
          );
        }
        // When
        const link = yield* makeOpenLink(api, executor, nodeFs, fake.path)(
          { name: "abc123def4567", region: "us" },
          paths,
          ride ? "cli" : "keeper",
          { to: "sshd", user },
        );
        // Then
        expect(yield* Ref.get(asked)).toEqual(
          ride ? [] : [["us", "abc123def4567"]],
        );
        expect(link.ssh.slice(0, 4)).toEqual([
          "-S",
          paths.control,
          "-i",
          paths.key,
        ]);
        expect(link.ssh).toContain(
          `UserKnownHostsFile=${paths.sshdKnownHosts}`,
        );
        expect(link.ssh).toContain("StrictHostKeyChecking=yes");
        expect(link.ssh.at(-1)).toBe(
          user === "root" ? "root@127.0.0.1" : "runner@127.0.0.1",
        );
        expect(link.ssh).toContain(
          `ProxyCommand='${fake.path}' '-i' '${sshKey}' '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=yes' '-o' 'UserKnownHostsFile=${paths.knownHosts}' '-o' 'LogLevel=ERROR' '-o' 'ServerAliveInterval=10' '-o' 'ServerAliveCountMax=3' '-W' '127.0.0.1:22' 'abc123def4567@ssh.iad4.namespace.so'`,
        );
        // ... and the master carries keep-alive, so a stalled link ends in
        // 30 to 40 s, not at the 120 s helper limit
        expect(link.ssh).toContain("ServerAliveInterval=10");
        expect(link.ssh).toContain("ServerAliveCountMax=3");
        expect(link.ssh).not.toContain("abc123def4567@ssh.iad4.namespace.so");
      }).pipe(
        Effect.scoped,
        Effect.withConfigProvider(
          ConfigProvider.fromMap(new Map([["PROOFBOX_RUNTIME_DIR", runtime]])),
        ),
        Effect.provide(NodeContext.layer),
      );
    });
  }
});

describe("Keeper link reopen", () => {
  afterEach(() => {
    cleanupEnvs();
  });

  const here: ReadonlyArray<InstanceListed> = [
    { id: "abc123def4567", labels: {} },
  ];

  const inSandbox = <A, E>(
    runtime: string,
    effect: Effect.Effect<A, E, Scope.Scope | NodeContext.NodeContext>,
  ) =>
    effect.pipe(
      Effect.scoped,
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ["PROOFBOX_RUNTIME_DIR", runtime],
            ["PROOFBOX_NS_LINK_WAIT", "0s"],
          ]),
        ),
      ),
      Effect.provide(NodeContext.layer),
    );

  const tempDirs = () => {
    const dir = mkdtempSync(join(tmpdir(), "proofbox-ssh-"));
    trackTempDir(dir);
    const runtime = mkdtempSync(join(tmpdir(), "proofbox-runtime-"));
    trackTempDir(runtime);
    return { dir, runtime };
  };

  it.live(
    "a Keeper link whose master died opens a new master on the next run",
    () => {
      const { dir, runtime } = tempDirs();
      const fake = fakeSshMaster(dir);
      return inSandbox(
        runtime,
        Effect.gen(function* () {
          // Given: a Keeper link whose first run went over its master
          const { link } = yield* openKeeperLink(fake, here);
          yield* link.run("true");
          // When: the master drops
          rmSync(join(dir, "alive"));
          const result = yield* link.run("true");
          // Then
          expect({ masterStarts: fake.masterStarts(), result }).toEqual({
            masterStarts: 2,
            result: { exitCode: 0, stdout: "ok\n", stderr: "" },
          });
        }),
      );
    },
  );

  it.live(
    "a Keeper link that cannot open again fails link-lost, and the next run tries again",
    () => {
      const { dir, runtime } = tempDirs();
      const fake = fakeSshMaster(dir);
      return inSandbox(
        runtime,
        Effect.gen(function* () {
          // Given
          const { link } = yield* openKeeperLink(fake, here);
          yield* link.run("true");
          // When: the master drops and the gateway does not answer
          rmSync(join(dir, "alive"));
          writeFileSync(join(dir, "refuse"), "");
          const first = yield* Effect.flip(link.run("true"));
          yield* Effect.flip(link.run("true"));
          // Then
          expect({
            first: first.message,
            masterStarts: fake.masterStarts(),
          }).toEqual({
            first:
              "Could not connect to Sandbox ns:us:abc123def4567 over SSH (ssh: connect to host ssh.iad4.namespace.so port 22: Operation timed out). Try again in a minute.",
            masterStarts: 3,
          });
        }),
      );
    },
  );

  it.live(
    "a Keeper link whose Sandbox was deleted while it was down fails gone",
    () => {
      const { dir, runtime } = tempDirs();
      const fake = fakeSshMaster(dir);
      return inSandbox(
        runtime,
        Effect.gen(function* () {
          // Given: the Namespace list no longer holds the Sandbox
          const { link } = yield* openKeeperLink(fake, []);
          yield* link.run("true");
          // When
          rmSync(join(dir, "alive"));
          writeFileSync(join(dir, "refuse"), "");
          const error = yield* Effect.flip(link.run("true"));
          // Then
          expect({ _tag: error._tag, message: error.message }).toEqual({
            _tag: "SandboxGoneError",
            message: "Sandbox ns:us:abc123def4567 is gone",
          });
        }),
      );
    },
  );

  it.live("a Keeper link logs one line each time it opens again", () => {
    const { dir, runtime } = tempDirs();
    const fake = fakeSshMaster(dir);
    return inSandbox(
      runtime,
      Effect.gen(function* () {
        // Given
        const { link, paths } = yield* openKeeperLink(fake, here);
        // When: the master drops twice
        yield* link.run("true");
        rmSync(join(dir, "alive"));
        yield* link.run("true");
        rmSync(join(dir, "alive"));
        yield* link.run("true");
        // Then
        const lines = readFileSync(paths.log, "utf8")
          .trimEnd()
          .split("\n")
          .map((line) => {
            const fields = line.split(" ");
            return [...fields.slice(1, 7), fields.at(-1)];
          });
        expect(lines).toEqual([
          ["link", "reopen", "out=0", "err=0", "exit=-", "first=-", "done"],
          ["link", "reopen", "out=0", "err=0", "exit=-", "first=-", "done"],
        ]);
      }),
    );
  });

  it.live(
    "a Keeper link command cut off mid-way fails as a dropped link",
    () => {
      const { dir, runtime } = tempDirs();
      const fake = fakeSshMaster(dir);
      return inSandbox(
        runtime,
        Effect.gen(function* () {
          // Given: the master goes on answering, and the command's own ssh
          // exits 255 as a mux client does when its master dies
          const { link } = yield* openKeeperLink(fake, here);
          writeFileSync(join(dir, "cut"), "");
          // When
          const error = yield* Effect.flip(
            Stream.runDrain(link.stream("true")),
          );
          // Then
          expect({
            tag: error._tag,
            message: error.message,
            plainCalls: fake.plainCalls(),
          }).toEqual({
            tag: "LinkDroppedError",
            message:
              "Could not connect to Sandbox ns:us:abc123def4567 over SSH (the ssh link dropped mid-command). Try again in a minute.",
            plainCalls: 1,
          });
        }),
      );
    },
  );

  it.live("two runs on a dropped Keeper link open it once", () => {
    const { dir, runtime } = tempDirs();
    const fake = fakeSshMaster(dir);
    return inSandbox(
      runtime,
      Effect.gen(function* () {
        // Given: a new master waits for `go` between its start and its socket
        const { link } = yield* openKeeperLink(fake, here);
        yield* link.run("true");
        writeFileSync(join(dir, "hold"), "");
        // When: two runs find the master dropped at once
        rmSync(join(dir, "alive"));
        const runs = yield* Effect.fork(
          Effect.all([link.run("true"), link.run("true")], {
            concurrency: "unbounded",
          }),
        );
        yield* Effect.sync(() => fake.masterStarts() >= 2).pipe(
          Effect.repeat({
            until: (started) => started,
            schedule: Schedule.spaced("20 millis"),
          }),
          Effect.timeout("10 seconds"),
        );
        yield* Effect.sleep("300 millis");
        writeFileSync(join(dir, "go"), "");
        const results = yield* Fiber.join(runs);
        // Then
        expect({
          masterStarts: fake.masterStarts(),
          results: results.map((result) => result.stdout),
        }).toEqual({ masterStarts: 2, results: ["ok\n", "ok\n"] });
      }),
    );
  });
});
