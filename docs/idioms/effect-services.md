<!-- embed-source: effect@3.22.2 -->
# Effect services

How to define a service (Tag), build it (Layer), wire it (provide) and swap it in a test. Reach for this when a Provider, the Keeper client, or a command needs a dependency.

## Constructors

| Name | Purpose | Defined in |
| --- | --- | --- |
| `Context.Tag("Id")<Self, Shape>()` | Class-style tag: the key plus the service type. | `repos/effect/packages/effect/src/Context.ts` (`export const Tag`) |
| `Effect.Service<Self>()("Id", { sync / effect / scoped, dependencies })` | Tag and `Default` layer in one class. | `repos/effect/packages/effect/src/Effect.ts` (`export const Service`) |
| `Layer.succeed(tag, value)` | Layer from a plain value. | `repos/effect/packages/effect/src/Layer.ts` (`export const succeed`) |
| `Layer.effect(tag, effect)` | Layer built by an effect (no cleanup). | `repos/effect/packages/effect/src/Layer.ts` (`export const effect`) |
| `Layer.scoped(tag, scopedEffect)` | Layer with cleanup; pair with `Effect.acquireRelease`. | `repos/effect/packages/effect/src/Layer.ts` (`export const scoped`) |
| `Layer.provide` / `Layer.provideMerge` / `Layer.merge` | Feed one layer into another / feed and keep both / put side by side. | `repos/effect/packages/effect/src/Layer.ts` |
| `Layer.mock(tag, partial)` | Partial test double; missing members die when called. | `repos/effect/packages/effect/src/Layer.ts` (`export const mock`) |
| `Effect.provide(effect, layer)` | Run an effect with a layer (or an array of layers). | `repos/effect/packages/effect/src/Effect.ts` (`export const provide`) |

Import style: `import { Effect, Context, Layer } from "effect"`.

## Shapes this project uses

Service with `Effect.Service`: `sync:` for a static value, `effect:` plus `dependencies:` for a wired one, and a static `Test` layer that swaps the implementation.

```ts
// from repos/effect/packages/effect/test/Effect/service.test.ts
class Prefix extends Effect.Service<Prefix>()("Prefix", {
  sync: () => ({ prefix: "PRE" })
}) {}

class Logger extends Effect.Service<Logger>()("Logger", {
  accessors: true,
  effect: Effect.gen(function*() {
    const { prefix } = yield* Prefix
    return {
      info: (message: string) => Effect.sync(() => { messages.push(`[${prefix}][${message}]`) })
    }
  }),
  dependencies: [Prefix.Default]
}) {
  static Test = Layer.succeed(this, new Logger({ info: () => Effect.void }))
}

// use: Logger.info("Ok").pipe(Effect.provide([Logger.Default, Prefix.Default]))
// test: Logger.info("Ok").pipe(Effect.provide(Logger.Test))
```

Plain `Context.Tag` class, with `Layer.succeed` / `Layer.effect` as statics (`Effect.Tag` is `Context.Tag` plus generated accessors).

```ts
// from repos/effect/packages/effect/test/Effect/environment.test.ts
class NumberRepo extends Context.Tag("NumberRepo")<NumberRepo, {
  readonly numbers: Array<number>
}>() {}

class DateTag extends Effect.Tag("DateTag")<DateTag, Date>() {
  static date = new Date(1970, 1, 1)
  static Live = Layer.succeed(this, this.date)
}

class MapTag extends Effect.Tag("MapTag")<MapTag, Map<string, string>>() {
  static Live = Layer.effect(this, Effect.sync(() => new Map()))
}
```

Resource layer with `Layer.scoped` + `Effect.acquireRelease`, then composition with `provideMerge`, `provide` and `merge`.

```ts
// from repos/effect/packages/effect/test/Layer.test.ts
export const makeLayer1 = (ref: Ref.Ref<Chunk.Chunk<string>>): Layer.Layer<Service1> => {
  return Layer.scoped(
    Service1Tag,
    Effect.acquireRelease(
      ref.pipe(Ref.update(Chunk.append(acquire1)), Effect.as(new Service1())),
      () => Ref.update(ref, Chunk.append(release1))
    )
  )
}

const fedB = bLayer.pipe(
  Layer.provideMerge(aLayer),                                   // B, A and Config visible
  Layer.provideMerge(Layer.succeed(ConfigTag, new Config(1)))
)
const fedC = cLayer.pipe(
  Layer.provideMerge(aLayer),
  Layer.provide(Layer.succeed(ConfigTag, new Config(2)))        // Config hidden
)
const env = yield* pipe(fedB, Layer.merge(fedC), Layer.build, Effect.scoped)
```

## Mistakes to avoid

- Wrong: `class Foo extends Effect.Service()("Foo", ...)`. Right: `Effect.Service<Foo>()`. Without the `Self` generic the type is the literal string ``Missing `Self` generic`` (`src/Effect.ts`, `MissingSelfGeneric`).
- Wrong: `Layer.effect(tag, Effect.acquireRelease(...))`. Right: `Layer.scoped(tag, Effect.acquireRelease(...))`. `Layer.effect` leaves `Scope` in the requirements; `Layer.scoped` removes it and runs the release on shutdown (`test/Layer.test.ts`, `makeLayer1`).
- Wrong: `Layer.provide(dep)` when the caller also needs `dep`. Right: `Layer.provideMerge(dep)`. `provide` hides the dependency; `provideMerge` keeps it in the output (`test/Layer.test.ts`, `fedB` vs `fedC`).
- Wrong: run an effect whose `R` is not `never` and hope the tag resolves. Right: `Effect.provide(layer)` first. A missing tag fails with `Service not found: <Id>` (`test/Context.test.ts`, "error messages").
- Wrong: rebuild a full fake class for a test. Right: `Layer.succeed(Logger, new Logger({ info: () => Effect.void }))` or `Layer.mock(Service1, { _tag: "Service1", one: Effect.succeed(123) })` (`test/Effect/service.test.ts`, `test/Layer.test.ts`).
