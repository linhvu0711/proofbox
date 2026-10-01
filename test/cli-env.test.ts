import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { cleanupEnvs, makeEnv } from "./support/cli.ts";

describe("cli env", () => {
  afterEach(cleanupEnvs);

  it("a plain env has its own empty HOME", () => {
    // Given
    const env = makeEnv();
    // When
    const home = env.env.HOME;
    // Then
    expect({
      set: home !== undefined,
      developers: home === process.env.HOME,
      files: home === undefined ? undefined : readdirSync(home),
    }).toEqual({ set: true, developers: false, files: [] });
  });

  it("a namespace env and a docker env keep the real HOME", () => {
    // Given
    const namespace = makeEnv({ namespace: true });
    const docker = makeEnv({ docker: true });
    // When
    const homes = [namespace.env.HOME, docker.env.HOME];
    // Then
    expect(homes).toEqual([undefined, undefined]);
  });
});
