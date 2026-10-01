import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type CliEnv, runCli } from "./cli.ts";

// A browser page on a Mac that logs each input event it sees, the macOS
// match for xev: events.html in Chrome, events-server.py writing the log.

const DIR = "/tmp/proofbox-events";

export interface PageEvent {
  readonly type: string;
  readonly x?: number;
  readonly y?: number;
  readonly button?: number;
  readonly key?: string;
  readonly ctrl?: boolean;
  readonly meta?: boolean;
  readonly value?: string;
  readonly dir?: string;
}

const sendFile = (env: CliEnv, id: string, name: string) =>
  runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `mkdir -p ${DIR} && printf "%s" "$1" > ${DIR}/${name}`,
    "sh",
    readFileSync(join(import.meta.dirname, name), "utf8"),
  ]);

export const readEvents = async (
  env: CliEnv,
  id: string,
): Promise<ReadonlyArray<PageEvent>> => {
  const result = await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `cat ${DIR}/events.jsonl 2>/dev/null; true`,
  ]);
  return result.stdout
    .split("\n")
    .filter((line) => line !== "")
    .map((line) => JSON.parse(line) as PageEvent);
};

// The modifiers the Mac thinks are held, as held-modifiers.swift prints
// them: "none" when no key is down.
export const readHeldModifiers = async (
  env: CliEnv,
  id: string,
): Promise<string> => {
  await sendFile(env, id, "held-modifiers.swift");
  const result = await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `cd ${DIR} && swiftc -O held-modifiers.swift -o held-modifiers && ./held-modifiers`,
  ]);
  return result.stdout.trim();
};

export const openEventsPage = async (env: CliEnv, id: string) => {
  await sendFile(env, id, "events.html");
  await sendFile(env, id, "events-server.py");
  await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    `cd ${DIR}; nohup python3 events-server.py </dev/null >/dev/null 2>&1 &`,
  ]);
  // Chrome on a Namespace Mac is a Homebrew download still marked as one,
  // which opens a Gatekeeper alert over the page.
  await runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    'xattr -dr com.apple.quarantine "/Applications/Google Chrome.app"; true',
  ]);
  await runCli(env, [
    "exec",
    id,
    "--",
    "open",
    "-na",
    "Google Chrome",
    "--args",
    "--kiosk",
    "--no-first-run",
    "--no-default-browser-check",
    "--use-mock-keychain",
    // No "Can't update Chrome" bubble over the page.
    "--simulate-outdated-no-au=Tue, 31 Dec 2099 23:59:59 GMT",
    "--user-data-dir=/tmp/proofbox-chrome",
    "http://127.0.0.1:8123/events.html",
  ]);
  const until = Date.now() + 60_000;
  while (Date.now() < until) {
    const events = await readEvents(env, id);
    if (events.some((event) => event.type === "ready")) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("the events page never became ready");
};
