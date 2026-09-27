# Every Provider must delete Sandboxes on its own Deadline

A Sandbox is deleted by the Provider at its Deadline, even when the Caller crashes, loses its network, or forgets. Each proofbox command pushes the Deadline ahead by the idle time (5 minutes on macOS, 15 on Linux by default, set by the Caller on create), never past the Max life of 3 hours. A Provider that cannot enforce a Deadline on its side is not accepted, because a leaked Mac costs about $3.60 to $5.40 an hour.

## Consequences

- Namespace: `nsc create --duration` and `nsc extend --ensure_minimum`. The live test deleted a 2-minute instance to the second (`docs/research/namespace-test.md`).
- Docker: a watchdog inside the container, because Docker has no Deadline of its own.
- The macOS idle time is short on purpose: starting a new Mac costs about 1 minute (about $0.06), while waiting through a 10-minute fix costs about $0.60.
