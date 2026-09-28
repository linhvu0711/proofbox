export const shellJoin = (argv: ReadonlyArray<string>): string =>
  argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
