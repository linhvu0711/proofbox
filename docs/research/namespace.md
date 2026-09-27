# What does Namespace offer proofbox?

Date: 2026-09-27
For: proofbox v1 design grill

## Findings

### Lifecycle and access

- `nsc create` creates an instance and the CLI/API can destroy it. Source: https://namespace.so/docs/reference/cli/create.
- Instance duration is limited, and `nsc extend` moves the deadline forward. Source: https://namespace.so/docs/reference/cli/extend.
- `nsc vnc` opens a VNC view of the instance. Source: https://namespace.so/docs/reference/cli/vnc.
- The CLI gives SSH, command execution, and file upload/download. Source: https://namespace.so/docs/llms.txt.
- Windows instances are reached with `nsc rdp`. Source: https://namespace.so/docs/architecture/compute/windows.md.

### Operating systems

- Namespace offers macOS instances with selectable macOS and Xcode versions. Source: https://namespace.so/docs/architecture/compute/macos.
- Windows instances are GA on Team, Business, and Business+ plans; the Windows version is not stated. Source: https://namespace.so/docs/architecture/compute/windows.md.

### Images

- Custom images are built from Dockerfiles and apply to Linux Devboxes only. Source: https://namespace.so/docs/devbox/images.md.
- "macOS Devboxes run from a Namespace-managed base image, where you select the macOS and Xcode version instead." Source: https://namespace.so/docs/devbox/images.md.
- The images page shows no option to snapshot a running machine into an image. Source: https://namespace.so/docs/devbox/images.md.

### Limits

- Developer plan concurrency is 32 vCPU / 64 GB for Linux. Source: https://namespace.so/docs/architecture/compute/resource-limits.md.
- Developer plan concurrency is 12 vCPU / 28 GB for macOS. Source: https://namespace.so/docs/architecture/compute/resource-limits.md.
- Windows is not available on Developer; Team gets 32 vCPU / 64 GB. Source: https://namespace.so/docs/architecture/compute/resource-limits.md.
- The resource-limits page documents no maximum instance duration. Source: https://namespace.so/docs/architecture/compute/resource-limits.md.

### Pricing

- The Developer plan is free and pay-as-you-go. Source: https://namespace.so/pricing.
- The Team plan is $100/month with 100,000 unit minutes. Source: https://namespace.so/pricing.
- The Business plan is $250/month. Source: https://namespace.so/pricing.
- Linux costs $0.001/min for 1 vCPU / 2 GB prepaid, and $0.0015/min as overage. Source: https://namespace.so/pricing.
- macOS costs $0.04 to $0.20 per minute. Source: https://namespace.so/pricing.
- Windows costs $0.002 to $0.512 per minute and is included from the Team plan. Source: https://namespace.so/pricing.
- The pricing page describes a 10x compute-unit multiplier for macOS. Source: https://namespace.so/pricing.
- Namespace has a 30-day free trial. Source: https://namespace.so/pricing.

### Gaps

- Namespace does not document automatic screen recording or a pre-granted macOS Screen Recording (TCC) permission. Source: https://namespace.so/docs/architecture/compute/macos.

## Open

- What the maximum instance lifetime is per plan, because the resource-limits page does not say and the extend page only says it is plan-limited.
- What a macOS minute really costs on the Developer plan, because the 10x unit multiplier and the per-minute rate card need a real bill to confirm.
- How long a macOS instance takes to boot, because no boot-time figure is published.
- Whether ffmpeg or `screencapture` can record the macOS screen with no TCC prompt, because this needs a live test.
- Which Windows version Namespace runs, because the Windows page does not state it.
