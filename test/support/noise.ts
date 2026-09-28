import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type CliEnv, runCli } from "./cli.ts";

const page = Buffer.from(
  readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "noise.html"),
    "utf8",
  ),
).toString("base64");

export const startNoise = (env: CliEnv, id: string) =>
  runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `setsid chromium --no-sandbox --kiosk --user-data-dir=/tmp/noise 'data:text/html;base64,${page}' > /dev/null 2>&1 < /dev/null & sleep 5`,
  ]);
