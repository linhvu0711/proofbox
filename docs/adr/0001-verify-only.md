# proofbox verifies; it does not write code

Superseded by ADR 0023.

proofbox only rents a Sandbox, runs the app, drives its screen, and brings back proof. Writing code stays wherever the Caller already works (a laptop, a server, any harness). We rejected a Devin-style "whole session in the cloud" tool because it duplicates the harness, needs the model and the repo credentials inside the Sandbox, and bills Sandbox minutes while the model thinks about code.
