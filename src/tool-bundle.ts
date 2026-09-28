import { Schema } from "effect";

export const ToolFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  linux: Schema.Struct({
    amd64: Schema.Struct({ url: Schema.String, sha256: Schema.String }),
    arm64: Schema.Struct({ url: Schema.String, sha256: Schema.String }),
  }),
});
export type ToolFile = typeof ToolFile.Type;

export const TOOL_BUNDLE: ReadonlyArray<ToolFile> = [
  ToolFile.make({
    name: "ffmpeg",
    path: "/opt/proofbox/tools/ffmpeg",
    linux: {
      amd64: {
        // BtbN autobuild-2026-09-25-15-37, ffmpeg n9.0.2; the hash is of the
        // extracted binary, not the archive.
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-25-15-37/ffmpeg-n9.0.2-8-gb135b25c19-linux64-gpl-9.0.tar.xz",
        sha256:
          "9a380286db8a65bfadf83b67256e58b0e8fbe0a82781375ec7fd410ebee73f02",
      },
      arm64: {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-25-15-37/ffmpeg-n9.0.2-8-gb135b25c19-linuxarm64-gpl-9.0.tar.xz",
        sha256:
          "583e6f13cdc325e4633d1d61f2d27bb8baeb234a4f75fca4e0b8f2b9aab09e60",
      },
    },
  }),
];
