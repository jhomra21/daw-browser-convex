# DAW Browser Convex

**Last Updated: 2026-08-26**

DAW Browser Convex is a local-first digital audio workstation with a portable
browser core and an Electron desktop runtime for native audio and VST3
features. Projects can remain local in browser storage or use authenticated
Convex and Cloudflare services for sharing, realtime collaboration, backups,
assets, and exports.

The repository follows Ableton-style interaction patterns while keeping
browser, cloud, desktop, and native responsibilities explicit.

## Start here

- **[What changed in the model-independent control platform merge](docs/changes/2026-08-26-model-independent-control-platform.md)**
- [Control platform architecture](docs/control-platform.md)
- [Agent and automation contract](docs/agent-control.md)
- [Native VST3 architecture](docs/native-vst3.md)

Historical implementation and certification evidence is retained separately:

- [Packaged runtime acceptance](acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](implementation-trackers/model-independent-control-platform.md)

## Agent/Automation

Agents and integrations must use the capability-first workflow in
[the agent control manual](docs/agent-control.md). Discover the project, read
canonical V2 capabilities and snapshot state, preview, obtain approval when
required, commit with keyed idempotency, and re-observe. Do not access raw
Convex, IndexedDB, native frames, registration internals, or plugin state
artifacts when a public adapter exists.

## Desktop/Native Runtime

The authenticated Electron desktop host owns transport, diagnostics, local
import/export, VST discovery, and bounded VST reads. These runtime operations
are separate from project semantic actions. VST parameter writes use the
canonical local project-control action only when advertised by local
capabilities. See [native VST3 architecture](docs/native-vst3.md).

## Current highlights

- Browser-local projects use IndexedDB for entities and history and OPFS for
  local media.
- Cloud/shared projects use the Worker API, Convex realtime state, Better Auth,
  and project-scoped R2 assets.
- The portable browser audio path uses Web Audio API, MediaBunny, built-in
  instruments/effects, recording, waveform rendering, and offline export.
- The Electron desktop path adds authenticated project control, native
  transport/import/export, CoreAudio-backed audio hosting, and trust-gated VST3
  hosting.
- The canonical control surface is capability-driven: discover, read the
  canonical V2 state, preview, obtain approval when required, commit with a
  keyed idempotency request, and re-observe.
- Project semantic actions and desktop runtime operations are separate
  catalogs. See the control and VST3 docs before adding an adapter.
- Public adapters have exact entry points and names: the SDK exports
  `createCanonicalControlClient`, `createJsonlRpcAdapter`, and desktop
  `connectDesktopControl`; the CLI executable is `daw-control`; MCP prefers
  `control_capabilities_v2` and `control_snapshot_v2`.

## Runtime architecture

### Browser path

```text
SolidJS app
  ├─ local project repositories
  │    └─ IndexedDB entities/history + OPFS assets
  ├─ optional authenticated cloud adapters
  │    └─ Hono Worker API ── Convex realtime state
  └─ portable audio
       └─ Web Audio API + MediaBunny + workspace audio packages
```

### Desktop and native path

```text
Electron renderer
  ├─ browser UI and local project state
  └─ typed desktop protocol
       └─ Electron main/preload authority
            ├─ authenticated registration/socket control host
            ├─ native audio host and CoreAudio lifecycle
            ├─ VST3 scanner/catalog/trust boundary
            └─ isolated VST3 worker/editor processes
```

### Control path

```text
SDK / CLI / MCP / REST
  └─ compatibility adapter
       └─ canonical control catalog
            ├─ cloud handlers → authenticated Convex gateway
            └─ desktop handlers → local project authority
```

Host runtime IDs such as transport, diagnostics, import/export, and VST
discovery are owned by the desktop protocol. They are not project semantic
actions.

## Technology stack

| Area | Technology |
| --- | --- |
| UI | SolidJS, Tailwind CSS v4, Kobalte, TanStack Router |
| Client state | Solid signals/stores, TanStack Solid Query, IndexedDB via `idb` |
| Audio | Web Audio API, MediaBunny, portable WASM/native audio contracts |
| Cloud API | Hono on Cloudflare Workers |
| Realtime/backend | Convex |
| Auth | Better Auth, OAuth, D1, KV, Convex JWT bridge |
| Storage | OPFS locally; Cloudflare R2 for cloud assets, backups, and exports |
| Tooling | Bun, TypeScript, Vite, Wrangler, Oxlint, Knip |
| Desktop/native | Electron, C++/CMake native hosts, VST3 SDK |

## Workspace packages

All packages are private Bun workspaces. Their manifests are the source of
truth for exports and scripts.

| Package | Responsibility |
| --- | --- |
| `@daw-browser/shared` | Cross-runtime schemas and pure helpers for project, media, timeline, and routing contracts. |
| `@daw-browser/control` | Versioned control contracts, action schemas, snapshots, serialization, recovery payloads, and the keyed operation catalog. |
| `@daw-browser/control-core` | Pure semantic planning, projection, MIDI, deletion, and recovery ordering used by authorities. |
| `@daw-browser/control-sdk` | Transport-neutral canonical client, legacy REST compatibility client, JSONL adapter, and authenticated desktop client entry point. |
| `@daw-browser/control-cli` | `daw-control` CLI, OAuth credentials, cloud REST commands, desktop host commands, and MCP process startup. |
| `@daw-browser/control-mcp` | MCP server/tool adapter over control contracts, cloud services, and desktop host tools. |
| `@daw-browser/desktop-protocol` | Desktop wire frames, registration/socket discovery, host-runtime schemas, native audio bridge contracts, and menu protocol. |
| `@daw-browser/timeline-core` | Pure timeline types, clip placement, track indexing, routing, fades, and audio time mapping. |
| `@daw-browser/waveforms` | Peak extraction, persistence, resampling, viewport selection, and waveform rendering helpers. |
| `@daw-browser/audio-engine` | Web Audio facade, scheduling, mixing/effects, metering, portable runtimes, and MediaBunny export support. |
| `@daw-browser/audio-core-contract` | Generated processor metadata and shared native/WASM audio-core contracts plus native test/build scripts. |
| `@daw-browser/audio-core-wasm` | WASM-facing audio-core implementation over the audio-core contract. |
| `@daw-browser/plugin-host-protocol` | Typed native VST3 worker startup, control, transport, state, editor, and preflight protocol. |
| `@daw-browser/external-plugins` | Browser-safe/native-boundary schemas and helpers for external plugin metadata and control. |

The Electron app in `apps/desktop` is not a workspace package summary shortcut:
it owns main/preload lifecycle, release packaging, native artifact selection,
and the desktop runtime authority.

## Repository structure

```text
api/                    Hono Worker routes, auth, control, assets, exports
convex/                 Convex schema, queries, mutations, access checks
apps/desktop/           Electron main/preload, packaging, native orchestration
packages/               Private pure contracts, control, audio, timeline, and protocol packages
src/                    Solid app, local/cloud repositories, controllers, and adapters
native/                 C++ audio and VST3 hosts, workers, scanner, and tests
docs/                   Current architecture and automation references
acceptance-reports/     Historical packaged/runtime evidence
implementation-trackers/ Historical implementation evidence
```

## Installation and local configuration

Prerequisites:

- Bun
- Node.js for ecosystem tooling compatibility
- Convex project access for cloud/realtime development
- Cloudflare Workers/R2/D1/KV access for deployment
- OAuth credentials for authenticated flows

```sh
git clone https://github.com/jhomra21/daw-browser-convex.git
cd daw-browser-convex
bun install
cp example.env .env
```

Fill only the environment values needed for the flow being exercised. Common
values include `VITE_CONVEX_URL`, `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`,
OAuth credentials, Convex signing keys, and the R2 maintenance token.

## Quality gates and development commands

These are opt-in commands; agents must not start a dev server unless the task
explicitly asks for it.

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

Native audio/VST3 build and CTest commands are documented by the scripts under
`native/` and the `audio-core-contract` package. Packaging VST3 hosting requires
the explicit release environment and native artifact manifest; it is not
implicitly enabled by a browser build.

Opt-in local servers, when needed for a manually requested browser/cloud
session, are `bun dev`, `bunx convex dev`, and `wrangler dev`. They are not
required for static type checks, tests, or documentation work.

## Browser, cloud, and desktop responsibilities

The browser is the portable product surface. It owns UI, local repositories,
Web Audio playback, built-in processors, recording, waveform work, and
MediaBunny export. It does not load native VST3 binaries.

The cloud surface owns authenticated project access, Convex-backed shared
state, role checks, project control, R2 assets/backups/exports, and collaboration
routes. Cloud control supports the canonical cloud operations; it does not
provide desktop-only `project.current` or a cloud JSONL process transport.

The desktop surface owns local project mounting, native capability tokens,
transport and diagnostics, audio import/export, native host lifecycle, VST3
catalog/trust, and the authenticated registration/socket boundary. Read
[docs/native-vst3.md](docs/native-vst3.md) for the limits of that boundary.

## Local-first persistence

Local projects use a global project database and one database per project. The
project stores include entities, assets, project state, history, and sync
state. OPFS holds local media. Cloud-capable projects retain backup manifests,
asset mappings, deleted-asset bookkeeping, and restore information so local
work can continue without making the cloud the primary editor state.

## Cloud API and storage

`api/index.ts` registers authentication, Convex auth, control, samples,
backups, exports, timeline operations, sharing, and maintenance route modules.
Convex stores project metadata, ownership/membership, tracks, clips, mixer
channels, effects, samples, operations, backups, exports, and messages.

Cloudflare R2 stores project assets, uploaded samples, backup assets, and
exports. Project-scoped authorization and role checks remain at the API/Convex
boundary; do not treat R2 keys as a public control reference.

## Audio engine

`@daw-browser/audio-engine` coordinates the browser `AudioContext`, transport
clock, source registry, clip/MIDI scheduling, live mixer/effects graph,
metering, master effects, metronome, synth runtime, native projection, and
MediaBunny/offline export helpers. Package exports are exactly those declared
in its manifest; internal files are not implied public API.

## Compatibility policy

V1/V2 control contracts, REST routes, desktop protocol frames, CLI commands,
MCP tools, durable rows, and `registration-v1.json` remain compatibility
surfaces. The canonical operation catalog is additive and does not justify
deleting an older entry point without repository and deployed-consumer
evidence.

The current control and runtime limits are intentionally narrow: no public
arbitrary operation endpoint, external extension package loading, arbitrary
DSP/package loading, or cloud JSONL process transport.

## License

MIT. See `package.json`.
