import { mkdir, writeFile } from 'node:fs/promises'
import { expect, test } from 'bun:test'
import { z } from 'zod'

import { runServedBrowserFixture } from '~/test-support/browser-fixture-test-support'

const note = z.object({
  idleSilent: z.boolean(), heard: z.boolean(), holds: z.boolean(), endsOnItsOwn: z.boolean(), silentAfterRelease: z.boolean(),
  renderMs: z.number().nullable(), wallMs: z.number().nullable(), preparedAfterMs: z.number().nullable(), lastSoundMs: z.number().nullable(), peak: z.number(),
})

const data = z.object({
  auditionSec: z.number(), soundThreshold: z.number(), silenceThreshold: z.number(),
  measurements: z.array(z.object({
    instrument: z.string(), mode: z.enum(['cold', 'prepared']), contextBuiltBeforeNote: z.boolean(), preparedBeforeFirstNote: z.boolean(),
    first: note, second: note, faults: z.array(z.string()),
  })),
})

const outputDirectory = new URL('../../acceptance-reports/instruments-research-2026-11-27/live-notes-e2e/', import.meta.url).pathname
const ms = (value: number | null) => value === null ? 'none' : value.toFixed(1)

test('live notes sound and release through the real hooks, portable controller and WASM core while the transport is stopped', async () => {
  const { results, data: published } = await runServedBrowserFixture(new URL('./live-notes.browser-runtime.tsx', import.meta.url))
  const measured = data.parse(published)
  await mkdir(outputDirectory, { recursive: true })

  await writeFile(`${outputDirectory}/live-notes.json`, `${JSON.stringify({
    recordedAt: new Date().toISOString(),
    note: 'Latencies are provisional: they were measured on a shared machine. renderMs is the render-clock distance from the note-on call to the first output block above the sound threshold (128-frame blocks); wallMs is the main-thread distance to that block\'s arrival.',
    ...measured,
    results,
  }, null, 2)}\n`)

  const row = (instrument: string, mode: string) => {
    const entry = measured.measurements.find((candidate) => candidate.instrument === instrument && candidate.mode === mode)

    return entry ? `${ms(entry.first.renderMs)} / ${ms(entry.first.wallMs)} | ${ms(entry.second.renderMs)} / ${ms(entry.second.wallMs)}` : 'missing | missing'
  }

  const instruments = [...new Set(measured.measurements.map((entry) => entry.instrument))]

  await writeFile(`${outputDirectory}/report.md`, [
    '# Live notes E2E',
    '',
    'Real useTimelinePlayback and useTimelineMidiOverlay, the real portable controller and the real WASM core on a real AudioContext in Chromium, with the transport stopped.',
    `Each note is an audition of ${measured.auditionSec} s. Output is a pass-through worklet tap on the context destination; a block is sound above ${measured.soundThreshold} and silent at or below ${measured.silenceThreshold}.`,
    'Each case checks that the output was silent before the note, sounds while the note is held, and is silent from 1.2 s after the release. A Drum Rack pad plays a 0.15 s one-shot (pads 36 and 37), so its check is that the sound ends on its own inside the audition.',
    'The first note of a cold case follows the mount at once, and the engine has no audio context yet: its first audio builds one. A prepared case opens the instrument panel first, which builds the context and the paused session.',
    '',
    'Latency is note-on call to the first non-zero output block, as render ms / wall ms. **Provisional**: measured while other work may have been using the CPU.',
    '',
    '| Instrument | Cold: first note | Cold: second note | Prepared: first note | Prepared: second note |',
    '| --- | --- | --- | --- | --- |',
    ...instruments.map((instrument) => `| ${instrument} | ${row(instrument, 'cold')} | ${row(instrument, 'prepared')} |`),
    '',
    'Cold: nothing prepared, the note carries the transport and waits for the session. Prepared: the instrument panel opened first and the paused session was ready before the note.',
    '',
    `Checks: ${Object.values(results).filter(Boolean).length} of ${Object.keys(results).length} passed.`,
    '',
  ].join('\n'))

  expect(Object.keys(results)).toHaveLength(40)
  expect(Object.entries(results).filter(([, passed]) => !passed)).toEqual([])
}, 240_000)
