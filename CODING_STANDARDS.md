# Coding standards

One rule per line. A rule from a source names the source in parentheses, from the Sources table at the end. A rule a tool checks names the tool in brackets. Effect examples and the full list of Effect mistakes, with paths into the library source, are in `docs/idioms/effect-*.md`. `/embed-source` owns those files, so they stay there. This file holds only the Effect rules this project settled. Words are in `CONTEXT.md`, and decisions are in `docs/adr/`.

## Names

- Files are `kebab-case`. [biome useFilenamingConvention]
- Types, classes, and schemas are `PascalCase`. Functions and values are `camelCase`. Module-level constants can be `CONSTANT_CASE`. (ts-guidelines) [biome useNamingConvention]
- Static layers on a service class are `PascalCase`: `Default`, `Test`, `Direct`. [biome useNamingConvention]
- Service ids are `"proofbox/<ClassName>"`.
- Env vars are `PROOFBOX_<NAME>`.
- Swift types are `UpperCamelCase`. Swift functions, values, and enum cases are `lowerCamelCase`. (swift-api-guidelines)

## Layout

- A command's handler goes in `src/commands/<command>.ts`. Its args and options are in `src/cli.ts`.
  `src/main.ts` calls the `exec` handler without the parser, so a handler never imports `@effect/cli`.
- A subsystem with more than one file gets its own folder, like `src/keeper/` and `src/fake/`.
- The entry file of a process that proofbox spawns is `<name>-main.ts`. `pnpm build` bundles each one as its own entry, `dist/<path>-main.js`.
- A Provider's code loads only when a command asks for it: `src/provider-registry.ts` imports it inside the entry's `load`, never at the top.
- An expected-failure class that leaves its file is in `src/errors.ts`. A private one that only its own file uses stays in that file.
  An example is `LinkDownError` in `src/namespace/ssh-link.ts`, which only tells the retry loop to try again.
- Relative imports end in `.ts`. (node-typescript)
  Node runs `src/` directly with type stripping, so a `.js` path fails at run time. The CLI tests catch it.
- Type-only imports use `import type`, or `type` inside the braces. (node-typescript) [biome useImportType, tsc verbatimModuleSyntax]
- Node built-ins are imported with the `node:` prefix. (node-esm) [biome useNodejsImportProtocol]

## Errors

- An expected failure is a `Data.TaggedError` class in the `E` channel. (effect-errors)
- `Effect.die` is only for "cannot happen". (effect-unexpected-errors)
- Code never throws inside an effect. A call that can throw runs in `Effect.try` or `Effect.tryPromise`, with a `catch` that maps to a tagged error. (effect-creating)
  A throw becomes a defect, and `catchTag`, `catchAll`, and `Effect.option` do not see it.
- A Promise that can reject runs in `Effect.tryPromise`, never in `Effect.promise`. (effect-creating)
  `Effect.promise` turns a rejection into a defect.

## Logging and output

- All output goes through the `CliOutput` service. [biome noConsole, in `src/`]
- stdout carries only the result: an id, a list, or `--json`. Progress and messages go to stderr.
  An agent reads stdout as data, so one stray line breaks it.
- The Keeper writes its log only through `writeKeeperLog` in `src/keeper/keeper-log.ts`: one line per request, never argv past the program name, never stdin or output (ADR 0019). There is no log library.

## Tests

- Tests use Vitest and live in `test/<module>.test.ts`. [vitest include]
- Each user-visible behavior of a command has a test that runs the real CLI on the fake Provider through `test/support/cli.ts`.
  This tests from the outside, as the Caller uses proofbox (ADR 0002).
- A command that needs a desktop is tested on Docker, in `test/<module>.docker.test.ts`. On the fake Provider, which has no desktop, a test checks that proofbox refuses the command.
  A fake desktop would test a copy that can differ from the real one.
- Effect code with no CLI is tested with `it.effect` from `@effect/vitest`, never with `Effect.runPromise` inside a plain `it`. (effect-vitest)
- A test name says the behavior in plain words: `"exec passes stdout, stderr, and exit code unchanged"`.
- A test sets its config with `ConfigProvider`, with env vars on the child process, or with a dependency it passes in. It never changes `process.env`, not even `PATH`. (effect-config, vitest-vi)
  A change to `process.env` leaks into every other test in the same process.

## Commits

- Commit messages follow Conventional Commits: `type(scope): intent`, where the scope is optional. (conventional-commits, commitlint-conventional) [commitlint, in CI on each PR]
- Branches are `type/slug`, for example `feat/6-cli-core`. This holds for bots too: a Devin handoff names the branch.
- One PR is one reviewable change.

## Deps

- `pnpm` is the only package manager. [package.json packageManager]
- pnpm is on a major version that still gets security fixes. (pnpm-security)
- A dependency's install script runs only when `allowBuilds` lists it. (pnpm-supply-chain)
  An install script runs code from the package on the machine that installs it.
- Every version is pinned exact. [pnpm-workspace.yaml saveExact]
- `pnpm-lock.yaml` is committed, and CI installs with `--frozen-lockfile`. (pnpm-install) [ci]
- After a bump of `effect`, run `/embed-source update effect`.
- Import from the installed package, never from `repos/`.
- A GitHub Action is pinned by its full commit SHA, with the version in a comment: `uses: actions/checkout@<sha> # v7`. (gh-actions-hardening)
  A tag can be moved to new code. A SHA cannot.
- Each workflow sets `permissions: contents: read`. A job that needs more asks for it in its own `permissions`. (gh-actions-hardening)

## Config and secrets

- Settings come from `Config`, never from `process.env` in `src/`. (biome-no-process-env) [biome noProcessEnv, in `src/`]
- A secret is read with `Config.redacted`. (effect-config)
- A secret never goes to stdout, stderr, or a file in the Work folder. (owasp-secrets)
  A Sandbox runs user code, and ADR 0009 shows what a leaked token can do.
- No `.env` file and no secret goes into git.
- proofbox's own config lives in `~/.config/proofbox/`, never in a checked repo (ADR 0007).

## API shape

- `exec` passes the exit code of the Sandbox command through unchanged.
- A proofbox failure exits `125`, with one plain line on stderr for each thing that failed. (node-process)
  Node keeps 1, 3 to 14, and codes above 128 for its own failures, so 125 does not clash.
- A command that runs out of memory exits `122`, with a message that names the Sandbox size and the next size up.
- An error message says what went wrong and what to do next, for example `Sandbox ran out of memory (4x8). Try --size 8x16.`

## Formatting

- Biome formats all code: 2 spaces, 80 columns, double quotes, semicolons, trailing commas. (biome-config) [biome]
- Imports are sorted. (biome-organize-imports) [biome organizeImports]
- Files are UTF-8 with LF line ends and a final newline. [editorconfig]

## Stack-specific

### TypeScript and Node

- Node is 24.12 or newer. (node-typescript) [package.json engines]
  proofbox runs `.ts` files directly, and type stripping is stable from Node 24.12.
- TypeScript runs with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. (ts-tsconfig, node-typescript) [tsc]
- No `enum` and no `namespace`. (node-typescript) [tsc erasableSyntaxOnly]
- No `any`. [biome noExplicitAny]
- A caught value is `unknown`, and code narrows it before it reads it. (ts-tsconfig) [tsc useUnknownInCatchVariables]
- `as` is used only after a check proves the type, as after a regex match. (ts-handbook)
- `as` can bridge a wrong type in a library, with a comment on that line that names the gap.
- `as unknown` is always allowed, as in `JSON.parse(text) as unknown`.
  It widens the type, so it cannot hide a wrong type.
- Fields and service shapes are `readonly`.

### Effect

- A top-level function or a service method that returns an effect is `Effect.fn("<Service or module>.<function>")`, for example `Effect.fn("KeeperClient.start")`. This holds for a plain function body too, not only a generator. (effect-fn)
  It gives each call a trace span and a stack trace that points to where the function is defined.
- A small helper inside one function body can stay a plain function.
  It runs inside the span of the function around it, so its own span adds nothing.
- An effect written once, inside other code, is `Effect.gen`. (effect-gen)
- A combinator gets a lambda, never a bare function name: `Effect.map((value) => Option.some(value))`, not `Effect.map(Option.some)`. (effect-guidelines)
  A bare name can lose generic types and makes stack traces less clear.
- Code tells one failure from another by `instanceof` or `_tag`, never by `===` against a saved error.
  Inside a span, as in an `Effect.fn`, `Effect.fail` hands on a Proxy of the error, so `===` is false.
- A service with code is `Effect.Service<Self>()("proofbox/Name", …)`. A service that is a plain value is a `Context.Tag`. (effect-services)
- Data that crosses an edge (JSON on disk, a Keeper frame, CLI input) is a `Schema`. Its type comes from the schema, never from a second `interface`. (effect-schema)
- A count or a duration in a schema is `Schema.Number.pipe(Schema.int(), Schema.positive())`, or `Schema.nonNegative()` when zero is valid.

### Effect platform

- A child process runs through `Command` from `@effect/platform`. (platform-command)
- `node:child_process` is only for a job `Command` cannot do, such as a detached spawn, with a comment that says why.
- A non-zero exit of a child process is a value from `Command.exitCode`, not an error. (platform-command)
- File access goes through `FileSystem` from `@effect/platform`, never `node:fs`.
  Its failures come as a `SystemError` with a `reason`, so no code reads raw Node error codes such as `ENOENT`.
- A platform error is matched by `_tag` and `reason`, never by its message. (platform-error)
- `NodeContext.layer` is provided only in the entry file of a process: `src/main.ts` and each `-main.ts` file. (platform-node-context)

### Shell scripts

- A shell script starts with `set -eu`. A bash script also sets `-o pipefail`. (bash-set)
  `-e` stops at a failed command, `-u` stops at an unset variable, and `pipefail` stops at a failed command inside a pipe.
- A script that must keep going after an error leaves out `-e` and says why in a comment, as `scripts/sync-repos.sh` does.
- Shell scripts pass ShellCheck.

### Linux image

- The base image in `images/linux/Dockerfile` is pinned by digest: `FROM <image>:<tag>@sha256:<digest>`. (docker-best-practices)
  The base image version is a hash of the files in `images/linux/`, so only a pinned `FROM` makes a new Debian a new version.
- User code runs as `app`. Only `init.sh` runs as root, to set up the Sandbox and watch the Deadline. (docker-best-practices)

## Not covered

- HTTP API shape: proofbox has no HTTP API. Its API is the CLI, under "API shape".
- Log library: none. The Keeper log is one hand-written file (see Logging and output).
- `.dockerignore`: the build folder holds only the files the image needs, so there is nothing to keep out.
- Swift formatter: there is one Swift file, and CI has no Swift toolchain.

## Sources

| Part | Name | Link | Version | Checked |
|---|---|---|---|---|
| typescript | ts-tsconfig | https://www.typescriptlang.org/tsconfig/ | 7.0 | 2026-10-01 |
| typescript | ts-handbook | https://www.typescriptlang.org/docs/handbook/2/everyday-types.html | - | 2026-10-01 |
| typescript | ts-guidelines | https://github.com/microsoft/TypeScript/wiki/Coding-guidelines | - | 2026-10-01 |
| typescript | ts-7 | https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/ | 7.0 | 2026-10-01 |
| node | node-typescript | https://nodejs.org/docs/latest-v24.x/api/typescript.html | 24 | 2026-10-01 |
| node | node-esm | https://nodejs.org/docs/latest-v24.x/api/esm.html | 24 | 2026-10-01 |
| node | node-process | https://nodejs.org/docs/latest-v24.x/api/process.html#exit-codes | 24 | 2026-10-01 |
| node | node-security | https://nodejs.org/en/learn/getting-started/security-best-practices | - | 2026-10-01 |
| effect | effect-errors | https://effect.website/docs/v3/error-management/expected-errors | 3.x | 2026-10-01 |
| effect | effect-unexpected-errors | https://effect.website/docs/error-management/unexpected-errors/ | 3.x | 2026-10-01 |
| effect | effect-creating | https://effect.website/docs/getting-started/creating-effects/ | 3.x | 2026-10-01 |
| effect | effect-config | https://effect.website/docs/configuration/ | 3.x | 2026-10-01 |
| effect | effect-gen | https://effect.website/docs/getting-started/using-generators/ | 3.x | 2026-10-01 |
| effect | effect-fn | https://effect.website/blog/releases/effect/312/ | 3.12 | 2026-10-01 |
| effect | effect-guidelines | https://effect.website/docs/code-style/guidelines/ | 3.x | 2026-10-01 |
| effect | effect-services | https://effect.website/docs/requirements-management/services/ | 3.x | 2026-10-01 |
| effect | effect-schema | https://effect.website/docs/schema/introduction/ | 3.x | 2026-10-01 |
| effect | effect-logging | https://effect.website/docs/v3/observability/logging | 3.x | 2026-10-01 |
| effect | effect-vitest | https://raw.githubusercontent.com/Effect-TS/effect/v3/packages/vitest/README.md | 3.x | 2026-10-01 |
| platform | platform-command | https://github.com/Effect-TS/effect/blob/main/packages/platform/src/Command.ts | 0.97 | 2026-10-04 |
| platform | platform-error | https://github.com/Effect-TS/effect/blob/main/packages/platform/src/Error.ts | 0.97 | 2026-10-04 |
| platform | platform-node-context | https://github.com/Effect-TS/effect/blob/main/packages/platform-node/src/NodeContext.ts | 0.108 | 2026-10-04 |
| cli | effect-cli-readme | https://github.com/Effect-TS/effect/blob/main/packages/cli/README.md | 0.77 | 2026-10-04 |
| vitest | vitest-vi | https://vitest.dev/api/vi | 3.x | 2026-10-01 |
| vitest | vitest-migration | https://vitest.dev/guide/migration | 3.x | 2026-10-01 |
| biome | biome-config | https://biomejs.dev/reference/configuration/ | 2.5 | 2026-10-01 |
| biome | biome-organize-imports | https://biomejs.dev/assist/actions/organize-imports/ | 2.5 | 2026-10-01 |
| biome | biome-no-process-env | https://biomejs.dev/linter/rules/no-process-env/ | 2.5 | 2026-10-01 |
| general | conventional-commits | https://www.conventionalcommits.org/en/v1.0.0/ | 1.0.0 | 2026-10-01 |
| general | commitlint-conventional | https://github.com/conventional-changelog/commitlint/blob/master/%40commitlint/config-conventional/src/index.ts | 21 | 2026-10-01 |
| general | pnpm-security | https://github.com/pnpm/pnpm/blob/main/SECURITY.md | 12 | 2026-10-01 |
| general | pnpm-supply-chain | https://pnpm.io/supply-chain-security | 12 | 2026-10-01 |
| general | pnpm-install | https://pnpm.io/cli/install | 12 | 2026-10-01 |
| general | gh-actions-hardening | https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions | - | 2026-10-01 |
| general | owasp-secrets | https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html | - | 2026-10-01 |
| shell | bash-set | https://www.gnu.org/software/bash/manual/html_node/The-Set-Builtin.html | - | 2026-10-01 |
| docker | docker-best-practices | https://docs.docker.com/build/building/best-practices/ | - | 2026-10-01 |
| swift | swift-api-guidelines | https://www.swift.org/documentation/api-design-guidelines/ | - | 2026-10-01 |
