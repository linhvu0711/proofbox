import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// An `ssh` whose ControlMaster the test can drop. Files in `dir` steer it:
// `alive` is the master's socket, so `-O check` answers 0 only while it
// exists; `refuse` makes a new master fail as an unreachable gateway does;
// `hold` makes a new master wait for `go` before it comes up; `cut` makes
// every command exit 255, as a mux client does when its master dies.
export const fakeSshMaster = (dir: string) => {
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  const path = join(binDir, "ssh");
  const log = join(dir, "ssh.log");
  writeFileSync(
    path,
    `#!/bin/sh
d='${dir}'
printf '%s\\n' "$*" >> "$d/ssh.log"
case " $* " in
  *" -O check "*) test -e "$d/alive"; exit $? ;;
  *" -O exit "*) rm -f "$d/alive"; exit 0 ;;
  *" -M "*)
    if [ -e "$d/refuse" ]; then
      echo 'ssh: connect to host ssh.iad4.namespace.so port 22: Operation timed out' >&2
      exit 255
    fi
    if [ -e "$d/hold" ]; then
      while [ ! -e "$d/go" ]; do sleep 0.05; done
    fi
    touch "$d/alive"
    exec sleep 600 ;;
esac
if [ -e "$d/cut" ]; then exit 255; fi
echo ok
`,
    { mode: 0o755 },
  );
  const lines = () => {
    try {
      return readFileSync(log, "utf8").split("\n");
    } catch {
      return [];
    }
  };
  return {
    binDir,
    path,
    log,
    masterStarts: () => lines().filter((line) => line.startsWith("-M ")).length,
    plainCalls: () =>
      lines().filter(
        (line) =>
          line !== "" && !line.startsWith("-M ") && !line.includes(" -O "),
      ).length,
  };
};
