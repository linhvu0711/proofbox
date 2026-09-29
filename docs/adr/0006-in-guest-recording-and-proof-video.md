# Record the real desktop in the guest; build the Proof video in the Sandbox

proofbox records the whole desktop with ffmpeg inside the Sandbox (x11grab on Linux, avfoundation on macOS) and builds the Proof video there. The link to the Caller moved about 0.45 MB/s in the live test, so only the finished Proof video (about 1 MB) is downloaded, never the raw Recording (17 MB for 100 s of Retina desktop). Still parts are found by screen change, not only by the Action log, so a slow page load is kept while a frozen screen is cut.

The Proof video must be easy for a person to follow. Pixel actions run at human pace (the pointer glides, typing is about 80 ms a letter, a short wait after each action), and the edit holds each result for 2 seconds, rings each click, and keeps a caption bar for the whole step. The caption bar is drawn above the picture and the video grows taller, so it hides nothing, for web pages and desktop apps alike. The edit alone is not enough: a pointer that jumps cannot be fixed afterwards.

## Considered options

- Playwright video: rejected, it records only the page, with no codec or quality control, and it does not show desktop apps.
- Recording over VNC from outside: kept only as a fallback, it adds viewer compression and needs the Caller online for the whole Recording.
