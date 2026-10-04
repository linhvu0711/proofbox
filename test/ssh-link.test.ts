import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CommandExecutor } from "@effect/platform";
import { NodeContext } from "@effect/platform-node";
import { it } from "@effect/vitest";
import { ConfigProvider, Effect, Ref } from "effect";
import { afterEach, describe, expect } from "vitest";
import { keeperPaths } from "../src/keeper/paths.ts";
import type { NamespaceApi } from "../src/namespace/namespace-api.ts";
import { makeOpenLink, makeSshForward } from "../src/namespace/ssh-link.ts";
import { cleanupEnvs, trackTempDir } from "./support/cli.ts";
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
          "gateway",
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
        "gateway",
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
        "gateway",
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

  for (const [name, ride] of [
    [
      "a Mac link reaches runner@127.0.0.1 through the gateway with the Sandbox key and the pinned sshd host key",
      false,
    ],
    ["a CLI Mac link rides the Keeper's master over sshd", true],
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
          "sshd",
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
        expect(link.ssh.at(-1)).toBe("runner@127.0.0.1");
        expect(link.ssh).toContain(
          `ProxyCommand='${fake.path}' '-i' '${sshKey}' '-o' 'BatchMode=yes' '-o' 'StrictHostKeyChecking=yes' '-o' 'UserKnownHostsFile=${paths.knownHosts}' '-o' 'LogLevel=ERROR' '-W' '127.0.0.1:22' 'abc123def4567@ssh.iad4.namespace.so'`,
        );
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
