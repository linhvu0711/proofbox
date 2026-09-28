<!-- embed-source: effect@3.22.2 -->
# Effect config

How to describe settings (`Config`), read them from the env, a `Map` or JSON (`ConfigProvider`), swap the source in tests, and read the error you get when a value is missing or bad. Reach for this for `PROOFBOX_FAKE_ROOT`, `PROOFBOX_RUNTIME_DIR`, and other env settings.

## Constructors

| Name | Purpose | Defined in |
| --- | --- | --- |
| `Config.string("KEY")` / `Config.number("KEY")` | One primitive value; `Config.integer` also exists. | `repos/effect/packages/effect/src/Config.ts` (`export const string`, `number`) |
| `Config.all({ a, b })` or `Config.all([a, b])` | Struct or tuple of configs. | `repos/effect/packages/effect/src/Config.ts` (`export const all`) |
| `Config.nested("prefix")` | Put a config under `prefix.` in the key path. | `repos/effect/packages/effect/src/Config.ts` (`export const nested`) |
| `Config.withDefault(value)` | Use `value` when the key is missing (only on `MissingData`). | `repos/effect/packages/effect/src/Config.ts` (`export const withDefault`) |
| `Config.option(config)` | `Option.none()` when missing, else `Option.some`. | `repos/effect/packages/effect/src/Config.ts` (`export const option`) |
| `Config.orElse(() => other)` | Try `other` when the first one fails. | `repos/effect/packages/effect/src/Config.ts` (`export const orElse`) |
| `Config.redacted("KEY")` | Secret wrapped in `Redacted` so it never prints. | `repos/effect/packages/effect/src/Config.ts` (`export const redacted`) |
| `ConfigProvider.fromMap(map)` / `ConfigProvider.fromJson(obj)` | Test or in-memory sources; `.load(config)` runs them. | `repos/effect/packages/effect/src/ConfigProvider.ts` (`export const fromMap`, `fromJson`) |
| `Effect.withConfigProvider(provider)` / `Layer.setConfigProvider(provider)` | Replace the provider for one effect / for a layer tree. | `repos/effect/packages/effect/src/Effect.ts`, `repos/effect/packages/effect/src/Layer.ts` |
| `ConfigError.MissingData` / `InvalidData` / `And` / `Or` | The failure union; each has `_op`, `path`, `message`. | `repos/effect/packages/effect/src/ConfigError.ts` |

Import style: `import { Effect, Config, ConfigProvider, ConfigError } from "effect"`. A `Config<A>` is itself an `Effect<A, ConfigError>`, so `yield* Config.string("KEY")` works.

## Shapes this project uses

Struct config with `Config.all`, `Config.nested`, `Config.withDefault`, loaded from a `Map` and from JSON.

```ts
// from repos/effect/packages/effect/test/ConfigProvider.test.ts
const hostPortConfig: Config.Config<HostPort> = Config.all({
  host: Config.string("host"),
  port: Config.integer("port")
})

const serviceConfigConfig: Config.Config<ServiceConfig> = Config.all({
  hostPort: hostPortConfig.pipe(Config.nested("hostPort")),
  timeout: Config.integer("timeout")
})

const webScrapingTargetsConfigWithDefault = Config.all({
  targets: Config.chunk(Config.string()).pipe(
    Config.withDefault(Chunk.make("https://effect.website2", "https://github.com/Effect-TS2"))
  )
})

const map = new Map([["hostPort.host", "localhost"], ["hostPort.port", "8080"], ["timeout", "1000"]])
const result = yield* ConfigProvider.fromMap(map).load(serviceConfigConfig)
const fromJson = yield* ConfigProvider.fromJson({ host: "localhost", port: 8080 }).load(hostPortConfig)
```

Optional values (`option`, `orElse`, `withDefault`), a secret, and swapping the provider in a test with `Effect.withConfigProvider`.

```ts
// from repos/effect/packages/effect/test/Config.test.ts
const config = pipe(
  Config.integer("key1"),
  Config.orElse(() => Config.integer("key2")),
  Config.withDefault(0)
)
const maybe = Config.option(Config.integer("key"))   // Option.none() when missing
const secret = Config.redacted("secret")             // equals Redacted.make("sauce")

const result = Effect.runSync(Effect.withConfigProvider(
  Config.string("STRING"),
  ConfigProvider.fromMap(new Map([["STRING", "value"]]))
))
```

The error shape on failure: `MissingData` for an absent key, `InvalidData` for a bad value, `And` / `Or` when a struct or fallback combines them.

```ts
// from repos/effect/packages/effect/test/Config.test.ts
const assertConfigError = <A>(config: Config.Config<A>, map: ReadonlyArray<readonly [string, string]>, error: ConfigError.ConfigError) => {
  const configProvider = ConfigProvider.fromMap(new Map(map))
  const result = Effect.runSyncExit(configProvider.load(config))
  assertFailure(result, Cause.fail(error))
}

assertConfigError(Config.number("NUMBER"), [], ConfigError.MissingData(["NUMBER"], "Expected NUMBER to exist in the provided map"))
assertConfigError(Config.number("NUMBER"), [["NUMBER", "value"]], ConfigError.InvalidData(["NUMBER"], `Expected a number value but received "value"`))

const andError = ConfigError.And(missingData, invalidData)
strictEqual(andError.message, "(Missing data at PATH: \"missing PATH\") and (Invalid data at PATH1: \"invalid PATH1\")")
```

## Mistakes to avoid

- Wrong: expect `Config.withDefault(0)` to hide a bad value. Right: it only covers `MissingData`; `"1.2"` for `Config.integer` still fails with `InvalidData` (`test/Config.test.ts`, "does not recover from other errors").
- Wrong: `Config.string("nested.key")`. Right: `Config.string("key").pipe(Config.nested("nested"))`. The path is a list, `["nested", "key"]`, and the provider joins it with `.` (`test/ConfigProvider.test.ts`, "nested").
- Wrong: `Config.string("secret")` for a token. Right: `Config.redacted("secret")`, and compare with `Redacted.make(...)` in tests (`test/Config.test.ts`, "unwrap correctly builds config").
- Wrong: read `process.env` inside a test. Right: `Effect.withConfigProvider(ConfigProvider.fromMap(...))` on the effect, or `Layer.setConfigProvider(...)` in the test layer, so the source is explicit (`test/Config.test.ts`, "can be yielded").
- Wrong: match on `error.message` text. Right: use `ConfigError.isMissingData(e)` / `isInvalidData(e)` and `e.path`; `And` / `Or` nest two errors and their `message` is built from both (`test/ConfigProvider.test.ts`, "indexed sequence - multiple product types with missing fields"; `test/Config.test.ts`, "ConfigError message").
