import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import { z } from 'zod'
import { agentBrowser } from '~/test-support/agent-browser'

test('loop gestures restore their baseline on cancellation', async () => {
  const directory = `/tmp/daw-ruler-cancel-${crypto.randomUUID()}`
  const session = `daw-ruler-cancel-${crypto.randomUUID()}`

  const browser = agentBrowser(session)

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

    const gestures = ['pointercancel-create', 'escape-create', 'blur-create', 'pointercancel-resize-start',
      'escape-resize-start', 'blur-resize-start', 'pointerup-create', 'pointerup-resize-start',
      'pointerup-resize-end', 'pointerup-move']

    const expectedScenarios = [
      ...gestures.flatMap((gesture) => [gesture, `${gesture}-preview-only`, `${gesture}-commit-count`]),
      'pointerup-create-dialog-escape', 'pointerup-create-menu-escape',
      'dialog-escape-not-consumed', 'menu-escape-not-consumed',
      'subsequent-gesture-after-escape', 'unmount-cancel', 'nested-group-output',
      'expanded-group-not-aggregated', 'mounted-collapsed-group-updates',
    ]

    expect(Object.keys(results.result).sort()).toEqual(expectedScenarios.sort())
    expect(Object.entries(results.result).filter(([, passed]) => !passed)).toEqual([])
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
