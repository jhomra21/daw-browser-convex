> **Last Updated**: 09/24/2025

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
  - **Moving clips**: Drag clips between tracks or within tracks
  - **Timeline Scrubbing**: Click and drag on the timeline ruler to scrub playback
  - **Playback Control**: Use spacebar to play/pause, click ruler for seeking
  - **Volume Control**: Adjust track volume in the sidebar

### Multi-Selection (09/24/2025)
 
 - **Select one clip**: Click a clip. Selection becomes that single clip.
 - **Add to selection**: Hold Shift and click additional clips to add them to the selection (additive).
 - **Marquee selection**: Click and drag on empty lane space to draw a selection rectangle. All clips intersecting the marquee are selected.
   - Hold Shift while marquee-dragging to add to the current selection (additive marquee).
 - **Clear selection**: Click empty lane space without Shift to clear the selection.
 - **Move selected clips together**: When multiple clips are selected, dragging any selected clip moves the entire group together.
   - Horizontal moves preserve each clip’s relative offset; vertical moves shift the group by the same track delta.
   - Dragging below the last lane creates a new track; the group drops onto that new track.
 - **Duplicate / Delete (operate on selection)**
   - Ctrl+D duplicates all selected clips. Duplicates are placed to the right per-track with non-overlapping placement.
   - Delete or Backspace removes all selected clips.
 - **Resize**: Edge-resize acts on the specific clip you grab. Group resize is not supported.
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
`Timeline.tsx` now composes dedicated hooks for room state, playback, clip import, and selection. `useTimelineData()` supplies the current room and Convex queries, `useClipBuffers()` hydrates missing audio buffers, and `useTimelineClipActions()` centralises keyboard-driven edits. A guarded projection effect keeps Convex state and local optimistic changes aligned while respecting per-user mix preferences.

```ts
// src/components/Timeline.tsx
const { roomId, userId, fullView } = useTimelineData()
const { audioBufferCache, ensureClipBuffer, uploadToR2 } = useClipBuffers({ audioEngine, tracks, setTracks })

createEffect(() => {
  const raw = (fullView as any).data
  const data = typeof raw === 'function' ? raw() : raw
  if (!data) return

  const oldTracks = untrack(() => tracks())
  const oldTrackMap = new Map(oldTracks.map(t => [t.id, t]))
  const sm = syncMix()
  const dragSnapshot = activeDrag()
  const addedTrackDuringDrag = dragSnapshot?.addedTrackDuringDrag
  const localMix = loadLocalMixMap(roomId())

  const projected: Track[] = data.tracks.map((t: any, idx: number) => {
    const id = t._id as string
    const prev = oldTrackMap.get(id)
    const serverMuted = (t as any).muted as boolean | undefined
    const serverSoloed = (t as any).soloed as boolean | undefined
    return {
      id,
      name: (t as any).name ?? prev?.name ?? `Track ${idx + 1}`,
      volume: typeof t.volume === 'number' ? t.volume : 0.8,
      clips: [],
      muted: sm
        ? (typeof serverMuted === 'boolean' ? serverMuted : prev?.muted ?? localMix[id]?.muted ?? false)
        : (prev?.muted ?? localMix[id]?.muted ?? false),
      soloed: sm
        ? (typeof serverSoloed === 'boolean' ? serverSoloed : prev?.soloed ?? localMix[id]?.soloed ?? false)
        : (prev?.soloed ?? localMix[id]?.soloed ?? false),
    }
  })

  // inject drag placeholders, hydrate clips, honour optimisticMoves, seed selection...
  setTracks(projected)
})
```

Clip imports are handled in `useTimelineClipImport.ts`, which decodes audio, creates Convex records, pushes buffers into the cache, and uploads samples to R2—supporting drag-and-drop, file pickers, per-lane hit testing, overlap avoidance, optimistic placeholders, and empty-lane auto track creation.

### Audio engine architecture (`src/lib/audio-engine.ts`)
The custom `AudioEngine` wraps the Web Audio API but now adds master routing, pending EQ hydration, and offline decoding safeguards. It coordinates master/track EQ chains, mute/solo precedence, and clip scheduling without blocking Solid's reactive updates.

```ts
// src/lib/audio-engine.ts
export class AudioEngine {
  private audioCtx: AudioContext | null = null
  private masterGain: GainNode | null = null
  private destination: AudioDestinationNode | null = null
  private trackGains = new Map<string, GainNode>()
  private activeSources: AudioBufferSourceNode[] = []
  private trackInputs = new Map<string, GainNode>()
  private eqChains = new Map<string, BiquadFilterNode[]>()
  private pendingEqParams = new Map<string, EqParamsLite>()
  private masterEqChain: BiquadFilterNode[] = []

  ensureAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new AudioContext()
      this.masterGain = this.audioCtx.createGain()
      this.destination = this.audioCtx.destination
      this.masterGain.gain.value = 1.0
      this.rebuildMasterRouting()
    }
  }

  setTrackEq(trackId: string, params: EqParamsLite) {
    if (!this.audioCtx) {
      this.pendingEqParams.set(trackId, params)
      return
    }
    this.ensureTrackNodes(trackId)
    const old = this.eqChains.get(trackId)
    if (old) {
      for (const n of old) { try { n.disconnect() } catch {} }
    }
    const nodes: BiquadFilterNode[] = []
    if (params.enabled) {
      for (const b of params.bands) {
        if (!b.enabled) continue
        const f = this.audioCtx.createBiquadFilter()
        f.type = b.type
        f.frequency.value = Math.max(20, Math.min(20000, b.frequency))
        f.Q.value = Math.max(0.001, b.q)
        f.gain.value = this.supportsGain(b.type) ? b.gainDb : 0
        nodes.push(f)
      }
    }
    this.eqChains.set(trackId, nodes)
    this.rebuildTrackRouting(trackId)
  }

  updateTrackGains(tracks: Track[]) {
    if (!this.audioCtx || !this.masterGain) return
    const anySoloed = tracks.some(tt => tt.soloed)
    for (const t of tracks) {
      this.ensureTrackNodes(t.id)
      const gain = this.trackGains.get(t.id)!
      gain.gain.value = (!t.muted && (!anySoloed || t.soloed)) ? t.volume : 0
    }
    for (const [id, g] of Array.from(this.trackGains.entries())) {
      if (!tracks.find(t => t.id === id)) {
        try { g.disconnect() } catch {}
        this.trackGains.delete(id)
        const input = this.trackInputs.get(id)
        if (input) {
          try { input.disconnect() } catch {}
          this.trackInputs.delete(id)
        }
        const nodes = this.eqChains.get(id)
        if (nodes) {
          for (const n of nodes) { try { n.disconnect() } catch {} }
          this.eqChains.delete(id)
        }
        this.pendingEqParams.delete(id)
      }
    }
  }

  scheduleAllClipsFromPlayhead(tracks: Track[], playheadSec: number) {
    if (!this.audioCtx) return
    this.stopAllSources()
    const now = this.audioCtx.currentTime
    const anySoloed = tracks.some(t => t.soloed)

    for (const t of tracks) {
      this.ensureTrackNodes(t.id)
      const input = this.trackInputs.get(t.id)!
      const gain = this.trackGains.get(t.id)!
      gain.gain.value = (!t.muted && (!anySoloed || t.soloed)) ? t.volume : 0

      for (const c of t.clips) {
        if (!c.buffer) continue
        const leftPad = Math.max(0, c.leftPadSec ?? 0)
        const audioStart = c.startSec + leftPad
        if (playheadSec >= audioStart + c.buffer.duration) continue

        const when = Math.max(0, audioStart - playheadSec)
        const offset = Math.max(0, playheadSec - audioStart)
        const playDur = Math.min(
          c.buffer.duration - offset,
          (c.startSec + c.duration) - Math.max(playheadSec, audioStart),
        )
        if (playDur <= 0) continue

        const source = this.audioCtx.createBufferSource()
        source.buffer = c.buffer
        source.connect(input)
        source.start(now + when, offset, playDur)
        this.activeSources.push(source)
      }
    }
  }
}
```

Key behaviors:

- **Lazy initialization**: `ensureAudio()` wires the master bus only after a user gesture, avoiding autoplay violations while remembering the intended destination.
- **Per-track routing**: `ensureTrackNodes()` provisions dedicated input and gain nodes so `setTrackEq()` can insert user-configured EQ chains between them.
- **Mute/solo and cleanup**: `updateTrackGains()` applies solo precedence, synchronises gain values, and tears down nodes, EQ chains, and pending parameters when tracks disappear.
- **Clip scheduling**: `scheduleAllClipsFromPlayhead()` recreates `AudioBufferSourceNode`s relative to the current playhead, respecting clip padding, window duration, and partially consumed buffers.
- **Master processing**: `setMasterEq()` rebuilds a Biquad chain on the master bus, while `decodeAudioData()` falls back to an `OfflineAudioContext` until the live context is user-activated and `resume()` has been called.

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
