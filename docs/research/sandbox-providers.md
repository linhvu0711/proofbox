# Which cloud providers can supply API-driven Linux, Windows, and macOS sandboxes for an outside agent?

Date: 2026-09-27
For: proofbox v1 design grill

## Findings

### Cua

- Cua advertises cloud Fleets for Linux, Windows, macOS, and Android. Source: https://cua.ai/.
- Cua Linux Fleet price is $0.044625 per vCPU-hour plus $0.0223125 per GB-hour; billing granularity is not documented. Source: https://cua.ai/.
- The Python SDK is `cua-sandbox` and gives shell, file upload/download, screenshots, mouse, and keyboard. Source: https://cua.ai/docs/reference/sandbox-sdk/interfaces.
- Recursive folder upload is not clearly documented in the Cua SDK; single files and directory operations are. Source: https://cua.ai/docs/reference/sandbox-sdk/interfaces.
- The TypeScript package `@trycua/fleet` manages pools, templates, and claims only; it has no computer-control interface like the Python SDK. Source: https://cua.ai/docs/reference/sandbox-sdk/typescript.
- Cua has a CLI with screenshot, shell, mouse, keyboard, and VNC commands, plus `cua serve-mcp`. Source: https://cua.ai/docs/reference/cua-cli/cli-reference.
- `Sandbox.snapshot()` is not implemented for Fleet; reusable images must be prebuilt OCI/KubeVirt `containerDisk` artifacts in a registry. Source: https://cua.ai/docs/how-to-guides/sandbox/prepare-and-reference-a-fleet-image.
- SDK setup layers such as `run()` and `copy()` are not applied during Fleet provisioning. Source: https://cua.ai/docs/concepts/how-fleet-images-work.
- Fleet has creation-age TTL and manual claim renewal (`keep_alive()`), not an activity-reset idle timeout. Source: https://cua.ai/docs/reference/sandbox-sdk/pool.
- Pool capacity can stay billable after a claim is released. Source: https://cua.ai/docs/concepts/sandbox-lifecycle.
- The built-in Fleet Windows image is Windows Server 2022; `Image.windows("11")` is not a built-in Fleet mapping. Source: https://cua.ai/docs/reference/sandbox-sdk/runtime-support.
- `Image.macos()` is "Rejected as built-in Fleet inputs"; macOS runs only locally through Lume. Source: https://cua.ai/docs/reference/sandbox-sdk/runtime-support.
- Cua's vendor blog says Windows 11 cloud is GA at 8, 15, and 31 credits per hour (small, medium, large); credit-to-dollar rate is not stated. Source: https://github.com/trycua/cua/blob/main/blog/cloud-windows-ga-macos-preview.md.
- The same Cua blog says cloud macOS is "Invite-only. Join the waitlist". Source: https://github.com/trycua/cua/blob/main/blog/cloud-windows-ga-macos-preview.md.
- The Cua repo is MIT-licensed, with separate release streams for Driver, Sandbox, and Lume. Source: https://github.com/trycua/cua/releases.
- `cua-computer-server` can be installed in a guest and gives HTTP/WebSocket (and optional MCP) tools for input, screenshots, shell, and files. Source: https://github.com/trycua/cua/blob/main/libs/python/computer-server/README.md.

### E2B

- E2B Desktop gives a Linux desktop only, with screenshots and mouse/keyboard; no Windows or macOS guest. Source: https://github.com/e2b-dev/desktop.
- The E2B SDK gives commands, PTY, and file operations. Source: https://e2b.dev/docs/sdk-reference/js-sdk/v2.6.2/sandbox.
- E2B session length is up to 1 hour on Hobby and 24 hours on Pro. Source: https://e2b.dev/pricing.
- No first-party E2B session-to-video recording API was found. Source: https://github.com/e2b-dev/desktop.

### Daytona

- Daytona gives Linux sandboxes and Windows VMs, with computer-use screenshots, actions, shell, files, and VNC. Source: https://www.daytona.io/docs/en/computer-use/.
- Daytona documents screen recording. Source: https://www.daytona.io/docs/en/computer-use/.
- Daytona Windows computer use is early access. Source: https://www.daytona.io/dotfiles/computer-use-windows-early-access.
- Daytona `windows-small` is 1 vCPU, 4 GiB, 30 GiB, about $0.2037/hour, billed per second; the Windows version is not stated as Windows 11. Source: https://www.daytona.io/pricing.
- Daytona can make Windows snapshots from a configured sandbox, including hot snapshots. Source: https://www.daytona.io/docs/snapshots/.
- Daytona has auto-pause/auto-stop and a separate wall-clock TTL; only API or preview activity resets inactivity, a guest process alone does not. Source: https://www.daytona.io/docs/sandboxes.
- Stopped or paused Daytona sandboxes still bill for disk. Source: https://www.daytona.io/docs/billing.
- Daytona macOS goes through the separate use.computer service. Source: https://docs.use.computer/docs/quickstart.

### Modal

- Modal Sandboxes are Linux containers; a full Linux VM runtime is beta and CPU-only. Source: https://modal.com/docs/guide/vm-sandboxes.
- Modal has no first-party desktop, screenshot, VNC, or recording API. Source: https://modal.com/docs/guide/sandboxes.
- Modal sandbox maximum lifetime is 24 hours. Source: https://modal.com/docs/guide/sandbox-resources.

### Scrapybara

- Scrapybara gives Ubuntu and Windows 11 desktops; Windows is early access. Source: https://docs.scrapybara.com/windows.
- Scrapybara Windows costs 2x the base compute rate; the base dollar rate is not stated there. Source: https://docs.scrapybara.com/windows.
- Scrapybara `timeout_hours` can be set from 0.01 to 24, default 1 hour. Source: https://docs.scrapybara.com/api-reference/start.
- Scrapybara has computer-action, screenshot, and file-upload APIs; the Bash tool is Ubuntu-only. Source: https://docs.scrapybara.com/tools.
- No Scrapybara retained video-recording API was found. Source: https://docs.scrapybara.com/introduction.

### Orgo

- Orgo Linux is generally available; Windows needs a paid tier; macOS is closed beta. Source: https://www.orgo.ai/faq.
- Orgo plans start at $29/month with persistent computers, not short per-second sandboxes. Source: https://www.orgo.ai/.

### Browser-only services

- Browserbase gives hosted browser sessions with recording/replay, not OS desktops or guest shell. Source: https://www.browserbase.com/pricing.
- Steel gives managed browser sessions with recording and live view, not OS desktops or guest shell. Source: https://docs.steel.dev/.

### Other Windows providers

- AgentBay (Alibaba) Windows Computer Use API is documented for Windows Server 2022, not Windows 11. Source: https://www.alibabacloud.com/help/en/agentbay/developer-reference/computer-use-windows-server-2022.
- AgentBay compute is $0.027 per core-hour plus $0.0113 per GB-hour, billed per second. Source: https://www.alibabacloud.com/help/en/agentbay/product-overview/agentbay-billing-instructions.
- Windows 365 for Agents costs $0.40/hour in the U.S., rounded up to a full hour. Source: https://learn.microsoft.com/en-us/windows-365/agents/pricing-paygo-always-available.
- Windows 365 for Agents reclaims a session after 30 minutes with no MCP activity. Source: https://learn.microsoft.com/en-us/windows-365/agents/agent-session-lifecycle.
- Namespace Windows instances are GA on Team, Business, and Business+ plans. Source: https://namespace.so/docs/architecture/compute/windows.md.
- Windows desktop licensing is separate from Windows Server licensing (SPLA). Source: https://www.microsoft.com/licensing/guidance/SPLA.

### Self-hosted reference

- Anthropic's computer-use demo is a Docker Linux desktop with Xvfb, VNC/noVNC, and screenshots; it is a reference, not a hosted service. Source: https://github.com/anthropics/claude-quickstarts/blob/main/computer-use-demo/README.md.

## Open

- What Cua credits cost in dollars, and whether the Windows 11 product has a public lifecycle API, because the blog and the SDK matrix describe different products.
- Whether Daytona Windows is Windows 11 or Windows Server, because the docs do not say.
- Whether an in-guest ffmpeg process keeps a Daytona sandbox awake, because only API activity resets its idle timer.
- Which provider proofbox should use for Windows later, because no provider documents Windows 11, per-minute billing, shell, image restore, and in-guest recording together.
