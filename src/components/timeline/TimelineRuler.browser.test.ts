import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'

test('loop gestures restore their baseline on cancellation', async () => {
  const directory = `/tmp/daw-ruler-cancel-${crypto.randomUUID()}`
  const session = `daw-ruler-cancel-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ])
    if (await child.exited !== 0) throw new Error(stderr || stdout)
    return stdout.trim()
  }
  await mkdir(directory, { recursive: true })
  try {
    const repositoryRoot = new URL('../../../', import.meta.url).pathname
    const result = await build({
      root: repositoryRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [solidPlugin()],
      resolve: { alias: { '~': `${repositoryRoot}src` } },
      build: {
        write: false,
        minify: false,
        lib: {
          entry: new URL('./TimelineRuler.browser-runtime.tsx', import.meta.url).pathname,
          formats: ['iife'],
          name: 'timelineRulerFixture',
        },
      },
    })
    const output = Array.isArray(result) ? result[0] : result
    if (!output || !('output' in output)) throw new Error('Expected a single ruler fixture bundle.')
    const bundle = output.output.find((chunk) => chunk.type === 'chunk')?.code
    expect(bundle).toBeDefined()
    await Bun.write(`${directory}/index.html`, `<!doctype html><body><script>window.addEventListener('error',event=>window.__timelineRulerError=event.message)</script><script>${bundle ?? ''}</script>`)
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.__timelineRulerCancelResults || !!window.__timelineRulerError')
    const resultOutput = await browser('eval', 'JSON.stringify({ result: window.__timelineRulerCancelResults, errors: window.__timelineRulerError })')
    if (resultOutput.includes('"result":null')) throw new Error(resultOutput)
    const results = z.object({
      result: z.record(z.string(), z.boolean()),
      errors: z.string().optional(),
    }).parse(JSON.parse(JSON.parse(resultOutput)))
    expect(results.errors).toBeUndefined()
    expect(Object.entries(results.result).filter(([, passed]) => !passed)).toEqual([])
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
