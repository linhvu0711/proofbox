import { fileURLToPath } from "node:url";

export const entryPath = (rel: string) =>
  fileURLToPath(
    import.meta.url.endsWith(".ts")
      ? new URL(`${rel}.ts`, import.meta.url)
      : new URL(`${rel}.js`, import.meta.url),
  );
