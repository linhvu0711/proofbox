# Where can proofbox get disposable macOS machines without buying hardware or a 24-hour minimum?

Date: 2026-09-27
For: proofbox v1 design grill

## Findings

### Namespace (best fit)

- Namespace creates, destroys, and extends macOS instances from the `nsc` CLI and API, pay-as-you-go, with no 24-hour reservation. Source: https://namespace.so/docs/reference/cli/create.
- Namespace macOS costs $0.04/min (4 vCPU, 7 GB) to $0.20/min (16 vCPU, 56 GB). Source: https://namespace.so/pricing.
- Namespace macOS gives SSH, VNC, command execution, and file upload/download. Source: https://namespace.so/docs/reference/cli/vnc.
- Namespace macOS runs from a Namespace-managed base image where you pick the macOS and Xcode version; custom Dockerfile images are Linux only. Source: https://namespace.so/docs/devbox/images.md.

### Cua (waitlist only)

- The only CTA on Cua's macOS page is "Join the partnership waitlist", aimed at "companies that need fleets of thousands of macOS machines". Source: https://cua.ai/macos.
- Cua says joining the waitlist "does not create a purchase commitment or promise an onboarding date", and shows no price. Source: https://cua.ai/macos.
- Cua's vendor blog calls cloud macOS "Invite-only. Join the waitlist". Source: https://github.com/trycua/cua/blob/main/blog/cloud-windows-ga-macos-preview.md.
- Cua's SDK rejects `Image.macos()` as a built-in Fleet input; macOS runs only locally through Lume. Source: https://cua.ai/docs/reference/sandbox-sdk/runtime-support.

### Options with a 24-hour minimum

- use.computer bills $1.91/hour per Mac with a 24-hour minimum, so $45.84 per Mac at least. Source: https://docs.use.computer/docs/quickstart.
- use.computer has the richest documented API: shell, files, screenshots, mouse/keyboard, VNC, recordings, and snapshots. Source: https://docs.use.computer/docs/sdk.
- AWS EC2 Mac Dedicated Hosts have a 24-hour minimum allocation. Source: https://docs.aws.amazon.com/AWSEC2/latest/UserGuide/ec2-mac-instances.html.
- Scaleway Apple Silicon Macs have a mandatory 24-hour minimum; M4-S is €0.22/hour or €149/month. Source: https://www.scaleway.com/en/docs/apple-silicon/faq/.
- Apple's license does not state a universal 24-hour minimum; the 24-hour rule is a provider rule. Source: https://www.apple.com/legal/sla/docs/macOSMonterey.pdf.

### Alpha, beta, and monthly options

- Orchard Intel sells API sessions at $0.60/hour, billed per second, with video stream and mouse/keyboard endpoints. Source: https://orchardintel.com/.
- Orchard Intel is alpha, keys are issued by hand, and it uses a shared Darwin kernel, not a full VM; no shell or file transfer is documented. Source: https://orchardintel.com/docs.
- Orgo macOS is closed beta. Source: https://www.orgo.ai/.
- MacStadium rents an M4 16 GB/256 GB for $149/month and an M4 24 GB/512 GB for $249/month; no 24-hour plan. Source: https://macstadium.com/pricing.
- MacinCloud needs a prepaid 25-hour credit and has no public provisioning API. Source: https://www.macincloud.com/pages/payg.html.

### CI runners (jobs, not sandboxes)

- GitHub-hosted macOS runners start jobs, not user-managed VMs, with a 6-hour job maximum. Source: https://docs.github.com/en/enterprise-cloud%40latest/actions/reference/limits.
- GitHub macOS larger runners do not support custom images. Source: https://docs.github.com/en/actions/concepts/runners/larger-runners.
- Codemagic bills $0.095/min (M2) and $0.114/min (M4) per build, with temporary SSH and VNC to a running build. Source: https://docs.codemagic.io/billing/pricing/.
- Depot, WarpBuild, and Blacksmith sell macOS CI runners at about $0.08/min; they are not interactive VM APIs. Source: https://www.blacksmith.sh/pricing.

### Owning hardware

- Lume runs macOS VMs on Apple Silicon, up to two at once per host. Source: https://cua.ai/docs/reference/lume/limits.
- Apple's Sequoia license allows two extra virtual macOS copies per Mac for uses such as development and testing, and restricts service-bureau use. Source: https://www.apple.com/legal/sla/docs/macOSSequoia.pdf.
- Lume's HTTP API is local by default; reach it over an SSH tunnel. Source: https://cua.ai/docs/how-to-guides/lume/serve-api.
- The Mac mini M4 base launched at $599 (16 GB/256 GB). Source: https://www.apple.com/newsroom/2024/10/apples-new-mac-mini-is-more-mighty-more-mini-and-built-for-apple-intelligence/.
- Apple lists the Mac mini M4 24 GB/512 GB at $899 in its U.S. education price list. Source: https://www.apple.com/education/pricelists/pdfs/Apple_US_Education_Institution_Price_List.pdf.
- The user's Hostinger VPS (Ubuntu 24.04, 2 vCPU, 7.8 GB RAM) has no /dev/kvm, so it cannot run nested VMs; Docker works. Source: checked directly on the VPS, 2026-09-27.

### Screen-recording permission (TCC)

- No provider promises that macOS Screen Recording (TCC) permission is pre-granted. Source: https://namespace.so/docs/architecture/compute/macos.
- Apple grants screen capture without a prompt only through a `ScreenCapture` PPPC profile deployed by user-approved MDM. Source: https://developer.apple.com/documentation/devicemanagement/privacypreferencespolicycontrol.

## Open

- Whether a fresh Namespace macOS instance lets ffmpeg or `screencapture` record the screen without a TCC prompt, because no doc says so and only a live test can tell.
- Whether Namespace can boot a new macOS instance from a customized snapshot, because the docs only show managed base images.
- When Cua cloud macOS will open to small users, because the waitlist promises no date.
