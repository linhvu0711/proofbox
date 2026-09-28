<!-- embed-source: effect@3.22.2 -->
# Effect Schema

How to declare domain shapes (SandboxInfo, the Sandbox id, Keeper frames), decode unknown input, and derive TypeScript types from one source. Reach for it whenever data crosses a boundary (JSON on disk, a socket frame, CLI args).

Project import style: `import { Schema, Effect, Data } from "effect"`. The library tests alias `Schema` as `S`; read `S.` as `Schema.` below.

## Constructors

| Name | Purpose | Defined in |
| --- | --- | --- |
| `Schema.Struct` | Plain object shape from a fields record. | `repos/effect/packages/effect/src/Schema.ts` (`export function Struct`, ~line 2936) |
| `Schema.Class<Self>("Id")({...})` | Struct plus a class with methods/getters and a validated constructor. | `repos/effect/packages/effect/src/Schema.ts` (`export const Class`, ~line 8713) |
| `Schema.TaggedError<Self>()("Tag", {...})` | Error class with `_tag`, schema fields, yieldable in `Effect.gen`. | `repos/effect/packages/effect/src/Schema.ts` (`export const TaggedError`, ~line 8834) |
| `Schema.decodeUnknown` | `unknown -> Effect<A, ParseError, R>`. | `repos/effect/packages/effect/src/ParseResult.ts` (~line 504), re-exported from `Schema.ts` |
| `Schema.decodeUnknownSync` | Same, throws `ParseError`. Use only at the edge. | `repos/effect/packages/effect/src/ParseResult.ts` (~line 464) |
| `Schema.decodeUnknownEither` | Same, returns `Either<A, ParseError>`. | `repos/effect/packages/effect/src/ParseResult.ts` (~line 482) |
| `Schema.transform` / `Schema.transformOrFail` | Map between an encoded and a decoded schema; `OrFail` may return `ParseResult` failures. | `repos/effect/packages/effect/src/Schema.ts` (~lines 3940 / 3831) |
| `Schema.filter`, `Schema.int()`, `Schema.positive()` | Refinements, e.g. `Schema.Number.pipe(Schema.int(), Schema.positive())`. | `repos/effect/packages/effect/src/Schema.ts` (~lines 3695, 5105, 5248) |
| `Schema.Schema.Type<typeof X>` / `Schema.Schema.Encoded<typeof X>` | Derive the decoded / encoded TS type from a schema value. | `repos/effect/packages/effect/src/Schema.ts` (~lines 335, 340) |

Type derivation: `type SandboxInfo = Schema.Schema.Type<typeof SandboxInfo>` gives the decoded side; `Schema.Schema.Encoded<typeof SandboxInfo>` gives the wire side (e.g. `string` for `NumberFromString`). For a `Schema.Class`, the class name is already the decoded type.

## Shapes this project uses

Class with a refinement on a field, a getter, and an effectful decode.

```ts
// from repos/effect/packages/effect/test/Schema/Schema/Class/Class.test.ts
class Person extends S.Class<Person>("Person")({
  id: S.Number,
  name: S.String.pipe(S.nonEmptyString())
}) {
  get upperName() {
    return this.name.toUpperCase()
  }
}

const person = S.decodeUnknown(Person)({ id: 1, name: "John" }).pipe(
  Effect.runSync
)
strictEqual(person.name, "John")
```

Tagged error with fields; it is an `Error`, yieldable, and decodable from the wire.

```ts
// from repos/effect/packages/effect/test/Schema/Schema/Class/TaggedError.test.ts
class MyError extends S.TaggedError<MyError>()("MyError", {
  id: S.Number
}) {}

let err = new MyError({ id: 1 })
strictEqual(err._tag, "MyError")
strictEqual(err.id, 1)

err = Effect.runSync(Effect.flip(err))
strictEqual(err._tag, "MyError")

err = S.decodeUnknownSync(MyError)({ _tag: "MyError", id: 1 })
strictEqual(err.id, 1)
```

Struct to Struct transform; `NumberFromString` shows the encoded/decoded split.

```ts
// from repos/effect/packages/effect/test/Schema/Schema/transform.test.ts
const A = Schema.Struct({
  a: Schema.NumberFromString
})

const B = Schema.Struct({
  a: Schema.String,
  b: Schema.NumberFromString
})

const AB = Schema.transform(B, A, {
  strict: true,
  decode: ({ a, b: _b }, i) => ({ a: a + i.b }),
  encode: (i, a) => ({ ...i, b: a.a * 2 })
})
```

## Mistakes to avoid

- Wrong: `Schema.Number` for an ID or a duration. Right: `Schema.Number.pipe(Schema.int(), Schema.positive())`. The tests in `repos/effect/packages/effect/test/Schema/Schema/filter.test.ts` show the `int & positive` failure tree for `1.1` and `-1`.
- Wrong: `Schema.decodeUnknownSync` on a schema that does async work or needs a service. It throws `ParseError` with "cannot be be resolved synchronously" / "Service not found" (`repos/effect/packages/effect/test/Schema/Schema/decodeUnknownSync.test.ts`). Right: `Schema.decodeUnknown` inside `Effect.gen`, or `decodeUnknownEither` for pure schemas.
- Wrong: `Schema.transform` with a `decode` that can fail (returns a partial value or throws). Right: `Schema.transformOrFail` returning `ParseResult.succeed` / `ParseResult.fail(new ParseResult.Type(ast, input, "why"))` (`repos/effect/packages/effect/test/Schema/Schema/transformOrFail.test.ts`, `Class.test.ts`).
- Wrong: `class E extends Schema.TaggedError<E>("E", {...})`. Right: two calls, `Schema.TaggedError<E>()("E", {...})`; the first `()` takes only the optional identifier (`TaggedError.test.ts`).
- Wrong: writing a separate `interface SandboxInfo` next to the schema. Right: `Schema.Schema.Type<typeof SandboxInfo>`, or use `Schema.Class` so the class is the type (`repos/effect/packages/effect/test/Schema/Schema/keyof.test.ts` comments show `S.Schema.Type<typeof schema>`).
