> **Last Updated**: 09/27/2025

# Collaborative Realtime DAW

Realtime, collaborative Digital audio workstation built with SolidJS, Convex, and Cloudflare Workers. 

## Table of Contents
- [Overview](#overview)
- [Highlights](#highlights)
- [Tech Stack](#tech-stack)
- [System Architecture](#system-architecture)
- [Project Structure](#project-structure)
- [Environment Setup](#environment-setup)
- [Development Workflow](#development-workflow)
- [Key Features](#key-features)
- [Frontend Modules](#frontend-modules)
- [Backend & API](#backend--api)
- [Data Model](#data-model)
- [Authentication](#authentication)
- [Audio Pipeline](#audio-pipeline)
- [Deployment](#deployment)
- [Troubleshooting](#troubleshooting)
- [Contributing](#contributing)
- [License](#license)

## Overview

The Collaborative Realtime DAW combines SolidJS reactivity with Convex real-time data and Cloudflare edge services to deliver an end-to-end music production workspace. Every clip edit, track automation, and mix decision synchronises across collaborators while maintaining per-user preferences such as solo/mute states and equalizer chains.

## Highlights
- **Multi-tenant projects**: Each user can create and manage independent project rooms backed by Convex.
- **Realtime timeline projection**: Optimistic client projections keep the UI responsive while Convex mutations settle.
- **Edge-native uploads**: Audio samples stream directly to Cloudflare R2 through a secure Hono Worker.
- **Web Audio engine**: Custom scheduler manages clip playback, EQ chains, and metronome timing with sample accuracy.
- **Collaborative mixing**: Mix state can be synchronised across users or isolated locally, toggled per room.

## Tech Stack

| Layer | Technology |
| --- | --- |
| UI | SolidJS, TailwindCSS, `@kobalte/core` |
| State | TanStack Solid Query, TanStack Router |
| Audio | Web Audio API, `mediabunny` tooling |
| Backend | Hono on Cloudflare Workers, Better Auth |
| Storage | Cloudflare R2 (samples), D1 (auth), Convex (timeline data) |
| Tooling | Bun, TypeScript, Wrangler |

## System Architecture

- **Frontend (`src/`)**: SolidJS SPA served through the Worker with routing handled by `@tanstack/solid-router`. Shared QueryClient (`src/lib/query-client.ts`) ensures consistent state across routes.
- **Realtime data (`convex/`)**: Convex schema defines tracks, clips, projects, samples, effects, and ownership. Functions in `convex/*.ts` guard room access and enforce authorization.
- **Worker API (`api/index.ts`)**: Hono app authenticates users, exposes auth proxies, uploads samples to R2, and streams audio back with signed keys.
- **Authentication (`auth.ts`)**: Better Auth instance wraps Cloudflare D1 + KV for primary and secondary storage while registering Google OAuth.
- **Audio engine (`src/lib/audio-engine.ts`)**: Maintains playback graph, EQ routing, and scheduling. Lazy initialisation respects autoplay policies.

## Project Structure

```
<root>/
├── api/
│   └── index.ts              # Hono Worker entrypoint & routes
├── auth.ts                   # Better Auth configuration for Workers
├── convex/
│   ├── schema.ts             # Convex schema definitions
│   ├── tracks.ts             # Track CRUD & mix mutations
│   ├── clips.ts              # Clip CRUD & sample bindings
│   ├── timeline.ts           # Room timeline aggregation
│   ├── effects.ts            # EQ chain persistence
│   ├── samples.ts            # Sample library helpers
│   └── projects.ts           # Project ownership utilities
├── migrations/               # D1 migrations used by Better Auth
├── src/
│   ├── components/           # Solid components (timeline, audio, UI)
│   ├── hooks/                # Timeline hooks (drag, selection, recording)
│   ├── lib/                  # Clients, audio engine, utilities
│   ├── routes/               # File-based routes for TanStack Router
│   ├── main.tsx              # SPA bootstrap
│   └── index.css             # Tailwind entrypoint
├── public/                   # Static assets
├── tailwind.config.cjs       # Tailwind v4 configuration
├── tsconfig.json             # Strict TypeScript config
├── wrangler.jsonc            # Worker bindings (R2, D1, KV)
└── package.json              # Bun scripts & dependency manifest
```

## Environment Setup

### Prerequisites
- **Bun** ≥ 1.1 (preferred package manager/runtime)
- **Node.js** ≥ 18 (for tooling compatibility)
- **Cloudflare account** with Workers, R2, D1, and KV enabled
- **Convex account** connected to the CLI (`bunx convex dev`)
- **Google OAuth credentials** for Better Auth social sign-in

### Configuration Steps
1. **Install dependencies**
   ```bash
   bun install
   ```
2. **Copy environment template**
   ```bash
   cp example.env .env
   ```
   Populate the following keys:
   - **`CONVEX_DEPLOYMENT`**, **`VITE_CONVEX_URL`** (set by Convex CLI)
   - **`BETTER_AUTH_SECRET`**, **`BETTER_AUTH_URL`**
   - **`GOOGLE_CLIENT_ID`**, **`GOOGLE_CLIENT_SECRET`**
   - Optional: **`VITE_AUTH_BASE_URL`** when testing against remote Workers
3. **Cloudflare bindings** (see `wrangler.jsonc`)
   - `daw_audio_samples`: Cloudflare R2 bucket (`daw-audio-samples`)
   - `daw_convex_auth`: Cloudflare D1 database for Better Auth
   - `daw_convex_auth_kv`: KV namespace used as Better Auth secondary storage
   Ensure secrets are uploaded:
   ```bash
   wrangler secret put BETTER_AUTH_SECRET
   wrangler secret put GOOGLE_CLIENT_ID
   wrangler secret put GOOGLE_CLIENT_SECRET
   ```
4. **Convex development server**
   ```bash
   bunx convex dev
   ```
   Follow prompts to link the project; keep the dev server running for hot reloads.

## Development Workflow

- **Start the app**
  ```bash
  bun dev
  ```
  The Worker proxy serves the SPA at `http://localhost:3000`.
- **Local Worker**
  ```bash
  wrangler dev
  ```
  Useful for testing Worker-only routes (`/api/*`).
- **Build artifacts**
  ```bash
  bun run build
  bun run serve   # Preview production bundle
  ```
- **Deploy**
  ```bash
  wrangler deploy
  ```

Scripts are defined in `package.json` to align with Bun’s CLI. Tailwind v4 uses the zero-runtime CSS pipeline enabled through `tailwind.config.cjs`.

## Key Features

- **Collaborative timeline**: `src/components/Timeline.tsx` merges Convex snapshots, optimistic clip moves, and drag placeholders to prevent jitter during multi-user edits.
- **Multi-selection workflow**: `useTimelineSelection.ts` enables marquee and shift-click selection, while `useTimelineClipActions.ts` handles duplication, deletion, and keyboard shortcuts.
- **Audio imports**: `useTimelineClipImport.ts` supports drag-and-drop, sample library insertion, and overlap avoidance before uploading to R2.
- **Recording pipeline**: `useTrackRecording.ts` streams microphone input into the timeline, generating clips and uploading buffers after take completion.
- **Mix management**: Track volume, mute, and solo states are throttled locally (`TrackSidebar.tsx`) and optionally synced through Convex (`tracks.setMix`).

## Frontend Modules

- **`src/components/timeline/TransportControls.tsx`**: Central transport bar controlling playback, recording, BPM, and project management.
- **`src/components/timeline/TrackLane.tsx`**: Renders clips per track, handles drag handles, resizing, and visual feedback.
- **`src/components/timeline/EffectsPanel.tsx`**: Manages master/track EQ editing, wired into Convex effects mutations.
- **`src/components/AudioRecorder.tsx`**: Wraps `mediabunny` for browser capture, including waveform previews.
- **`src/components/VisualEqualizer.tsx`**: Real-time analyser that visualises frequency bands using the Web Audio analyser node.

## Backend & API

- **Auth proxy**: `/api/auth/*` routes pass through Better Auth handlers while respecting CORS (`api/index.ts`).
- **Session middleware**: Global Hono middleware resolves the Better Auth session and surfaces `user` and `session` on the context.
- **Sample uploads**: `/api/samples` sanitises filenames, checks for collisions, writes metadata to R2, and returns a signed fetch URL.
- **Sample streaming**: `/api/samples/:roomId/:clipId` streams from R2, setting cache headers and surfacing the origin key in `X-R2-Key`.

## Data Model

Convex tables (see `convex/schema.ts`):
- **`tracks`**: Room-scoped tracks with ordering, mix state, and locking metadata.
- **`clips`**: Audio clip placements including padding, sample URL, and optional names.
- **`samples`**: User-curated sample library entries referencing R2 URLs.
- **`projects`**: User-to-room mapping with per-owner project names.
- **`ownerships`**: Authorization guard ensuring only owners mutate tracks/clips.
- **`effects`**: Ordered EQ chains per track or master bus with band parameters.

## Authentication

- **Better Auth (`auth.ts`)**: Uses Cloudflare D1 via `kysely-d1` for primary storage and KV as a cache/secondary store. Google OAuth is the default provider; GitHub placeholder is ready for future use.
- **Client helpers (`src/lib/auth-client.ts`)**: Solid-friendly auth client binding ensures credentials are included and supports overriding base URLs for remote Workers.
- **Session hook (`src/lib/session.ts`)**: Exposes `useSessionQuery()` to keep TanStack Query and router guards (`src/routes/index.tsx`) aligned.
- **Login route (`src/routes/Login.tsx`)**: Presents Google sign-in and session awareness via `LoginMethodButton`.

## Audio Pipeline

- **Engine singleton (`src/lib/audio-engine-singleton.ts`)** ensures a shared `AudioEngine` instance across components.
- **Scheduling**: `AudioEngine.scheduleAllClipsFromPlayhead()` computes offsets per clip and rebuilds sources on transport changes.
- **EQ chains**: `effects.ts` mutations persist EQ bands, while the engine hydrates nodes lazily and cleans up when tracks disappear.
- **Metronome & BPM**: `usePlayheadControls.ts` maintains playhead state, while BPM changes propagate to the engine via Solid signals.
- **Buffer cache**: `useClipBuffers.ts` memoises decoded buffers and rehydrates missing audio using sample URLs.

## Deployment

- **Wrangler config (`wrangler.jsonc`)**: Sets `compatibility_date` (2025-09-12), enables `nodejs_compat`, and configures SPA asset handling.
- **Secrets**: Manage via `wrangler secret put`. Deployments automatically attach R2, D1, and KV bindings referenced by the Worker.
- **Static assets**: Vite handles bundling; the Worker serves the SPA with `run_worker_first` to prioritise API routes.

## Troubleshooting

- **Cannot load Convex data**: Verify `CONVEX_DEPLOYMENT`/`VITE_CONVEX_URL` and ensure `bunx convex dev` is running locally.
- **Samples missing**: Check `daw_audio_samples` bucket permissions; ensure upload path `rooms/<roomId>/clips/<filename>` exists.
- **Auth failures**: Confirm Better Auth secrets in Cloudflare and align `BETTER_AUTH_URL` with deployed Worker origin.
- **Audio playback stalled**: User gesture may be required; trigger play from an interaction so `AudioEngine.ensureAudio()` can resume context.

## Contributing

Pull requests are welcome. Please:
- **Run Bun lint/build** before submitting.
- **Describe architectural changes** in the PR body, especially those touching Convex functions or the audio engine.
- **Keep diffs focused**—avoid unrelated refactors when adjusting timeline logic.

## License

This project is released under the MIT License. Refer to `package.json` for the license declaration.

---

Built with ❤️ using SolidJS, Hono, Convex, Cloudflare Workers, and Bun.
