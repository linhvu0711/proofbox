# Coding standards

One rule per line. A rule a tool checks names the tool in brackets. Effect examples and the full list of Effect mistakes, with paths into the library source, are in `docs/idioms/effect-*.md`. `/embed-source` owns those files, so they stay there. This file holds only the Effect rules this project settled. Words are in `CONTEXT.md`, and decisions are in `docs/adr/`.

## Names

- Files are `kebab-case`. [biome useFilenamingConvention]
- Types, classes, and schemas are `PascalCase`. Functions and values are `camelCase`. Module-level constants can be `CONSTANT_CASE`. [biome useNamingConvention]
- Static layers on a service class are `PascalCase`: `Default`, `Test`, `Direct`. [biome useNamingConvention]
- Service ids are `"proofbox/<ClassName>"`.
- Env vars are `PROOFBOX_<NAME>`.

## Layout

- A command goes in `src/commands/<command>.ts`.
- A subsystem with more than one file gets its own folder, like `src/keeper/` and `src/fake/`.
- The entry file of a process that proofbox spawns is `<name>-main.ts`.
- All expected-failure classes are in `src/errors.ts`.
- Relative imports end in `.ts`.
  Node runs `src/` directly with type stripping, so a `.js` path fails at run time. The CLI tests catch it.

## Errors

- An expected failure is a `Data.TaggedError` class in the `E` channel.
- `Effect.die` is only for "cannot happen".
- Code never throws inside an effect. A call that can throw runs in `Effect.try` or `Effect.tryPromise`, with a `catch` that maps to a tagged error.
  A throw becomes a defect, and `catchTag`, `catchAll`, and `Effect.option` do not see it.
- A Promise that can reject runs in `Effect.tryPromise`, never in `Effect.promise`.
  `Effect.promise` turns a rejection into a defect.

## Logging and output

- All output goes through the `CliOutput` service. [biome noConsole, in `src/`]
- stdout carries only the result: an id, a list, or `--json`. Progress and messages go to stderr.
  An agent reads stdout as data, so one stray line breaks it.
- There is no log library. See "Not covered".

## Tests

- Tests use Vitest and live in `test/<module>.test.ts`. [vitest include]
- Each user-visible behavior of a command has a test that runs the real CLI on the fake Provider through `test/support/cli.ts`.
  This tests from the outside, as the Caller uses proofbox (ADR 0002).
- Effect code with no CLI is tested with `it.effect` from `@effect/vitest`, never with `Effect.runPromise` inside a plain `it`.
- A test name says the behavior in plain words: `"exec passes stdout, stderr, and exit code unchanged"`.
- A test sets its config with `ConfigProvider` or with env vars on the child process, never by changing `process.env`.

## Commits

- Commit messages follow Conventional Commits: `type(scope): intent`, where the scope is optional. [commitlint, in CI on each PR]
- Branches are `type/slug`, for example `feat/6-cli-core`.
- One PR is one reviewable change.

## Deps

- `pnpm` is the only package manager. [package.json packageManager]
- Every version is pinned exact. [.npmrc save-exact]
- `pnpm-lock.yaml` is committed, and CI installs with `--frozen-lockfile`. [ci]
- After a bump of `effect`, run `/embed-source update effect`.
- Import from the installed package, never from `repos/`.

## Config and secrets

- Settings come from `Config`, never from `process.env` in `src/`. [biome noProcessEnv, in `src/`]
- A secret is read with `Config.redacted`.
- A secret never goes to stdout, stderr, or a file in the Work folder.
  A Sandbox runs user code, and ADR 0009 shows what a leaked token can do.
- No `.env` file and no secret goes into git.
- proofbox's own config lives in `~/.config/proofbox/`, never in a checked repo (ADR 0007).

## API shape

- `exec` passes the exit code of the Sandbox command through unchanged.
- A proofbox failure exits `125` with one plain line on stderr.
- An error message says what went wrong and what to do next, for example `Sandbox ran out of memory (4x8). Try --size 8x16.`

## Formatting

- Biome formats all code: 2 spaces, 80 columns, double quotes, semicolons, trailing commas. [biome]
- Files are UTF-8 with LF line ends and a final newline. [editorconfig]

## Stack-specific

- TypeScript runs with `strict`, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, and `verbatimModuleSyntax`. [tsc]
- No `enum` and no `namespace`. [tsc erasableSyntaxOnly]
- No `any`. [biome noExplicitAny]
- `as` is used only after a check proves the type, as after a regex match.
- Fields and service shapes are `readonly`.
- Effects are written with `Effect.gen`.
- A service with code is `Effect.Service<Self>()("proofbox/Name", …)`. A service that is a plain value is a `Context.Tag`.
- Data that crosses an edge (JSON on disk, a Keeper frame, CLI input) is a `Schema`. Its type comes from the schema, never from a second `interface`.
- A count or a duration in a schema is `Schema.Number.pipe(Schema.int(), Schema.positive())`, or `Schema.nonNegative()` when zero is valid.

## Not covered

- HTTP API shape: proofbox has no HTTP API. Its API is the CLI, under "API shape".
- Log library: none for now. Add a rule when proofbox needs logs past stderr.
