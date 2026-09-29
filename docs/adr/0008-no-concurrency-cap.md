# proofbox does not cap how many Sandboxes run at once

proofbox creates as many Sandboxes as the Caller asks for. Guards against a runaway agent (for example, stop after repeated create failures) belong in the Caller, not in the tool. The Provider's own limit is the real cap: proofbox reports Namespace's `ResourceLimitsError` in plain words ("Mac limit reached: 6 of 6 vCPU in use") instead of a raw error.
