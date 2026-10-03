import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "test/**/*.docker.test.ts",
      "test/**/*.namespace.test.ts",
    ],
    // Many tests start CLI processes, and when the full suite runs on all
    // cores these run 2 to 3 times slower; the limit catches a hang, not a
    // busy machine.
    testTimeout: 60_000,
  },
});
