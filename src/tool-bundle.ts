import { Schema } from "effect";

const Download = Schema.Struct({ url: Schema.String, sha256: Schema.String });
// A file proofbox carries itself, relative to images/macos/.
const RepoFile = Schema.Struct({ file: Schema.String, sha256: Schema.String });

export const ToolFile = Schema.Struct({
  name: Schema.String,
  path: Schema.String,
  linux: Schema.optional(Schema.Struct({ amd64: Download, arm64: Download })),
  macos: Schema.optional(
    Schema.Struct({ arm64: Schema.Union(Download, RepoFile) }),
  ),
});
export type ToolFile = typeof ToolFile.Type;

export const TOOL_BUNDLE: ReadonlyArray<ToolFile> = [
  ToolFile.make({
    name: "ffmpeg",
    path: "/opt/proofbox/tools/ffmpeg",
    linux: {
      amd64: {
        // BtbN autobuild-2026-09-30-13-08, ffmpeg n9.0.2; the hash is of the
        // extracted binary, not the archive. Pin a month-end build: BtbN
        // keeps those and deletes the daily ones.
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-linux64-gpl-9.0.tar.xz",
        sha256:
          "0d709a0bed1a43f24cd2c420878c63afea4580671b6949ad19ed124572f3bc3d",
      },
      arm64: {
        url: "https://github.com/BtbN/FFmpeg-Builds/releases/download/autobuild-2026-09-30-13-08/ffmpeg-n9.0.2-17-g2a571b6068-linuxarm64-gpl-9.0.tar.xz",
        sha256:
          "0b0b5ac30495b4e07ce1321b8d58200f901f57782884a8b6b264c7528c2c9e77",
      },
    },
    macos: {
      arm64: {
        // martin-riedl.de release 9.0.2 (zip sha256 c8ed4c4e…d924, as
        // published); the hash is of the extracted binary, not the zip.
        url: "https://ffmpeg.martin-riedl.de/download/macos/arm64/1789931890_9.0.2/ffmpeg.zip",
        sha256:
          "2e11c6f90993cdb79fff84d3f90044d28316b310e75b3e030cfc9a54f2c9d384",
      },
    },
  }),
  ToolFile.make({
    name: "input",
    path: "/opt/proofbox/tools/input",
    macos: {
      arm64: {
        // proofbox's own input helper; images/macos/build-input.sh builds it
        // and prints this hash.
        file: "input/proofbox-input",
        sha256:
          "9d872ace96aff19424dbef2a2b09ec6d39689afed228d6ea461f7f8d9548e66d",
      },
    },
  }),
];

// The Linux half alone, in the key order the Base image version has always
// hashed, so macOS tools never change the Linux image tag.
export const LINUX_TOOL_BUNDLE = TOOL_BUNDLE.flatMap((file) =>
  file.linux === undefined
    ? []
    : [{ name: file.name, path: file.path, linux: file.linux }],
);
