## Scope
- Applies to all Solid UI components.

## JSX and Component Structure
- Keep JSX hierarchy shallow and readable.
- Prefer fragments and extracted subcomponents over wrapper-heavy markup.
- If nesting exceeds ~3 levels, extract a child component.
- One component = one UI responsibility.
- Keep view components declarative; move non-trivial logic to pure helpers/hooks.
- Reuse existing primitives whenever applicable.
- If a primitive does not exist, create/derive it before adding one-off local variants.

## Solid-Specific Practices
- Prefer derived state (`createMemo`) over effect-driven state syncing.
- Use `<For>` for dynamic lists, `<Index>` for stable-index lists to minimize churn.
- Use `<Show>`/control-flow primitives instead of ad-hoc ternary pyramids.
- Keep signal updates localized; avoid broad reactive dependencies.

## Performance Rules
- No per-render allocations in hot paths when avoidable (memoize derived structures).
- Avoid repeated linear scans in render; pre-index with `Map`/`Set`.
- Do not introduce animation/timer loops (`setTimeout`, `setInterval`, `requestAnimationFrame`) unless explicitly required and fully cleaned up.
- Prefer event-driven/reactive updates over polling.

## Styling Rules
- Use global Tailwind utility classes and shared class patterns.
- Prefer CSS variables (shadcn-inspired token style) over hardcoded values.
- Avoid arbitrary value utilities (`prop-[<val>]`) when a standard utility, token, or semantic class can express the intent.

## Event and Handler Hygiene
- Keep JSX event handlers thin; call named functions, don’t embed heavy logic inline.
- Ensure handlers are deterministic and side effects are explicit.

## Done Criteria (Web Changes)
- Type check passes
- No unnecessary DOM wrappers introduced.