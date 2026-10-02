# The Keeper does each command's checks in one trip

A warm `exec` takes about 2.2 s, not the "well under a second" that ADR 0010 promises, because the CLI makes six remote calls in a row around the command: two Sandbox reads, two Deadline pushes, and two memory-kill counts. The CLI starts fresh on every run, so it cannot remember anything between commands. The Keeper stays up, so it can. So we decided that the Keeper does these checks for every request it runs. It keeps the Sandbox info it read when it connected, and it already watches whether the Sandbox is gone, so neither needs a new call. It pushes the Deadline while the command runs, and it pushes the host's own lifetime itself, with no detached process. It reads the memory-kill count before and after the command in the same remote call, and sends the counts back in the End line, with the command's exit code and how many bytes of stdout it made. The Keeper strips the End line before the Caller sees the output. A warm command then costs one remote call.

## Considered options

- The Keeper pushes the Deadline on its own timer: rejected. A Sandbox that nobody uses would never reach its Deadline, and the idle time would mean nothing.
- Keep the checks in the CLI and only run them at the same time: rejected. Three calls in a row stay, and with Node startup that is still about 1.25 s.
