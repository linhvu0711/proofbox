# v1 Providers are Namespace (Linux and macOS) and Docker; Windows is not implemented

Namespace was the only service that gives disposable macOS machines per minute from a CLI, with no 24-hour minimum (https://namespace.so/docs/reference/cli/create, https://namespace.so/pricing). Docker covers Linux on any machine that runs Docker, at no cost, and runs the CI tests. Both sit behind the Provider interface, so a better platform can replace either one later. Windows stays out of v1 because no chosen Provider offers it.

## Considered options

- Cua cloud macOS: waitlist only, aimed at "fleets of thousands of macOS machines", no price (https://cua.ai/macos).
- use.computer: $1.91 an hour with a 24-hour minimum, so $45.84 per Mac at least (https://docs.use.computer/docs/quickstart).
- AWS EC2 Mac: 24-hour minimum allocation (https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html).
- MacStadium: monthly only, from $149 (https://macstadium.com/pricing).
- A Mac mini at home: $599 up front (https://www.apple.com/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/), one machine, and our own upkeep.
- Orgo (closed beta, https://www.orgo.ai/) and Orchard (alpha, keys by hand, https://orchardintel.com/docs).
- E2B and Daytona: good Linux sandboxes, no macOS guest (https://github.com/e2b-dev/desktop, https://www.daytona.io/docs/en/computer-use/).

## Consequences

- Namespace Linux runs our Base image as a Docker container on a bare Namespace host, so it reuses the Docker provider's code. A Snapshot there is an image in the workspace registry with an expiry. Each reuse pushes the expiry to at least 14 days ahead (`ContainerRegistryService.UpdateImageLifetime` with ensureMinimumRemaining 336h), so a Snapshot unused for 14 days is deleted by Namespace itself. The Base image there follows the same rule: its push sets the expiry, and every Sandbox started from it or from one of its Snapshots pushes its expiry to at least 14 days ahead. Old Base versions are not expired when a new one is pushed, because a Caller with an older proofbox may still start Sandboxes from them. Not built yet: until #107 ships, a Base image is pushed with no expiry.
- Namespace macOS has no custom images, so the Setup script runs on every Mac.
- The Developer plan allows 12 macOS vCPU (https://namespace.so/docs/architecture/compute/resource-limits.md), so a small 4x7 Mac fits at most three at once. More Macs at once need a bigger Namespace plan.
