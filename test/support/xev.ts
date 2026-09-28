import { type CliEnv, runCli } from "./cli.ts";

export const startXev = (env: CliEnv, id: string) =>
  runCli(env, [
    "exec",
    id,
    "--",
    "sh",
    "-c",
    "setsid xev -geometry 1440x900+0+0 -event button -event keyboard -event mouse > /tmp/xev.log 2>&1 < /dev/null & sleep 1",
  ]);

export interface XevEvent {
  readonly type: string;
  readonly root?: readonly [number, number];
  readonly button?: number;
  readonly keysym?: string;
}

export const readXev = async (
  env: CliEnv,
  id: string,
): Promise<ReadonlyArray<XevEvent>> => {
  const result = await runCli(env, ["exec", id, "--", "cat", "/tmp/xev.log"]);
  return result.stdout
    .split(/\n\s*\n/)
    .map((block) => {
      const type = /^(\w+) event/.exec(block)?.[1];
      if (type === undefined) {
        return undefined;
      }
      const root = /root:\((\d+),(\d+)\)/.exec(block);
      const button = /button (\d+)/.exec(block);
      const keysym = /keysym 0x[0-9a-f]+, (\w+)\)/.exec(block)?.[1];
      const event: {
        type: string;
        root?: readonly [number, number];
        button?: number;
        keysym?: string;
      } = { type };
      if (root !== null) {
        event.root = [Number(root[1]), Number(root[2])];
      }
      if (button !== null) {
        event.button = Number(button[1]);
      }
      if (keysym !== undefined) {
        event.keysym = keysym;
      }
      return event;
    })
    .filter((event) => event !== undefined);
};
