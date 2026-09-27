# How can proofbox record sharp desktop video inside a sandbox and deliver it to a GitHub PR?

Date: 2026-09-27
For: proofbox v1 design grill

## Findings

### Capture inside the guest

- On Linux X11 or Xvfb, ffmpeg `x11grab` records the display that the app runs on. Source: https://ffmpeg.org/ffmpeg-devices.html.
- `x11grab` does not record native Wayland surfaces. Source: https://ffmpeg.org/ffmpeg-devices.html.
- On Wayland, `wf-recorder` works on wlroots compositors only. Source: https://github.com/ammen99/wf-recorder.
- The Wayland ScreenCast portal can ask the user to pick a screen, which blocks unattended runs. Source: https://flatpak.github.io/xdg-desktop-portal/docs/doc-org.freedesktop.portal.ScreenCast.html.
- On Windows, ffmpeg `ddagrab` captures the modern desktop and `gdigrab` is the compatible fallback; both need a live desktop session. Source: https://ffmpeg.org/ffmpeg-devices.html.
- On macOS, ffmpeg `avfoundation`, `screencapture -v`, or a ScreenCaptureKit recorder can capture the screen. Source: https://developer.apple.com/documentation/screencapturekit.
- macOS screen capture needs TCC Screen Recording permission and a logged-in GUI session. Source: https://support.apple.com/guide/mac-help/control-access-to-screen-and-system-audio-recording-mchld6aa7d23/mac.
- Recording the guest display directly avoids VNC compression and viewer scaling. Source: https://ffmpeg.org/ffmpeg-devices.html.

### Sharpness and size

- Use libx264 with CRF 16 to 18 and preset `medium` or `slow` as a start; CRF does not fix the file size. Source: https://ffmpeg.org/ffmpeg-codecs.html.
- Deliver H.264 with `yuv420p`, because `yuv444p` plays badly in browsers. Source: https://ffmpeg.org/ffmpeg-codecs.html.
- GitHub recommends H.264 for video attachments. Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.
- Capture at native resolution, 30 fps for normal UI, 60 fps only for fast motion. Source: https://ffmpeg.org/ffmpeg-codecs.html.
- Max bitrate is file size (MB) x 8 / seconds; a 10 MB cap allows about 1.33 Mbps for 1 minute. Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.

### Post-processing

- ffmpeg `trim`, `setpts`, and `concat` cut idle time and speed up segments; `setpts` alone does not remove pauses. Source: https://ffmpeg.org/ffmpeg-filters.html.
- ffmpeg `drawtext` adds simple captions and step labels. Source: https://ffmpeg.org/ffmpeg-filters.html#drawtext.
- Remotion renders scripted, frame-exact overlays but is not a recorder. Source: https://www.remotion.dev/docs.
- ffmpeg cannot add cursor or click effects after the fact; log pointer and click coordinates during the run. Source: https://ffmpeg.org/ffmpeg-filters.html.

### Browser and terminal capture

- CDP `Page.startScreencast` sends JPEG/PNG frames that you must encode yourself, and shows only the page. Source: https://chromedevtools.github.io/devtools-protocol/tot/Page/.
- Playwright video gives no codec or CRF control. Source: https://playwright.dev/docs/videos.
- Playwright Trace Viewer is not a continuous video. Source: https://playwright.dev/docs/trace-viewer.
- VHS renders repeatable terminal demos from a `.tape` file to MP4 or GIF. Source: https://github.com/charmbracelet/vhs.

### GitHub delivery

- GitHub attachments accept MP4, MOV, and WebM. Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.
- GitHub video attachments are capped at 10 MB on Free and 100 MB on paid plans. Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.
- GitHub has no documented public API for user-attachment uploads; inline PR video needs the web UI. Source: https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files.
- The Release Assets API is a documented upload path with a larger file limit, but a link to it is not an inline player. Source: https://docs.github.com/en/rest/releases/assets.
- R2 presigned URLs expire, so they are only temporary links. Source: https://developers.cloudflare.com/r2/api/s3/presigned-urls/.

## Open

- How proofbox can put an inline video in a PR with no public upload API, because the only documented upload routes (release assets, commits, external hosts) give links, not players.
- Whether a Namespace macOS guest grants ffmpeg Screen Recording permission without a prompt, because this needs a live test.
- What CRF and resolution keep a 1 to 2 minute clip under 10 MB and still sharp, because size depends on content and needs a test encode.
