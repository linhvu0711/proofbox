import type { EditPlan } from "./edit-plan.ts";

const num = (value: number): string =>
  value.toFixed(3).replace(/\.?0+$/, "");

export const renderEdit = (
  plan: EditPlan,
  options: {
    readonly width: number;
    readonly height: number;
    readonly dir: string;
    readonly font: string;
  },
): string => {
  const size = Math.round(options.width / 40);
  const bar = 2 * size;
  const chains = plan.clips.map((clip, index) => {
    if (clip.kind === "cut") {
      return (
        `movie=${options.dir}/raw.mkv:seek_point=${num(clip.from)}` +
        `,trim=start=${num(clip.from)}:end=${num(clip.to)}` +
        `,setpts=PTS-STARTPTS,fps=30[c${index}]`
      );
    }
    const at = Math.max(clip.at - 0.1, 0);
    const frames = Math.round(clip.seconds * 30) - 1;
    const label =
      clip.label === undefined
        ? ""
        : `,drawtext=fontfile=${options.font}:text='${clip.label}'` +
          `:fontsize=${size}:fontcolor=white:box=1` +
          `:boxcolor=black@0.6:boxborderw=${size / 2}` +
          `:x=(w-text_w)/2:y=h-text_h-${bar}`;
    return (
      `movie=${options.dir}/raw.mkv:seek_point=${num(at)}` +
      `,trim=start=${num(at)},setpts=PTS-STARTPTS,trim=end_frame=1` +
      `,loop=loop=${frames}:size=1:start=0,setpts=N/30/TB${label}[c${index}]`
    );
  });
  const captions = plan.captions.map(
    (caption) =>
      `drawtext=fontfile=${options.font}` +
      `:textfile=${options.dir}/caption-${caption.step}.txt` +
      `:fontsize=${size}:fontcolor=white:x=${size}` +
      `:y=(${bar}-text_h)/2` +
      `:enable='between(t,${num(caption.from)},${num(caption.to)})'`,
  );
  const inputs = plan.clips.map((_, index) => `[c${index}]`).join("");
  return (
    `${chains.join(";")};` +
    `${inputs}concat=n=${plan.clips.length}:v=1:a=0` +
    `,pad=${options.width}:${options.height + bar}:0:${bar}:color=0x111111` +
    (captions.length === 0 ? "" : `,${captions.join(",")}`) +
    `[out]`
  );
};
