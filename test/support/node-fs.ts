import { FileSystem } from "@effect/platform";
import { NodeFileSystem } from "@effect/platform-node";
import { Effect } from "effect";

// The Node FileSystem as a value, for code that takes it as an argument, as
// the fake Provider does.
export const nodeFs = Effect.runSync(
  FileSystem.FileSystem.pipe(Effect.provide(NodeFileSystem.layer)),
);
