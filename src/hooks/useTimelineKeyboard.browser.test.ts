import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { z } from 'zod'

test('isolates portalled dialogs and preserves arrangement and native keyboard behavior', async () => {
  const directory = `/tmp/daw-keyboard-${crypto.randomUUID()}`
  const session = `daw-keyboard-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    // Never inherit the attached desktop/CDP session for this isolated fixture.
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    // Bound CLI stalls independently of the test timeout, including cleanup.
    const timeout = setTimeout(() => child.kill(), 10_000)
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ])
      if (exitCode !== 0) throw new Error(`agent-browser ${args[0]} failed: ${stderr || stdout}`)
      return stdout.trim()
    } finally {
      clearTimeout(timeout)
    }
  }
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
