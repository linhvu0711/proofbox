# The Caller can label a wait, never cut one

Only proofbox decides what to cut from a Proof video, and it cuts only a Still part. A Still part that a Caller action ended (a click, a key, typing, a scroll, a drag) is the Caller thinking, so it is cut with no label. A Still part that the app ended on its own, or that a Wait mark names, keeps its "» N s later" label, so a slow app or a real wait such as a scheduler stays visible. The Caller can add a reason to a wait with `mark --wait`, but nothing the Caller does removes footage. Shell commands are not in the Action log, so a Still part that one ends keeps its label. A mistake adds a label and never hides a wait.

## Considered options

- `record pause` / `record resume`: rejected. The Caller could hide a slow or broken app, and the Proof video would stop being proof.
- Label only the Still parts that a Wait mark names: rejected. A Caller that forgets the mark would make a slow app look fast.
- Label every Still part, as before: rejected. In the perch demo (https://github.com/linhvu0711/perch/pull/127) most labels were Caller thinking time and confused viewers.
