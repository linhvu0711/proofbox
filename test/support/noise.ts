import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliEnv, runCli } from "./cli.ts";

const page = (file: string) =>
  Buffer.from(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), file), "utf8"),
  ).toString("base64");

const startPage = (env: CliEnv, id: string, file: string) =>
  runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `setsid chromium --no-sandbox --kiosk --user-data-dir=/tmp/noise 'data:text/html;base64,${page(file)}' > /dev/null 2>&1 < /dev/null & sleep 5`,
  ]);

// Random pixels every frame: the screen never holds still, and the
// Proof video is too big to compress under the Size limit.
export const startNoise = (env: CliEnv, id: string) =>
  startPage(env, id, "noise.html");

// One flat color every frame: the screen never holds still, and the
// Proof video stays small.
export const startFlicker = (env: CliEnv, id: string) =>
  startPage(env, id, "flicker.html");
