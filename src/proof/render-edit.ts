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
    return (
      `movie=${options.dir}/raw.mkv:seek_point=${num(at)}` +
      `,trim=start=${num(at)},setpts=PTS-STARTPTS,trim=end_frame=1` +
      `,loop=loop=${frames}:size=1:start=0,setpts=N/30/TB[c${index}]`
    );
  });
  const inputs = plan.clips.map((_, index) => `[c${index}]`).join("");
  return (
    `${chains.join(";")};` +
    `${inputs}concat=n=${plan.clips.length}:v=1:a=0[out]`
  );
};
