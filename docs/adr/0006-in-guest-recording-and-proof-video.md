# Record the real desktop in the guest; build the Proof video in the Sandbox

proofbox records the whole desktop with ffmpeg inside the Sandbox (x11grab on Linux, avfoundation on macOS) and builds the Proof video there. The link to the Caller moved about 0.45 MB/s in the live test, so only the finished Proof video (about 1 MB) is downloaded, never the raw Recording (17 MB for 100 s of Retina desktop). Still parts are found by screen change, not only by the Action log, so a slow page load is kept while a frozen screen is cut. The time a `type` action ran, from its `type` line to its `typed` line in the Action log, is never cut as a Still part: one new letter changes too few pixels for the screen check to see. A Recording still needs a change the screen check saw, or no Proof video is made.

The Proof video must be easy for a person to follow. Pixel actions run at human pace (the pointer glides, typing is about 100 ms a letter, a short wait after each action), and the edit keeps a Still part under 4 s as recorded, cuts a longer one to 4 s, holds each step's last screen at least 4 s, rings each click, and keeps a caption bar for the whole step. The caption bar is drawn above the picture and the video grows taller, so it hides nothing, for web pages and desktop apps alike. The edit alone is not enough: a pointer that jumps cannot be fixed afterwards.

## Considered options

- Playwright video: rejected, it records only the page, with no codec or quality control, and it does not show desktop apps.
- Recording over VNC from outside: kept only as a fallback, it adds viewer compression and needs the Caller online for the whole Recording.
