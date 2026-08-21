# Control Platform Packaged Runtime Acceptance

## Artifact

- Initial commit: `c5c429417abf293ddaf5f2ac379d9e3bb9c78a39`
- Branch: `feat/model-independent-control-platform`
- OS: macOS 26.3 arm64
- Bun: 1.3.14
- Electron: 43.1.1
- Packaged app: `apps/desktop/out/@daw-browser-desktop-darwin-arm64/@daw-browser-desktop.app`
- Profile: isolated temporary Electron user-data directory

The unsigned local package flow rebuilt and packaged the native audio host, VST3
scanner, VST3 worker, file-capability helper, native manifest, and portable
audio assets. Forge packaging hooks completed successfully.

## Results

| Scenario | Surface | Packaged app | Result | Evidence |
| --- | --- | --- | --- | --- |
| App launch | Electron | Yes | PASS | Launch screenshot and live CDP target |
| Registration and socket creation | Desktop host | Yes | PASS | Private `0600` registration and socket created by app |
| Zero-context project discovery | CLI | Yes | PASS | `project list`, `project current` |
| Capabilities and snapshot | CLI | Yes | PASS | Canonical V2 snapshot at revisions 0–2 |
| Preview immutability | Python JSONL | Yes | PASS | Snapshot unchanged before commit |
| Safe commit | Python JSONL | Yes | PASS | Revision advanced and authoritative snapshot changed |
| Visible state after external commit | JSONL + Electron | Yes | PASS after fix | Track name updated in snapshot and mounted UI |
| Idempotent replay | Python JSONL | Yes | PASS | Replay true, revision remained 2 |
| Idempotency conflict | CLI/JSONL | Yes | PASS after fix | Canonical `idempotency-conflict`, no mutation |
| History | CLI | Yes | PASS | Two chronological commits, no replay entry |
| Browser toggle shortcut | Packaged UI | Yes | PASS | `Mod+Alt+B` hid browser sidebar |
| MCP initialization and discovery | Independent stdio client | Yes | PASS | 24 tools, project discovery, revision-2 snapshot |
| Protocol-naive autonomous agent | MCP | Yes | PASS after discoverability hardening | GPT-5.6 Sol discovered the host project, used canonical V2 reads, previewed, committed, and verified revision 3 without protocol hints |
| Cross-model autonomous agent | MCP | Yes | PASS | GPT-5.5 independently completed the same no-hints workflow and verified revision 5 |
| Revision conflict and recovery | MCP | Yes | PASS | Stale revision rejected as `revision-conflict`; fresh snapshot, preview, and commit succeeded |
| Destructive approval and integrity | MCP | Yes | PASS | Missing and request-mismatched approval tokens were rejected; exact approved delete succeeded |
| Recovery restore | MCP | Yes | PASS | Deleted track produced a recovery and was restored through `recovery.restore` |
| MCP/JSONL mutation parity | MCP + JSONL | Yes | PASS | JSONL rename advanced revision 11 to 12; MCP observed the same canonical name and revision |
| Host status | CLI | Yes | PASS | Mounted local project, ready, stopped |
| Restart discovery | CLI | Yes | PASS | New registration/socket discovered after package restart |
| Human/agent concurrency | MCP + Electron | Yes | PASS | Stale agent request refreshed and committed without clobbering the manual unmute |
| Transport runtime | CLI + Electron | Yes | PASS after fix | Play, seek, pause, stop, and authoritative stopped state verified |
| Audio import | CLI + Electron | Yes | PASS after fix | Real WAV persisted as canonical asset/clip and appeared in the mounted UI |
| Restart media hydration | Electron + CLI | Yes | PASS after fix | Fresh imported WAV survived termination, cold restart, reopen, and playback |
| Mixdown export | CLI | Yes | PASS after fixes | Decodable stereo PCM WAV, 48 kHz, exactly 1 second, 192,044 bytes |
| Export cancellation | CLI | Yes | PASS | Long export reached `canceled` without publishing an output |
| JSONL survival matrix | Spawned CLI process | Yes | PASS after fix | Malformed, valid, oversized, valid, notification, split UTF-8, valid; six responses, exit 0 |
| Registration adversarial matrix | CLI | Yes | PASS | Missing, malformed, dead socket, unsafe permissions, stopped host, and restart recovery fail closed |
| Standalone TypeScript SDK | Public package imports | Yes | PASS after public adapter | V2 discovery, snapshot, immutable preview, commit, revision advance, and mounted UI reconciliation |
| Native application menu | macOS menu + Electron | Yes | PASS | Actual View → Assets Browser item reopened the hidden browser sidebar |
| Installed VST3 scan | Electron | Yes | PARTIAL / PRODUCT SKIP | ValhallaSupermassive 5.0.0 scanned successfully; packaged catalog reported native VST3 hosting inactive, so no instance could be mounted |
| Extension lifecycle | Electron | Yes | PRODUCT SKIP | No packaged product/debug lifecycle entrypoint or registered extension commands exist |
| Cloud control | Cloud | No | ENVIRONMENT SKIP | No disposable authenticated cloud environment or credentials were available |
| Repository-wide lint | Source gate | N/A | FAIL baseline | Existing broad anti-slop violations in unchanged files |

## Confirmed product bugs fixed

1. **PACKAGING/ADAPTER BUG:** macOS canonical `/private/tmp` socket paths were
   rejected when the CLI used the equivalent `/tmp` profile path.
2. **ADAPTER BUG:** successful renderer replies explicitly included
   `error: undefined`, causing packaged desktop reply serialization failure.
3. **PRODUCT BUG:** durable external commits updated snapshots but did not
   reconcile the mounted timeline UI.
4. **ADAPTER BUG:** canonical renderer errors retained optional
   `undefined` properties, causing idempotency conflicts to collapse into
   generic internal serialization failures.
5. **TRANSPORT BUG:** `transport.stop` returned stale paused state before the
   mounted timeline's awaited stop result was reflected.
6. **IMPORT BOUNDARY BUG:** main-process-only file metadata crossed a strict
   renderer schema, and `AbortSignal` was incorrectly sent across the context
   bridge.
7. **EXPORT DISPATCH BUG:** preflight and final export reused one request ID,
   but active queue state was removed only after the preflight reply callback.
8. **MEDIA LIFECYCLE BUG:** persisted local audio clips were not proactively
   hydrated during project mount, allowing canonical state and renderable state
   to diverge after restart.
9. **OUTPUT CAPABILITY BUG:** macOS `/tmp` output parents were not canonicalized
   to `/private/tmp` before capability containment checks.
10. **NATIVE STREAM BUG:** JavaScript buffered only four native PCM frames;
    normal native bursts overflowed the queue and made export time out.
11. **CLI STDIN BUG:** Bun stdin remained flowing while a JSON-RPC host request
    was awaited, dropping later chunks and preventing oversized-line recovery.
12. **SDK SURFACE GAP:** secure desktop transport and canonical adaptation were
    CLI-private, so an external TypeScript SDK consumer could not connect
    without importing internal modules.

Each bug was reproduced through a public packaged-app boundary, reduced to its
architectural owner, covered by a focused regression, and rerun against a
rebuilt package.

## Agent discoverability follow-up

The initial autonomous failures were addressed without adding convenience
mutation tools or a second semantic API. Canonical schemas now describe request
fields, persisted references, and representative actions. MCP initialization
provides an executable workflow, V2 reads are labeled canonical/preferred, and
invalid tool input includes bounded public field details.

The rebuilt package was exercised by two protocol-naive models. Each model was
given only the DAW MCP tools and the task to rename the first audio track in the
current desktop project. Both independently discovered the project, selected
the canonical V2 snapshot, constructed a persisted track reference, previewed,
committed with an idempotency key, and verified the resulting snapshot. The
mounted Electron UI also displayed the committed name.

## Remaining environmental and product skips

- **VST3 instance and parameter reads:** the installed ValhallaSupermassive
  bundle was discovered through the real packaged settings workflow, including
  class metadata, code-sign verification, architecture, and fingerprinting.
  The packaged catalog explicitly reported that native VST3 audio hosting was
  not active, so the product exposed no legitimate way to create a mounted
  instance. An empty external instance list is recorded as a product skip, not
  a runtime pass.
- **Extension lifecycle:** the packaged Extension Commands menu was empty and
  the repository exposes no product/debug lifecycle entrypoint. No test-only
  registration surface was invented.
- **Cloud control:** no disposable authenticated cloud environment or cloud
  credentials were present. No credentials or test-only cloud route were
  created.

Audible transport output was not independently measured. State transitions,
playhead behavior, restart media playback readiness, and export rendering were
verified through the packaged product boundaries.

## Evidence location

Temporary transcripts, snapshots, logs, and screenshots were retained under:

`/tmp/daw-control-acceptance-c5c4294`

The focused discoverability transcripts and safety/parity results are under:

`/tmp/daw-control-acceptance-c5c4294/agent-discoverability`

The expanded merge-gate evidence, including media lifecycle, export,
cancellation, JSONL reduction, registration, standalone SDK, native menu, and
VST3 catalog results, is under:

`/tmp/daw-control-merge-gate-3fb4ce1/evidence`

No registration secret was copied into this report.
