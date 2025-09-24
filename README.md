> **Last Updated**: 09/23/2025

# Collaborative Realtime DAW

A modern, collaborative digital audio workstation (DAW) built with SolidJS, featuring real-time collaboration, drag-and-drop audio editing, and cloud-based audio storage.

## 🎵 Features

### Core Functionality
- **Multi-track Audio Timeline**: Professional-grade audio timeline with multiple tracks
- **Real-time Collaboration**: Multiple users can collaborate on the same project via shared rooms
- **Drag & Drop Audio**: Intuitive drag-and-drop interface for audio clips
- **Audio Playback Engine**: Real-time audio playback with precise timing
- **Visual Equalizer**: Built-in audio effects and visualization
- **Audio Recording**: Integrated audio recording capabilities

## 📁 Project Structure

```
<root>/
├── api/                    # Cloudflare Workers API entry point
│   └── index.ts           # Hono API routes for audio upload/storage to R2
├── convex/                # Convex database schema and functions
│   ├── schema.ts          # Defines the data model for tracks, clips, and ownership
│   ├── timeline.ts        # Backend logic for timeline operations
│   ├── tracks.ts          # Backend logic for track management
│   └── clips.ts           # Backend logic for clip management
├── migrations/            # Database migration files
│   └── *.sql              # SQL files for database schema changes
├── src/                    # SolidJS frontend application
│   ├── components/        # Reusable SolidJS components
│   │   ├── timeline/      # Components specific to the audio timeline
│   │   ├── ui/            # Generic UI components (buttons, dialogs, etc.)
│   │   └── *.tsx          # Main application components like AudioRecorder
│   ├── hooks/             # Custom SolidJS hooks for managing state and side effects
│   ├── lib/               # Utility functions and libraries
│   │   ├── auth-client.ts # Client-side authentication logic
│   │   ├── convex.ts      # Convex client setup
│   │   ├── query-client.ts# TanStack Query client setup
│   │   ├── session.ts     # Session management utilities
│   │   └── waveform.ts    # Waveform generation logic
│   ├── routes/            # Application routes
│   │   ├── __root.tsx     # Root layout
│   │   ├── index.tsx      # Home page
│   │   ├── Login.tsx      # Login page
│   │   └── about.tsx      # About page
│   ├── types/             # TypeScript type definitions
│   └── main.tsx           # Main application entry point
├── auth.ts                # Authentication configuration
├── package.json           # Project dependencies and scripts
└── wrangler.jsonc         # Cloudflare Workers configuration
                            # - Defines R2 bucket bindings for audio storage
                            # - Configures deployment settings for Cloudflare
                            # - Sets up SPA routing for the frontend
```

## 🚀 Getting Started

### Prerequisites
- **Bun** (recommended package manager)
- **Node.js** 18+ and npm (for compatibility)
- **Cloudflare Account** with Workers and R2 enabled
- **Convex Account** for database setup

### Installation

1. **Clone the repository**
   ```bash
   git clone <repository-url>
   cd <folder-name>
   ```

2. **Install dependencies**
   ```bash
   bun install
   # or npm install
   ```

3. **Environment Setup**

   **Cloudflare R2 Setup:**
   - Create R2 bucket for audio storage:
     ```bash
     wrangler r2 bucket create daw-audio-samples
     ```
   - Generate Cloudflare Workers types:
     ```bash
     wrangler types ./api/worker-configuration.d.ts
     ```

   **Database & Environment:**
   - Copy `example.env` to `.env` and configure your environment variables
   - Set up Convex deployment
   - Configure Cloudflare Workers bindings in `wrangler.jsonc`:
     - R2 bucket binding: `daw_audio_samples` (matches the bucket name created above)
     - Ensure `nodejs_compat` is enabled
     - The `compatibility_date` is set to `2025-09-12`. It's recommended to keep this up to date with the latest Cloudflare Workers runtime version.
   - Populate the following secrets to satisfy `auth.ts`, `api/index.ts`, and Cloudflare bindings:
     - `BETTER_AUTH_SECRET` – secret used by Better Auth
     - `BETTER_AUTH_URL` – public URL of your Cloudflare Worker (e.g. `https://<worker>.workers.dev`)
     - `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` – OAuth credentials for Google sign-in
     - `daw_convex_auth`, `daw_convex_auth_kv`, `daw_audio_samples` – these are created via `wrangler.jsonc`; ensure they exist in your Cloudflare account
     - `VITE_AUTH_BASE_URL` – optional override used by `src/lib/auth-client.ts` when developing against a remote Worker
     - `CONVEX_DEPLOYMENT` / `VITE_CONVEX_URL` – Convex deployment slug and public URL (see Convex setup below)

   **Convex Setup:**
   - Install the Convex CLI if you haven't already:
     ```bash
     bunx convex dev
     ```
   - Follow the interactive prompts to link or create a deployment; the command will populate/update `CONVEX_DEPLOYMENT` and `VITE_CONVEX_URL` in your `.env`.
   - Keep the Convex dev server running while working on the app so queries/mutations in `convex/` stay hot-reloaded.

4. **Development**
   ```bash
   bun dev
   # or npm run dev
   ```
   Opens the app at [http://localhost:3000](http://localhost:3000)

5. **Build for Production**
   ```bash
   bun run build
   # or npm run build
   ```

6. **Deploy**
   ```bash
   # Deploy to Cloudflare Workers
   wrangler deploy
   ```

## 🎛️ Usage

### Creating a Project
1. **Start a new session**: The app automatically creates a unique room ID
2. **Share the URL**: Copy the URL with `?roomId=` to collaborate with others
3. **Add audio files**: Drag and drop audio files or use the file picker

### Working with Audio
- **Adding Tracks**: Click "Add Track" or drag audio below existing tracks
- **Moving Clips**: Drag clips between tracks or within tracks
- **Timeline Scrubbing**: Click and drag on the timeline ruler to scrub playback
- **Playback Control**: Use spacebar to play/pause, click ruler for seeking
- **Volume Control**: Adjust track volume in the sidebar

### Collaboration Features
- **Real-time Sync**: All changes sync instantly across connected clients
- **Session Management**: Each user has a persistent session ID
- **Ownership Tracking**: Users can only delete items they created
- **Optimistic Updates**: Local changes appear immediately, sync to server

## 🔐 Authentication

The application uses `better-auth` to handle authentication, supporting various providers like Google and GitHub. The authentication flow is handled by the `auth.ts` file and the `src/lib/auth-client.ts` file.

- **Database Migrations**: The `migrations` directory contains SQL scripts for setting up and updating the database schema to support user authentication and sessions.
- **Login**: The `/login` route provides the user interface for logging in with different authentication providers.


## 🔧 Development

### Tools & Technologies
- **SolidJS**: A declarative and efficient JavaScript library for building user interfaces. Used for the core frontend framework.
- **`@tanstack/solid-router`**: A fully type-safe router for SolidJS applications.
- **Hono**: A small, simple, and ultrafast web framework for the edge. Used for the Cloudflare Workers API.
- **Convex**: A backend platform with a real-time database, used for collaborative state management.
- **Cloudflare Workers**: A serverless platform for running backend code.
- **R2**: Cloudflare's S3-compatible object storage, used for storing audio samples.
- **`better-auth`**: A library for handling authentication with different providers.
- **`kysely-d1`**: A type-safe SQL query builder for Cloudflare D1.
- **Zod**: A TypeScript-first schema declaration and validation library.
- **TailwindCSS**: A utility-first CSS framework for rapid UI development.
- **`mediabunny`**: A library for client-side audio processing, used for recording, encoding, and analyzing audio files.
- **`solid-devtools`**: A browser extension for debugging SolidJS applications.
- **Web Audio API**: The standard browser API for processing and synthesizing audio.

### Development Guidelines
- Use `~` alias for `./src` directory imports
- Follow SolidJS reactivity patterns (avoid circular dependencies)
- Use `batch()` for grouping related state updates
- Use TanStack Solid Query for API state management

### Scripts
```bash
bun start        # Start development server
bun dev          # Start development server
bun run build    # Build for production
bun run serve    # Preview production build
wrangler dev     # Develop Workers locally
wrangler deploy  # Deploy to Cloudflare
```

## 🧠 Code Examples

### Authentication flow (`src/lib/auth-client.ts`, `src/lib/session.ts`, `src/routes/Login.tsx`)
The client initializes Better Auth with cross-origin cookies and exposes Solid-friendly helpers for session state. The login route consumes those helpers to trigger OAuth flows and keep the TanStack Query cache in sync.

```ts
// src/lib/auth-client.ts
import { createAuthClient } from "better-auth/solid";

const baseURL = (import.meta as any).env?.VITE_AUTH_BASE_URL || window.location.origin;

export const authClient = createAuthClient({
  baseURL,
  fetchOptions: {
    credentials: "include",
  },
});
```

```ts
// src/lib/session.ts
export function useSessionQuery() {
  const q = useQuery<ClientSession>(() => ({
    queryKey: ['session'],
    queryFn: fetchSession,
    staleTime: 1000 * 60 * 15,
    refetchOnWindowFocus: false,
    retry: false,
  }));

  return createMemo(() => ({
    data: read<ClientSession>(q.data),
    isLoading: !!read(q.isLoading),
    error: (read(q.error) as Error | null) ?? null,
    refetch: q.refetch,
  }));
}
```

```tsx
// src/routes/Login.tsx
async function signInWithGoogle() {
  try {
    setLoadingGoogle(true);
    await authClient.signIn.social({
      provider: 'google',
      callbackURL: '/',
    });
  } catch (err) {
    console.error('Google sign-in error:', err);
    alert('Failed to start Google sign-in. Please try again.');
    setLoadingGoogle(false);
  }
}

async function signOut() {
  await authClient.signOut();
  queryClient.setQueryData(['session'], null);
}
```

### Routing & data fetching guard (`src/main.tsx`, `src/routes/index.tsx`)
Routing is driven by TanStack Router. The root of the app wires a shared `QueryClientProvider`, while the home route uses `beforeLoad` to require authentication before rendering the timeline.

```tsx
// src/main.tsx
const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
});

render(() => (
  <QueryClientProvider client={queryClient}>
    <RouterProvider router={router} />
  </QueryClientProvider>
), rootElement);
```

```tsx
// src/routes/index.tsx
export const Route = createFileRoute('/')({
  beforeLoad: async ({ location }) => {
    const session = await queryClient.ensureQueryData({
      queryKey: ['session'],
      queryFn: fetchSession,
      staleTime: 1000 * 60 * 15,
    });
    if (!session) {
      throw redirect({
        to: '/Login',
        search: { redirect: location.href },
      });
    }
  },
  component: Index,
});
```

### Collaborative timeline syncing (`src/components/Timeline.tsx`)
The main timeline component subscribes to Convex queries, projects server state into local Solid signals, and keeps optimistically updated tracks in sync with audio buffers and R2 uploads.

```ts
// src/components/Timeline.tsx
const fullView = useConvexQuery(
  convexApi.timeline.fullView,
  () => roomId() ? ({ roomId: roomId() }) : null,
  () => ['timeline', roomId()]
);

createEffect(() => {
  const raw = (fullView as any).data;
  const data = typeof raw === 'function' ? raw() : raw;
  if (!data) return;

  const oldTracks = untrack(() => tracks());
  const oldTrackMap = new Map(oldTracks.map(t => [t.id, t]));

  const projected: Track[] = data.tracks.map((t: any, idx: number) => ({
    id: t._id as string,
    name: oldTrackMap.get(t._id as string)?.name ?? `Track ${idx + 1}`,
    volume: typeof t.volume === 'number' ? t.volume : 0.8,
    clips: [],
    muted: false,
    soloed: false,
  }));

  setTracks(projected);
});
```

```ts
async function onDrop(e: DragEvent) {
  e.preventDefault();
  const file = e.dataTransfer?.files?.[0];
  if (!file || !file.type.startsWith('audio')) return;

  const ab = await file.arrayBuffer();
  const decoded = await audioEngine.decodeAudioData(ab);

  const createdClipId = await convexClient.mutation(convexApi.clips.create, {
    roomId: roomId(),
    trackId: targetTrackId as any,
    startSec,
    duration: decoded.duration,
    userId: userId(),
    name: file.name,
  });

  audioBufferCache.set(createdClipId, decoded);
  const url = await uploadToR2(roomId(), createdClipId, file, decoded.duration);
  if (url) {
    await convexClient.mutation(convexApi.clips.setSampleUrl, { clipId: createdClipId as any, sampleUrl: url });
  }
}
```

### Audio engine architecture (`src/lib/audio-engine.ts`)
The custom `AudioEngine` wraps the Web Audio API to provide per-track gain staging, optional EQ chains, and precise clip scheduling without blocking Solid's reactive updates. The context is created lazily to comply with browser autoplay rules, and it maintains internal maps for track inputs, gains, and EQ nodes.

```ts
// src/lib/audio-engine.ts
export class AudioEngine {
  private audioCtx: AudioContext | null = null;
  private masterGain: GainNode | null = null;
  private trackGains = new Map<string, GainNode>();
  private trackInputs = new Map<string, GainNode>();
  private eqChains = new Map<string, BiquadFilterNode[]>();

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext();
      this.masterGain = this.audioCtx.createGain();
      this.masterGain.gain.value = 1.0;
      this.rebuildMasterRouting();
    }
  }

  setTrackEq(trackId: string, params: EqParamsLite) {
    if (!this.audioCtx) {
      this.pendingEqParams.set(trackId, params);
      return;
    }
    this.ensureTrackNodes(trackId);
    const nodes: BiquadFilterNode[] = [];
    if (params.enabled) {
      for (const band of params.bands) {
        if (!band.enabled) continue;
        const filter = this.audioCtx.createBiquadFilter();
        filter.type = band.type;
        filter.frequency.value = Math.max(20, Math.min(20000, band.frequency));
        filter.Q.value = Math.max(0.001, band.q);
        filter.gain.value = this.supportsGain(band.type) ? band.gainDb : 0;
        nodes.push(filter);
      }
    }
    this.eqChains.set(trackId, nodes);
    this.rebuildTrackRouting(trackId);
  }

  scheduleAllClipsFromPlayhead(tracks: Track[], playheadSec: number) {
    if (!this.audioCtx) return;
    this.stopAllSources();
    const now = this.audioCtx.currentTime;
    const anySoloed = tracks.some(t => t.soloed);

    for (const track of tracks) {
      this.ensureTrackNodes(track.id);
      const gain = this.trackGains.get(track.id)!;
      gain.gain.value = (!track.muted && (!anySoloed || track.soloed)) ? track.volume : 0;

      for (const clip of track.clips) {
        if (!clip.buffer) continue;
        const source = this.audioCtx.createBufferSource();
        source.buffer = clip.buffer;
        source.connect(this.trackInputs.get(track.id)!);
        const when = Math.max(0, (clip.startSec + (clip.leftPadSec ?? 0)) - playheadSec);
        const offset = Math.max(0, playheadSec - (clip.startSec + (clip.leftPadSec ?? 0)));
        const duration = Math.min(clip.buffer.duration - offset, clip.duration - Math.max(0, playheadSec - clip.startSec));
        if (duration > 0) {
          source.start(now + when, offset, duration);
          this.activeSources.push(source);
        }
      }
    }
  }
}
```

Key behaviors:

- **Lazy initialization**: `ensureAudio()` postpones `AudioContext` creation until playback, avoiding browser autoplay warnings during page load.
- **Per-track routing**: `ensureTrackNodes()` wires a dedicated input `GainNode` per track so EQ chains (`setTrackEq()`) can slot between the input and the shared master bus.
- **Mute/solo logic**: `updateTrackGains()` applies solo precedence across all tracks before each playback pass, muting non-soloed tracks automatically.
- **Clip scheduling**: `scheduleAllClipsFromPlayhead()` restarts all active `AudioBufferSourceNode`s relative to the current playhead, respecting clip padding (`leftPadSec`), duration windows, and partially played buffers.
- **Master EQ**: `setMasterEq()` rebuilds an optional Biquad chain on the master bus, reconnecting the final node to the `AudioDestinationNode` to keep global effects isolated from track-specific EQ.

### Sample storage API (`api/index.ts`)
The Hono worker enforces authentication, streams uploads to Cloudflare R2 with collision handling, and exposes a signed fetch endpoint for playback.

```ts
// api/index.ts
app.post('/api/samples', async (c) => {
  const user = c.get('user');
  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  const form = await c.req.formData();
  const roomId = form.get('roomId')?.toString();
  const clipId = form.get('clipId')?.toString();
  const file = form.get('file');
  if (!roomId || !clipId || !(file instanceof File)) {
    return c.json({ error: 'Missing roomId, clipId or file' }, 400);
  }

  const key = `rooms/${roomId}/clips/${sanitizedName}`;
  await c.env.daw_audio_samples.put(key, file.stream(), {
    httpMetadata: {
      contentType: file.type || 'application/octet-stream',
      contentDisposition: `inline; filename="${file.name}"`,
    },
    customMetadata: {
      roomId,
      clipId,
      uploadedBy: user.id,
    },
  });

  return c.json({ key, url: `/api/samples/${roomId}/${clipId}?key=${encodeURIComponent(key)}` });
});
```

### Convex mutations (`convex/clips.ts`)
Convex functions centralize collaborative state changes, guaranteeing authorization and room scoping before persisting timeline edits.

```ts
// convex/clips.ts
export const create = mutation({
  args: {
    roomId: v.string(),
    trackId: v.id('tracks'),
    startSec: v.number(),
    duration: v.number(),
    userId: v.string(),
    name: v.optional(v.string()),
  },
  handler: async (ctx, { roomId, trackId, startSec, duration, userId, name }) => {
    const track = await ctx.db.get(trackId);
    if (!track || track.roomId !== roomId) return;

    const clipId = await ctx.db.insert('clips', { roomId, trackId, startSec, duration, name });
    await ctx.db.insert('ownerships', {
      roomId,
      ownerUserId: userId,
      clipId,
    });

    return clipId;
  },
});

export const setSampleUrl = mutation({
  args: { clipId: v.id('clips'), sampleUrl: v.string() },
  handler: async (ctx, { clipId, sampleUrl }) => {
    const clip = await ctx.db.get(clipId);
    if (!clip) return;
    await ctx.db.patch(clipId, { sampleUrl });
  },
});
```

## 🎨 UI Components

### Timeline Components
- **TimelineRuler**: Time-based ruler with scrubbing
- **TrackLane**: Individual track rendering with clips
- **TrackSidebar**: Track controls and volume adjustment
- **TransportControls**: Playback and file import controls
- **EffectsPanel**: Audio effects and visualization

### Core Features
- **AudioRecorder**: Built-in audio recording
- **VisualEqualizer**: Real-time audio visualization
- **ClipComponent**: Individual audio clip rendering

## 📊 Performance Optimizations

- **Audio Buffering**: Efficient audio buffer caching
- **Optimistic Updates**: Immediate UI feedback with server sync
- **Debounced Operations**: Volume changes and server updates
- **Lazy Loading**: Audio samples loaded on demand
- **Memory Management**: Proper cleanup of audio resources


---

Built with ❤️ using SolidJS, Hono, Convex, and Cloudflare Workers
