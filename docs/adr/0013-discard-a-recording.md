# A failed Recording can be discarded; it never becomes proof

`record stop --discard` ends a Recording without making a Proof video. The raw Recording and the app logs stay in the Sandbox until it is deleted, so the Caller can still debug the failure. So a Caller can record every attempt and keep only the first one that passes. A second, clean recording pass is not needed, and it would cost one more run of Sandbox minutes (Mac minutes are the costly ones). Human pace and the Still part cut keep a first-try video easy to follow, even where the Caller paused to think.

## Considered options

- Record only in a separate pass after every check passes: a fully planned run on video, but one more run of Sandbox time per video.
