import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'
import { agentBrowser } from '~/test-support/agent-browser'

test('isolates portalled dialogs and preserves arrangement and native keyboard behavior', async () => {
  const directory = `/tmp/daw-keyboard-${crypto.randomUUID()}`
  const session = `daw-keyboard-${crypto.randomUUID()}`

  const browser = agentBrowser(session)

  await mkdir(directory, { recursive: true })

  try {
    const build = await Bun.build({
      entrypoints: [new URL('./useTimelineKeyboard.browser-runtime.ts', import.meta.url).pathname],
      target: 'browser',
      format: 'iife',
    })

    expect(build.success).toBe(true)
    const bundle = await build.outputs[0]!.text()
    await Bun.write(`${directory}/index.html`, `<!doctype html><body><script>${bundle}</script>`)
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.keyboardRegression')
    const scenarios = JSON.parse(await browser('eval', 'window.keyboardRegression.scenarios()'))
    const results = z.record(z.string(), z.boolean()).parse(scenarios)
    await Bun.write(`${directory}/scenarios.json`, JSON.stringify(results, null, 2))
    expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
    await browser('eval', 'window.keyboardRegression.open()')
    await browser('press', 'Space')
    expect(JSON.parse(await browser('eval', 'window.keyboardRegression.calls'))).toEqual(['modal-click'])
    await browser('screenshot', `${directory}/modal.png`)
    await browser('eval', 'window.keyboardRegression.close(); document.querySelector("#ordinary-button").focus(); window.keyboardRegression.calls.length = 0')
    await browser('press', 'Space')
    // Space is transport even with a button focused: the button must not also click.
    expect(JSON.parse(await browser('eval', 'window.keyboardRegression.calls'))).toEqual(['space'])
    await browser('eval', 'window.keyboardRegression.dispose(); window.keyboardRegression.calls.length = 0; document.querySelector("#arrangement").focus()')
    await browser('press', 'Space')
    expect(JSON.parse(await browser('eval', 'window.keyboardRegression.calls'))).toEqual([])
    expect(JSON.parse(await browser('eval', 'document.querySelector("#arrangement").dispatchEvent(new KeyboardEvent("keydown", { key: "Delete", bubbles: true, cancelable: true }))'))).toBe(true)
    expect(JSON.parse(await browser('eval', 'window.keyboardRegression.calls'))).toEqual([])
    console.log(`Keyboard regression artifacts: ${directory}`)
  } finally {
    await browser('close').catch(() => undefined)
    // Retain the small JSON/screenshot evidence, not the generated bundle.
    await rm(`${directory}/index.html`, { force: true })
  }
}, 60_000)
