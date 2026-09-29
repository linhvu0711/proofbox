# proofbox leaves no trace in the repos it checks

No config file, script, or marker for proofbox lives in a checked repo. The Caller passes the Setup script (`--setup <file>`) and the env file (`--env-file <file>`) from wherever it keeps them, and proofbox's own config lives in `~/.config/proofbox/`. We rejected a `.proofbox/` folder in each repo (the Cursor `environment.json` shape) because a tool that checks a codebase must not leave its trace there.
