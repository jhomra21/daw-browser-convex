import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'vite'
import solidPlugin from 'vite-plugin-solid'
import tailwindcss from '@tailwindcss/vite'
import { z } from 'zod'

const root = new URL('../../../', import.meta.url).pathname.replace(/\/$/u, '')
const evidence = process.env.DAW_INSTRUMENT_EVIDENCE ?? `${root}/acceptance-reports/native-running-seek-${crypto.randomUUID()}`
const runtime = `${root}/src/lib/desktop/native-playback-lifecycle.browser-runtime.ts`
const stateSchema = z.object({
  isPlaying: z.boolean(), prepared: z.boolean(), preparing: z.boolean(), active: z.boolean(),
  projectGeneration: z.number(),
  position: z.number().nullable(), hostPrepared: z.boolean(), hostStarted: z.boolean(),
  playheadSec: z.number(), hostRunning: z.boolean(), hostCycleActive: z.boolean(),
  hostCycleStartSec: z.number(), hostCycleEndSec: z.number(),
  commitHeld: z.boolean(), liveLeases: z.number(), leaseAcquires: z.number(), leaseReleases: z.number(),
  duplicateLeaseReleases: z.number(), meterSubscriptions: z.number(), spectrumSubscriptions: z.number(),
  scheduleSubscriptions: z.number(), lossSubscriptions: z.number(), meterAdds: z.number(),
  spectrumAdds: z.number(), mappedAssets: z.number(), mappedCreates: z.number(), pageWrites: z.number(),
  attachmentCoordinates: z.number(), starts: z.number(), stops: z.number(), teardowns: z.number(),
  rollbacks: z.number(), scheduleRejections: z.number(), faults: z.array(z.string()),
  trace: z.array(z.object({ sequence: z.number(), event: z.string(), owner: z.number(), detail: z.union([z.number(), z.string()]).optional() })),
})

const fixtureHtml = async () => {
  const beforeFix = process.env.DAW_LATE_COMMIT_BASELINE === '1'
  const graphEnvelopeUrl = `data:text/javascript;base64,${Buffer.from(await Bun.file(`${root}/public/audio-worklets/daw-portable-graph-envelope-v3.js`).text()).toString('base64')}`
  const portableHost = (await Bun.file(`${root}/public/audio-worklets/daw-portable-audio-core-host-v2.js`).text())
    .replace('export class DawPortableAudioCoreHost', 'window.FixturePortableHost = class DawPortableAudioCoreHost')
    .replace("'./daw-portable-graph-envelope-v3.js'", JSON.stringify(graphEnvelopeUrl))
  const result = await build({
    root, configFile: false, logLevel: 'silent',
    define: { 'process.env.NODE_ENV': '"production"', 'import.meta.env.VITE_DESKTOP': '"true"', 'import.meta.env.VITE_CONVEX_URL': '"https://fixture.convex.cloud"' },
    plugins: [solidPlugin(), tailwindcss(), {
      name: 'isolated-lifecycle-repository-observer',
      enforce: 'pre',
      resolveId: (id, importer) => importer?.endsWith('/src/hooks/useTimelinePlayback.ts')
        && id.endsWith('/lib/desktop/native-playback-controller')
        ? '\0observed-native-controller'
        : importer?.endsWith('/src/hooks/usePlayheadControls.ts') && id === './useTimelinePlayback'
          ? '\0observed-timeline-playback'
          : importer?.endsWith('/src/components/timeline/EffectsPanel.tsx') && id.endsWith('/create-effects-panel-controller')
            ? '\0observed-panel-controller'
          : undefined,
      load: async (id) => {
        if (process.env.DAW_INSTRUMENT_R22_REFRESH_BASELINE === '1'
          && id === `${root}/src/lib/portable-browser-playback-controller.ts`) {
          return Bun.file(`${root}/acceptance-reports/daw-experience-packaged-r22-2026-10-16/initial-portable-controller.ts.txt`).text()
        }
        if (process.env.DAW_INSTRUMENT_R21_REFRESH_BASELINE === '1'
          && id === `${root}/src/lib/portable-browser-playback-controller.ts`) {
          // Replay the reviewed stale replacement without touching source files.
          return (await Bun.file(id).text())
            .replace('if (parameterSnapshot) {', 'if (false && parameterSnapshot) {')
            .replace('if (parameterGeneration !== instrumentParameterGeneration) {', 'if (false) {')
        }
        if (id === `${root}/src/hooks/useEffectsPanelAudioSync.ts`) {
          // The fixture has no authenticated room. Once synthetic subscription
          // rows arrive, don't let its local storage mirror act as a second
          // remote authority.
          return (await Bun.file(id).text()).replace(
            'if (isLocalId("project", projectId) && track.kind === "instrument")',
            'if (options.roomEffects() === undefined && isLocalId("project", projectId) && track.kind === "instrument")',
          )
        }
        if (!process.env.DAW_LOOP_REGRESSION && id === `${root}/src/hooks/useTimelinePlayback.ts`) {
          return (await Bun.file(id).text()).replace(
            '    await awaitPendingPauseAndStop()\n    if (isSuperseded()) return',
            '    await awaitPendingPauseAndStop()\n    await Reflect.get(globalThis, "holdRebuildBeforeRetirement")?.()\n    if (isSuperseded()) return',
          )
        }
        if (process.env.DAW_INSTRUMENT_R20_BASELINE === '1' || process.env.DAW_INSTRUMENT_NO_IDENTITY_GUARD === '1') {
          if (id === `${root}/src/lib/desktop/native-built-in-parameter-mapper.ts`) {
            return (await Bun.file(id).text()).replace(
              "case 'instrument':\n      values = mapInstrument(payload)\n      break",
              "case 'instrument': if (Reflect.get(globalThis, 'instrumentKnobBaseline')) return undefined; values = mapInstrument(payload); break",
            )
          }
          if (id === `${root}/src/components/timeline/create-effects-panel-state.ts`) {
            return (await Bun.file(id).text()).replaceAll(
              'context.onStructuralPlaybackChange?.(targetId, next);',
              'if (next) context.onStructuralPlaybackChange?.(targetId, next);',
            )
          }
          if (id === `${root}/src/components/Timeline.tsx`) {
            return (await Bun.file(id).text()).replace(
              /onStructuralPlaybackChange: \(targetId: Track\["id"\], instrument: TrackInstrumentParams \| undefined\) => \{[\s\S]*?\n      usesLegacyAudioEngine,/u,
              `onStructuralPlaybackChange: (targetId, instrument) => {
                const previous = preparedInstrument(targetId);
                if (${process.env.DAW_INSTRUMENT_NO_IDENTITY_GUARD === '1' ? "!Reflect.get(globalThis, 'instrumentKnobBaseline') && " : ""}previous && previous.kind === instrument.kind && previous.instanceId === instrument.instanceId) return;
                if (!isPlaying() && !isNativePlaybackPrepared() && !isPortableBrowserPlaybackPrepared() && !isStructuralRebuildInProgress() && !isPreparingPlayback()) return;
                void rebuildPlaybackBackend(renderTracks(), undefined, { targetId, instrument });
              },
      usesLegacyAudioEngine,`,
            )
          }
        }
        if (id === '\0observed-panel-controller') {
          return `export { observePanelController as createEffectsPanelController } from ${JSON.stringify(runtime)}`
        }
        if (process.env.DAW_LOOP_REGRESSION === 'stop-ordering' && id === `${root}/src/hooks/useTimelinePlayback.ts`) {
          return (await Bun.file(id).text())
            .replace('publishPlayhead(0)', '')
            .replace('if (stopSeekSequence === nativeSeekSequence)', 'if (true)')
            .replace(
              'if (!requiresNativeAudio && stopSeekSequence === nativeSeekSequence)',
              'publishPlayhead(0)\n      if (!requiresNativeAudio)',
            )
        }
        // Replay each reviewed regression without changing the working tree.
        if (process.env.DAW_LOOP_REGRESSION === 'button' && id === `${root}/src/components/Timeline.tsx`) {
          return (await Bun.file(id).text()).replace('else if (isPlaying() && !isNativePlaybackPrepared())', 'else if (isPlaying())')
        }
        if (process.env.DAW_LOOP_REGRESSION === 'settings' && id === `${root}/src/hooks/useTimelinePreferences.ts`) {
          return (await Bun.file(id).text()).replaceAll('subscribeToChanges: subscribeToLocalProjectChanges,', '')
        }
        if (process.env.DAW_LOOP_REGRESSION === 'cold' && id === `${root}/src/lib/desktop/native-playback-controller.ts`) {
          return (await Bun.file(id).text()).replace(
            'const runtimeSnapshot = { ...configuredSnapshot, transport: effectiveTransport }',
            'const runtimeSnapshot = configuredSnapshot',
          )
        }
        if (process.env.DAW_LOOP_REGRESSION === 'drag' && id === `${root}/src/components/timeline/TimelineRuler.tsx`) {
          return (await Bun.file(id).text()).replace(
            'setLoopPreview({ startSec: nextStart, endSec: curEnd })',
            'props.onSetLoopRegion(nextStart, curEnd)',
          )
        }
        if (process.env.DAW_LOOP_REGRESSION === 'portable' && id === `${root}/src/lib/portable-browser-playback-controller.ts`) {
          return (await Bun.file(id).text()).replace(
            /const transport = effectiveLoopForStart\(\s*configuredTransport,\s*Math\.round\(configuredTransport\.playheadSec \* context\.sampleRate\),\s*context\.sampleRate,\s*\)/u,
            'const transport = configuredTransport',
          )
        }
        if (id === `${root}/src/lib/auth-client.ts`) return `export const authClient = { getSession: async () => ({ data: null }), signOut: async () => undefined };`
        // This journey is local-only. Keep cloud I/O disconnected.
        if (id === `${root}/src/lib/convex.ts`) return `
          import { createSignal } from 'solid-js';
          const [roomRows, setRoomRows] = createSignal();
          Object.assign(window, { setFixtureRoomEffects: setRoomRows });
          export { api as convexApi } from ${JSON.stringify(`${root}/convex/_generated/api.js`)};
          export const convexClient = { mutation: async () => { throw new Error('Cloud mutation in local journey') }, query: async () => undefined };
          export const useConvexQuery = (_fn, _args, key) => ({ get data() { return key?.()[0] === 'effects' && key?.()[1] === 'room' ? roomRows() : undefined }, status: 'success', isPending: false, isLoading: false, isError: false, refetch: async () => ({ data: undefined }) });
        `
        if (id === '\0observed-native-controller') {
          return `export { observeController as createNativePlaybackController } from ${JSON.stringify(runtime)};
            export { nativePlaybackFaultText } from ${JSON.stringify(`${root}/src/lib/desktop/native-playback-controller.ts`)}`
        }
        if (id === '\0observed-timeline-playback') {
          return `export { observePlayback as useTimelinePlayback } from ${JSON.stringify(runtime)}`
        }
        if (beforeFix && id === `${root}/src/lib/desktop/native-playback-controller.ts`) {
          return Bun.file(`${root}/acceptance-reports/daw-experience-late-commit-stop-2026-10-13/controller-before.ts.txt`).text()
        }
        return undefined
      },
    }],
    resolve: { alias: { '~': `${root}/src` } },
    build: { write: false, minify: false, rollupOptions: { output: { inlineDynamicImports: true } }, lib: { entry: runtime, formats: ['iife'], name: 'nativeLifecycleFixture' } },
  })
  const output = Array.isArray(result) ? result[0] : result
  if (!output || !('output' in output)) throw new Error('Expected fixture bundle.')
  const chunk = output.output.find((value) => value.type === 'chunk')
  if (!chunk) throw new Error('Fixture JavaScript missing.')
  const css = output.output.flatMap(value => value.type === 'asset' && value.fileName.endsWith('.css') ? [z.union([z.string(), z.instanceof(Uint8Array).transform(bytes => new TextDecoder().decode(bytes))]).parse(value.source)] : []).join('\n')
  return `<!doctype html><meta charset="utf-8"><body><script type="module">${portableHost.replaceAll('</script', '<\\/script')}</script><script>if(location.search.includes("layout")){const s=document.createElement("style");s.textContent=${JSON.stringify(css + "\nhtml,body{height:100%;margin:0}")};document.head.append(s)}window.fixtureErrors=[];window.addEventListener('error',e=>window.fixtureErrors.push(JSON.stringify({message:e.message,error:String(e.error),stack:e.error?.stack})));window.addEventListener('unhandledrejection',e=>document.body.append(String(e.reason?.stack ?? e.reason)))</script><script>${chunk.code.replaceAll('</script', '<\\/script')}</script>`
}

test('Chromium prepares instrument-only regions before notes and balances replace, cancel, late ACK, Stop/Play and project switch', async () => {
  const directory = `/tmp/daw-sample-paging-${crypto.randomUUID()}`
  await mkdir(directory)
  await mkdir(evidence, { recursive: true })
  await Bun.write(`${directory}/index.html`, await fixtureHtml())
  const session = `daw-sample-paging-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const browser = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (exit !== 0) throw new Error(error || out)
    return out.trim()
  }
  const schema = stateSchema.extend({
    installCalls: z.number(), maximumPagePayload: z.number(), configuredInstruments: z.number(),
    liveNotes: z.number(), instrumentBytes: z.number(), instrumentReservedBytes: z.number(), pageHeld: z.boolean(),
  })
  const read = async () => schema.parse(JSON.parse(JSON.parse(await browser('eval', 'JSON.stringify(nativeLifecycle.snapshot())'))))
  const wait = (condition: string) => browser('wait', '--fn', condition)
  const save = async (kind: string, stage: string) => {
    const state = await read()
    await Bun.write(`${evidence}/paging-${kind}-${stage}.json`, JSON.stringify(state, null, 2))
    return state
  }
  try {
    for (const kind of ['sampler', 'granular', 'drum-rack']) {
      await browser('open', `file://${directory}/index.html?sampled=${kind}`)
      await wait('!!window.nativeLifecycle')
      await browser('eval', 'nativeLifecycle.armPage()')
      await browser('click', '#preview')
      await wait('nativeLifecycle.snapshot().pageHeld')
      await browser('eval', 'nativeLifecycle.note()')
      const loading = await save(kind, 'loading')
      expect(loading.prepared).toBe(false)
      expect(loading.configuredInstruments).toBe(0)
      expect(loading.liveNotes).toBe(0)
      await browser('eval', 'nativeLifecycle.releasePage()')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
      const ready = await save(kind, 'ready')
      expect(ready.prepared).toBe(true)
      expect(ready.liveNotes).toBe(0)
      expect(ready.installCalls).toBe(0)
      expect(ready.maximumPagePayload).toBeLessThanOrEqual(1024 ** 2)
      expect(ready.trace.find((entry) => entry.event === 'mapped.prepare')?.detail).toBe(384_000)
      expect(ready.trace.findIndex((entry) => entry.event === 'mapped.prepare'))
        .toBeLessThan(ready.trace.findIndex((entry) => entry.event === 'instrument.configure'))
      expect(ready.instrumentReservedBytes).toBe(0)
      await browser('eval', 'nativeLifecycle.note()')
      await wait('nativeLifecycle.snapshot().liveNotes === 1')
      await browser('eval', 'nativeLifecycle.replaceSample()')
      const replaced = await save(kind, 'replaced')
      expect(replaced.mappedAssets).toBe(1)
      expect(replaced.instrumentBytes).toBe(ready.instrumentBytes)
      await browser('click', '#play')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
      await browser('click', '#stop')
      await browser('eval', 'nativeLifecycle.settle()')
      await browser('click', '#play')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
      expect((await read()).isPlaying).toBe(true)
      await browser('eval', 'nativeLifecycle.setLoopProbePosition(0.875)')
      await browser('eval', 'nativeLifecycle.settle()')
      const beforeSwitch = await read()
      expect(beforeSwitch.playheadSec).toBeCloseTo(0.875)
      await browser('click', '#switch')
      await browser('eval', 'nativeLifecycle.settle()')
      const switched = await save(kind, 'project-switch')
      expect(switched.instrumentBytes).toBe(0)
      expect(switched.mappedAssets).toBe(0)
      expect(switched.playheadSec).toBe(0)
      expect(switched.trace.filter((entry) => entry.event.startsWith('transport.'))).toHaveLength(
        beforeSwitch.trace.filter((entry) => entry.event.startsWith('transport.')).length,
      )

      await browser('eval', 'nativeLifecycle.armPage()')
      await browser('click', '#preview')
      await wait('nativeLifecycle.snapshot().pageHeld')
      await browser('click', '#stop')
      await browser('eval', 'nativeLifecycle.releasePage()')
      await browser('eval', 'nativeLifecycle.settle()')
      const canceled = await save(kind, 'cancel-page')
      expect(canceled.prepared).toBe(false)
      expect(canceled.instrumentBytes).toBe(0)
      expect(canceled.instrumentReservedBytes).toBe(0)
      expect(canceled.mappedAssets).toBe(0)

      await browser('eval', 'nativeLifecycle.armCommit()')
      await browser('click', '#preview')
      await wait('nativeLifecycle.snapshot().commitHeld')
      await browser('click', '#stop')
      await wait('!nativeLifecycle.snapshot().hostPrepared')
      await browser('eval', 'nativeLifecycle.releaseCommit()')
      await browser('eval', 'nativeLifecycle.settle()')
      const late = await save(kind, 'late-ack')
      expect(late.prepared).toBe(false)
      expect(late.instrumentBytes).toBe(0)
      expect(late.instrumentReservedBytes).toBe(0)
      expect(late.mappedAssets).toBe(0)
      expect(late.installCalls).toBe(0)
      expect(late.faults).toEqual([])
      await browser('eval', 'nativeLifecycle.close()')
    }
  } finally {
    await browser('close')
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

test('3B1 full Timeline desired instruments reconcile post-capture and exclude a stale start', async () => {
  const directory = `/tmp/dv01-timeline-desired-${crypto.randomUUID()}`
  await mkdir(directory)
  await mkdir(evidence, { recursive: true })
  await Bun.write(`${directory}/index.html`, await fixtureHtml())
  const session = `dv01-timeline-desired-${crypto.randomUUID()}`
  const { AGENT_BROWSER_CDP: _cdp, AGENT_BROWSER_SESSION: _session, ...env } = process.env
  const browser = async (...args: string[]) => {
    const child = Bun.spawn(['perl', '-e', 'alarm shift; exec @ARGV', '90', 'agent-browser', '--session', session, ...args],
      { env, stdout: 'pipe', stderr: 'pipe' })
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited])
    if (code !== 0) throw new Error(`${args.join(" ")}: ${err || out}`)
    return out.trim()
  }
  const read = async () => z.object({ reads: z.array(z.object({ afterStart: z.boolean(), capture: z.number(),
    instruments: z.array(z.tuple([z.string(), z.object({ kind: z.string(), state: z.object({ filterCutoffHz: z.number() }).optional() })])) })),
    trace: z.array(z.object({ event: z.string() })),
  }).parse(JSON.parse(JSON.parse(await browser('eval', 'JSON.stringify(dv01Timeline.evidence())'))))
  try {
    await browser('open', `file://${directory}/index.html?timeline&layout`)
    await browser('wait', '--fn', '!!window.timelineJourney?.instrumentTrackId')
    await browser('eval', 'dv01Timeline.holdCapture()')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'dv01Timeline.held()')
    await browser('eval', 'timelineJourney.setPanelInstrument(timelineJourney.instrumentTrackId, "instrument:layout-fixture", 431)')
    await browser('wait', '--fn', 'timelineJourney.instrumentEvidence(timelineJourney.instrumentTrackId).desiredInstrument?.params.filter.frequencyHz === 431')
    await browser('eval', 'dv01Timeline.releaseCapture()')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    await browser('eval', 'timelineJourney.flushInstrument()')
    const current = await read()
    const afterStart = current.reads.filter(row => row.afterStart)
    expect(afterStart.length).toBeGreaterThan(0)
    expect(afterStart.filter(row => row.capture === afterStart[0]?.capture)).toHaveLength(1)
    expect(afterStart[0]?.instruments.some(([, instrument]) => instrument.kind === 'synth' && instrument.state?.filterCutoffHz === 431)).toBeTrue()
    const start = current.trace.findIndex(row => row.event === 'session.start')
    expect(current.trace.slice(start + 1).some(row => row.event === 'desired.read')).toBeTrue()
    // A fresh Timeline is invalidated after actual configure/start, while run confirmation is held.
    await browser('open', `file://${directory}/index.html?timeline&layout`)
    await browser('wait', '--fn', '!!window.timelineJourney?.instrumentTrackId')
    await browser('eval', 'dv01Timeline.holdRun()')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'dv01Timeline.runHeld()')
    const before = await read()
    await browser('eval', 'void timelineJourney.close()')
    await browser('eval', 'dv01Timeline.releaseRun()')
    await browser('wait', '--fn', '!timelineJourney.snapshot().preparing')
    const stale = await read()
    expect(stale.reads.length).toBe(before.reads.length)
    expect(stale.reads.some(row => row.afterStart)).toBeFalse()
    expect(stale.trace.some(row => row.event === 'session.start')).toBeTrue()
    expect(stale.trace.some(row => row.event === 'instrument.configure')).toBeTrue()
    await Bun.write(`${evidence}/3b1-timeline-desired.json`, JSON.stringify({ current, stale }, null, 2))
    if (process.env.DV01_3B1_REPORT === '1') console.log(`DV01-3B1 ${JSON.stringify({
      name: 'R2-B6a full Timeline desired-instrument callback', location: 'src/components/Timeline.tsx',
      flip: 'Actual Timeline projection after capture/start', status: 'green', failure: null, expectedFailure: null, standIn: null,
      evidence: { current, stale, artifact: `${evidence}/3b1-timeline-desired.json` },
    })}`)
  } finally {
    await browser('eval', 'dv01Timeline.releaseCapture(); dv01Timeline.releaseRun(); timelineJourney.close()').catch(() => undefined)
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)

test('real Chromium owns late Commit cancellation, Stop settlement, and the next Play', async () => {
  await mkdir(evidence, { recursive: true })
  const directory = `/tmp/daw-late-commit-${crypto.randomUUID()}`
  await mkdir(directory)
  const html = await fixtureHtml()
  await Bun.write(`${directory}/index.html`, html)
  const session = `daw-late-commit-${crypto.randomUUID()}`
  const env = { ...process.env }
  delete env.AGENT_BROWSER_CDP
  delete env.AGENT_BROWSER_SESSION
  const browser = async (...args: string[]) => {
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], { env, stdout: 'pipe', stderr: 'pipe' })
    const [stdout, stderr, exit] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    if (exit !== 0) throw new Error(`Isolated browser ${args[0]}: ${stderr || stdout}`)
    return stdout.trim()
  }
  const read = async (script = 'nativeLifecycle.snapshot()') => stateSchema.parse(
    JSON.parse(JSON.parse(await browser('eval', `(async () => JSON.stringify(await ${script}))()`))),
  )
  const save = async (name: string, script?: string) => {
    const state = await read(script)
    await Bun.write(`${evidence}/${name}.json`, JSON.stringify(state, null, 2))
    return state
  }
  const idle = (state: z.infer<typeof stateSchema>) => {
    expect(state.isPlaying).toBe(false)
    expect(state.prepared).toBe(false)
    expect(state.preparing).toBe(false)
    expect(state.active).toBe(false)
    expect(state.hostPrepared).toBe(false)
    expect(state.hostStarted).toBe(false)
    expect(state.liveLeases).toBe(0)
    expect(state.leaseAcquires).toBe(state.leaseReleases)
    expect(state.duplicateLeaseReleases).toBe(0)
    expect(state.meterSubscriptions).toBe(0)
    expect(state.spectrumSubscriptions).toBe(0)
    expect(state.scheduleSubscriptions).toBe(0)
    expect(state.lossSubscriptions).toBe(0)
    expect(state.mappedAssets).toBe(0)
  }
  try {
    await browser('open', `file://${directory}/index.html`)
    await browser('wait', '--fn', '!!window.nativeLifecycle')
    await browser('eval', 'nativeLifecycle.armCommit()')
    await browser('click', '#play')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().commitHeld')
    const held = await save('01-commit-held')
    expect(held.liveLeases).toBe(1)
    expect(held.mappedCreates).toBe(2)
    expect(held.attachmentCoordinates).toBe(1)
    expect(held.starts).toBe(0)
    await browser('click', '#stop')
    await browser('click', '#stop')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().teardowns > 0')
    const stoppedWhileHeld = await save('02-stop-before-delivery')
    expect(stoppedWhileHeld.commitHeld).toBe(true)
    expect(stoppedWhileHeld.prepared).toBe(false)
    expect(stoppedWhileHeld.hostPrepared).toBe(false)
    expect(stoppedWhileHeld.scheduleSubscriptions).toBe(0)
    expect(stoppedWhileHeld.liveLeases).toBe(1)
    await browser('eval', 'nativeLifecycle.releaseCommit()')
    const canceled = await save('03-canceled-settled', 'nativeLifecycle.settle()')
    await browser('screenshot', `${evidence}/stopped.png`)
    // Retain exact counters/trace before assertions, including on regression.
    idle(canceled)
    expect(canceled.starts).toBe(0)
    expect(canceled.meterAdds).toBe(0)
    expect(canceled.spectrumAdds).toBe(0)
    expect(canceled.rollbacks).toBe(0)
    expect(canceled.faults).toEqual([])
    const events = canceled.trace.map((entry) => entry.event)
    expect(events.indexOf('commit.host-completed')).toBeLessThan(events.indexOf('session.stop'))
    expect(events.indexOf('session.teardown')).toBeLessThan(events.indexOf('gate.release'))
    expect(events.indexOf('gate.release')).toBeLessThan(events.indexOf('commit.renderer-delivery'))
    expect(events.indexOf('commit.renderer-delivery')).toBeLessThan(events.indexOf('stretch.release'))

    await browser('click', '#play')
    const playing = await save('04-next-play', 'nativeLifecycle.settlePlaying()')
    expect(playing.isPlaying).toBe(true)
    expect(playing.prepared).toBe(true)
    expect(playing.starts).toBe(1)
    expect(playing.pageWrites).toBeGreaterThan(0)
    const advanced = await save('05-next-play-progress', 'nativeLifecycle.advance()')
    expect(advanced.position).toBeGreaterThan(playing.position ?? 0)
    expect(advanced.faults).toEqual([])
    await browser('eval', 'nativeLifecycle.holdNextPause()')
    await browser('click', '#stop')
    await browser('wait', '--fn', 'nativeLifecycle.pauseHeld()')
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(10)')
    await browser('eval', 'nativeLifecycle.releasePause()')
    const stopThenSeek = await save('04a-stop-then-stopped-seek', 'nativeLifecycle.settlePlaying()')
    expect(stopThenSeek.isPlaying).toBe(false)
    expect(stopThenSeek.playheadSec).toBe(10)
    await browser('click', '#play')
    const playAfterStoppedSeek = await save('04b-play-after-stopped-seek', 'nativeLifecycle.settlePlaying()')
    expect(playAfterStoppedSeek.position).toBe(10)
    await browser('click', '#seek')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().hostRunning && nativeLifecycle.snapshot().position === 0.25')
    const sought = await save('05a-running-ruler-seek')
    expect(sought.isPlaying).toBe(true)
    expect(sought.active).toBe(true)
    expect(sought.starts).toBe(playing.starts)
    expect(sought.stops).toBe(playing.stops)
    expect(sought.teardowns).toBe(playing.teardowns)
    expect(sought.mappedCreates).toBe(playing.mappedCreates)
    expect(sought.attachmentCoordinates).toBe(playing.attachmentCoordinates)
    await browser('click', '#rapid-seek')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().hostRunning && nativeLifecycle.snapshot().position === 0.2')
    const rapid = await save('05b-rapid-backward-ruler-seek')
    expect(rapid.isPlaying).toBe(true)
    expect(rapid.starts).toBe(playing.starts)
    expect(rapid.teardowns).toBe(playing.teardowns)
    expect(rapid.faults).toEqual([])
    expect(rapid.trace.slice(sought.trace.length).filter((entry) => entry.event === 'transport.pause')).toHaveLength(1)
    const seekProgress = await save('05c-seek-progress', 'nativeLifecycle.advance()')
    expect(seekProgress.position).toBeGreaterThan(0.2)
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().playheadSec > 0.2')
    await browser('screenshot', `${evidence}/playing.png`)
    const beforeRoutineControls = await read()
    await browser('click', '#stop')
    const stopped = await save('05d-stop-with-prepared-session')
    expect(stopped.prepared).toBe(true)
    expect(stopped.teardowns).toBe(beforeRoutineControls.teardowns)
    await browser('click', '#seek')
    await browser('click', '#loop')
    await browser('click', '#follow')
    const routineControls = await save('05e-routine-controls')
    expect(routineControls.teardowns).toBe(beforeRoutineControls.teardowns)
    expect(routineControls.prepared).toBe(true)
    expect(routineControls.faults).toEqual([])
    await browser('click', '#pause')
    const paused = await save('06-paused', 'nativeLifecycle.settlePlaying()')
    expect(paused.prepared).toBe(true)
    expect(paused.isPlaying).toBe(false)
    await browser('click', '#seek')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().position === 0.25')
    const pausedSeek = await save('06a-paused-ruler-seek')
    expect(pausedSeek.isPlaying).toBe(false)
    expect(pausedSeek.hostRunning).toBe(false)
    await browser('click', '#play')
    const resumed = await save('07-resumed', 'nativeLifecycle.settlePlaying()')
    expect(resumed.isPlaying).toBe(true)
    expect(resumed.starts).toBe(1)
    await browser('click', '#stop')
    const ordinaryStop = await save('08-ordinary-stop', 'nativeLifecycle.settle()')
    expect(ordinaryStop.prepared).toBe(true)
    await browser('click', '#play')
    await browser('eval', 'nativeLifecycle.settlePlaying()')
    await browser('click', '#range-commit')
    const changedLoop = await save('08b-ruler-loop-range-commit', 'nativeLifecycle.settlePlaying()')
    expect(changedLoop.isPlaying).toBe(true)
    expect(changedLoop.hostRunning).toBe(true)
    expect(changedLoop.hostCycleActive).toBe(true)
    expect(changedLoop.hostCycleStartSec).toBeCloseTo(0.2, 4)
    expect(changedLoop.hostCycleEndSec).toBeCloseTo(0.3, 4)
    expect(changedLoop.trace.filter((entry) => entry.event === 'ui.ruler-loop-range-commit')).toHaveLength(1)
    expect(changedLoop.trace.slice(ordinaryStop.trace.length).some((entry) => entry.event === 'transport.pause')).toBe(true)
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(0.8)')
    const seekOutsideLoop = await save('08c-seek-outside-loop', 'nativeLifecycle.settlePlaying()')
    expect(seekOutsideLoop.isPlaying).toBe(true)
    expect(seekOutsideLoop.hostRunning).toBe(true)
    expect(seekOutsideLoop.position ?? -1).toBeCloseTo(0.8, 4)
    expect(seekOutsideLoop.hostCycleActive).toBe(false)
    await browser('click', '#pause')
    await browser('eval', 'nativeLifecycle.settlePlaying()')
    await browser('click', '#play')
    const resumedOutsideLoop = await save('08c1-resume-outside-loop', 'nativeLifecycle.settlePlaying()')
    expect(resumedOutsideLoop.hostCycleActive).toBe(false)
    expect(resumedOutsideLoop.position ?? -1).toBeCloseTo(0.8, 4)
    await browser('eval', 'nativeLifecycle.retireForColdPlay()')
    await browser('click', '#play')
    const coldOutsideLoop = await save('08c2-cold-play-outside-loop', 'nativeLifecycle.settlePlaying()')
    expect(coldOutsideLoop.hostCycleActive).toBe(false)
    expect(coldOutsideLoop.position ?? -1).toBeCloseTo(0.8, 4)
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(0.25)')
    const seekInsideLoop = await save('08d-seek-inside-loop', 'nativeLifecycle.settlePlaying()')
    expect(seekInsideLoop.position ?? -1).toBeCloseTo(0.25, 4)
    expect(seekInsideLoop.hostCycleActive).toBe(true)
    await browser('click', '#stop')
    await browser('eval', 'nativeLifecycle.settle()')
    await browser('click', '#seek')
    const stoppedSeek = await save('08a-stopped-ruler-seek')
    expect(stoppedSeek.prepared).toBe(true)
    expect(stoppedSeek.liveLeases).toBe(1)
    expect(stoppedSeek.playheadSec).toBe(0.25)
    expect(stoppedSeek.hostRunning).toBe(false)

    await browser('click', '#switch')
    await browser('eval', 'nativeLifecycle.settle()')
    await browser('eval', 'nativeLifecycle.armCommit()')
    await browser('click', '#play')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().commitHeld')
    await browser('click', '#switch')
    await browser('eval', 'nativeLifecycle.releaseCommit()')
    const switched = await save('09-project-switch', 'nativeLifecycle.settle()')
    expect(switched.hostPrepared).toBe(false)
    idle(switched)
    expect(switched.starts).toBe(coldOutsideLoop.starts)
    expect(switched.faults).toEqual([])
    await browser('click', '#play')
    expect((await save('10-new-project-play', 'nativeLifecycle.settlePlaying()')).isPlaying).toBe(true)
    await browser('click', '#stop')
    expect((await read('nativeLifecycle.settle()')).prepared).toBe(true)
    await browser('click', '#switch')
    await browser('eval', 'nativeLifecycle.settle()')

    await browser('eval', 'nativeLifecycle.armCommit()')
    await browser('click', '#preview')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().commitHeld')
    const beforeSupersession = await read()
    await browser('click', '#supersede')
    await browser('eval', 'nativeLifecycle.releaseCommit()')
    const preview = await save('11-preview-supersession', 'nativeLifecycle.settlePlaying()')
    expect(preview.prepared).toBe(true)
    expect(preview.active).toBe(false)
    expect(preview.starts).toBe(beforeSupersession.starts + 1)
    expect(preview.teardowns).toBe(beforeSupersession.teardowns + 1)
    expect(preview.liveLeases).toBe(1)
    expect(preview.meterSubscriptions).toBe(1)
    expect(preview.spectrumSubscriptions).toBe(1)
    expect(preview.faults).toEqual([])
    await browser('click', '#stop')
    expect((await read('nativeLifecycle.settle()')).prepared).toBe(true)
    await browser('click', '#switch')
    await browser('eval', 'nativeLifecycle.settle()')

    await browser('eval', 'nativeLifecycle.armCommit()')
    await browser('click', '#play')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().commitHeld')
    const beforeLoss = await read()
    await browser('click', '#stop')
    expect((await read()).hostPrepared).toBe(false)
    await browser('eval', 'nativeLifecycle.loseHost(); nativeLifecycle.releaseCommit()')
    const lost = await save('12-host-loss-during-canceled-success', 'nativeLifecycle.settle()')
    idle(lost)
    expect(lost.starts).toBe(beforeLoss.starts)
    expect(lost.faults).toEqual([])

    await browser('eval', 'nativeLifecycle.failCommit()')
    await browser('click', '#play')
    const failed = await save('13-genuine-current-failure', 'nativeLifecycle.settle()')
    idle(failed)
    expect(failed.rollbacks).toBe(1)
    expect(failed.faults).toHaveLength(1)
    expect(failed.faults[0]).toContain('Genuine current Commit rejection')
    await browser('click', '#play')
    await browser('eval', 'nativeLifecycle.settlePlaying()')
    await browser('eval', 'nativeLifecycle.failNextSchedule()')
    await browser('click', '#fail-loop')
    const failedLoop = await save('14-failed-loop-transition', 'nativeLifecycle.settle()')
    idle(failedLoop)
    expect(failedLoop.scheduleRejections).toBeGreaterThan(0)
    expect(failedLoop.faults.some((fault) => fault.includes('Genuine schedule submission rejection'))).toBe(true)
    await browser('click', '#play')
    const cyclesBegin = await save('14a-repeated-cycles-begin', 'nativeLifecycle.settlePlaying()')
    await browser('eval', 'nativeLifecycle.setLoopRange(20, 24)')
    await browser('eval', 'nativeLifecycle.settlePlaying()')
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(35)')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().position === 35 && nativeLifecycle.snapshot().hostRunning')
    expect((await save('14a-r15-seek-35')).hostCycleActive).toBe(false)
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(10)')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().position === 10 && nativeLifecycle.snapshot().hostRunning')
    expect((await save('14a-r15-seek-10')).hostCycleActive).toBe(true)
    const wrappedAt24 = await save('14a-r15-wrap-at-24', 'nativeLifecycle.advanceFrames(684000)')
    expect(wrappedAt24.position).toBe(20.25)
    expect(wrappedAt24.isPlaying).toBe(true)
    await browser('eval', 'nativeLifecycle.setLoopProbePosition(0)')
    await browser('wait', '--fn', 'nativeLifecycle.snapshot().position === 0 && nativeLifecycle.snapshot().hostRunning')
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await browser('eval', 'nativeLifecycle.holdNextPause()')
      await browser('click', '#seek')
      await browser('wait', '--fn', 'nativeLifecycle.pauseHeld()')
      await browser('click', '#stop')
      await browser('eval', 'nativeLifecycle.releasePause()')
      const stoppedDuringSeek = await save(`14b-${cycle}-stop-during-running-seek`, 'nativeLifecycle.settle()')
      expect(stoppedDuringSeek.isPlaying).toBe(false)
      expect(stoppedDuringSeek.hostRunning).toBe(false)
      expect(stoppedDuringSeek.position).toBe(0)
      expect(stoppedDuringSeek.prepared).toBe(true)
      await browser('click', '#play')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
      await browser('eval', `nativeLifecycle.holdNextPause(); nativeLifecycle.setLoopRange(${0.1 + cycle / 100}, 0.7)`)
      await browser('wait', '--fn', 'nativeLifecycle.pauseHeld()')
      await browser('click', '#stop')
      await browser('eval', 'nativeLifecycle.releasePause()')
      const stoppedDuringLoop = await save(`14c-${cycle}-stop-during-loop-update`, 'nativeLifecycle.settle()')
      expect(stoppedDuringLoop.isPlaying).toBe(false)
      expect(stoppedDuringLoop.hostRunning).toBe(false)
      expect(stoppedDuringLoop.position).toBe(0)
      expect(stoppedDuringLoop.prepared).toBe(true)
      expect(stoppedDuringLoop.starts).toBe(cyclesBegin.starts)
      expect(stoppedDuringLoop.stops).toBe(cyclesBegin.stops)
      expect(stoppedDuringLoop.teardowns).toBe(cyclesBegin.teardowns)
      expect(stoppedDuringLoop.faults).toEqual(cyclesBegin.faults)
      await browser('click', '#play')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
      await browser('click', '#stop')
      await browser('eval', 'nativeLifecycle.settle()')
      await browser('click', '#play')
      await browser('eval', 'nativeLifecycle.settlePlaying()')
    }
    await browser('eval', 'nativeLifecycle.holdNextPause()')
    await browser('click', '#stop')
    await browser('wait', '--fn', 'nativeLifecycle.pauseHeld()')
    await browser('eval', 'nativeLifecycle.loseHost(); nativeLifecycle.setLoopProbePosition(15); nativeLifecycle.releasePause()')
    const stoppedAfterLoss = await save('14d-loss-during-stop-stopped-seek', 'nativeLifecycle.settle()')
    expect(stoppedAfterLoss.isPlaying).toBe(false)
    expect(stoppedAfterLoss.prepared).toBe(false)
    expect(stoppedAfterLoss.playheadSec).toBe(15)
    await browser('click', '#play')
    const playAfterLoss = await save('14e-recovered-play-from-stopped-seek', 'nativeLifecycle.settlePlaying()')
    expect(playAfterLoss.isPlaying).toBe(true)
    expect(playAfterLoss.position).toBe(15)
    expect(playAfterLoss.hostCycleActive).toBe(false)
    await browser('click', '#pause')
    await browser('eval', 'nativeLifecycle.settlePlaying()')
    idle(await save('14-closed', 'nativeLifecycle.close()'))
    await browser('open', `file://${directory}/index.html?timeline`)
    await browser('wait', '--fn', '!!window.timelineJourney')
    await browser('wait', '--fn', '!!document.querySelector(\'[aria-label="Toggle loop region"]\')')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    const uiState = async () => JSON.parse(JSON.parse(await browser('eval', 'JSON.stringify(timelineJourney.snapshot())')))
    const uiBeforeLoop = await uiState()
    await browser('click', '[aria-label="Toggle loop region"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().cycleActive && timelineJourney.snapshot().running')
    const uiAfterLoop = await uiState()
    expect(uiAfterLoop.playing).toBe(true)
    expect(uiAfterLoop.teardowns).toBe(uiBeforeLoop.teardowns)
    expect(uiAfterLoop.stops).toBe(uiBeforeLoop.stops)
    await Bun.write(`${evidence}/15-production-loop-button.json`, JSON.stringify({ uiBeforeLoop, uiAfterLoop }, null, 2))
    const drag = async () => {
      await browser('eval', `(() => {
      const ruler = document.querySelector('[data-timeline-ruler="1"]');
      if (!ruler) throw new Error('Missing production ruler');
      const rect = ruler.getBoundingClientRect();
      ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: rect.left + 20, clientY: rect.top + 5, pointerId: 7 }));
      })()`)
      // Separate browser tasks model real pointer delivery, not a synthetic
      // same-task burst that would hide repeated native reconciliations.
      for (let move = 1; move <= 12; move += 1) {
        await browser('eval', `(() => {
          const rect = document.querySelector('[data-timeline-ruler="1"]').getBoundingClientRect();
          window.dispatchEvent(new PointerEvent('pointermove', { clientX: rect.left + 20 + ${move}, clientY: rect.top + 5, pointerId: 7 }));
        })()`)
      }
      return browser('eval', `(() => {
      const beforeRelease = timelineJourney.snapshot();
      window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 7 }));
      return JSON.stringify(beforeRelease);
    })()`)
    }
    const beforeDrag = await uiState()
    const dragPreview = JSON.parse(JSON.parse(await drag()))
    expect(dragPreview.pauses).toBe(beforeDrag.pauses)
    await browser('wait', '--fn', `timelineJourney.snapshot().running && timelineJourney.snapshot().pauses === ${beforeDrag.pauses + 1}`)
    const afterDrag = await uiState()
    expect(afterDrag.teardowns).toBe(beforeDrag.teardowns)
    await Bun.write(`${evidence}/16-production-ruler-drag.json`, JSON.stringify({ beforeDrag, dragPreview, afterDrag }, null, 2))
    for (const end of ['pointercancel', 'escape']) {
      // Start a create gesture away from the current brace.
      await browser('eval', `(() => {
        const r = document.querySelector('[data-timeline-ruler="1"]').getBoundingClientRect();
        document.querySelector('[data-timeline-ruler="1"]').dispatchEvent(new PointerEvent('pointerdown', { bubbles:true, cancelable:true, button:0, clientX:r.left+100, clientY:r.top+5, pointerId:8 }));
        window.dispatchEvent(new PointerEvent('pointermove', { clientX:r.left+140, pointerId:8 }));
        ${end === 'escape' ? "window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',cancelable:true}))" : "window.dispatchEvent(new PointerEvent('pointercancel', {pointerId:8}))"};
      })()`)
      expect((await uiState()).pauses).toBe(afterDrag.pauses)
    }
    await browser('eval', 'timelineJourney.commitLoop()')
    await browser('wait', '--fn', 'timelineJourney.snapshot().cycleStart === 0.3 && timelineJourney.snapshot().cycleEnd === 0.7 && timelineJourney.snapshot().running')
    const controlCommit = await uiState()
    expect(controlCommit.pauses).toBe(afterDrag.pauses + 1)
    expect(controlCommit.teardowns).toBe(afterDrag.teardowns)
    await Bun.write(`${evidence}/17-production-local-control-commit.json`, JSON.stringify(controlCommit, null, 2))
    await browser('eval', 'timelineJourney.seek(0.8)')
    await browser('wait', '--fn', 'timelineJourney.snapshot().position === 0.8 && timelineJourney.snapshot().running')
    expect((await uiState()).cycleActive).toBe(false)
    await browser('click', '[aria-label="Pause"]')
    await browser('wait', '--fn', '!timelineJourney.snapshot().running')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    const uiResumedOutside = await uiState()
    expect(uiResumedOutside.cycleActive).toBe(false)
    expect(uiResumedOutside.position).toBe(0.8)
    await browser('eval', 'timelineJourney.retire()')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    const uiColdOutside = await uiState()
    expect(uiColdOutside.cycleActive).toBe(false)
    expect(uiColdOutside.position).toBe(0.8)
    const configured = JSON.parse(JSON.parse(await browser('eval', '(async () => JSON.stringify(await timelineJourney.loop()))()')))
    expect(configured).toEqual({ enabled: true, startSec: 0.3, endSec: 0.7 })
    await Bun.write(`${evidence}/18-production-outside-loop-starts.json`, JSON.stringify({ uiResumedOutside, uiColdOutside, configured }, null, 2))
    const portable = JSON.parse(JSON.parse(await browser('eval', '(async () => JSON.stringify(await timelineJourney.portableLoopProbe()))()')))
    expect(portable.cold).toBe(0.8)
    expect(portable.resumed).toBe(0.8)
    expect(portable.beforeLoopWrap).toBeCloseTo(0.3, 4)
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') {
      expect(portable.liveResult.accepted).toBe(true)
      expect(portable.liveValues.some((event: { target: number; value: number }) => event.target === 3 && event.value === 913)).toBe(true)
      expect(portable.publicationsAfter).toBe(portable.publicationsBefore)
    }
    await Bun.write(`${evidence}/19-portable-loop-parity.json`, JSON.stringify(portable, null, 2))
    const refresh = JSON.parse(JSON.parse(await browser('eval', '(async () => JSON.stringify(await timelineJourney.portableRefreshProbe()))()')))
    await Bun.write(`${evidence}/19-portable-refresh-flush.json`, JSON.stringify(refresh, null, 2))
    expect(refresh.settledBeforeApplied).toBe(false)
    expect(refresh.result.accepted).toBe(true)
    expect(refresh.staleRefresh).toBe('started')
    expect(refresh.concurrent.accepted).toBe(true)
    expect(refresh.pendingResult.accepted).toBe(true)
    expect(refresh.preserved.params.filter.frequencyHz).toBe(946)
    expect(refresh.replacement.params.filter.frequencyHz).toBe(946)
    expect(refresh.liveValues).toContainEqual({ session: 2, epoch: 2, target: 3, value: 945 })
    expect(refresh.liveValues).toContainEqual({ session: 2, epoch: 2, target: 3, value: 946 })
    expect(refresh.liveValues).toContainEqual({ session: 2, epoch: 2, target: 3, value: 947 })
    expect(refresh.starts).toContainEqual({ session: 2, frame: 4_500 })
    expect(refresh.handoffMs).toBeLessThan(1_000)
    expect(refresh.coverage[0].endFrame).toBeGreaterThan(4_500)
    expect(refresh.coverage[1].endFrame).toBeGreaterThan(4_500)
    expect(refresh.nextRefresh).toBe('started')
    const workletLive = JSON.parse(JSON.parse(await browser('eval', `(() => {
      const faults=[];
      const host=new window.FixturePortableHost({sampleRate:48000,postMessage:message=>faults.push(message),close:()=>{}});
      host.ready=true;host.revision=1;host.transportEpoch=1;host.maxFramesPerBlock=128;
      host.memory=new WebAssembly.Memory({initial:1});let offset=4096;
      host.malloc=bytes=>{const result=offset;offset+=bytes;return result};host.free=()=>{};
      host.schedule={revision:1,transportEpoch:1};host.scheduleParameterStreams=[];
      host.scheduleInstrumentEvents=[{nodeId:1n,noteId:1n,sequence:1n,frame:0,type:1,pitch:60,value:0.8}];
      host.scheduleInstrumentCursor=0;host.scheduleCursor=0;
      host.scheduleEventView=new DataView(host.memory.buffer,64,4+256*20);
      host.scheduleInstrumentEventView=new DataView(host.memory.buffer,16384,4+256*48);
      for(const [sequence,value] of [[1000001,913],[1000002,740]])host.handleMessage({version:2,type:'instrument-events',epoch:1,events:[{nodeId:'track',noteId:1,sequence,frameOffset:0,type:'parameter',channel:0,note:3,value}]});
      const materialized=host.materializeSchedule(0,128);const events=[];
      for(let i=0;i<host.scheduleInstrumentEventCount;i++){const at=4+i*48;events.push({kind:host.scheduleInstrumentEventView.getUint32(at+32,true),target:host.scheduleInstrumentEventView.getUint32(at+40,true),value:host.scheduleInstrumentEventView.getFloat32(at+44,true),epoch:host.scheduleInstrumentEventView.getUint32(at+24,true)})}
      return JSON.stringify({materialized,events,faults});
    })()`)))
    await Bun.write(`${evidence}/19-portable-worklet-live-merge.json`, JSON.stringify(workletLive, null, 2))
    expect(workletLive.materialized).toBe(true)
    expect(workletLive.faults).toEqual([])
    expect(workletLive.events).toEqual([
      { kind: 1, target: 60, value: expect.closeTo(0.8, 5), epoch: 1 },
      { kind: 5, target: 3, value: 913, epoch: 1 },
      { kind: 5, target: 3, value: 740, epoch: 1 },
    ])
    await browser('eval', 'timelineJourney.loseHost()')
    await browser('wait', '--fn', '!timelineJourney.snapshot().playing && !timelineJourney.snapshot().prepared')
    await browser('eval', 'Array.from(document.querySelectorAll("button")).find(button => button.textContent.trim() === "OK")?.click()')
    for (const seconds of [10, 15]) {
      await browser('eval', `(() => {
        const ruler = document.querySelector('[data-timeline-ruler="1"]');
        const rect = ruler.getBoundingClientRect();
        ruler.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, button: 0, clientX: rect.left + ${seconds * 100}, clientY: rect.bottom - 2, pointerId: 9 }));
        window.dispatchEvent(new PointerEvent('pointerup', { pointerId: 9 }));
      })()`)
      const stoppedRecoveredSeek = await uiState()
      expect(stoppedRecoveredSeek.playheadSec).toBe(seconds)
      expect(stoppedRecoveredSeek.playing).toBe(false)
      await Bun.write(`${evidence}/20-stopped-ruler-after-loss-${seconds}.json`, JSON.stringify(stoppedRecoveredSeek, null, 2))
    }
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running && timelineJourney.snapshot().playing')
    const recoveredRulerPlay = await uiState()
    expect(recoveredRulerPlay.position).toBe(15)
    expect(recoveredRulerPlay.cycleActive).toBe(false)
    await Bun.write(`${evidence}/21-recovered-play-from-ruler.json`, JSON.stringify(recoveredRulerPlay, null, 2))
    await browser('screenshot', `${evidence}/production-timeline.png`)
    await browser('eval', 'timelineJourney.close()')
    await browser('set', 'viewport', '1720', '1080')
    await browser('open', `file://${directory}/index.html?timeline&layout`)
    await browser('wait', '--fn', `!!window.timelineJourney && !!document.querySelector('[aria-label="Play"]')`)
    await browser('eval', `(() => {for(const [label,enabled] of [['Toggle Follow',true],['Toggle snap to grid',false]]){const b=document.querySelector('button[aria-label="'+label+'"]');if((b.getAttribute('aria-pressed')==='true')!==enabled)b.click()}})()`)
    await browser('eval', 'timelineJourney.seek(70)')
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running && timelineJourney.snapshot().position === 70')
    const followLocate = JSON.parse(JSON.parse(await browser('eval', `(() => {
      const viewport = document.querySelector('[data-timeline-scroll-viewport="1"]');
      const ruler = document.querySelector('[data-timeline-ruler="1"]');
      const markers = [...ruler.querySelectorAll(':scope > .absolute.bottom-0')].map(e=>({x:parseFloat(e.style.left),sec:Number(e.textContent.trim().replace(/s$/,''))}));
      const pps = (markers[1].x-markers[0].x)/(markers[1].sec-markers[0].sec);
      const start = markers[0].sec-markers[0].x/pps;
      viewport.scrollLeft=(viewport.scrollWidth-viewport.clientWidth)/2+(2.8-start)*pps;
      viewport.dispatchEvent(new Event('scroll'));
      return JSON.stringify({start,pps,scrollLeft:viewport.scrollLeft});
    })()`)))
    await browser('eval', `(() => {
      const ruler=document.querySelector('[data-timeline-ruler="1"]');
      const rect=ruler.getBoundingClientRect();
      ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:rect.left+720,clientY:rect.bottom-2,pointerId:10}));
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:10}));
    })()`)
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    const followResult=await uiState()
    await Bun.write(`${evidence}/22-layout-follow-backward-locate.json`,JSON.stringify({followLocate,followResult},null,2))
    expect(followResult.position).toBeCloseTo(10,3)
    expect(followResult.playing).toBe(true)
    await browser('click', '[aria-label="Stop"]')
    await browser('eval', `(() => {
      const viewport=document.querySelector('[data-timeline-scroll-viewport="1"]');
      viewport.scrollLeft=(viewport.scrollWidth-viewport.clientWidth)/2-100000;
      viewport.dispatchEvent(new Event('scroll'));
    })()`)
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    await browser('eval', `document.querySelector('[aria-label="Toggle Follow"]').getAttribute('aria-pressed') === 'true' && document.querySelector('[aria-label="Toggle Follow"]').click()`)
    const clipBefore=await uiState()
    await browser('screenshot', `${evidence}/clip-before.png`)
    const playbackBeforeClip = await browser('eval', 'JSON.stringify(timelineJourney.snapshot())')
    await browser('click', '[data-timeline-clip-id]')
    await browser('wait', '150')
    const clipAfter=await uiState()
    const playbackAfterClip = await browser('eval', 'JSON.stringify(timelineJourney.snapshot())')
    await Bun.write(`${evidence}/23-layout-plain-clip-click.json`,JSON.stringify({clipBefore,clipAfter,playbackBeforeClip:JSON.parse(playbackBeforeClip),playbackAfterClip:JSON.parse(playbackAfterClip)},null,2))
    expect(clipAfter.playing).toBe(true)
    expect(clipAfter.running).toBe(true)
    expect(clipAfter.teardowns).toBe(clipBefore.teardowns)
    expect(JSON.parse(playbackAfterClip)).toEqual(JSON.parse(playbackBeforeClip))
    await browser('eval', `(()=>[...document.querySelectorAll('button')].find(button=>button.textContent.trim()==='Effects')?.click())()`)
    const knobBefore = await uiState()
    const knobTrackId = JSON.parse(await browser('eval', 'timelineJourney.instrumentTrackId'))
    const knobBeforeBoundary = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify(timelineJourney.instrumentEvidence("${knobTrackId}"))`)))
    await browser('eval', 'Reflect.set(globalThis, "instrumentKnobBaseline", true); timelineJourney.changeSynthCutoff(913)')
    await browser('eval', 'timelineJourney.flushInstrument()')
    await browser('wait', '500')
    const knobAfter = await uiState()
    const knobBoundary = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify(timelineJourney.instrumentEvidence("${knobTrackId}"))`)))
    await Bun.write(`${evidence}/25-knob-native-boundary.json`, JSON.stringify({ knobBefore, knobBeforeBoundary, knobAfter, knobBoundary }, null, 2))
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') {
      expect(knobBoundary.nativeParameters.filter((event: { target: number }) => event.target === 3).at(-1)?.value).toBe(913)
      expect(knobBoundary.instrument.params.filter.frequencyHz).toBe(913)
      expect(knobBoundary.nativeStates.length).toBe(knobBeforeBoundary.nativeStates.length)
    }
    expect(knobAfter.starts).toBe(knobBefore.starts)
    expect(knobAfter.stops).toBe(knobBefore.stops)
    expect(knobAfter.teardowns).toBe(knobBefore.teardowns)
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') {
      for (const [shiftKey, cutoff] of [[false, 12000], [true, 913]]) {
        await browser('eval', `document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:${shiftKey},bubbles:true,cancelable:true}))`)
        await browser('wait', '--fn', `timelineJourney.instrumentEvidence("${knobTrackId}").nativeParameters.filter(event=>event.target===3).at(-1)?.value === ${cutoff}`)
        const replay = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${knobTrackId}")})`)))
        await Bun.write(`${evidence}/25-knob-${shiftKey ? 'redo' : 'undo'}.json`, JSON.stringify(replay, null, 2))
        expect(replay.boundary.instrument.params.filter.frequencyHz).toBe(cutoff)
        expect(replay.state.starts).toBe(knobBefore.starts)
        expect(replay.state.stops).toBe(knobBefore.stops)
      }
    }
    const immediateGeometry = JSON.parse(JSON.parse(await browser('eval', `(() => {
      document.querySelector('[aria-label="Stop"]').click();
      const viewport=document.querySelector('[data-timeline-scroll-viewport="1"]');
      viewport.scrollLeft=(viewport.scrollWidth-viewport.clientWidth)/2+1000;
      viewport.dispatchEvent(new Event('scroll'));
      const ruler=document.querySelector('[data-timeline-ruler="1"]');
      const rect=ruler.getBoundingClientRect();
      ruler.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,cancelable:true,button:0,clientX:rect.left+500,clientY:rect.bottom-2,pointerId:11}));
      window.dispatchEvent(new PointerEvent('pointerup',{pointerId:11}));
      return JSON.stringify({rect:rect.toJSON(),scrollLeft:viewport.scrollLeft,markers:[...ruler.querySelectorAll(':scope > .absolute.bottom-0')].map(e=>({left:e.style.left,label:e.textContent})),state:timelineJourney.snapshot()});
    })()`)))
    await browser('wait','150')
    const immediateStopLocate=await uiState()
    await Bun.write(`${evidence}/24-layout-immediate-stop-locate.json`,JSON.stringify({immediateGeometry,immediateStopLocate},null,2))
    expect(immediateStopLocate.playing).toBe(false)
    expect(immediateStopLocate.playheadSec).toBeCloseTo(15,3)
    await browser('click', '[aria-label="Play"]')
    await browser('wait', '--fn', 'timelineJourney.snapshot().running')
    expect((await uiState()).position).toBeCloseTo(15,3)
    const localStoreTrackId = JSON.parse(await browser('eval', 'timelineJourney.coalescedTrackId'))
    await browser('eval', `timelineJourney.setLocalStoreInstrument("${localStoreTrackId}", "local-store:first", 621)`)
    await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${localStoreTrackId}")?.instanceId === "local-store:first"`)
    const localStoreBefore = await uiState()
    await browser('eval', `timelineJourney.setLocalStoreInstrument("${localStoreTrackId}", "local-store:first", 372)`)
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') {
      await browser('wait', '--fn', `timelineJourney.instrumentEvidence("${localStoreTrackId}").instrument?.params.filter.frequencyHz === 372`)
    } else await browser('wait', '300')
    const localStoreAfter = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${localStoreTrackId}")})`)))
    await Bun.write(`${evidence}/24b-unselected-local-store-update.json`, JSON.stringify({ localStoreBefore, localStoreAfter }, null, 2))
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') {
      expect(localStoreAfter.boundary.nativeParameters.filter((event: {target: number}) => event.target === 3).at(-1)?.value).toBe(372)
      expect(localStoreAfter.state.starts).toBe(localStoreBefore.starts)
      expect(localStoreAfter.state.stops).toBe(localStoreBefore.stops)
      await browser('eval', `timelineJourney.setPanelInstrument("${localStoreTrackId}", "local-store:replacement", 531); timelineJourney.flushInstrument()`)
      await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${localStoreTrackId}")?.instanceId === "local-store:replacement"`)
      for (const [shiftKey, instanceId, cutoff] of [[false, 'local-store:first', 372], [true, 'local-store:replacement', 531], [false, 'local-store:first', 372]]) {
        await browser('eval', `document.activeElement?.blur(); window.dispatchEvent(new KeyboardEvent('keydown',{key:'z',ctrlKey:true,shiftKey:${shiftKey},bubbles:true,cancelable:true}))`)
        await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${localStoreTrackId}")?.instanceId === "${instanceId}"`)
        const replay = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${localStoreTrackId}")})`)))
        await Bun.write(`${evidence}/24b-topology-${shiftKey ? 'redo' : 'undo'}.json`, JSON.stringify(replay, null, 2))
        expect(replay.boundary.instrument.params.filter.frequencyHz).toBe(cutoff)
        expect(replay.boundary.nativeStates.at(-1).cutoff).toBe(cutoff)
        expect(replay.state.playing).toBe(true)
      }
    }
    const remoteTrackId = JSON.parse(await browser('eval', 'timelineJourney.remoteTrackId'))
    const remoteBefore = await uiState()
    await browser('eval', `(() => {
      const rows=timelineJourney.roomRows();
      rows.push({_id:'fixture:remote',_creationTime:1,targetType:'track',trackId:timelineJourney.remoteTrackId,type:'instrument',params:{kind:'synth',instanceId:'remote:first',params:{...timelineJourney.instrumentEvidence(timelineJourney.instrumentTrackId).instrument.params,filter:{...timelineJourney.instrumentEvidence(timelineJourney.instrumentTrackId).instrument.params.filter,frequencyHz:823}}}});
      window.setFixtureRoomEffects(rows);
    })()`)
    await browser('eval', `timelineJourney.mirrorRoomInstrument("${remoteTrackId}")`)
    await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${remoteTrackId}")?.instanceId === "remote:first"`)
    const remoteAfter = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${remoteTrackId}")})`)))
    await Bun.write(`${evidence}/26-room-first-insertion.json`, JSON.stringify({ remoteBefore, remoteAfter }, null, 2))
    expect(remoteAfter.boundary.instrument.params.filter.frequencyHz).toBe(823)
    expect(remoteAfter.boundary.nativeStates.at(-1).cutoff).toBe(823)
    const coalescedTrackId = JSON.parse(await browser('eval', 'timelineJourney.coalescedTrackId'))
    await browser('eval', `(()=>[...document.querySelectorAll('[data-track-name]')].find(button=>button.textContent.trim()==='Coalesced instrument fixture')?.click())()`)
    const coalescedBefore = await uiState()
    const coalescedInstanceId = `instrument:coalesced-${crypto.randomUUID()}`
    await browser('eval', `(async()=>{await timelineJourney.coalescedInstrumentApply("${coalescedInstanceId}")})()`)
    await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${coalescedTrackId}")?.instanceId === "${coalescedInstanceId}"`)
    const coalescedAfter = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${coalescedTrackId}")})`)))
    await Bun.write(`${evidence}/27-overlapping-panel-applies.json`, JSON.stringify({ coalescedBefore, coalescedAfter }, null, 2))
    expect(coalescedAfter.boundary.instrument.params.filter.frequencyHz).toBe(740)
    expect(coalescedAfter.boundary.nativeStates.at(-1).cutoff).toBe(740)
    await browser('eval', `window.setFixtureRoomEffects(timelineJourney.roomRows().filter(row=>row.trackId!=="${remoteTrackId}")); timelineJourney.removeInstrument("${remoteTrackId}")`)
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${remoteTrackId}") === null`)
    else await browser('wait', '300')
    const removed = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${remoteTrackId}")})`)))
    await Bun.write(`${evidence}/28-instrument-removal.json`, JSON.stringify(removed, null, 2))
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') expect(removed.boundary.instrument).toBeNull()
    // Hold B before graph A retires, then queue A through panel-local apply.
    // The awaited handoff keeps A's registration behind B, while its draft is visible immediately.
    await browser('eval', 'timelineJourney.holdNextRebuild()')
    await browser('eval', `timelineJourney.setPanelInstrument("${coalescedTrackId}", "instrument:race-B", 650)`)
    await browser('wait', '--fn', 'timelineJourney.isRebuildHeld()')
    await browser('eval', `timelineJourney.setPanelInstrument("${coalescedTrackId}", "${coalescedInstanceId}", 740)`)
    await browser('wait', '--fn', `timelineJourney.instrumentEvidence("${coalescedTrackId}").desiredInstrument?.instanceId === "${coalescedInstanceId}" && timelineJourney.instrumentEvidence("${coalescedTrackId}").desiredInstrument?.params.filter.frequencyHz === 740`)
    await browser('eval', 'timelineJourney.releaseRebuild()')
    if (process.env.DAW_INSTRUMENT_R20_BASELINE !== '1') await browser('wait', '--fn', `timelineJourney.preparedInstrumentIdentity("${coalescedTrackId}")?.instanceId === "${coalescedInstanceId}"`)
    else await browser('wait', '500')
    await browser('eval', 'timelineJourney.flushInstrument()')
    const raceAfter = JSON.parse(JSON.parse(await browser('eval', `JSON.stringify({state:timelineJourney.snapshot(),boundary:timelineJourney.instrumentEvidence("${coalescedTrackId}")})`)))
    await Bun.write(`${evidence}/29-rebuild-race-A-B-A.json`, JSON.stringify(raceAfter, null, 2))
    expect(raceAfter.boundary.instrument.instanceId).toBe(coalescedInstanceId)
    expect(raceAfter.boundary.instrument.params.filter.frequencyHz).toBe(740)
    expect(raceAfter.boundary.nativeStates.at(-1).cutoff).toBe(740)
    expect(raceAfter.boundary.instrumentNotifications.at(-1).next.instanceId).toBe(coalescedInstanceId)
    expect(removed.boundary.instrument).toBeNull()
    await browser('eval', 'timelineJourney.close()')
    await Bun.write(`${evidence}/assertions.json`, JSON.stringify({
      status: 'passed', runtime: 'real Chromium', hostBoundary: 'emulated',
      packagedNativeOrdering: 'not verified',
      scenarios: ['successful Commit delivery gated across repeated Stop', 'no canceled Start or ownership publication',
        'exact Stretch lease release', 'next Play advances', 'running ruler seek without graph disposal',
        'rapid backward seeks coalesce and advance', 'paused ruler seek', 'pause/prepared resume',
        'play/seek/Stop/loop/Follow/settings update without host teardown request',
        'ordinary Stop preserves the prepared native session',
        'stopped ruler seek only moves the playhead',
        'committed ruler loop range updates the active native transport',
        'outside-loop seek continues linearly and a seek into the loop re-enables cycling',
        'real Timeline Loop button retains native playback',
        'real ruler pointer moves preview and reconcile once on release, never on cancellation',
        'local control preview/commit notifies real Timeline preferences and native loop observer',
        'native and portable cold Play and resume past loop end remain linear without changing settings',
        'stopped ruler seeks at 10/15 seconds survive host loss and next Play starts at 15 seconds',
        'repeated Stop during running seeks and loop updates keeps one prepared session',
        'failed loop transition reports fault and retires playback ownership',
        'project switch and new owner', 'serialized preview supersession', 'host loss after Stop with late successful reply',
        'genuine current Commit rejection and rollback'],
    }, null, 2))
    console.info(`Native running seek Chromium evidence: ${evidence}`)
  } catch (error) {
    await Bun.write(`${evidence}/failure-browser.json`, JSON.stringify({
      errors: await browser('errors').catch(String),
      moduleErrors: await browser('eval', 'window.fixtureErrors').catch(String),
      timeline: await browser('eval', 'window.timelineJourney?.snapshot()').catch(String),
      instrument: await browser('eval', 'window.timelineJourney?.instrumentEvidence(window.timelineJourney.instrumentTrackId)').catch(String),
      ui: await browser('eval', 'document.body.innerText.slice(-3000)').catch(String),
    }, null, 2))
    await save('failure-final-state').catch(() => undefined)
    await Bun.write(`${evidence}/assertions.json`, JSON.stringify({ status: 'failed', error: String(error), hostBoundary: 'emulated' }, null, 2))
    throw error
  } finally {
    await browser('eval', 'nativeLifecycle.releaseCommit(); nativeLifecycle.close()').catch(() => undefined)
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
