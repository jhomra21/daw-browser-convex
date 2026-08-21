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

## Not completed in this pass

The following scenarios remain unproven at the packaged boundary:

- native application-menu invocation of the browser toggle;
- revision conflict with a concurrent manual UI edit;
- transport play/seek/pause with visible and audible verification;
- VST3 discovery, no known-good installed instance was selected;
- real audio import and export/cancel;
- malformed registration matrix and JSONL memory observation;
- TypeScript SDK host mutation;
- cloud acceptance, no disposable authenticated cloud environment was used;
- extension lifecycle stress, no current product-facing lifecycle surface;
- sustained human/agent concurrency.

These are skips, not passes.

## Evidence location

Temporary transcripts, snapshots, logs, and screenshots were retained under:

`/tmp/daw-control-acceptance-c5c4294`

The focused discoverability transcripts and safety/parity results are under:

`/tmp/daw-control-acceptance-c5c4294/agent-discoverability`

No registration secret was copied into this report.
