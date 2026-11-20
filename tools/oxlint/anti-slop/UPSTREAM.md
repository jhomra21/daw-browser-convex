# Vendored anti-slop plugin

This tree is owned by the repository. It is not a pristine copy of upstream.

## Source identity

- Incoming source: the `install-anti-slop` skill bundle (`~/.factory/skills/install-anti-slop`), staged 2026-11-19 with the skill's `scripts/install.mjs`.
- Upstream repository and commit: unknown. The bundle does not record them, so no immutable revision is claimed.
- Base: unrecoverable. History has 99d7e7f9 (initial vendoring), 9dfce9e2 (app-wide commit that changed 31 plugin files, origin unknown) and e8f77958 (test renames). The 2026-11 update is a no-base conservative port, not a three-way merge.

## Adopted from the bundle (2026-11 update)

- New rules: `no-array-filter-map`, `no-reduce-accumulator-copy`, `require-readable-spacing`.
- New shared helpers: `array-method`, `function-parameters`, `scope`, `type-alias-resolution`. `reflect-method`, `no-module-mocking` and `no-known-value-widening` now use `shared/scope` instead of private copies of `resolveVariable`.
- `vendor/eslint-stylistic/` (padding-line rule, LICENSE, UPSTREAM.md) backs `require-readable-spacing`.
- `index.ts` registers the three new rules next to the existing 15.
- Updated rule behavior: `no-known-value-widening` (call arguments to type-predicate subjects), `no-object-parameters`, `no-unknown-returns`, `no-unknown-type-aliases` (lexical alias resolution), `no-unknown-parameters` (nested unknown, type-predicate subjects allowed), `no-unsafe-dictionary-type` (type-parameter constraints exempt), `shared/dictionary-types` (lexical alias environment; `Record` with narrow keys is not an open dictionary), `no-runtime-typeof` (`typeof x === "undefined"` existence probes allowed), `no-shape-in-symbol-names` (borrowed `obj.shapeName` members allowed), `require-safety-comment-for-type-assertion` (configurable `markers` option; a comment above an `export` statement counts).
- `shared/lexical-type-parameters.ts` was identical in the bundle and is still used (by `type-alias-resolution`).

## Local deviations preserved

- 12 `rules/*.rule-test.ts` suites, run by `bun run test:anti-slop`. All pass against the adopted source. The diff review found no local-only predicate in the changed files: every removed local line was superseded by an upstream equivalent, so the changed files were replaced with the bundle versions.
- `no-runtime-typeof` keeps the `allowInTypeGuards` option (the bundle has it too).
- Three suites written here, because the bundle ships no tests: `no-array-filter-map`, `no-reduce-accumulator-copy`, `require-readable-spacing` (15 total).

## Not adopted

- `effect/**`: the repository has no direct `effect` dependency.

## Pending

- The origin of the changes in 9dfce9e2 is unknown. If a future update shows a local-only behavior regression, compare against that commit.
- Formatting (tabs vs two spaces) differs between files, as in the bundle; untouched.

## Dependencies and configuration

- `oxlint` and `@oxlint/plugins` stay at 1.78.0; the incoming source runs on them.
- `.oxlintrc.json` enables `oxc/no-accumulating-spread` and the three new rules at `error`.
- `package.json`: `test:anti-slop` expects 15 suites.

## Verification

- `bun run test:anti-slop`: 15 suites pass.
