import { fileURLToPath } from "node:url";

export const entryPath = (rel: string) =>
  fileURLToPath(
    import.meta.url.endsWith(".ts")
      ? new URL(`${rel}.ts`, import.meta.url)
      : new URL(`${rel}.js`, import.meta.url),
  );

// src/entry.ts, and the dist/ file the build puts it in, both sit one folder
// below the package root (scripts/build.ts checks this).
export const packagePath = (rel: string) =>
  fileURLToPath(new URL(`../${rel}`, import.meta.url));
