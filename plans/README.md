# Implementation Plans

Generated on 2026-08-01 for commit `964a313`. Execute in order. Do not push unless explicitly requested.

## Execution order and status

| Plan | Title | Priority | Effort | Depends on | Status |
|------|-------|----------|--------|------------|--------|
| 001 | Patch built-in processor state without stopping audio | P1 | L | — | TODO |
| 002 | Bound EQ interaction and spectrum rendering work | P1 | M | 001 | TODO |
| 003 | Recover audio deterministically after system sleep | P1 | L | 001 | TODO |

## Dependency notes

- Plan 001 removes backend restarts for state-only built-in effect edits through a same-core, block-boundary state patch.
- Plan 002 then coalesces continuous EQ control and visualization work without having restart behavior obscure performance measurements.
- Plan 003 uses the same explicit native-session ownership and generation boundaries established in Plan 001 to discard pre-sleep work and restore a fresh paused session.

## Findings considered and rejected

- Disabling the EQ spectrum: rejected because the spectrum is expected DAW feedback and the measured code path can be bounded instead.
- Increasing persistence debounce: rejected because persistence is already debounced and is not the main synchronous pointer-move cost.
- Whole-core graph revision publication: rejected because the host prepares a separate audio-core handle, which resets instrument voices, source state, processor histories, and tails.
