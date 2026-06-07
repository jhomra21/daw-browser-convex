> **Last Updated**: 2026-06-06

# Collaborative Realtime DAW

Browser-based digital audio workstation built with SolidJS, Convex, Cloudflare Workers, the Web Audio API, and MediaBunny. The app supports local-first projects, cloud/shared projects, timeline editing, recording, mixing, effects, AI-assisted timeline commands, cloud backups, and authenticated R2-backed media storage.

## Table of Contents

- [Overview](#overview)
- [Current Highlights](#current-highlights)
- [Tech Stack](#tech-stack)
- [Architecture](#architecture)
- [Workspace Packages](#workspace-packages)
- [Project Structure](#project-structure)
- [Getting Started](#getting-started)
- [Development Workflow](#development-workflow)
- [Frontend App](#frontend-app)
- [Local-First Storage](#local-first-storage)
- [Backend API](#backend-api)
- [Convex Data Model](#convex-data-model)
- [Authentication](#authentication)
- [Audio Engine](#audio-engine)
- [Cloud Backups, Exports, and R2](#cloud-backups-exports-and-r2)
- [AI and Agent Commands](#ai-and-agent-commands)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [License](#license)

## Overview

This repository is a full-stack DAW prototype with a SolidJS single-page app, a Hono/Cloudflare Worker API, Convex realtime/backend state, and private Bun workspace packages for shared contracts, timeline logic, waveform processing, and Web Audio runtime code.

The codebase is now split around runtime boundaries:

- `src/` owns the frontend app, UI orchestration, local project flows, hooks, and app adapters.
- `api/` owns the Cloudflare Worker API, auth/session integration, R2 operations, exports, cloud backups, timeline operation execution, and AI routes.
- `convex/` owns realtime data, role checks, mutations, queries, and backend project state.
- `packages/` owns reusable pure/domain/runtime packages that are checked independently.

## Current Highlights

- **Local-first projects**: Local projects are stored in IndexedDB and OPFS, with project-specific entity, asset, history, and sync stores.
- **Cloud/shared projects**: Authenticated projects can be shared with owner/editor/viewer roles and synced through Convex plus Worker API operations.
- **Timeline editing**: Track/clip creation, drag/drop, resizing, MIDI clips, multi-selection, undo/redo, clip import, recording, and missing-media recovery.
- **Audio playback and mixing**: Web Audio playback, BPM/transport mapping, metronome, synth/MIDI scheduling, live mixer routing, EQ/reverb, meters, spectra, and offline export.
- **Cloud backup flow**: Local projects can be backed up to R2 with manifests, asset mappings, deleted asset tracking, and restore support.
- **AI-assisted editing**: Worker routes validate agent command envelopes and stream chat through OpenRouter/AI SDK.
- **Package-boundary checks**: Workspace packages have local TypeScript checks, and root `typecheck` composes package, app, and API checks.

## Tech Stack

| Layer | Technology |
| --- | --- |
| UI | SolidJS, Tailwind CSS v4, Kobalte, TanStack Router |
| Client state | TanStack Solid Query, Solid signals/stores, IndexedDB via `idb` |
| Audio | Web Audio API, package-local audio engine, MediaBunny export tooling |
| Backend API | Hono on Cloudflare Workers |
| Realtime/backend data | Convex |
| Auth | Better Auth, Google OAuth, D1, KV, custom Convex JWT bridge |
| Storage | Cloudflare R2 for samples, assets, backups, and exports; OPFS for local assets |
| AI | AI SDK and OpenRouter provider |
| Tooling | Bun workspaces, TypeScript, Vite, Wrangler, Knip |

## Architecture

```txt
Browser / Solid app
  ├─ local projects: IndexedDB + OPFS
  ├─ cloud/shared projects: Worker API + Convex
  ├─ audio playback: @daw-browser/audio-engine
  └─ waveform helpers: @daw-browser/waveforms

Cloudflare Worker / Hono API
  ├─ Better Auth session routes
  ├─ Convex auth token bridge
  ├─ R2 sample, asset, export, and backup routes
  ├─ shared timeline operation endpoint
  ├─ share/member/project routes
  └─ AI agent/chat routes

Convex backend
  ├─ project, ownership, invite, and role data
  ├─ tracks, clips, mixer channels, effects, samples, exports
  ├─ cloud backup and R2 delete queue tables
  └─ chat and shared operation result tables

Workspace packages
  ├─ @daw-browser/shared
  ├─ @daw-browser/timeline-core
  ├─ @daw-browser/waveforms
  └─ @daw-browser/audio-engine
```

## Workspace Packages

The repository uses Bun workspaces with `packages/*`. Root depends on the private workspace packages via `workspace:*`.

### `@daw-browser/shared`

Pure cross-runtime contracts and helpers used by the app, API, and Convex:

- agent command schemas and command targets
- audio source metadata/rules
- clip create payload construction
- clip timing normalization
- default sample URL/key rules
- effect parameter defaults and serializers
- local ID helpers
- project manifest contracts and role helpers
- R2 delete key validation
- shared timeline operation schema, descriptors, durable operation metadata, and target extraction
- track routing core rules

Public export: `@daw-browser/shared`.

### `@daw-browser/timeline-core`

Pure timeline domain types and helpers:

- canonical `Track`, `Clip`, routing, send, selected clip, and channel-role types
- clip placement and non-overlap helpers
- track indexing helpers
- track routing compatibility logic

Public exports include `@daw-browser/timeline-core/types`, `track-index`, `track-routing`, and `clip-placement`.

### `@daw-browser/waveforms`

Waveform peak utilities:

- peak extraction and encoded peak data
- peak persistence/cache helpers
- resampling and viewport selection
- canvas waveform rendering

### `@daw-browser/audio-engine`

Web Audio runtime package:

- public `AudioEngine` facade
- offline export mixdown
- clip scheduling, transport clock, source registry
- live mixer/effects routing
- metering, spectra, master FX, metronome, and synth/MIDI runtimes

Only `./audio-engine`, `./export-mixdown`, and `./export-audio-support` are public package exports; internal runtime modules use relative imports inside the package.

## Project Structure

```txt
<root>/
├── api/                         # Hono Worker API, auth bridge, R2/cloud/export/agent routes
├── convex/                      # Convex schema, queries, mutations, access checks
├── implementation-trackers/     # Completed implementation/validation trackers
├── migrations/                  # D1 Better Auth migrations
├── packages/
│   ├── audio-engine/            # Web Audio runtime and export mixdown package
│   ├── shared/                  # Cross-runtime contracts and pure helpers
│   ├── timeline-core/           # Timeline types and pure timeline logic
│   └── waveforms/               # Waveform peak extraction/rendering helpers
├── src/
│   ├── components/              # Solid UI, timeline, effects, dialogs, app panels
│   ├── hooks/                   # Timeline/audio/persistence/selection/recording controllers
│   ├── lib/                     # App adapters, local storage, cloud sync, undo, API clients
│   ├── routes/                  # TanStack Router routes
│   ├── main.tsx                 # SPA bootstrap
│   └── index.css                # Tailwind entrypoint
├── public/                      # Static assets
├── tsconfig.base.json           # Shared TypeScript compiler base
├── tsconfig.json                # App/Convex/Vite TypeScript config
├── wrangler.jsonc               # Worker bindings and vars
└── package.json                 # Bun workspace scripts and dependencies
```

## Getting Started

### Prerequisites

- Bun
- Node.js for ecosystem tooling compatibility
- Convex CLI/project access
- Cloudflare account with Workers, R2, D1, and KV
- Google OAuth credentials for Better Auth

### Installation

```bash
git clone https://github.com/jhomra21/daw-browser-convex.git
cd daw-browser-convex
bun install
```

Copy the example env file and fill in local credentials:

```bash
cp example.env .env
```

Common variables/secrets used by the app and Worker include:

- `VITE_CONVEX_URL`
- `BETTER_AUTH_SECRET`
- `BETTER_AUTH_URL`
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `CONVEX_AUTH_PRIVATE_JWK`
- `CONVEX_AUTH_JWKS`
- `CONVEX_AUTH_ISSUER`
- `OPENROUTER_API_KEY`
- `R2_DELETE_QUEUE_DRAIN_TOKEN`
- optional `VITE_AUTH_BASE_URL` for testing against a remote Worker origin

Run Convex separately when developing realtime/cloud flows:

```bash
bunx convex dev
```

Run the Vite dev server:

```bash
bun dev
```

For Worker-local testing, use Wrangler with the configured bindings:

```bash
wrangler dev
```

## Development Workflow

### Root scripts

- `bun dev` / `bun start`: start the Vite dev server.
- `bun run build`: production build through Vite and the Cloudflare Vite plugin.
- `bun serve`: preview the production build locally.
- `bun run check:packages`: run TypeScript checks for all workspace packages.
- `bun run typecheck`: run package checks, app check, and API check.
- `bun run knip`: run unused dependency/export analysis.

### TypeScript setup

- `tsconfig.base.json` contains shared strict compiler settings.
- Root `tsconfig.json` is app-focused and includes `src`, `convex`, and `vite.config.ts` with `~/*` and `@/*` aliases for `src/*`.
- `api/tsconfig.json` extends the shared base instead of the app config and includes Worker/API-specific types.
- Each workspace package has its own `tsconfig.json` and `check` script.

## Frontend App

The frontend is a SolidJS SPA with TanStack Router and TanStack Query.

Key areas:

- `src/routes/index.tsx`: local project picker or lazy-loaded timeline route.
- `src/routes/Login.tsx`: Better Auth login flow with redirect handling.
- `src/components/Timeline.tsx`: studio orchestrator for data, local/cloud persistence, projection, selection, transport, audio, recording, mixer, undo/redo, dialogs, and timeline UI.
- `src/components/timeline/`: transport, track lanes, clips, ruler, overlays, effects panel, project/media menus, cloud backup dialog, export dialog, and delete dialogs.
- `src/components/effects/`: EQ, synth, reverb, arpeggiator, and synth card controls.
- `src/hooks/`: controllers for clip buffers, drag/resize/import/actions, playback, recording, mixer, preferences, exports, samples, persistence, cloud sync, local mix, route identity, and history.
- `src/lib/`: app adapters for Convex, auth, local project DBs, local/cloud assets, cloud backups, project manifests, shared outbox, timeline repositories, undo, clip mutations, audio source/cache, sharing, and exports.

## Local-First Storage

Local projects use IndexedDB and OPFS:

- global DB: `daw-browser-projects`
- per-project DBs: `daw-browser-project-{projectId}`
- project stores: `entities`, `assets`, `projectState`, `history`, and `syncState`
- local assets use OPFS through `navigator.storage.getDirectory()`
- local projects track modes such as `local-only` and `backup`

Cloud-capable local projects can back up manifests and assets to R2. The app tracks cloud asset mappings, deleted cloud assets, and sync bookkeeping so a project can be restored or continue backing up later.

## Backend API

`api/index.ts` builds the Hono Worker app and registers route modules for auth, samples, cloud backups, exports, timeline operations, share invites/members, agent routes, maintenance, and Convex auth.

Important route groups:

- `/api/auth/*`: Better Auth handlers.
- `/api/session`: current user/session data.
- `/api/convex-auth/token` and `/.well-known/jwks.json`: Convex custom JWT bridge.
- `/api/default-samples`, `/api/default-sample`: default sample access.
- `/api/samples`: upload, stream, and delete project-scoped R2 assets.
- `/api/cloud-projects`, `/api/cloud-backups`: cloud project creation, backup, restore, and deletion flows.
- `/api/projects/:projectId/timeline/full-view`: full timeline view through authenticated Convex access.
- `/api/projects/:projectId/timeline/operations`: shared timeline operation endpoint.
- `/api/projects/:projectId/members` and `/api/share-invites`: member management and share invites.
- `/api/exports`: audio export upload/list/delete/stream flows.
- `/api/agent/execute`, `/api/agent/chat`: validated agent command execution and streamed AI chat.
- `/api/maintenance/r2-delete-queue/drain`: protected R2 cleanup route.

## Convex Data Model

Convex stores realtime/project state and enforces project access.

Main tables:

- `projects`: project metadata, owner, name, deletion state.
- `ownerships`: project role markers and optional entity ownership links.
- `shareInvites`: tokenized editor/viewer invites.
- `tracks`: project-scoped tracks and ordering.
- `mixerChannels`: volume, mute, solo, locks, routing, and sends.
- `clips`: audio/MIDI placements, source metadata, timing, and offsets.
- `samples`: sample library entries.
- `effects`: track/master EQ, synth, reverb, and arpeggiator state.
- `cloudBackups`: latest backup manifest metadata and counts.
- `r2DeleteQueue`: retryable queued R2 object deletion.
- `sharedOperationResults`: durable timeline operation results.
- `exports`: uploaded export metadata.
- `chatHistories` and `projectMessages`: agent/chat history.

Access control uses owner/editor/viewer roles. Writes generally require owner/editor, reads allow project members, and project deletion requires owner.

## Authentication

Authentication uses Better Auth on the Worker:

- D1 is the primary Better Auth store through Kysely/D1.
- KV is configured as secondary/cache storage.
- Google OAuth is the configured social provider.
- Session middleware resolves the Better Auth user/session for API routes.
- Convex auth is bridged by Worker-issued ES256 JWTs signed from `CONVEX_AUTH_PRIVATE_JWK` and accepted by `convex/auth.config.ts`.
- The frontend auth client lives in `src/lib/auth-client.ts` and includes credentials on requests.

## Audio Engine

The frontend imports `AudioEngine` from `@daw-browser/audio-engine/audio-engine` and shares one instance through `src/lib/audio-engine-singleton.ts`.

The public facade coordinates focused package modules:

- `audio-runtime.ts`: `AudioContext` creation, closing, decoding, and latency helpers.
- `transport-clock.ts`: BPM and timeline/context time mapping.
- `source-registry.ts`: active source tracking by clip.
- `clip-scheduler.ts`: audio and MIDI scheduling from the current playhead.
- `live-mixer-runtime.ts`: track mixer graph, sends, routing, and live effects.
- `metering-runtime.ts`: track meter worklets, level batching, and spectra.
- `master-fx-runtime.ts`: master EQ, reverb, and analyser state.
- `metronome-runtime.ts`: metronome nodes and tick scheduling.
- `synth-runtime.ts`: synth params, preview state, arpeggiator config, and MIDI note scheduling.

The app coordinates clip decoding, buffer cache status, recording, playback, BPM, metronome, and loop/grid controls through timeline hooks.

## Cloud Backups, Exports, and R2

R2 stores project assets, uploaded samples, cloud backup assets, exports, and default samples.

Current flows:

- sample uploads hash file content and store project-scoped objects under `projects/{projectId}/assets/...`
- cloud backups validate manifests/assets, upload missing assets, upsert latest backup metadata, and queue superseded/deleted R2 keys
- project deletion prepares and finalizes Convex deletion, then queues project R2 prefix cleanup
- exports upload WAV blobs to project-scoped export keys and can be streamed or deleted later
- `r2DeleteQueue` retries cleanup with backoff and has a maintenance drain endpoint protected by bearer token

## AI and Agent Commands

The Worker exposes agent routes for command execution and chat:

- shared command envelopes and targets live in `@daw-browser/shared`
- `/api/agent/execute` validates and executes command payloads
- `/api/agent/chat` streams AI responses through the AI SDK and OpenRouter provider
- project chat/history is persisted through Convex tables

## Deployment

`wrangler.jsonc` configures the Cloudflare Worker, assets, and bindings:

- R2 bucket binding: `daw_audio_samples`
- D1 binding: `daw_convex_auth`
- KV binding: `daw_convex_auth_kv`
- Worker vars such as `BETTER_AUTH_URL`, `CONVEX_AUTH_ISSUER`, `DEFAULT_SAMPLES_BASE_URL`, and `VITE_CONVEX_URL`
- `nodejs_compat` compatibility flag
- SPA asset handling through the Cloudflare Vite plugin

Use Wrangler secrets for private values such as OAuth credentials, Better Auth secret, Convex signing keys, OpenRouter key, and maintenance tokens.

## Troubleshooting

- **Convex data does not load**: verify `VITE_CONVEX_URL`, run `bunx convex dev`, and confirm `/api/convex-auth/token` can issue tokens for signed-in users.
- **Auth fails**: check `BETTER_AUTH_URL`, `BETTER_AUTH_SECRET`, Google OAuth credentials, D1/KV bindings, and cookie origin settings.
- **Samples/assets are missing**: check R2 object keys, project membership, local OPFS permissions, cloud asset mappings, and backup manifest state.
- **Local project cannot access files**: re-grant directory/OPFS access if the browser reports `permission-denied` or media recovery cannot relink assets.
- **Audio does not start**: Web Audio requires a user gesture; start playback from an interaction so the engine can create/resume its `AudioContext`.
- **Package import/type errors**: run `bun run check:packages` first, then `bun run typecheck` to isolate package, app, or API config issues.

## License

This project is released under the MIT License. See `package.json` for the license declaration.
