---
name: testing-cli-terminal-walks
description: How to record proofbox CLI UI walks in a real GUI terminal (which terminal works, sizing, and environment setup).
---

# Recording proofbox CLI terminal walks

- Run the CLI from source: `node --disable-warning=ExperimentalWarning src/main.ts <command>`; needs Node 24+ for type stripping. This requires a checkout that contains the CLI (PR #17 / `feat/6-cli-core`, or `main` once it merges).
- In every shell/terminal first run `export PATH="$HOME/.local/bin:$HOME/.local/node24/bin:$PATH"` — the default `node` on PATH may be older.
- Isolated run env: `export PROOFBOX_FAKE_ROOT="$(mktemp -d)" PROOFBOX_RUNTIME_DIR="$(mktemp -d)"` before creating sandboxes.
- Terminal choice matters: **konsole on this box has a repaint bug** — after `clear`, freshly printed lines may not render (the text is in scrollback but invisible in screenshots/recording). Use **xterm** (`sudo apt-get install -y xterm`, then `xterm -geometry 100x30 -fa Monospace -fs 12`). In konsole, `\e[8;30;100t` resizes to 100x30 if resize needed.
- Click inside the terminal window before typing — an unfocused terminal silently swallows keystrokes.
- `proofbox create --os linux --provider fake` prints `proofbox: creating fake Sandbox`, `proofbox: starting Keeper`, then `fake:` + 6 chars. `exec` propagates exit codes; bad ids and missing capabilities exit 125; double `delete` exits 0 with "already gone".
