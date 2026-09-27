# The Caller drives the Sandbox from outside; no agent runs inside

Every command (Pixel actions, shell exec, Recording, Step marks) comes from the Caller over the Provider's channel. Nothing that reasons runs in the Sandbox, so any harness, main agent or helper agent can use proofbox, and no model key ever enters a Sandbox. The Sandbox exposes Pixel actions and shell exec; the accessibility tree comes later.

## Considered options

- An agent installed in the Sandbox (the Devin and Cursor shape): rejected, it ties proofbox to one harness and puts model credentials next to untrusted app code.
