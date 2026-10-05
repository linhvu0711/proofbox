import { afterEach, expect, it } from "vitest";
import { cleanupEnvs } from "./support/cli.ts";
import {
  containers,
  docker,
  fakeCodexLogin,
  fixture,
} from "./support/harness.ts";

afterEach(() => {
  for (const container of containers.splice(0)) docker("rm", "-f", container);
  cleanupEnvs();
});

it("create --harness claude on Docker clones the branch, keeps local work, and installs claude and gh", async () => {
  // Given
  const { create, exec } = fixture();
  // When
  const created = await create();
  const id = created.stdout.trim();
  const log = await exec(id, "git", "log", "-1", "--format=%s");
  const dirty = await exec(id, "tail", "-1", "README");
  const claude = await exec(id, "claude", "--version");
  const gh = await exec(id, "gh", "auth", "status");
  const token = await exec(
    id,
    "sh",
    "-c",
    'printf %s "$CLAUDE_CODE_OAUTH_TOKEN"',
  );
  const profile = await exec(id, "cat", ".claude/CLAUDE.md");
  const status = await exec(id, "git", "status", "--porcelain");
  // Then
  expect({
    code: created.exitCode,
    cloning: created.stderr.includes("proofbox: cloning octocat/Hello-World\n"),
    installing: created.stderr.includes("proofbox: installing claude\n"),
    log: log.stdout,
    dirty: dirty.stdout,
    claude: claude.stdout,
    gh: gh.stderr,
    token: token.stdout,
    profile: profile.stdout,
    status: status.stdout,
  }).toEqual({
    code: 0,
    cloning: true,
    installing: true,
    log: "local: add note.txt\n",
    dirty: "changed\n",
    claude: expect.stringMatching(/^\d+\.\d+\.\d+ \(Claude Code\)\n$/),
    gh: expect.stringContaining("using token (GH_TOKEN)"),
    token: "sk-ant-oat01-test",
    profile: "# sandbox rules\n",
    status: " M README\n",
  });
}, 300_000);

it("create --harness codex on Docker installs codex and puts the profile and the login in ~/.codex", async () => {
  // Given
  const { create, exec } = fixture("codex", { file: fakeCodexLogin() });
  // When
  const created = await create();
  const id = created.stdout.trim();
  const codex = await exec(id, "codex", "--version");
  const profile = await exec(id, "cat", ".codex/AGENTS.md");
  const mode = await exec(id, "stat", "-c", "%a", ".codex/auth.json");
  const status = await exec(id, "git", "status", "--porcelain");
  // Then
  expect({
    code: created.exitCode,
    installing: created.stderr.includes("proofbox: installing codex\n"),
    codex: codex.stdout,
    profile: profile.stdout,
    mode: mode.stdout,
    status: status.stdout,
  }).toEqual({
    code: 0,
    installing: true,
    codex: expect.stringMatching(/^codex-cli \d+\.\d+\.\d+\n$/),
    profile: "# sandbox rules\n",
    mode: "600\n",
    status: " M README\n",
  });
}, 300_000);

it("create --harness codex --harness-version 0.159.0 installs that version", async () => {
  // Given
  const { create, exec } = fixture("codex", { file: fakeCodexLogin() });
  // When
  const created = await create(["--harness-version", "0.159.0"]);
  const version = await exec(created.stdout.trim(), "codex", "--version");
  // Then
  expect({ code: created.exitCode, version: version.stdout }).toEqual({
    code: 0,
    version: "codex-cli 0.159.0\n",
  });
}, 300_000);

it("create --harness claude --harness-version 2.1.280 installs that version", async () => {
  // Given
  const { create, exec } = fixture();
  // When
  const created = await create(["--harness-version", "2.1.280"]);
  const version = await exec(created.stdout.trim(), "claude", "--version");
  // Then
  expect({ code: created.exitCode, version: version.stdout }).toEqual({
    code: 0,
    version: "2.1.280 (Claude Code)\n",
  });
}, 300_000);

it("a bad --harness-version fails create, deletes the Sandbox, and shows the installer's last lines", async () => {
  // Given
  const { create } = fixture();
  const before = new Set(
    docker("ps", "-a", "--format", "{{.Names}}").trim().split("\n"),
  );
  // When
  const result = await create(["--harness-version", "0.0.0-nope"]);
  const remaining = docker("ps", "-a", "--format", "{{.Names}}")
    .trim()
    .split("\n")
    .filter((name) => name.startsWith("proofbox-") && !before.has(name));
  // Then
  expect({
    code: result.exitCode,
    out: result.stdout,
    tail: result.stderr.includes("Request failed with status code 404\n"),
    message: result.stderr.endsWith(
      "Installing claude failed with exit code 1; its last 50 lines are above. Check --harness-version and the Sandbox's network, then create again. This Sandbox was deleted.\n",
    ),
    remaining,
  }).toEqual({ code: 125, out: "", tail: true, message: true, remaining: [] });
}, 300_000);
