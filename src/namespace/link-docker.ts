import type { DockerHost } from "../docker/docker-client.ts";
import { ProviderUnavailableError, type SandboxGoneError } from "../errors.ts";
import { shellJoin } from "../shell.ts";
import type { Link } from "./ssh-link.ts";

// The Docker on a Namespace host, over its link. Each call goes through
// the link's `run` and `stream`, which open the link again when it dropped;
// a reopen that finds the Sandbox deleted fails the call as gone.
export const linkDockerHost = (link: Link): DockerHost<SandboxGoneError> => ({
  provider: "namespace",
  run: (argv) => link.run(shellJoin(["docker", ...argv])),
  stream: (argv, options) =>
    link.stream(shellJoin(["docker", ...argv]), options),
  unavailable: new ProviderUnavailableError({
    provider: "namespace",
    reason: "lost the link to the Namespace host: the link was already gone",
  }),
});
