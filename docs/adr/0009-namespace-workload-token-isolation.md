# User code must never reach the Namespace workload token

Every Namespace instance holds a workspace token in `/var/run/nsc/token.json` (readable by all users) that can create and destroy instances, open public ingress, and push to the registry. The live test showed it is valid for 24.5 hours, works from outside the instance, still works after the instance is destroyed, and cannot be revoked from the CLI. So no Work folder file, Setup script, or app process may ever read it.

- Linux: user code runs only inside the Base image container. The container cannot see the token file and cannot reach the token service at `169.254.169.42`.
- macOS: there is no container, and the Mac user has passwordless sudo, so proofbox deletes the token file and the Docker credentials before the first upload. The token service is not reachable from the Mac, even as root.

`create` checks both conditions and refuses the Sandbox when either fails, so a Namespace change cannot silently open the hole again. Details: `docs/research/namespace-test.md`.
