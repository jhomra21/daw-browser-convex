import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from '@solidjs/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { z } from 'zod'
import { agentBrowser } from '~/test-support/agent-browser'

// Bundles a browser-runtime fixture, opens it in an isolated Chromium session and returns the scenario results the
// fixture publishes as window.__browserFixtureResults (or fails with the error it published). A fixture that checks layout
// passes `styled` and imports ~/index.css, so its classes resolve to the app's real Tailwind rules.
export const runBrowserFixture = async (runtime: URL, options: { screenshot?: string; styled?: boolean } = {}) =>
  (await runFixture(runtime, options)).results

type FixtureOptions = {
  screenshot?: string
  styled?: boolean
  // Serves the page over http with the app's `public/` files at their product paths (the AudioWorklet and the WASM core load from
  // there) and lets the context start without a gesture. The fixture may also publish window.__browserFixtureData.
  served?: boolean
}

// A fixture that needs the worklet and the WASM core, and publishes measurements beside its pass/fail results.
export const runServedBrowserFixture = (runtime: URL) => runFixture(runtime, { served: true })

const runFixture = async (runtime: URL, options: FixtureOptions) => {
  const directory = `/tmp/daw-fixture-${crypto.randomUUID()}`
  const session = `daw-fixture-${crypto.randomUUID()}`

  const browser = agentBrowser(session, options.served
    ? { env: { AGENT_BROWSER_ARGS: '--autoplay-policy=no-user-gesture-required', AGENT_BROWSER_DEFAULT_TIMEOUT: '170000' }, timeoutMs: 180_000 }
    : {})

  let server: ReturnType<typeof Bun.serve> | undefined

  await mkdir(directory, { recursive: true })

  try {
    const repositoryRoot = new URL('../../', import.meta.url).pathname

    const result = await build({
      root: repositoryRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        {
          // Fixtures are local-only: keep the cloud client disconnected.
          name: 'disconnected-cloud-client',
          enforce: 'pre',
          load: (id) => id === `${repositoryRoot}src/lib/convex.ts`
            ? `export { api as convexApi } from ${JSON.stringify(`${repositoryRoot}convex/_generated/api.js`)};
               export const convexClient = { mutation: async () => { throw new Error('Cloud mutation in a local fixture') }, query: async () => undefined };`
            : undefined,
        },
        solidPlugin(),
        ...(options.styled ? [tailwindcss()] : []),
      ],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_CONVEX_URL': '"https://fixture.convex.cloud"' },
      resolve: { alias: { '~': `${repositoryRoot}src` } },
      build: { write: false, minify: false, lib: { entry: runtime.pathname, formats: ['iife'], name: 'browserFixture' } },
    })

    const output = Array.isArray(result) ? result[0] : result

    if (!output || !('output' in output)) throw new Error('Expected a single fixture bundle.')
    const bundle = output.output.find((chunk) => chunk.type === 'chunk')?.code

    if (!bundle) throw new Error('The fixture bundle is empty.')
    const styles = output.output.flatMap((asset) => asset.type === 'asset' && asset.fileName.endsWith('.css') ? [String(asset.source)] : [])

    const page = `<!doctype html><style>${styles.join('\n')}</style><body><script>window.addEventListener('error',event=>{window.__browserFixtureError=event.message});window.addEventListener('unhandledrejection',event=>{window.__browserFixtureError=String(event.reason)})</script><script>${bundle}</script>`

    if (options.served) {
      server = Bun.serve({ port: 0, hostname: '127.0.0.1', fetch: (request) => {
        const path = new URL(request.url).pathname

        if (path === '/') return new Response(page, { headers: { 'content-type': 'text/html' } })

        if (path.startsWith('/audio-worklets/') || path.startsWith('/audio-core/')) return new Response(Bun.file(`${repositoryRoot}public${path}`))

        return new Response('not found', { status: 404 })
      } })
      await browser('open', `http://127.0.0.1:${server.port}/`)
    } else {
      await Bun.write(`${directory}/index.html`, page)
      await browser('open', `file://${directory}/index.html`)
    }

    await browser('wait', '--fn', '!!window.__browserFixtureResults || !!window.__browserFixtureError')

    if (options.screenshot) await browser('screenshot', options.screenshot)

    const published = JSON.parse(JSON.parse(await browser(
      'eval',
      'JSON.stringify({ results: window.__browserFixtureResults ?? null, data: window.__browserFixtureData ?? null, error: window.__browserFixtureError ?? null })',
    )))

    const { results, data, error } = z.object({
      results: z.record(z.string(), z.boolean()).nullable(),
      data: z.json().nullable(),
      error: z.string().nullable(),
    }).parse(published)

    if (error !== null || results === null) throw new Error(error ?? 'The fixture published no results.')

    return { results, data }
  } finally {
    await server?.stop(true)
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}
