# DAW Browser Convex

**Last updated: 2026-08-26**

DAW Browser Convex is a local-first digital audio workstation with a portable
browser core, optional authenticated cloud collaboration, and an Electron/macOS
runtime for native audio and VST3 features.

The project follows Ableton-style interaction patterns while keeping browser,
cloud, desktop, native, and automation responsibilities explicit. Project
semantics are now exposed through one model-independent control platform so the
UI, agents, CLI, MCP, SDK consumers, and cloud/desktop authorities do not need
separate mutation models.

## Major platform update

PR #47 landed the model-independent control platform, authenticated desktop
control, packaged native VST3 lifecycle, recovery hardening, agent-facing
surfaces, and the related documentation/tooling work.

**[Read the complete “what changed” article](docs/changes/2026-08-26-model-independent-control-platform.md).**

That article is the durable high-level change record for the 132-commit merge
and links to the lower-level architecture, implementation, and acceptance
evidence.

## Start here

- **[What changed in the model-independent control platform merge](docs/changes/2026-08-26-model-independent-control-platform.md)**
- [Control platform architecture](docs/control-platform.md)
- [Agent control operating manual](docs/agent-control.md)
- [Native VST3 architecture](docs/native-vst3.md)
- [Packaged runtime acceptance](acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](implementation-trackers/model-independent-control-platform.md)

## What the project supports today

| Surface | Responsibilities |
| --- | --- |
| **Browser/local** | SolidJS DAW UI, local projects, timeline editing, audio/MIDI project state, Web Audio playback/DSP, recording, waveform work, MediaBunny import/export, IndexedDB history/entities, and OPFS media. |
| **Cloud/shared** | Authenticated project access, Convex realtime state, sharing/collaboration, project control, backups, assets, exports, and Cloudflare R2 storage behind API/role boundaries. |
| **Desktop/native** | Electron project mounting, authenticated local control, transport, diagnostics, import/export, native CoreAudio hosting, packaged native artifacts, and trust-gated VST3 hosting. |
| **Agent/automation** | Capability-driven project discovery, canonical snapshots, preview/approval/commit, history/recovery, plus bounded desktop runtime operations through SDK, CLI, JSONL, MCP, REST, and the authenticated desktop adapter. |

The browser remains the portable product surface. Native VST3 binaries are not
loaded by browser or cloud targets.

## Model-independent project control

Project semantic control is owned by one canonical operation catalog:

```text
project.list
project.current            # desktop only
control.capabilities
control.snapshot
control.preview
control.requestApproval
control.commit
control.history
control.recoveries
```

The canonical workflow is:

```text
discover
  → capabilities
  → snapshot
  → preview exact request
  → approval when required
  → keyed commit
  → fresh snapshot / history
```

Capabilities and snapshots are canonical V2 representations. Preview,
approval, commit, history, and recovery retain the V1 compatibility request
contracts. A revision conflict means the stale plan must be discarded and
rebuilt from a fresh snapshot.

Cloud project control currently exposes 39 semantic action kinds. Local desktop
project control exposes those actions plus the local-only
`external-plugin.parameters.set` action when advertised by capabilities.
Exact schemas and limits are source-owned by `@daw-browser/control`; do not
infer support from UI labels or host status.

Read [docs/control-platform.md](docs/control-platform.md) for ownership and
transport details and [docs/agent-control.md](docs/agent-control.md) for the
complete action inventory and safe workflow.

## Agent and automation discoverability

Repository-scoped Factory skills describe the supported control boundaries:

- [`daw-project-control`](.factory/skills/daw-project-control/SKILL.md) — discover,
  inspect, preview, approve, commit, recover, and audit semantic project changes.
- [`daw-desktop-runtime`](.factory/skills/daw-desktop-runtime/SKILL.md) — host
  status, transport, diagnostics, local import/export, and bounded VST reads.
- [`daw-vst3`](.factory/skills/daw-vst3/SKILL.md) — VST discovery/trust,
  parameters, packaged native lifecycle, recovery, and acceptance boundaries.

Agents and integrations should use the public adapters rather than raw Convex,
IndexedDB, native frames, registration/socket internals, or plugin state
artifacts.

Public integration entry points include:

- `@daw-browser/control-sdk` → `createCanonicalControlClient`,
  `createJsonlRpcAdapter`, and retained REST compatibility APIs.
- `@daw-browser/control-sdk/desktop` → `connectDesktopControl`.
- `daw-control` CLI → cloud/desktop project control plus separate `host ...`
  runtime commands.
- MCP → canonical V2 reads, preview/approval/commit/history/recovery, and
  separately named host tools.
- Worker REST → retained `/api/control/v1` and canonical V2 read routes.

`daw-control rpc --target host` is project-control JSONL over the authenticated
desktop host. It is not a generic native/runtime RPC escape hatch.

## Desktop and native VST3

The Electron desktop runtime adds native capabilities without moving project
semantics into the native layer.

On macOS, VST3 hosting includes:

- automatic discovery of standard system/user VST3 directories;
- explicit trust acknowledgement before first native scan/execution;
- canonical-path, quarantine, code-signing, architecture, scanner, fingerprint,
  packaged-artifact, protocol, and bus-layout validation;
- isolated playback and editor worker lifecycles;
- bounded public instance/parameter reads;
- normalized parameter writes through canonical project control;
- bounded opaque state capture with SHA-256 validation when supported;
- cold-restart restoration and stale-catalog revalidation;
- bounded worker/native-host recovery;
- manual parameter automation overrides and explicit schedule re-enable;
- native playback and WAV export through the packaged host.

Worker isolation is a crash/availability boundary, not a malicious-code
sandbox. Arbitrary plugin insertion/removal, process control, raw native calls,
and arbitrary package/DSP loading are deliberately not public operations.

Current native Phase A export rejects projects containing automation. The
certified product flow also requires stopped transport before automation
re-enable succeeds. See [docs/native-vst3.md](docs/native-vst3.md) for exact
current behavior and limits.

## Runtime architecture

### Browser/local and cloud

```text
SolidJS app
  ├─ local project repositories
  │    └─ IndexedDB entities/history + OPFS assets
  ├─ authenticated cloud adapters
  │    └─ Hono Worker API
  │         ├─ Better Auth / OAuth
  │         ├─ Convex realtime/project state
  │         └─ Cloudflare R2 assets/backups/exports
  └─ portable audio
       └─ Web Audio API + MediaBunny + workspace audio packages
```

### Desktop/native

```text
Electron renderer
  └─ typed preload / desktop protocol
       └─ Electron main authority
            ├─ private authenticated registration/socket host
            ├─ local project-control authority
            ├─ transport / diagnostics / import / export
            └─ native audio host
                 ├─ VST3 scanner/catalog/trust checks
                 ├─ playback workers
                 └─ editor workers/windows
```

### Control path

```text
UI / Extension / Agent / SDK / CLI / MCP / REST
                      │
                ControlClient
                      │
                ControlInvoker
             ┌────────┼────────┐
            HTTP    Desktop   Direct
             └────────┼────────┘
                ControlHandler
                      │
                 control-core
                      │
             canonical project state
```

Desktop runtime IDs such as transport, diagnostics, import/export, and VST
reads remain owned by `@daw-browser/desktop-protocol`; they are not project
semantic actions.

## Technology stack

| Area | Technology |
| --- | --- |
| UI | SolidJS, Tailwind CSS v4, Kobalte, TanStack Router |
| Client state | Solid signals/stores, TanStack Solid Query, IndexedDB via `idb` |
| Audio | Web Audio API, MediaBunny 1.55.1, portable WASM/native audio contracts |
| Cloud API | Hono on Cloudflare Workers |
| Realtime/backend | Convex |
| Auth | Better Auth, OAuth, D1, KV, Convex JWT bridge |
| Storage | OPFS locally; Cloudflare R2 for cloud assets, backups, and exports |
| Tooling | Bun, TypeScript, Vite, Wrangler, Oxlint, Knip |
| Desktop/native | Electron, C++/CMake native hosts, CoreAudio, VST3 SDK |

## Workspace packages

All packages are private Bun workspaces. Package manifests remain the source of
truth for exports and scripts.

| Package | Responsibility |
| --- | --- |
| `@daw-browser/shared` | Cross-runtime schemas and pure helpers for project, media, timeline, and routing contracts. |
| `@daw-browser/control` | Versioned control contracts, actions, snapshots, capabilities, serialization, recovery payloads, and the keyed operation catalog. |
| `@daw-browser/control-core` | Pure semantic planning, projection, MIDI, destructive transforms, and recovery ordering. |
| `@daw-browser/control-sdk` | Transport-neutral canonical client, REST compatibility client, JSONL adapter, and desktop client entry point. |
| `@daw-browser/control-cli` | `daw-control`, OAuth credentials, cloud control commands, desktop host commands, JSONL, and MCP startup. |
| `@daw-browser/control-mcp` | MCP tools over canonical project control plus bounded desktop runtime tools. |
| `@daw-browser/desktop-protocol` | Desktop wire frames, registration/socket discovery, host-runtime schemas, native audio bridge contracts, and menu protocol. |
| `@daw-browser/timeline-core` | Pure timeline types, clip placement, track indexing, routing, fades, and audio time mapping. |
| `@daw-browser/waveforms` | Peak extraction, persistence, resampling, viewport selection, and waveform rendering helpers. |
| `@daw-browser/audio-engine` | Web Audio facade, scheduling, mixing/effects, metering, portable runtimes, and MediaBunny export support. |
| `@daw-browser/audio-core-contract` | Generated processor metadata and shared native/WASM audio-core contracts plus native test/build scripts. |
| `@daw-browser/audio-core-wasm` | WASM-facing audio-core implementation over the audio-core contract. |
| `@daw-browser/plugin-host-protocol` | Typed native VST3 worker startup, control, transport, state, editor, and preflight protocol. |
| `@daw-browser/external-plugins` | Browser-safe/native-boundary schemas and helpers for external plugin metadata and control. |

The Electron app under `apps/desktop` owns main/preload lifecycle, release
packaging, native artifact selection, and desktop runtime authority.

## Repository structure

```text
api/                     Hono Worker routes, auth, control, assets, exports
convex/                  Convex schema, queries, mutations, access checks
apps/desktop/            Electron main/preload, packaging, native orchestration
packages/                Control, protocol, audio, timeline, and shared packages
src/                     Solid app, repositories, controllers, and adapters
native/                  C++ audio/VST3 hosts, workers, scanner, and tests
docs/                    Current architecture, operations, and change articles
.factory/skills/         Repo-scoped agent operating skills
acceptance-reports/      Packaged/runtime certification evidence
implementation-trackers/ Historical implementation evidence
```

## Installation

Prerequisites depend on the surface being exercised. Browser/local development
needs Bun and Node.js ecosystem compatibility. Cloud development additionally
needs the applicable Convex/Cloudflare/Auth configuration. Native VST3
packaging additionally needs the macOS native toolchain and explicitly enabled
release artifacts.

```sh
git clone https://github.com/jhomra21/daw-browser-convex.git
cd daw-browser-convex
bun install
cp example.env .env
```

Fill only the environment values needed for the flow being exercised. Common
cloud values include `VITE_CONVEX_URL`, `BETTER_AUTH_SECRET`,
`BETTER_AUTH_URL`, OAuth credentials, Convex signing keys, and the R2
maintenance token.

Do not start a development server merely to run static checks or documentation
work.

## Development and quality gates

Core repository gates:

```sh
bun run check:packages
bun run typecheck
bun run test
bun run test:anti-slop
bun run test:control-platform
bun run test:control-compat
bun run lint
bun run knip
bun run build
```

Desktop-specific checks and packaging:

```sh
bun --cwd apps/desktop run check
bun --cwd apps/desktop run test:portable-wasm-worklet
bun --cwd apps/desktop run package
bun --cwd apps/desktop run make
```

Native audio/VST3 build and CTest commands live with the scripts under
`native/` and `@daw-browser/audio-core-contract`. Packaged VST3 hosting requires
the explicit native release/artifact gate; a normal browser build does not
automatically enable it.

Opt-in development servers include `bun dev`, `bunx convex dev`, and
`wrangler dev` when the task actually requires a running browser/cloud session.

## Latest merge certification

The model-independent control platform was runtime-certified before merge and
then followed only by documentation/repository-guidance changes before the
final PR head. The accepted merge evidence records:

- **2,433 passed, 1 skipped, 0 failed** in the full Bun suite;
- **161 passed** in the focused control-platform suite;
- **40 passed** in control compatibility;
- **18 passed** in renderer lifecycle coverage;
- **5 passed** in the native session bridge coverage;
- **12/12 anti-slop RuleTester suites passed**;
- **0 Oxlint warnings/errors**;
- TypeScript checks passed;
- native CTest **6/6 passed** at the runtime-certified ancestor;
- production build and final unsigned Electron package passed;
- packaged browser/native VST3 acceptance, worker-loss recovery, renderer
  reload/crash recovery, cold restart, and verified WAV export passed.

See the [acceptance report](acceptance-reports/control-platform-runtime-2026-08-20.md)
for the exact evidence, environmental skips, and known boundaries.

## Compatibility policy

V1/V2 control contracts, REST routes, desktop protocol frames, CLI commands,
MCP tools, durable rows, and `registration-v1.json` remain compatibility
surfaces. Canonicalization is additive; older surfaces are not removed merely
because a newer canonical owner exists.

Current intentionally narrow boundaries include:

- no public arbitrary operation endpoint;
- no public arbitrary native/runtime RPC;
- no external extension package loader;
- no arbitrary VST3 insertion/removal API;
- no arbitrary DSP/package loader;
- no cloud JSONL process transport;
- no claim that native worker isolation makes third-party plugins safe;
- portable/cloud opaque VST state transport remains separate future scope.

## Change history and evidence

For the platform transition that produced the current architecture:

- [Model-independent control platform: what changed](docs/changes/2026-08-26-model-independent-control-platform.md)
- [Control platform architecture](docs/control-platform.md)
- [Agent control operating manual](docs/agent-control.md)
- [Native VST3 architecture](docs/native-vst3.md)
- [Packaged runtime acceptance](acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](implementation-trackers/model-independent-control-platform.md)

## License

MIT. See `package.json`.
