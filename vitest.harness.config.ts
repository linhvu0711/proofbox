import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.harness.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    fileParallelism: false,
    globalSetup: ["test/support/docker-image.ts"],
  },
});
