import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The short commit a build comes from. GitHub's archive, which a `github:`
// install builds from, fills scripts/archive-commit.txt with the full commit
// (.gitattributes marks it export-subst). A clone leaves it as is and asks git.
export const buildCommit = (root: string): string | undefined => {
  const filled = readFileSync(
    join(root, "scripts/archive-commit.txt"),
    "utf8",
  ).trim();
  if (/^[0-9a-f]{40}$/.test(filled)) {
    return filled.slice(0, 7);
  }
  if (existsSync(join(root, ".git"))) {
    return execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  }
  return undefined;
};
