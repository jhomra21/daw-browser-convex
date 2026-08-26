# DAW Browser Convex

**Last updated: 2026-08-26**

DAW Browser Convex is a local-first digital audio workstation. The browser runs the portable editor and Web Audio engine. The Electron app adds native audio, local host control, and VST3 support on macOS. Cloud projects use Convex and Cloudflare for sharing, realtime state, assets, backups, and exports.

The project follows Ableton-style interaction patterns. Browser, cloud, desktop, native audio, and automation code have separate owners so one layer does not quietly become the API for another.

## What changed recently

PR #47 replaced the old collection of control paths with one model-independent project-control system. It also finished the authenticated desktop adapter and the packaged VST3 lifecycle.

[Read the full change record](docs/changes/2026-08-26-model-independent-control-platform.md). It covers the 132-commit merge, the bugs found during packaged testing, the runtime evidence, and the compatibility decisions that stayed in place.

For current behavior, start with these docs:

- [Control platform architecture](docs/control-platform.md)
- [Agent control manual](docs/agent-control.md)
- [Native VST3 architecture](docs/native-vst3.md)
- [Packaged runtime acceptance](acceptance-reports/control-platform-runtime-2026-08-20.md)

## What runs where

| Target | What it owns |
| --- | --- |
| Browser and local projects | SolidJS editor, timeline state, IndexedDB history and entities, OPFS media, Web Audio playback and DSP, recording, waveform work, built-in processors, and MediaBunny import/export. |
| Cloud projects | Authenticated project access, Convex realtime state, sharing, project control, R2 assets, backups, and exports. |
| Electron desktop | Local project mounting, authenticated host control, transport, diagnostics, file capabilities, native import/export, CoreAudio hosting, and VST3. |
| Agents and external tools | Project discovery and mutation through the control SDK, CLI, MCP, JSONL, REST, or the authenticated desktop client. |

The browser and cloud targets never load native VST3 binaries.

## Project control

Project changes go through one operation catalog:

```text
project.list
project.current
control.capabilities
control.snapshot
control.preview
control.requestApproval
control.commit
control.history
control.recoveries
```

`project.current` exists only on desktop because it refers to the mounted local project.

A normal write follows this order:

```text
project discovery
  -> capabilities
  -> snapshot
  -> preview
  -> approval if preview requires it
  -> commit with an idempotency key
  -> fresh snapshot or history
```

Capabilities and snapshots use the V2 representation. Existing mutation, approval, history, and recovery requests keep their V1 compatibility envelope. If a commit hits `revision-conflict`, fetch a new snapshot and rebuild the request. Do not retry the stale request unchanged.

Cloud capabilities currently advertise 39 project action kinds. Desktop project control adds `external-plugin.parameters.set` when the local capabilities include it. The returned capabilities object decides what a client may do. UI labels and host status do not.

See [docs/control-platform.md](docs/control-platform.md) for ownership and transport details. See [docs/agent-control.md](docs/agent-control.md) for the complete action list and request examples.

## Agents and automation

The repository includes three Factory skills for DAW-specific work:

- [`daw-project-control`](.factory/skills/daw-project-control/SKILL.md) covers semantic project reads and writes.
- [`daw-desktop-runtime`](.factory/skills/daw-desktop-runtime/SKILL.md) covers host status, transport, diagnostics, local import/export, and VST reads.
- [`daw-vst3`](.factory/skills/daw-vst3/SKILL.md) covers plugin trust, discovery, parameters, recovery, and packaged VST testing.

Use the public clients. Do not mutate Convex rows, IndexedDB records, native host state, registration files, sockets, or plugin state artifacts when a supported control path exists.

Public entry points include:

- `@daw-browser/control-sdk` with `createCanonicalControlClient` and `createJsonlRpcAdapter`
- `@daw-browser/control-sdk/desktop` with `connectDesktopControl`
- the `daw-control` CLI
- `@daw-browser/control-mcp`
- Worker routes under `/api/control`

`daw-control rpc --target host` carries project-control JSONL over the authenticated desktop connection. It is not a generic native RPC channel.

## Desktop VST3 support

The macOS desktop app discovers the standard VST3 directories and requires trust acknowledgement before the first native scan. Before launch, the app checks the bundle path, quarantine state, code signature, arm64 support, scanner result, fingerprints, packaged artifacts, protocol versions, and bus layout.

Playback workers and editor workers are separate native processes. That separation helps contain crashes. It is not a security sandbox for malicious plugins. VST3 plugins are native code running with the desktop user's authority, so only load plugins you trust.

Current public VST operations are intentionally small:

```text
host.vst.instances
host.vst.parameters
external-plugin.parameters.set
```

The first two are desktop runtime reads. `external-plugin.parameters.set` is a project-control action and only exists when local capabilities advertise it.

Public control does not currently expose arbitrary plugin insertion, removal, scanner commands, editor-window commands, or worker process control.

Read [docs/native-vst3.md](docs/native-vst3.md) before changing the native plugin path.

## Architecture

```text
SolidJS UI / agent / CLI / MCP
            |
       ControlClient
            |
       ControlInvoker
       /     |     \
     HTTP  Desktop  Direct
       \     |     /
        ControlHandler
            |
        control-core
            |
      project authority
```

Browser and cloud authorities store project state. The desktop authority wraps the mounted local project and also exposes a separate runtime catalog for transport, diagnostics, import/export, and VST reads.

The native path is separate from project semantics:

```text
Electron renderer
      |
Electron main and preload
      |
native audio host
  |       |        |
scanner  playback  editor
         workers   workers
```

## Main packages

| Package | Job |
| --- | --- |
| `@daw-browser/control` | Versioned control schemas, actions, snapshots, serialization, recoveries, capabilities, and operation IDs. |
| `@daw-browser/control-core` | Pure planning, projection, MIDI resolution, destructive transforms, and recovery ordering. |
| `@daw-browser/control-sdk` | TypeScript client, REST compatibility client, JSONL adapter, and desktop client entry point. |
| `@daw-browser/control-cli` | `daw-control`, OAuth credentials, cloud commands, desktop host commands, and MCP startup. |
| `@daw-browser/control-mcp` | MCP tools for project control and desktop runtime operations. |
| `@daw-browser/desktop-protocol` | Desktop framing, registration discovery, authenticated socket client, runtime operation schemas, native bridge contracts, and menu protocol. |
| `@daw-browser/plugin-host-protocol` | VST worker startup, control, transport, state, editor, and preflight protocol. |
| `@daw-browser/external-plugins` | Shared external-plugin metadata and project-control schemas. |
| `@daw-browser/audio-engine` | Browser audio scheduling, mixing, effects, metering, portable runtimes, and MediaBunny export. |
| `@daw-browser/audio-core-contract` | Shared native and WASM audio-core contracts plus generated processor metadata. |
| `@daw-browser/audio-core-wasm` | WASM audio-core implementation. |
| `@daw-browser/timeline-core` | Timeline types, clip placement, routing, fades, and time mapping. |
| `@daw-browser/waveforms` | Waveform peak extraction, persistence, resampling, and rendering helpers. |
| `@daw-browser/shared` | Cross-runtime project, media, timeline, and routing schemas and helpers. |

## Stack

| Area | Technology |
| --- | --- |
| UI | SolidJS, Tailwind CSS v4, Kobalte, TanStack Router |
| Local data | Solid signals and stores, TanStack Solid Query, IndexedDB, OPFS |
| Audio | Web Audio API, MediaBunny, native and WASM audio-core packages |
| Cloud API | Hono on Cloudflare Workers |
| Realtime data | Convex |
| Auth | Better Auth and OAuth |
| Cloud storage | R2, D1, KV |
| Desktop | Electron |
| Native audio and VST3 | C++, CMake, CoreAudio, VST3 SDK |
| Tooling | Bun, TypeScript, Vite, Wrangler, Oxlint, Knip |

## Repository layout

```text
api/                     Worker routes and auth
convex/                  Convex schema and project data functions
apps/desktop/            Electron main, preload, packaging, and native orchestration
packages/                Shared packages for control, audio, timeline, and protocols
src/                     SolidJS app and local/cloud adapters
native/                  Audio hosts, VST scanner/workers, and native tests
docs/                    Current architecture and operating docs
acceptance-reports/      Packaged and runtime evidence
implementation-trackers/ Historical implementation notes
.factory/skills/         Repo-scoped Factory skills
```

## Setup

Requirements depend on what you are running. Browser-only work needs Bun and the normal web dependencies. Cloud work also needs the project credentials for Convex and Cloudflare. Native VST work requires macOS and the packaged native toolchain.

```sh
git clone https://github.com/jhomra21/daw-browser-convex.git
cd daw-browser-convex
bun install
cp example.env .env
```

Fill only the environment variables needed for the task. Do not commit credentials.

## Checks

The main repository checks are:

```sh
bun run lint
bun run test:anti-slop
bun run typecheck
bun test
bun run test:control-platform
bun run test:control-compat
bun run build
```

The merge certification for PR #47 reported 2,433 passing Bun tests, 1 intentional skip, 0 failures, 161 control-platform tests, 40 compatibility tests, 12 anti-slop RuleTester suites, and 6 of 6 native CTests at the runtime-certified commit. Packaged Electron and real ValhallaSupermassive acceptance also passed.

See the [acceptance report](acceptance-reports/control-platform-runtime-2026-08-20.md) for the exact runtime matrix and the cases that remain environment or product skips.

## Current limits

- Native VST3 runs only in the macOS desktop app.
- Public control does not expose arbitrary plugin insertion, removal, editor control, or worker process control.
- Native Phase A export rejects projects that contain automation.
- The current product flow requires stopped transport before automation re-enable succeeds.
- Cloud JSONL process transport is not implemented.
- External extension packages and arbitrary DSP/package loading are not implemented.
- VST worker processes do not make untrusted plugins safe.

## Docs and history

- [What changed in PR #47](docs/changes/2026-08-26-model-independent-control-platform.md)
- [Control platform architecture](docs/control-platform.md)
- [Agent control manual](docs/agent-control.md)
- [Native VST3 architecture](docs/native-vst3.md)
- [Packaged runtime acceptance](acceptance-reports/control-platform-runtime-2026-08-20.md)
- [Completed implementation tracker](implementation-trackers/model-independent-control-platform.md)

## License

MIT. See `package.json`.