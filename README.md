> **Last Updated**: 09/22/2025

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
