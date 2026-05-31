# ADR 002: Specta vs Typeshare for TypeScript Generation

## Context
As part of the Track A architecture review, we evaluated migrating from `typeshare` to `specta` (and `rspecta`) for generating TypeScript interfaces from our Rust models. The primary motivation was to explore whether `specta` could natively generate runtime validators (like Zod schemas) along with types, from a single Rust source of truth.

## Evaluation
1. **Typeshare (Current)**:
   - *Pros*: Already integrated into the `spine-api` crate via CLI. Fast, simple, and has zero runtime impact on the Rust binary (it's purely static analysis).
   - *Cons*: Does not natively generate Zod schemas without using third-party templates or writing a custom generator plugin.

2. **Specta**:
   - *Pros*: Extremely powerful, integrates via Rust macros and traits (`Type`), meaning type generation can be run as part of the cargo test/build pipeline. Ecosystem supports exporting Zod schemas.
   - *Cons*: Requires wrapping/decorating types with another macro, which could conflict or add noise on top of `serde` and `typeshare`. It forces a runtime generation step (executing Rust code to emit the TS files), which breaks the current simple `Makefile`/CLI flow.

## Decision
We have decided to **stick with `typeshare`** for the time being.

## Rationale
- `typeshare` is listed in project documentation as a "Locked-in decision (do not re-litigate without explicit user ask)".
- The overhead of refactoring the entire `spine-api` to use `specta` macros and the build process to emit the types runtime does not justify the potential benefit of Zod schema generation at this phase, especially when `typeshare` is already doing exactly what we need for static typing.
- If runtime validation becomes strictly necessary in the frontend, we can either use a `typeshare` template for Zod or manually maintain the critical schemas while keeping `typeshare` for static boundaries.
