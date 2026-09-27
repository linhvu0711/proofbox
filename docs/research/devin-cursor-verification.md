# How do Devin and Cursor verify apps and make proof fast?

Date: 2026-09-27
For: proofbox v1 design grill

## Findings

### Machines

- Devin works in a cloud VM, not only a project container. Source: https://cognition.com/blog/blockdiff.
- Devin added a Linux desktop in Devin 2.2 (February 2026). Source: https://cognition.com/blog/introducing-devin-2-2.
- Devin added native Windows cloud VMs in May 2026. Source: https://cognition.com/blog/devin-is-getting-a-windows-pc.
- Devin added cloud macOS in September 2026, using ScreenCaptureKit capture and a VNC live view. Source: https://devin.ai/blog/devin-gets-a-mac.
- Cursor Cloud Agents run in isolated Ubuntu VMs; a Dockerfile can set up the environment. Source: https://cursor.com/docs/cloud-agent/setup.
- Cursor computer use on self-hosted workers supports Linux and macOS, not Windows. Source: https://cursor.com/docs/cloud-agent/self-hosted/computer-use.
- Cursor self-hosted Linux uses X11 with optional TigerVNC and XFCE. Source: https://cursor.com/docs/cloud-agent/self-hosted/computer-use.
- Neither vendor publishes a fixed desktop resolution. Source: https://cognition.com/blog/testing-development.

### How they act

- Devin's test harness uses screenshots, mouse clicks, drags, typing, key presses, scrolling, zoom, waiting, and recording. Source: https://cognition.com/blog/testing-development.
- Devin on macOS uses the accessibility tree for native UI, plus screenshots for visual checks. Source: https://devin.ai/blog/devin-gets-a-mac.
- Cursor uses a separate computer-use subagent with its own model and screen recording. Source: https://cursor.com/blog/cloud-agent-lessons.
- Cursor's parent agent can also drive the same Chrome with Playwright. Source: https://cursor.com/blog/cloud-agent-lessons.
- Cursor's Browser tool passes DOM element context. Source: https://cursor.com/docs/agent/tools/browser.

### Proof output

- Devin returns a test report with labeled screenshots, assertions, and a chaptered video. Source: https://cognition.com/blog/testing-development.
- Devin compresses idle time between actions and plays action segments at normal speed. Source: https://cognition.com/blog/testing-development.
- Devin states the expected result before it acts, to reduce after-the-fact "pass" claims. Source: https://cognition.com/blog/testing-development.
- Cursor agents produce screenshots, videos, logs, and a polished walkthrough after testing. Source: https://cursor.com/blog/agent-computer-use.

### Speed

- Devin Machine Snapshots save prepared workspace state. Source: https://cognition.com/blog/dec-24-product-update.
- Devin reported snapshot creation down from about 30 minutes to 15 seconds, and first message from about 25 to 10 seconds. Source: https://cognition.com/blog/dec-24-product-update.
- Devin saves a YAML blueprint to rebuild a configured snapshot. Source: https://cognition.com/blog/testing-development.
- Cognition engineers run 10 to 20 Devins in parallel, each with its own dev server. Source: https://cognition.com/blog/testing-development.
- Cursor `.cursor/environment.json` sets install commands, startup processes, and Dockerfile or snapshot environments. Source: https://cursor.com/docs/cloud-agent/setup.
- Cursor keeps warm copies and forks live machines, reporting up to 10x faster boot and 3x faster first token. Source: https://cursor.com/blog/builds.

### The user's own PR proof videos (checked 2026-09-27)

- Devin's video on perch #53 is an animated WebP, 960x720, 237 s, full Linux desktop with cursor, idle time kept. Source: https://github.com/linhvu0711/perch/pull/53.
- Devin's video on clocktrace #229 is H.264, 1600x1200, 24 fps, 27 s, 9.6 MB, full macOS desktop, with about 2 minutes of real time cut. Source: https://github.com/linhvu0711/clocktrace/pull/229.
- The likely-Cursor video on perch #125 is H.264, 1280x720, 12.7 s, page only, no cursor, with a caption bar of step text, driven by Playwright. Source: https://github.com/linhvu0711/perch/pull/125.

## Open

- Where Devin and Cursor run model inference relative to the VM, because neither vendor says.
- Whether Devin uses a warm-VM pool or Firecracker, because no public source confirms either.
- How Devin cuts idle time on macOS (in-guest edit or post-process), because the blog does not describe the method.
- Whether the perch #125 video is really from Cursor, because the PR does not name the tool.
