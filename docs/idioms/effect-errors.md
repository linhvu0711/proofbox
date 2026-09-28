<!-- embed-source: effect@3.22.2 -->
# Effect Errors

How to model expected failures (a bad Sandbox id, a gone Sandbox, a missing Capability) as tagged errors in the `E` channel of `Effect<A, E, R>`, recover from them by tag, and keep real bugs as defects. Reach for it whenever a function can fail for a reason a caller should handle.

Project import style: `import { Schema, Effect, Data } from "effect"`. For errors that cross the wire (Keeper socket frames), prefer `Schema.TaggedError` (see `effect-schema.md`); for internal errors, `Data.TaggedError` is enough.

## Constructors

| Name | Purpose | Defined in |
| --- | --- | --- |
| `Data.TaggedError("Tag")<Fields>` | Error class with `_tag`, `Equal`/`Hash`, yieldable in `Effect.gen`. | `repos/effect/packages/effect/src/Data.ts` (~line 577) |
| `Effect.fail(e)` | Put `e` in the `E` channel: `Effect<never, E>`. | `repos/effect/packages/effect/src/Effect.ts` (~line 2575) |
| `Effect.die(defect)` | Unrecoverable defect, `E` stays `never`. | `repos/effect/packages/effect/src/Effect.ts` (~line 2647) |
| `Effect.catchTag("Tag", f)` | Recover one tagged error; removes it from `E`. | `repos/effect/packages/effect/src/Effect.ts` (~line 3882) |
| `Effect.catchTags({ Tag: f })` | Recover several tags in one call. | `repos/effect/packages/effect/src/Effect.ts` (~line 3948) |
| `Effect.mapError(f)` | Change the error type; success untouched. | `repos/effect/packages/effect/src/Effect.ts` (~line 5310) |
| `Effect.either` / `Effect.exit` | Move the error into the value for inspection: `Either<A, E>` / `Exit<A, E>`. | `repos/effect/packages/effect/src/Effect.ts` (~lines 8180, 8243) |
| `Effect.tryPromise({ try, catch })` | Wrap a Promise; `catch` maps the thrown value to `E`. | `repos/effect/packages/effect/src/Effect.ts` (~line 4677) |

Type reading: `Effect<A, E, R>` is "gives A, may fail with E, needs R". Every `yield*` of an effect with `E = DbError` adds `DbError` to the surrounding `Effect.gen` error type. `catchTag`/`catchTags` subtract handled tags with `Exclude`.

## Shapes this project uses

Tagged error class, and a Promise wrapped with a mapped error.

```ts
// from repos/effect/packages/effect/test/Effect/error.test.ts
class TestError extends Data.TaggedError("TestError")<{}> {}

const cause = yield* pipe(
  Effect.tryPromise({
    try: () => Promise.reject("fail"),
    catch: () => new TestError()
  }),
  Effect.withSpan("A"),
  Effect.sandbox,
  Effect.flip
)
```

Recover one tag with `catchTags`; the other tag stays in `E` and shows up in the `Exit`.

```ts
// from repos/effect/packages/effect/test/Effect/error-handling.test.ts
interface ErrorA {
  readonly _tag: "ErrorA"
}
interface ErrorB {
  readonly _tag: "ErrorB"
}
const effect: Effect.Effect<never, ErrorA | ErrorB, never> = Effect.fail({ _tag: "ErrorB" })
const result = yield* (Effect.exit(
  Effect.catchTags(effect, {
    ErrorA: (e) => Effect.succeed(e)
  })
))
deepStrictEqual(result, Exit.fail<ErrorB>({ _tag: "ErrorB" }))
```

`Effect.fail` lands in `Exit.fail`; a thrown exception inside `Effect.sync` lands in `Exit.die`. `Effect.either` gives a `Left` for failures only.

```ts
// from repos/effect/packages/effect/test/Effect/error-handling.test.ts
const ExampleErrorFail: Effect.Effect<never, Error, never> = Effect.fail(ExampleError)

const result = yield* (Effect.exit(ExampleErrorFail))
deepStrictEqual(result, Exit.fail(ExampleError))

const result2 = yield* pipe(
  Effect.sync(() => {
    throw ExampleError
  }),
  Effect.exit
)
deepStrictEqual(result2, Exit.die(ExampleError))

const io1 = Effect.either(ExampleErrorFail)
assertLeft(yield* io1, ExampleError)
```

## Mistakes to avoid

- Wrong: `throw new DbError()` inside `Effect.sync` or `Effect.gen`. That becomes a defect (`Exit.die`), invisible to `catchTag` (`repos/effect/packages/effect/test/Effect/error-handling.test.ts`, "uncaught - sync effect error"). Right: `yield* new DbError(...)` or `Effect.fail(new DbError(...))`.
- Wrong: `Effect.tryPromise(() => db.all(sql))` with no `catch`; the error is `UnknownException` (`repos/effect/packages/effect/test/Effect/tryPromise.test.ts`). Right: `Effect.tryPromise({ try, catch: (e) => new DbError({ cause: e }) })`.
- Wrong: `Effect.catchTag("DbErorr", ...)`; the tag is checked against `E["_tag"]`, so a typo or a tag not in `E` is a type error. Right: copy the tag from the class, or use `Effect.catchTags({ DbError: ... })` so the keys are checked as a set (`repos/effect/packages/effect/src/Effect.ts` `catchTags` signature).
- Wrong: recovering from a defect with `Effect.catchAll`; it only sees `E`. Right: keep defects as defects (`Effect.die` for "cannot happen"), and inspect with `Effect.exit` or `Effect.sandbox` when a test needs the `Cause` (`repos/effect/packages/effect/test/Cause.test.ts`, "Die with span").
- Wrong: `extends Data.TaggedError("X")` with a plain `message` string and nothing else, then using `String(err)` to see the fields. Right: give the class typed fields; `toJSON()` includes all args (`repos/effect/packages/effect/test/Data.test.ts`, "TaggedError toJSON includes all args").
