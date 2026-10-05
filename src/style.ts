import { Config, Effect, Option } from "effect";
import { CliOutput } from "./cli-output.ts";

const tones = {
  ok: "\u001b[32m",
  warn: "\u001b[33m",
  bad: "\u001b[31m",
  dim: "\u001b[2m",
  spin: "\u001b[36m",
};
const marks = { ok: "✔", warn: "!", bad: "✘" };

export class Style extends Effect.Service<Style>()("proofbox/Style", {
  effect: Effect.gen(function* () {
    const output = yield* CliOutput;
    const forceColor = yield* Config.option(Config.string("FORCE_COLOR"));
    const noColor = yield* Config.option(Config.string("NO_COLOR"));
    const term = yield* Config.option(Config.string("TERM"));
    const terminal =
      output.terminal.isTTY && Option.getOrElse(term, () => "") !== "dumb";
    const force = Option.getOrElse(forceColor, () => "");
    const look = terminal || (force !== "" && force !== "0");
    const color = look && Option.getOrElse(noColor, () => "") === "";
    const paint = (tone: keyof typeof tones, text: string) =>
      color ? `${tones[tone]}${text}\u001b[0m` : text;
    return {
      look,
      live: terminal,
      color,
      columns: output.terminal.columns,
      paint,
      mark: (tone: keyof typeof marks) => paint(tone, marks[tone]),
      cut: (text: string, room: number) => {
        const points = Array.from(text);
        if (points.length <= room) return text;
        return `${points.slice(0, Math.max(0, room - 1)).join("")}…`;
      },
    };
  }),
}) {}
