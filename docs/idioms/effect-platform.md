<!-- embed-source: effect@3.22.2 -->
# Effect platform and CLI

How to parse the command line (`@effect/cli`), run a child process and read its output and exit code (`@effect/platform` `Command`), and talk over a unix socket (`NodeSocketServer`, `NodeSocket`). Reach for this for the proofbox commands, `exec` in a Sandbox, and the Keeper.

## Constructors

| name | purpose | defined in |
| --- | --- | --- |
| `Command.make` (cli) | a command with options, args, and a handler | `repos/effect/packages/cli/src/Command.ts` |
| `Command.withSubcommands`, `Command.run` | the command tree, and the runner that takes `process.argv` | `repos/effect/packages/cli/src/Command.ts` |
| `Options.choice`, `Options.text`, `Options.boolean`, `Options.optional` | flags | `repos/effect/packages/cli/src/Options.ts` |
| `Args.text`, `Args.repeated`, `Args.atLeast` | positional args, variadic tails | `repos/effect/packages/cli/src/Args.ts` |
| `Command.make` (platform) | a child process: program and args | `repos/effect/packages/platform/src/Command.ts` |
| `Command.workingDirectory`, `Command.start`, `Command.exitCode`, `Command.string` | set cwd, start with a `Process` handle, run for the code or the text | `repos/effect/packages/platform/src/Command.ts` |
| `NodeSocketServer.make` | a socket server; takes Node `ListenOptions`, so `{ path }` is a unix socket | `repos/effect/packages/platform-node-shared/src/NodeSocketServer.ts:34` |
| `NodeSocket.makeNet` | a socket client; takes Node `NetConnectOpts`, so `{ path }` is a unix socket | `repos/effect/packages/platform-node-shared/src/NodeSocket.ts:38` |

## Shapes this project uses

A command tree with a flag, a positional arg, and subcommands:

```ts
// from repos/effect/packages/cli/test/Command.test.ts
const clone = Command.make("clone", {
  repository: Args.text({ name: "repository" })
}, ({ repository }) =>
  Effect.gen(function*() {
    const { log } = yield* Messages
    const { verbose } = yield* git
    yield* log(verbose ? `Cloning ${repository}` : "Cloning")
  }))

const run = git.pipe(
  Command.withSubcommands([clone, add]),
  Command.run({ name: "git", version: "1.0.0" })
)
```

Everything after `--` lands in a variadic arg, flags included:

```ts
// from repos/effect/packages/cli/test/CommandDescriptor.test.ts
const command = Descriptor.make(
  "cmd",
  Options.all([
    Options.optional(Options.text("something")),
    Options.boolean("verbose").pipe(Options.withAlias("v"))
  ]),
  Args.repeated(Args.text())
)
// ["cmd", "-v", "--", "--something", "abc", "something"]
// parses to options [Option.none(), true],
// args ["--something", "abc", "something"]
```

A non-zero exit is a value, not a failure; a spawn error is a typed `SystemError`:

```ts
// from repos/effect/packages/platform-node-shared/test/CommandExecutor.test.ts
const command = pipe(
  Command.make("./non-zero-exit.sh"),
  Command.workingDirectory(path.join(...TEST_BASH_SCRIPTS_PATH))
)
const result = yield* Command.exitCode(command)
expect(result).toBe(1)
```

A running process, inside a scope, with its exit code read once it ends:

```ts
// from repos/effect/packages/platform-node-shared/test/CommandExecutor.test.ts
Effect.gen(function*() {
  const command = Command.make("echo", "-n", "test")
  const process = yield* Command.start(command)
  const code = yield* process.exitCode
  expect(code).toEqual(0)
}).pipe(Effect.scoped)
```

A socket server that answers each client, and a client that connects to it:

```ts
// from repos/effect/packages/platform-node/test/Socket.test.ts
const server = yield* NodeSocketServer.make({ port: 0 })

yield* server.run(Effect.fnUntraced(function*(socket) {
  const write = yield* socket.writer
  yield* socket.run(write)
}, Effect.scoped)).pipe(Effect.forkScoped)

const channel = NodeSocket.makeNetChannel({
  port: (server.address as SocketServer.TcpAddress).port
})
```

For a unix socket, pass `{ path: "<file>.sock" }` in place of `{ port }` on both sides.

## Mistakes to avoid

- Wrong: `import { Command } from "@effect/cli"` and `import { Command } from "@effect/platform"` in one file. Right: keep the CLI tree and the child-process code in separate files, or import one side as a namespace (`import * as CliCommand from "@effect/cli/Command"`).
- Wrong: treating a non-zero exit as an error channel value. Right: read `process.exitCode` (or `Command.exitCode`) and branch on the number; only spawn and I/O problems fail the effect.
- Wrong: reading `process.stdout` to the end before `process.stderr` (a full stderr pipe blocks the child). Right: drain both streams at the same time (`Stream.merge`, or two forked fibers), then read `exitCode`.
- Wrong: `Command.start` outside a scope. Right: `Effect.scoped` around it; the scope kills the child when it closes.
- Wrong: expecting `Command` to spawn a detached process that outlives the parent. It has no `detached` option. Right: `node:child_process` `spawn(..., { detached: true, stdio: "ignore" }).unref()` wrapped in `Effect.try`.
