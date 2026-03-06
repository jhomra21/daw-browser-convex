## Philosophy
This codebase will outlive you. Every shortcut becomes someone else's burden. Every hack compounds into technical debt that slows the whole team down. 
You are not just writing code, you are shaping the future of this project. The patterns you establish will be copied. The corners you cut will be cut again.
Fight entropy. Leave the codebase better than you found it.

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

## Code Style

### TypeScript
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

## SolidJS Reactivity Guidelines ⚠️

**AVOID CIRCULAR DEPENDENCIES** - These cause "too much recursion" errors:

### ❌ Dangerous Patterns:
```javascript
// DON'T: Effect that reads query data and updates state affecting same query
createEffect(() => {
  const data = someQuery.data();
  setSomeState(data.map(...)); // Can trigger infinite re-renders
});

// DON'T: Memos for simple calculations
const size = createMemo(() => props.size || { width: 320, height: 384 });

// DON'T: Creating memos inside render loops
<For each={items}>
  {(item) => {
    const computed = createMemo(() => item.data); // Created on every render!
    return <div>{computed()}</div>;
  }}
</For>

// DON'T: Using function as its own default context
const context = contextObject || myFunction; // Self-reference
```

### ✅ Safe Patterns:
```javascript
// DO: Guard effects with change detection
createEffect(() => {
  const data = someQuery.data();
  if (!data || !hasActuallyChanged(data)) return;

  batch(() => { // Group state updates
    setSomeState(newValue);
    setOtherState(otherValue);
  });
});

// DO: Simple functions for basic calculations
const size = () => props.size || { width: 320, height: 384 };

// DO: Create memos outside render loops
const computed = createMemo(() => items().map(item => transform(item)));

// DO: Use stable default contexts
const defaultContext = {};
const context = contextObject || defaultContext;
```

### Consumer-shaped APIs

If a helper or component has one real consumer, shape its API around that call site instead of making it look generically reusable.

Rules:
- Prefer passing parent context directly over exploding it into many small props/accessors.
- Return domain-grouped objects instead of long flat lists of handlers and state.
- Hide target-specific plumbing, normalization, and bookkeeping inside the helper.
- Do not keep re-export surfaces or generic-looking types unless multiple consumers actually need them.
- Only generalize after a second real consumer proves the abstraction.
