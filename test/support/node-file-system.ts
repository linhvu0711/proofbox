import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

// A Node `FileSystem` value, for builders a test calls outside an effect,
// such as `makeFakeProvider`, which take their file access when built.
export const nodeFileSystem = Effect.runSync(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
