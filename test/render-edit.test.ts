import { describe, expect, it } from "vitest";
import { planEdit } from "../src/proof/edit-plan.ts";
import { renderEdit } from "../src/proof/render-edit.ts";

const FONT = "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf";
const DIR = "/run/proofbox/recordings/1";

describe("render-edit", () => {
  it("the caption bar sits above the picture, sized from the width", () => {
    // Given
    const plan = planEdit({
      duration: 20,
      freezes: [],
      marks: [2, 10],
      clicks: [],
    });
    const options = { width: 1440, height: 900, dir: DIR, font: FONT };
    // When
    const script = renderEdit(plan, options);
    // Then
    expect(script).toContain("concat=n=5:v=1:a=0");
    expect(script).toContain("pad=1440:972:0:72:color=0x111111");
    expect(script).toContain(
      `textfile=${DIR}/caption-1.txt:fontsize=36:fontcolor=white:x=36:y=(72-text_h)/2:enable='between(t,2,12)'`,
    );
    expect(script).toContain("enable='between(t,12,24)'");
  });

  it("a 2560-wide Recording gets a 128 px bar and a 64 px font", () => {
    // Given
    const plan = planEdit({
      duration: 20,
      freezes: [],
      marks: [2, 10],
      clicks: [],
    });
    const options = { width: 2560, height: 1600, dir: DIR, font: FONT };
    // When
    const script = renderEdit(plan, options);
    // Then
    expect(script).toContain("pad=2560:1728:0:128:color=0x111111");
    expect(script).toContain("fontsize=64");
  });

  it("a label is drawn on its still clip", () => {
    // Given
    const plan = planEdit({
      duration: 40,
      freezes: [[5, 30]],
      marks: [0],
      clicks: [],
    });
    const options = { width: 1440, height: 900, dir: DIR, font: FONT };
    // When
    const script = renderEdit(plan, options);
    // Then
    expect(script).toContain(
      `movie=${DIR}/raw.mkv:seek_point=6.9,trim=start=6.9,setpts=PTS-STARTPTS,trim=end_frame=1,loop=loop=59:size=1:start=0,setpts=N/30/TB,drawtext=fontfile=${FONT}:text='» 22 s later':fontsize=36:fontcolor=white:box=1:boxcolor=black@0.6:boxborderw=18:x=(w-text_w)/2:y=h-text_h-72`,
    );
  });

  it("a ring is drawn at the click, below the bar", () => {
    // Given
    const plan = planEdit({
      duration: 172,
      freezes: [
        [2, 58.5],
        [59, 115.5],
        [116, undefined],
      ],
      marks: [1, 58, 115],
      clicks: [
        { t: 1.5, x: 700, y: 400 },
        { t: 3.5, x: 10, y: 20 },
        { t: 30, x: 5, y: 5 },
      ],
    });
    const options = { width: 1440, height: 900, dir: DIR, font: FONT };
    // When
    const script = renderEdit(plan, options);
    // Then
    expect(script).toContain(
      "color=c=black@0:s=48x48:r=30:d=2.3,format=rgba,geq=r='255':g='59':b='48':a='if(between(hypot(X-24,Y-24),20,24),230,0)'",
    );
    expect(script).toContain(
      "overlay=x=676:y=448:enable='between(t,1.5,2.3)'",
    );
  });
});
