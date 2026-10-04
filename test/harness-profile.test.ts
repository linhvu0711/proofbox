import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-home-"));
  trackTempDir(home);
  return home;
};

describe("harness profile init", () => {
  afterEach(cleanupEnvs);

  it("harness profile init claude copies CLAUDE.md, skills, and agents and leaves the rest", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    mkdirSync(join(from, "skills", "grill"), { recursive: true });
    mkdirSync(join(from, "agents"));
    mkdirSync(join(from, "plugins", "p"), { recursive: true });
    mkdirSync(join(from, "hooks"));
    writeFileSync(join(from, "CLAUDE.md"), "# mine");
    writeFileSync(join(from, "skills", "grill", "SKILL.md"), "grill");
    writeFileSync(join(from, "agents", "reviewer.md"), "reviewer");
    writeFileSync(join(from, "settings.json"), '{"hooks":{}}');
    writeFileSync(join(from, "plugins", "p", "plugin.json"), "{}");
    writeFileSync(join(from, "hooks", "pre.sh"), "echo");
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
    });
    // Then
    expect(result).toEqual({
      stdout: `${profile}\n`,
      stderr: `Copied from ${from}: CLAUDE.md, skills/, agents/.\nNot copied: settings.json, hooks, plugins, and MCP config. They can point to programs on this laptop or hold tokens.\n`,
      exitCode: 0,
    });
    expect(readdirSync(profile).sort()).toEqual([
      "CLAUDE.md",
      "agents",
      "skills",
    ]);
    expect(readFileSync(join(profile, "CLAUDE.md"), "utf8")).toBe("# mine");
    expect(
      readFileSync(join(profile, "skills", "grill", "SKILL.md"), "utf8"),
    ).toBe("grill");
    expect(readFileSync(join(profile, "agents", "reviewer.md"), "utf8")).toBe(
      "reviewer",
    );
  });

  it("harness profile init codex copies AGENTS.md and skills and leaves the rest", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".codex");
    const profile = join(home, ".config", "proofbox", "harness", "codex");
    mkdirSync(join(from, "skills", "s"), { recursive: true });
    writeFileSync(join(from, "AGENTS.md"), "# codex");
    writeFileSync(join(from, "skills", "s", "SKILL.md"), "s");
    writeFileSync(join(from, "config.toml"), 'model = "x"');
    writeFileSync(join(from, "auth.json"), '{"k":1}');
    // When
    const result = await runCli(env, ["harness", "profile", "init", "codex"], {
      set: { HOME: home },
    });
    // Then
    expect(result).toEqual({
      stdout: `${profile}\n`,
      stderr: `Copied from ${from}: AGENTS.md, skills/.\nNot copied: config.toml, hooks, plugins, and MCP config. They can point to programs on this laptop or hold tokens.\n`,
      exitCode: 0,
    });
    expect(readdirSync(profile).sort()).toEqual(["AGENTS.md", "skills"]);
    expect(readFileSync(join(profile, "AGENTS.md"), "utf8")).toBe("# codex");
    expect(readFileSync(join(profile, "skills", "s", "SKILL.md"), "utf8")).toBe(
      "s",
    );
    expect(readdirSync(from).sort()).toEqual([
      "AGENTS.md",
      "auth.json",
      "config.toml",
      "skills",
    ]);
    expect(readFileSync(join(from, "auth.json"), "utf8")).toBe('{"k":1}');
  });

  it("harness profile init copies what a link points to and leaves the laptop's files alone", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    mkdirSync(join(home, ".agents", "skills", "grill"), { recursive: true });
    writeFileSync(
      join(home, ".agents", "skills", "grill", "SKILL.md"),
      "grill",
    );
    mkdirSync(join(from, "skills"), { recursive: true });
    mkdirSync(join(from, "agents"));
    writeFileSync(join(from, "CLAUDE.md"), "# mine");
    writeFileSync(join(from, "agents", "a.md"), "a");
    symlinkSync("../../.agents/skills/grill", join(from, "skills", "grill"));
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
    });
    writeFileSync(join(profile, "skills", "grill", "SKILL.md"), "edited");
    // Then
    expect(result.exitCode).toBe(0);
    expect(lstatSync(join(profile, "skills", "grill")).isSymbolicLink()).toBe(
      false,
    );
    expect(lstatSync(join(profile, "skills", "grill")).isDirectory()).toBe(
      true,
    );
    expect(
      readFileSync(
        join(home, ".agents", "skills", "grill", "SKILL.md"),
        "utf8",
      ),
    ).toBe("grill");
    expect(readlinkSync(join(from, "skills", "grill"))).toBe(
      "../../.agents/skills/grill",
    );
    expect(readdirSync(from).sort()).toEqual(["CLAUDE.md", "agents", "skills"]);
  });

  it("harness profile init claude skips and names the parts the laptop lacks", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    mkdirSync(from);
    writeFileSync(join(from, "CLAUDE.md"), "# mine");
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
    });
    // Then
    expect(result).toEqual({
      stdout: `${profile}\n`,
      stderr: `Copied from ${from}: CLAUDE.md.\nNot on this laptop, skipped: skills/, agents/.\nNot copied: settings.json, hooks, plugins, and MCP config. They can point to programs on this laptop or hold tokens.\n`,
      exitCode: 0,
    });
    expect(readdirSync(profile)).toEqual(["CLAUDE.md"]);
  });

  it("harness profile init claude with no ~/.claude makes an empty profile", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
    });
    // Then
    expect(result).toEqual({
      stdout: `${profile}\n`,
      stderr: `Copied nothing: ${from} has none of CLAUDE.md, skills/, agents/. The profile is empty.\nNot copied: settings.json, hooks, plugins, and MCP config. They can point to programs on this laptop or hold tokens.\n`,
      exitCode: 0,
    });
    expect(readdirSync(profile)).toEqual([]);
    expect(existsSync(from)).toBe(false);
  });

  it("harness profile init claude leaves an existing profile alone and exits 125", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    mkdirSync(profile, { recursive: true });
    writeFileSync(join(profile, "CLAUDE.md"), "# sandbox");
    mkdirSync(from);
    writeFileSync(join(from, "CLAUDE.md"), "# laptop");
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
    });
    // Then
    expect(result).toEqual({
      stdout: "",
      stderr: `Harness profile claude already exists at ${profile}. Edit it there, or delete it and run proofbox harness profile init claude again.\n`,
      exitCode: 125,
    });
    expect(readdirSync(profile)).toEqual(["CLAUDE.md"]);
    expect(readFileSync(join(profile, "CLAUDE.md"), "utf8")).toBe("# sandbox");
  });

  it("harness profile init claude skips and names links that lead nowhere or loop", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    const from = join(home, ".claude");
    const profile = join(home, ".config", "proofbox", "harness", "claude");
    mkdirSync(join(from, "skills", "ok"), { recursive: true });
    writeFileSync(join(from, "CLAUDE.md"), "# mine");
    writeFileSync(join(from, "skills", "ok", "SKILL.md"), "ok");
    symlinkSync("../../gone", join(from, "skills", "old"));
    symlinkSync(".", join(from, "skills", "loop"));
    // When
    const result = await runCli(env, ["harness", "profile", "init", "claude"], {
      set: { HOME: home },
      timeout: 10_000,
    });
    // Then
    expect(result).toEqual({
      stdout: `${profile}\n`,
      stderr: `Copied from ${from}: CLAUDE.md, skills/.\nNot on this laptop, skipped: agents/.\nSkipped links that lead nowhere or loop: skills/loop, skills/old.\nNot copied: settings.json, hooks, plugins, and MCP config. They can point to programs on this laptop or hold tokens.\n`,
      exitCode: 0,
    });
    expect(readdirSync(join(profile, "skills"))).toEqual(["ok"]);
    expect(readlinkSync(join(from, "skills", "old"))).toBe("../../gone");
  });

  it("harness profile init foo names the known Harnesses", async () => {
    // Given
    const env = makeEnv();
    const home = makeHome();
    // When
    const result = await runCli(env, ["harness", "profile", "init", "foo"], {
      set: { HOME: home },
      unset: ["PROOFBOX_FAKE_ROOT"],
    });
    // Then
    expect(result).toEqual({
      stdout: "",
      stderr: 'No Harness named "foo". Harnesses: claude, codex.\n',
      exitCode: 125,
    });
    expect(existsSync(join(home, ".config", "proofbox", "harness"))).toBe(
      false,
    );
  });
});
