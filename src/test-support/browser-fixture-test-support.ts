import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from '@solidjs/vite-plugin'
import { z } from 'zod'
import { agentBrowser } from '~/test-support/agent-browser'

// Bundles a browser-runtime fixture, opens it in an isolated Chromium session and returns the scenario results the
// fixture publishes as window.__browserFixtureResults (or fails with the error it published).
export const runBrowserFixture = async (runtime: URL, options: { screenshot?: string } = {}) => {
  const directory = `/tmp/daw-fixture-${crypto.randomUUID()}`
  const session = `daw-fixture-${crypto.randomUUID()}`

  const browser = agentBrowser(session)

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
      ],
      define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_CONVEX_URL': '"https://fixture.convex.cloud"' },
      resolve: { alias: { '~': `${repositoryRoot}src` } },
      build: { write: false, minify: false, lib: { entry: runtime.pathname, formats: ['iife'], name: 'browserFixture' } },
    })

    const output = Array.isArray(result) ? result[0] : result

    if (!output || !('output' in output)) throw new Error('Expected a single fixture bundle.')
    const bundle = output.output.find((chunk) => chunk.type === 'chunk')?.code

    if (!bundle) throw new Error('The fixture bundle is empty.')
    await Bun.write(
      `${directory}/index.html`,
      `<!doctype html><body><script>window.addEventListener('error',event=>{window.__browserFixtureError=event.message});window.addEventListener('unhandledrejection',event=>{window.__browserFixtureError=String(event.reason)})</script><script>${bundle}</script>`,
    )
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.__browserFixtureResults || !!window.__browserFixtureError')

    if (options.screenshot) await browser('screenshot', options.screenshot)

    const published = JSON.parse(JSON.parse(await browser(
      'eval',
      'JSON.stringify({ results: window.__browserFixtureResults ?? null, error: window.__browserFixtureError ?? null })',
    )))

    const { results, error } = z.object({
      results: z.record(z.string(), z.boolean()).nullable(),
      error: z.string().nullable(),
    }).parse(published)

    if (error !== null || results === null) throw new Error(error ?? 'The fixture published no results.')

    return results
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}
