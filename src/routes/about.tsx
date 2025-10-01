import { createFileRoute, Link } from '@tanstack/solid-router'

export const Route = createFileRoute('/about')({
  head: () => ({
    meta: [
      { title: 'MediaBunny – Collaborative DAW' },
      { name: 'description', content: 'Realtime collaborative DAW built with SolidJS, TanStack, Convex, Hono, Cloudflare Workers.' },
    ],
  }),
  component: About,
})

function About() {
  return (
    <main class="min-h-screen bg-neutral-950 text-neutral-100">
      <section class="container mx-auto px-4 py-14 flex flex-col items-center">
        <h1 class="text-3xl md:text-4xl font-semibold text-center tracking-tight">
          MediaBunny — Realtime Collaborative DAW
        </h1>
        <p class="mt-3 text-center text-neutral-400 max-w-2xl">
          Arrange audio and MIDI clips together, add EQ/Reverb/Synth, and collaborate live — all in the browser.
        </p>

        <div class="mt-8 w-full max-w-5xl aspect-video rounded-xl border border-neutral-800 bg-neutral-900/60 overflow-hidden shadow-lg">
          {/* Replace with an actual screenshot placed in /public when available */}
          <img src="/logo512.png" alt="MediaBunny DAW screenshot" class="w-full h-full object-contain p-4" />
        </div>

        <div class="mt-10 grid gap-6 w-full max-w-5xl sm:grid-cols-2">
          <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-5">
            <h2 class="text-lg font-semibold mb-2">Features</h2>
            <ul class="text-sm text-neutral-300 list-disc pl-5 space-y-1">
              <li>Collaborative tracks with per‑track mute/solo and volume</li>
              <li>MIDI and audio clips with grid snapping and loop regions</li>
              <li>Effects: EQ, Reverb, Synth, Arpeggiator</li>
              <li>Agent and shared chat for project coordination</li>
              <li>Cloud storage backed by R2 and Convex</li>
            </ul>
          </div>
          <div class="rounded-lg border border-neutral-800 bg-neutral-900/60 p-5">
            <h2 class="text-lg font-semibold mb-2">Tech stack</h2>
            <ul class="text-sm text-neutral-300 list-disc pl-5 space-y-1">
              <li>Bun • SolidJS • TailwindCSS</li>
              <li>TanStack Router & Solid Query</li>
              <li>Hono on Cloudflare Workers</li>
              <li>Convex for realtime data</li>
              <li>Better Auth • TypeScript</li>
            </ul>
          </div>
        </div>

        <div class="mt-10">
          <Link
            to="/Login"
            class="inline-flex items-center justify-center rounded-md bg-primary text-primary-foreground px-5 py-2 text-sm font-medium hover:bg-primary/90 border border-neutral-700/20 active:scale-97 transition-transform ease-out"
          >
            Get started — Sign in
          </Link>
        </div>
      </section>
    </main>
  )
}
