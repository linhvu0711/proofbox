import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    exclude: [
      ...configDefaults.exclude,
      "test/**/*.docker.test.ts",
      "test/**/*.namespace.test.ts",
    ],
    // Many tests start CLI processes. On all cores, or with two suites at
    // once, the machine overloads and these run several times slower. Half
    // the cores keeps a busy machine usable, and the limit catches a hang,
    // not a busy machine.
    testTimeout: 60_000,
    maxWorkers: "50%",
  },
});
