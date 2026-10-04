import type { Transport } from "../../src/command-checks.ts";
import type { Connection } from "../../src/provider.ts";

// The connection with its transport's call replaced.
export const withCall = (
  connection: Connection,
  call: Transport["call"],
): Connection =>
  "transport" in connection
    ? { ...connection, transport: { ...connection.transport, call } }
    : connection;

// The command a transport call carries: `checksArgv` puts it after
// `sh -c <script> sh <idle> <left>`.
export const commandOf = (argv: ReadonlyArray<string>) => argv.slice(6);
