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
| Protocol-naive autonomous agent | MCP | Yes | FAIL | Could not infer valid preview input from public surface |
| Informed autonomous agent | MCP | Yes | FAIL | Used wrong tool name, then reported transient MCP unavailability |
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

## Not completed in this pass

The following scenarios remain unproven at the packaged boundary:

- native application-menu invocation of the browser toggle;
- revision conflict with a concurrent manual UI edit;
- destructive approval, approval integrity, and recovery;
- MCP mutation parity;
- successful autonomous-agent mutation;
- transport play/seek/pause with visible and audible verification;
- VST3 discovery, no known-good installed instance was selected;
- real audio import and export/cancel;
- malformed registration matrix and JSONL memory observation;
- TypeScript SDK host mutation;
- cloud acceptance, no disposable authenticated cloud environment was used;
- extension lifecycle stress, no current product-facing lifecycle surface;
- sustained human/agent concurrency.

These are skips, not passes. Deterministic CLI, JSONL, and MCP reads plus JSONL
mutation were proven against the packaged application. Autonomous model
discoverability remains an acceptance failure requiring follow-up on tool
descriptions/schema presentation or the acceptance bridge.

## Evidence location

Temporary transcripts, snapshots, logs, and screenshots were retained under:

`/tmp/daw-control-acceptance-c5c4294`

No registration secret was copied into this report.
