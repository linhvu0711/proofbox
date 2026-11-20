import { symlinkSync } from "node:fs";
import { Server } from "node:net";

// Loaded through NODE_OPTIONS into every process a test CLI starts; only
// the Keeper is changed. Its socket path becomes a link to itself, so a
// client's connect fails at once with ELOOP; proofbox then starts a new
// Keeper, which leaves the same link and exits, so the command runs
// without one (src/keeper/keeper-client.ts). The exit skips the Keeper's
// own cleanup, which would remove that link.
if (process.argv[1]?.endsWith("keeper-main.ts")) {
  Server.prototype.listen = (...args: unknown[]): never => {
    const path = args[0];
    if (typeof path === "string") symlinkSync(path, path);
    process.exit(1);
  };
}
