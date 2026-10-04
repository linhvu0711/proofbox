import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, test } from "vitest";
import { cleanupEnvs, makeEnv, runCli, trackTempDir } from "./support/cli.ts";

afterAll(cleanupEnvs);

const makeHome = (): string => {
  const home = mkdtempSync(join(tmpdir(), "proofbox-github-home-"));
  trackTempDir(home);
  return home;
};

test("github login saves the token for the owner, owner-only, and says to protect main", async () => {
  const env = makeEnv();
  const home = makeHome();
  const result = await runCli(env, ["github", "login", "acme"], {
    input: "github_pat_11AAAA1111\n",
    set: { HOME: home },
  });
  const path = join(home, ".config", "proofbox", "github-logins.json");
  expect({
    ...result,
    mode: existsSync(path) ? statSync(path).mode & 0o777 : undefined,
    file: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined,
  }).toEqual({
    stderr:
      "Saved the GitHub login for acme.\nProtect main, or your default branch, with a ruleset that needs a review: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-rulesets/creating-rulesets-for-a-repository\n",
    stdout: "",
    exitCode: 0,
    mode: 0o600,
    file: { acme: { token: "github_pat_11AAAA1111" } },
  });
});

test("github login keeps other owners and replaces the same owner's token", async () => {
  const env = makeEnv();
  const home = makeHome();
  await runCli(env, ["github", "login", "acme"], {
    input: "github_pat_11AAAA1111\n",
    set: { HOME: home },
  });
  await runCli(env, ["github", "login", "beta"], {
    input: "github_pat_22BBBB2222\n",
    set: { HOME: home },
  });
  const result = await runCli(env, ["github", "login", "acme"], {
    input: "github_pat_33CCCC3333\n",
    set: { HOME: home },
  });
  const path = join(home, ".config", "proofbox", "github-logins.json");
  expect({
    firstLine: result.stderr.split("\n")[0],
    exitCode: result.exitCode,
    file: existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : undefined,
  }).toEqual({
    firstLine: "Saved the GitHub login for acme (replaced token …1111).",
    exitCode: 0,
    file: {
      acme: { token: "github_pat_33CCCC3333" },
      beta: { token: "github_pat_22BBBB2222" },
    },
  });
});

test("github login with no owner is refused and saves nothing", async () => {
  const env = makeEnv();
  const home = makeHome();
  const result = await runCli(env, ["github", "login"], {
    input: "github_pat_11AAAA1111\n",
    set: { HOME: home },
  });
  expect({
    ...result,
    saved: existsSync(join(home, ".config", "proofbox", "github-logins.json")),
  }).toEqual({
    stderr: "Missing argument <owner>\n\n",
    stdout: "",
    exitCode: 125,
    saved: false,
  });
});
