# A Keeper holds one open connection per Sandbox

Each `nsc ssh` call cost about 4 seconds in the live test, and an agent pays that on every look-decide-act step, while a Mac bills by the minute. So `create` starts a Keeper on the Caller's machine that holds one open connection to the Sandbox, and each command takes well under a second. The Sandbox id stays the source of truth: any command restarts a missing Keeper, and losing it changes nothing but speed.

## Considered options

- A fully stateless CLI that opens a new connection per command: simpler, rejected for the time and Mac minutes it wastes.
