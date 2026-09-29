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
          "5e5afcc44ff9cf10d2c01e24b29d80260312d11da4c8a7920a738e515e99756a",
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
