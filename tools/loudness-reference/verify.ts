import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { analyzeLoudness } from '../../packages/audio-engine/src/loudness-analyzer'

type Fixture = {
  name: string
  sampleRate: number
  channels: Float32Array[]
}

type ReferenceReport = {
  reference: string
  version: string
  integratedLufs: number | null
  loudnessRangeLu: number | null
  truePeak: number
  truePeakDbtp: number | null
}

const decoder = new TextDecoder()

const run = (command: string[], cwd?: string) => {
  const result = Bun.spawnSync({
    cmd: command,
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (result.exitCode !== 0) {
    const stdout = decoder.decode(result.stdout).trim()
    const stderr = decoder.decode(result.stderr).trim()
    throw new Error([
      `Command failed (${result.exitCode}): ${command.join(' ')}`,
      stdout,
      stderr,
    ].filter(Boolean).join('\n'))
  }
  return decoder.decode(result.stdout).trim()
}

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readNullableNumber = (value: unknown, field: string) => {
  if (value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Reference field "${field}" is invalid.`)
  }
  return value
}

const parseReferenceReport = (text: string): ReferenceReport => {
  const value: unknown = JSON.parse(text)
  if (!isRecord(value)
    || value.reference !== 'libebur128'
    || typeof value.version !== 'string'
    || typeof value.truePeak !== 'number'
    || !Number.isFinite(value.truePeak)) {
    throw new Error('libebur128 reference output is invalid.')
  }
  return {
    reference: value.reference,
    version: value.version,
    integratedLufs: readNullableNumber(value.integratedLufs, 'integratedLufs'),
    loudnessRangeLu: readNullableNumber(value.loudnessRangeLu, 'loudnessRangeLu'),
    truePeak: value.truePeak,
    truePeakDbtp: readNullableNumber(value.truePeakDbtp, 'truePeakDbtp'),
  }
}

const dbToLinear = (db: number) => 10 ** (db / 20)

const createProgram = (sampleRate: number, channelCount: 1 | 2): Fixture => {
  const durationSec = 12
  const length = sampleRate * durationSec
  const levelsDb = [-24, -17, -34, -14, -27, -19]
  const left = new Float32Array(length)
  const right = channelCount === 2 ? new Float32Array(length) : undefined

  for (let frame = 0; frame < length; frame += 1) {
    const time = frame / sampleRate
    const segment = Math.min(levelsDb.length - 1, Math.floor(time / 2))
    const levelDb = levelsDb[segment] ?? -24
    const amplitude = dbToLinear(levelDb)
    left[frame] = amplitude * Math.sin(2 * Math.PI * 997 * time)
    if (right) {
      right[frame] = amplitude * 0.72 * Math.sin(2 * Math.PI * 613 * time + 0.37)
    }
  }

  const burstFrames = Math.floor(sampleRate * 0.08)
  for (let frame = 0; frame < burstFrames; frame += 1) {
    const phase = 2 * Math.PI * sampleRate * 0.235 * frame / sampleRate + 0.41
    left[frame] += 0.78 * Math.sin(phase)
    if (right) right[frame] -= 0.63 * Math.sin(phase + 0.23)
  }

  return {
    name: `${channelCount === 1 ? 'mono' : 'stereo'}-${sampleRate}`,
    sampleRate,
    channels: right ? [left, right] : [left],
  }
}

const interleave = (channels: Float32Array[]) => {
  const frameCount = channels[0]?.length ?? 0
  const interleaved = new Float32Array(frameCount * channels.length)
  for (let frame = 0; frame < frameCount; frame += 1) {
    for (let channel = 0; channel < channels.length; channel += 1) {
      interleaved[frame * channels.length + channel] = channels[channel]?.[frame] ?? 0
    }
  }
  return interleaved
}

const nullableDelta = (actual: number | null, reference: number | null) => {
  if (actual === null || reference === null) return actual === reference ? 0 : Number.POSITIVE_INFINITY
  return Math.abs(actual - reference)
}

const verifyFixture = async (
  fixture: Fixture,
  referenceExecutable: string,
  workingDirectory: string,
) => {
  const pcmPath = join(workingDirectory, `${fixture.name}.f32`)
  await Bun.write(pcmPath, interleave(fixture.channels))
  const reference = parseReferenceReport(run([
    referenceExecutable,
    String(fixture.sampleRate),
    String(fixture.channels.length),
    pcmPath,
  ]))
  const actual = analyzeLoudness({
    numberOfChannels: fixture.channels.length,
    length: fixture.channels[0]?.length ?? 0,
    sampleRate: fixture.sampleRate,
    getChannelData(channel) {
      const samples = fixture.channels[channel]
      if (!samples) throw new Error('Fixture channel is missing.')
      return samples
    },
  })

  const integratedDeltaLu = nullableDelta(actual.integratedLufs, reference.integratedLufs)
  const rangeDeltaLu = nullableDelta(actual.loudnessRangeLu, reference.loudnessRangeLu)
  const truePeakDeltaDb = nullableDelta(actual.truePeakDbtp, reference.truePeakDbtp)
  const passed = integratedDeltaLu <= 0.15
    && rangeDeltaLu <= 0.25
    && truePeakDeltaDb <= 0.30

  return {
    name: fixture.name,
    sampleRate: fixture.sampleRate,
    channels: fixture.channels.length,
    referenceVersion: reference.version,
    actual: {
      integratedLufs: actual.integratedLufs,
      loudnessRangeLu: actual.loudnessRangeLu,
      truePeakDbtp: actual.truePeakDbtp,
    },
    reference: {
      integratedLufs: reference.integratedLufs,
      loudnessRangeLu: reference.loudnessRangeLu,
      truePeakDbtp: reference.truePeakDbtp,
    },
    delta: {
      integratedLu: integratedDeltaLu,
      loudnessRangeLu: rangeDeltaLu,
      truePeakDb: truePeakDeltaDb,
    },
    passed,
  }
}

const findReferenceExecutable = async (buildDirectory: string) => {
  const candidates = process.platform === 'win32'
    ? [
      join(buildDirectory, 'Release', 'daw-loudness-reference.exe'),
      join(buildDirectory, 'daw-loudness-reference.exe'),
    ]
    : [join(buildDirectory, 'daw-loudness-reference')]
  for (const candidate of candidates) {
    if (await stat(candidate).then(() => true, () => false)) return candidate
  }
  throw new Error('Built libebur128 reference executable was not found.')
}

const temporaryRoot = await mkdtemp(join(tmpdir(), 'daw-loudness-reference-'))
try {
  const buildDirectory = join(temporaryRoot, 'build')
  run([
    'cmake',
    '-S', import.meta.dir,
    '-B', buildDirectory,
    '-DCMAKE_BUILD_TYPE=Release',
  ])
  run(['cmake', '--build', buildDirectory, '--config', 'Release', '--target', 'daw-loudness-reference', '-j', '2'])
  const referenceExecutable = await findReferenceExecutable(buildDirectory)

  const fixtures = [44_100, 48_000, 96_000].flatMap((sampleRate) => [
    createProgram(sampleRate, 1),
    createProgram(sampleRate, 2),
  ])
  const reports = []
  for (const fixture of fixtures) {
    reports.push(await verifyFixture(fixture, referenceExecutable, temporaryRoot))
  }

  const summary = {
    reference: 'libebur128',
    pinnedCommit: '67b33abe1558160ed76ada1322329b0e9e058b02',
    tolerances: {
      integratedLu: 0.15,
      loudnessRangeLu: 0.25,
      truePeakDb: 0.30,
    },
    reports,
  }
  console.log(JSON.stringify(summary, null, 2))
  if (reports.some((report) => !report.passed)) {
    throw new Error('Loudness reference validation exceeded the declared tolerance.')
  }
} finally {
  await rm(temporaryRoot, { recursive: true, force: true })
}
