import { Effect } from "effect";
import type { DockerHost } from "../docker/docker-client.ts";
import { ProviderError, ProviderUnavailableError } from "../errors.ts";
import { shellJoin } from "../shell.ts";
import type { Link } from "./ssh-link.ts";

// The Docker on a Namespace host, over its link. Each call goes through
// the link's `run` and `stream`, which open the link again when it dropped.
export const linkDockerHost = (link: Link): DockerHost => ({
  provider: "namespace",
  run: (argv) =>
    link
      .run(shellJoin(["docker", ...argv]))
      .pipe(
        Effect.catchTag("SandboxGoneError", (error) =>
          Effect.fail(
            new ProviderError({ provider: "namespace", reason: error.message }),
          ),
        ),
      ),
  stream: (argv, options) =>
    link.stream(shellJoin(["docker", ...argv]), options),
  unavailable: new ProviderUnavailableError({
    provider: "namespace",
    reason: "lost the link to the Namespace host: the link was already gone",
  }),
});
