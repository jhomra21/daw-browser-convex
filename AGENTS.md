## Philosophy
This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down. 
You are not just writing code, you are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.
Fight entropy. Leave the codebase better than you found it.
Do not write plausible code, write accurate correct code

## Code Thinking
Review your implementation before stopping. Check whether there is a better or simpler approach whether any redundant code remains, whether duplicate logic was introduced, and whether any dead or unused code was left behind. If you find issues, fix them now; if not, briefly confirm the implementation is clean.
                
Think carefully and only action the specific task I have given you with the most concise and elegant solution that takes into consideration existing code across codebase.
Prefer the most concise and elegant solutions that changes or adds as little code as possible.
## Tech Stack
This project uses a specific tech stack. Only use these technologies:
- **Bun** - Package manager and runtime
- **SolidJS** - Frontend framework
- **TanStack Solid Query** - Data fetching and state management
- **TanStack Router** - Routing and navigation
- **Hono** - Backend API framework
- **Cloudflare Workers** - Serverless deployment platform
- **Convex** - Database and state management
- **Better Auth** - Authentication and authorization
- **TailwindCSS** - Styling framework
- **TypeScript** - Primary language
- **MediaBunny** - Media management

### Frontend (SolidJS)
- Use functional components with TypeScript
- Leverage SolidJS reactivity patterns (signals, stores)
- Use `@tanstack/solid-query` for API state management
- Import paths use `~` alias for `./src` directory
- Components should be in `src/components/` with proper organization

### Backend (Hono + Cloudflare Workers)
- API routes in `api/index.ts` using Hono framework
- Use Cloudflare Workers AI binding for LLM functionality
- Handle both streaming and non-streaming responses
- Proper error handling with JSON responses
- Type Cloudflare bindings appropriately

### Styling
- Use TailwindCSS v4 with Vite plugin
- Prefer utility classes over custom CSS
- Use `@kobalte/core` for accessible UI components
- Leverage `class-variance-authority` for component variants

### TypeScript
- Never typecast. Never use `as`
- Use strict TypeScript configuration
- Prefer `type` over `interface` for object shapes
- Use proper typing for Cloudflare Workers environment
- Export default for main components/modules

### File Organization
- Components in `src/components/`
- Utilities in `src/lib/`
- API handlers in `api/`
- Use descriptive file names with proper extensions (.tsx, .ts)

### Naming Conventions
- PascalCase for components and types
- camelCase for functions and variables
- kebab-case for file names when appropriate
- Descriptive names that indicate purpose

## Development Workflow
- Use `bun dev` for development server
- Build with `bun run build`
- Deploy via Wrangler to Cloudflare Workers
- Port 3000 for local development

### Consumer-shaped APIs
If a helper or component has one real consumer, shape its API around that call site instead of making it look generically reusable.

Rules:
- Prefer passing parent context directly over exploding it into many small props/accessors.
- Return domain-grouped objects instead of long flat lists of handlers and state.
- Hide target-specific plumbing, normalization, and bookkeeping inside the helper.
- Do not keep re-export surfaces or generic-looking types unless multiple consumers actually need them.
- Only generalize after a second real consumer proves the abstraction.

### Explicit UI and Static Content
Prefer dumb, explicit code for static UI. Do not turn plain JSX into a data model unless the content is truly dynamic or reused in multiple places.

Rules:
- For static pages and marketing UI, write the content inline in JSX.
- Do not create typed data arrays or config objects just to map static content into components.
- If markup repeats, extract a small wrapper component for the repeated shell instead of introducing a data structure.
- Prefer component extraction over class-string extraction.
- Do not create `const ...Class = "..."` helpers or style modules for one-off UI.
- Keep classes at the callsite unless a small wrapper component makes the file clearly easier to read.
- Prefer files that can be read top-to-bottom without chasing helper abstractions.
- Default to the most local and obvious solution, even if it is slightly longer.
- Suggest abstractions when local solutions are too long

Bad:
- `type Feature = ...`
- `const features = [...]`
- `features.map(...)` for static page content
- extracting class strings into JS constants instead of extracting a small component

Good:
- inline static JSX content
- small wrapper components for repeated layout/chrome
- explicit props for real repeated structure
- local code that stays easy to scan and edit

## Engineering Rules (Non-Negotiable)
- Functional style first: prefer pure functions, immutable updates, explicit inputs/outputs.
- Single responsibility: each function/module should have one reason to change.
- Complexity budget:
  - Target `O(1)` or `O(log n)` where practical.
  - Avoid accidental `O(n^2+)` (nested scans in hot paths).
  - Use `Map`/`Set` for membership and indexing instead of repeated linear lookups.
- Performance footgun policy:
  - Do not introduce `setTimeout`, `setInterval`, `requestAnimationFrame`, or self-rescheduling loops unless explicitly justified in code comments and cleaned up deterministically.
  - No polling loops when event-driven/reactive alternatives exist.
- Avoid hidden side effects: no mutation of shared module state unless clearly documented.
- Two things that make code actually maintainable:
  1. reduce the layers a reader has to trace
  2. reduce the state a reader has to hold in their head

## Code Organization
- Keep app-specific logic organized.
- Prefer composition over inheritance; avoid god-modules.
- Keep adapters thin and deterministic; isolate I/O at boundaries.

## Change Quality Bar
- Keep diffs focused; do not mix refactors with feature behavior changes unless requested.
- Preserve public contracts unless change is intentional and documented.
- Validate before finishing
