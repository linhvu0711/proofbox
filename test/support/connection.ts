import type { Transport } from "../../src/command-checks.ts";
import type { Connection } from "../../src/provider.ts";

// The connection with its transport's call replaced.
export const withCall = (
  connection: Connection,
  call: Transport["call"],
): Connection => ({
  ...connection,
  transport: { ...connection.transport, call },
});

// The command a transport call carries: the command run puts it after
// `sh -c <script> sh <idle> <left>`.
export const commandOf = (argv: ReadonlyArray<string>) => argv.slice(6);
