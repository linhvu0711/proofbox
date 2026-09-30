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
import { cleanupEnvs } from "./support/cli.ts";

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

describe("ssh link", () => {
  const originalPath = process.env.PATH;
  afterEach(() => {
    process.env.PATH = originalPath;
    cleanupEnvs();
  });

  it.effect(
    "the link dials the GetSSHConfig endpoint with its key and pinned host keys",
    () => {
      const fake = fakeSsh();
      process.env.PATH = `${fake.binDir}:${originalPath}`;
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
          name: "us:abc123def4567",
        });
        // The gateway key lives next to the control socket under a name
        // with no .pub sibling — ssh would compare the ephemeral key to
        // the create-time local public key otherwise.
        const sshKey = `${paths.control.replace(/\.ctl$/, "")}.sshkey`;
        // When
        const link = yield* makeOpenLink(api, executor)(
          "us:abc123def4567",
          paths,
          "keeper",
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
      process.env.PATH = `${fake.binDir}:${originalPath}`;
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
        const forward = yield* makeSshForward(api, executor)(
          "us:abc123def4567",
          5900,
        );
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
});
