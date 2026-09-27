# Code is built on the Mac; the VPS is out for now

The first brief asked to move building and checking off the Mac. Only checking moves: every project is still built in worktrees on the Mac, and the VPS (2 vCPU, 7 GB RAM, no Docker) plays no part. The user has not hit a bottleneck building locally yet, the Mac is where clocktrace's Swift helper can be built and tested, and the RAM problem came from local UI checks, which now run on Namespace. Revisit this when local builds become the bottleneck.

## Considered options

- A Dev home per project (perch on the VPS, clocktrace on the Mac): chosen first, then dropped when the user took the VPS out of scope.
- Everything on the VPS, with macOS builds and Swift tests in a Mac Sandbox: every Swift test run would cost Mac minutes and an upload.

## Consequences

- ADR 0004 names Docker for "Linux on the laptop or the VPS". Linux checks now run on Namespace, so the Mac's RAM stays free, and the Docker provider is used for proofbox's own CI tests.
