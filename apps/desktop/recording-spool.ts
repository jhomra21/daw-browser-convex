import { randomBytes, randomUUID } from "node:crypto"
import { constants, type BigIntStats } from "node:fs"
import { lstat, mkdir, open, opendir, realpath, unlink } from "node:fs/promises"
import path from "node:path"
import { z } from "zod"
import type { NativeMainRecordingStatus } from "./audio-host"
import type { NativeRecordingTake, NativeRecordingRelease } from "../../src/types/desktop-bridge"

type RecordingIntent = {
  userData: string
  projectId: string
  rendererGeneration: number
  projectGeneration?: number
  hostGeneration: number
  generation: number
  sessionId: bigint
  channelCount: number
  verifyDirectory?: (rootPath: string) => Promise<{ device: string; inode: string }>
}
type RecordingScope = { projectId: string; projectGeneration: number; rendererGeneration: number }
type PrivateRoot = { rootPath: string; root: { device: bigint; inode: bigint } }
// Main-only scalar evidence for the owned stdout collector, not a public protocol.
export type RecordingSpoolReleaseEvent = {
  version: 1
  releaseOrdinal: number
  sequence: number
  kind: "receipt-file-synced" | "receipt-directory-synced"
    | "source-unlink-started" | "source-unlinked" | "source-directory-synced"
  succeeded: boolean
  frames: number
  bytes: number
  blocks: number
  sampleRateHz: number
  channelCount: 1 | 2
}

// One main startup consumer owns this opt-in writer for the process lifetime.
// Output loss/capping is missing acceptance evidence, never a release gate.
export const createRecordingSpoolOrderEvidence = (flag: string | undefined, writeLine: (line: string) => void) => {
  if (flag !== "1") return undefined
  let events = 0
  let ready = false
  const write = (line: string) => {
    try { writeLine(line) } catch { /* Diagnostic output cannot veto I/O or startup. */ }
  }
  return {
    ready() {
      if (ready) return
      ready = true
      write('[recording-spool-order] {"version":1,"kind":"observer-ready"}\n')
    },
    observeRelease(event: RecordingSpoolReleaseEvent) {
      if (!ready || events === 16) return
      events++
      write(`[recording-spool-order] ${JSON.stringify(event)}\n`)
    },
  }
}
const integer = z.number().int().nonnegative().safe()
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/)
const intentSchema = z.object({
  version: z.literal(1), token: z.string().regex(/^[a-f0-9]{64}$/),
  projectIntent: z.string().min(1).max(256).regex(/^[^\0\r\n]+$/),
  intentAuthority: z.literal("trusted-renderer-declared"), rendererGeneration: integer,
  hostGeneration: integer, projectGeneration: integer.optional(), generation: integer.min(1),
  sessionId: decimal.refine((value) => BigInt(value) > 0n && BigInt(value) <= 0xffff_ffff_ffff_ffffn), channelCount: z.union([z.literal(1), z.literal(2)]),
  sampleRateHz: z.null(), stage: z.literal("configuring"),
}).strict()
const readySchema = intentSchema.extend({ sampleRateHz: integer.min(8000).max(384000), stage: z.literal("ready") })
const proofSchema = z.object({
  generation: integer.min(1), sessionId: decimal.refine((value) => BigInt(value) > 0n && BigInt(value) <= 0xffff_ffff_ffff_ffffn), channelCount: z.union([z.literal(1), z.literal(2)]),
  sampleRateHz: integer.min(8000).max(384000), frames: integer, bytes: integer, blocks: integer,
  fileDevice: decimal, fileInode: decimal, rootDevice: decimal, rootInode: decimal,
}).strict()
const releaseSchema = z.discriminatedUnion("reason", [
  z.object({ reason: z.literal("discard") }).strict(),
  z.object({ reason: z.literal("imported"), sessionId: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/),
    frames: integer, bytes: integer, blocks: integer, sampleRateHz: integer.min(8000).max(384000),
    channelCount: z.union([z.literal(1), z.literal(2)]), finalized: z.literal(true),
    savedClip: z.object({ clipId: z.string().min(1).max(256), sourceAssetKey: z.string().min(1).max(256) }).strict().optional(),
  }).strict().refine((receipt) => receipt.frames === 0 || receipt.savedClip !== undefined),
])
const receiptSchema = z.object({ manifest: intentSchema, proof: proofSchema, acknowledgment: releaseSchema }).strict()
const resolvedSchema = z.object({ manifest: intentSchema, rootDevice: decimal, rootInode: decimal,
  state: z.union([z.literal(3), z.literal(4)]), error: integer.max(13), systemError: integer }).strict()
type IntentManifest = z.infer<typeof intentSchema>
type RecordingManifest = IntentManifest | z.infer<typeof readySchema> | z.infer<typeof proofSchema> | z.infer<typeof receiptSchema> | z.infer<typeof resolvedSchema>
type CompleteProof = z.infer<typeof proofSchema>
const privateDirectory = (status: BigIntStats) => status.isDirectory()
  && status.uid === BigInt(process.getuid?.() ?? -1) && (status.mode & 0o7777n) === 0o700n
const privateFile = (status: BigIntStats) => status.isFile() && status.nlink === 1n
  && status.uid === BigInt(process.getuid?.() ?? -1) && (status.mode & 0o7777n) === 0o600n
const sameIdentity = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino
const assertTotals = (proof: CompleteProof) => {
  const bytes = 4 * proof.blocks + 4 * proof.frames * proof.channelCount
  if (!Number.isSafeInteger(bytes) || bytes !== proof.bytes
    || (proof.frames === 0 ? proof.blocks !== 0 : proof.blocks < 1 || proof.blocks > proof.frames)
    || proof.frames > proof.blocks * 2048 || BigInt(proof.fileInode) === 0n)
    throw new Error("Recording Complete totals mismatch.")
}
const verifyRoot = async (root: PrivateRoot) => {
  const status = await lstat(root.rootPath, { bigint: true })
  if (!privateDirectory(status) || status.dev !== root.root.device || status.ino !== root.root.inode)
    throw new Error("Recording root identity changed.")

}
const persistManifest = async (root: PrivateRoot, name: string, value: RecordingManifest,
  onSync?: (kind: "receipt-file-synced" | "receipt-directory-synced") => void) => {
  const bytes = Buffer.from(JSON.stringify(value), "utf8")
  if (bytes.length > 4096) throw new Error("Recording manifest exceeds its bounded size.")
  await verifyRoot(root)
  const target = path.join(root.rootPath, name)
  const handle = await open(target, constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_CREAT | constants.O_EXCL, 0o600)
  try {
    if (!privateFile(await handle.stat({ bigint: true }))) throw new Error("Recording manifest must be private.")
    let offset = 0
    while (offset < bytes.length) {
      const result = await handle.write(bytes, offset, bytes.length - offset, offset)
      if (result.bytesWritten <= 0) throw new Error("Recording manifest write made no progress.")
      offset += result.bytesWritten
    }
    await handle.sync()
    onSync?.("receipt-file-synced")
    const opened = await handle.stat({ bigint: true })
    const named = await lstat(target, { bigint: true })
    if (!privateFile(opened) || !privateFile(named) || !sameIdentity(opened, named) || opened.size !== BigInt(bytes.length))
      throw new Error("Recording manifest identity changed.")
  } finally { await handle.close() }
  await verifyRoot(root)
  const directory = await open(root.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const status = await directory.stat({ bigint: true })
    if (!privateDirectory(status) || status.dev !== root.root.device || status.ino !== root.root.inode)
      throw new Error("Recording root identity changed.")
    await directory.sync()
    onSync?.("receipt-directory-synced")
  } finally { await directory.close() }
}
const privateRoot = async (input: Pick<RecordingIntent, "userData" | "verifyDirectory">): Promise<PrivateRoot> => {
  const intended = path.join(input.userData, "recording-spool")
  await mkdir(intended, { mode: 0o700 }).catch(async (error) => { if (!await lstat(intended).catch(() => undefined)) throw error })
  const status = await lstat(intended, { bigint: true })
  if (!privateDirectory(status)) throw new Error("Recording spool root must be private.")
  const rootPath = await realpath(intended)
  const handle = await open(rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat({ bigint: true })
    if (!privateDirectory(opened) || !sameIdentity(opened, status)) throw new Error("Recording root identity changed.")
    const root = { rootPath, root: { device: opened.dev, inode: opened.ino } }
    await verifyRoot(root)
    // Component walking/helper execution is admission-only. Bounded reads use
    // pinned root lstat plus no-follow file checks, not per-chunk subprocesses.
    if (input.verifyDirectory) {
      const verified = await input.verifyDirectory(rootPath)
      if (BigInt(verified.device) !== opened.dev || BigInt(verified.inode) !== opened.ino)
        throw new Error("Recording root identity changed.")
    }
    return root
  } finally { await handle.close() }
}

// Main alone chooses private paths/tokens. The immutable caller-declared intent
// is not cloud authorization, nor is a native worker a same-uid sandbox.
export const prepareRecordingSpool = async (intent: RecordingIntent) => {
  const input = { ...intent }
  if (input.sessionId < 1n || input.sessionId > 0xffff_ffff_ffff_ffffn) throw new Error("Invalid recording project intent.")
  const token = randomBytes(32).toString("hex")
  const parsed = intentSchema.safeParse({ version: 1, token, projectIntent: input.projectId,
    intentAuthority: "trusted-renderer-declared", rendererGeneration: input.rendererGeneration,
    hostGeneration: input.hostGeneration, projectGeneration: input.projectGeneration,
    generation: input.generation, sessionId: input.sessionId.toString(), channelCount: input.channelCount,
    sampleRateHz: null, stage: "configuring" })
  if (!parsed.success) throw new Error("Invalid recording project intent.")
  const manifest = parsed.data
  const root = await privateRoot(input)
  let manifestPath = path.join(root.rootPath, `${token}.json`)
  await persistManifest(root, `${token}.json`, manifest)
  return { ...root, token, manifest, get manifestPath() { return manifestPath },
    async confirmReady(ready: { generation: number; sessionId: bigint; channelCount: number; sampleRateHz: number }) {
      if (ready.generation !== manifest.generation || ready.sessionId.toString() !== manifest.sessionId
        || ready.channelCount !== manifest.channelCount || !Number.isSafeInteger(ready.sampleRateHz)
        || ready.sampleRateHz < 8000 || ready.sampleRateHz > 384000) throw new Error("Recording ready binding mismatch.")
      await persistManifest(root, `${token}.ready.json`, { ...manifest, sampleRateHz: ready.sampleRateHz, stage: "ready" })
      manifestPath = path.join(root.rootPath, `${token}.ready.json`)
    },
  }
}

type RetainedTake = { projectIndex?: number; takeId: string; token: string; manifest: IntentManifest; root: PrivateRoot;
  state: "pending" | "interrupted" | "complete" | "released" | "resolved"; proof?: CompleteProof;
  completion?: Promise<void>; release?: Promise<void>; acknowledgment?: NativeRecordingRelease }
const readManifest = async <Manifest>(root: PrivateRoot, name: string, schema: z.ZodType<Manifest>): Promise<Manifest> => {
  await verifyRoot(root)
  const target = path.join(root.rootPath, name)
  const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat({ bigint: true })
    if (!privateFile(before) || before.size > 4096n) throw new Error("Recording manifest must be private and bounded.")
    const buffer = Buffer.alloc(Number(before.size))
    const result = await handle.read(buffer, 0, buffer.length, 0)
    const after = await handle.stat({ bigint: true })
    const named = await lstat(target, { bigint: true })
    if (result.bytesRead !== buffer.length || !privateFile(after) || !privateFile(named)
      || !sameIdentity(before, after) || !sameIdentity(after, named) || before.size !== after.size)
      throw new Error("Recording manifest identity changed.")
    await verifyRoot(root)
    return schema.parse(JSON.parse(buffer.toString("utf8")))
  } finally { await handle.close() }
}
const readyFor = async (take: RetainedTake) => {
  const ready = await readManifest(take.root, `${take.token}.ready.json`, readySchema)
  const { stage: _stage, sampleRateHz: _sampleRateHz, ...binding } = ready
  const { stage: _intentStage, sampleRateHz: _intentRate, ...intentBinding } = take.manifest
  if (JSON.stringify(binding) !== JSON.stringify(intentBinding)) throw new Error("Recording ready binding mismatch.")
  return ready
}
const withSource = async <T>(take: RetainedTake, operation: (handle: Awaited<ReturnType<typeof open>>, source: string) => Promise<T>) => {
  const proof = take.proof
  if (!proof || take.state !== "complete") throw new Error("Recording source is not proven Complete.")
  await verifyRoot(take.root)
  const source = path.join(take.root.rootPath, `${take.token}.pcm`)
  const handle = await open(source, constants.O_RDONLY | constants.O_NOFOLLOW)
  const verify = async () => {
    const status = await handle.stat({ bigint: true })
    const named = await lstat(source, { bigint: true })
    if (!privateFile(status) || !privateFile(named) || !sameIdentity(status, named)
      || status.dev !== BigInt(proof.fileDevice) || status.ino !== BigInt(proof.fileInode)
      || status.size !== BigInt(proof.bytes) || named.size !== status.size) throw new Error("Recording source identity or size changed.")
    await verifyRoot(take.root)
  }
  try {
    await verify()
    const result = await operation(handle, source)
    await verify()
    return result
  } finally { await handle.close() }
}

const statusAt = async (name: string) => lstat(name, { bigint: true }).catch((error) => {
  if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined
  throw error
})
const assertAbsentSources = async (take: RetainedTake) => {
  await verifyRoot(take.root)
  if (await statusAt(path.join(take.root.rootPath, `${take.token}.pcm`))
    || await statusAt(path.join(take.root.rootPath, `${take.token}.partial`)))
    throw new Error("Recording source ownership is unresolved; source retained.")
  await verifyRoot(take.root)
}
const validateReceipt = (take: RetainedTake, receipt: z.infer<typeof receiptSchema>) => {
  if (!take.proof || JSON.stringify(receipt.manifest) !== JSON.stringify(take.manifest)
    || JSON.stringify(receipt.proof) !== JSON.stringify(take.proof)) throw new Error("Recording receipt identity mismatch; source retained.")
  const ack = receipt.acknowledgment
  const proof = receipt.proof
  if (ack.reason === "imported" && (ack.frames !== proof.frames || ack.bytes !== proof.bytes || ack.blocks !== proof.blocks
    || ack.sampleRateHz !== proof.sampleRateHz || ack.channelCount !== proof.channelCount))
    throw new Error("Recording receipt totals mismatch; source retained.")
}
const finishRelease = async (take: RetainedTake,
  onOperation?: (kind: "source-unlink-started" | "source-unlinked" | "source-directory-synced") => void) => {
  await verifyRoot(take.root)
  const source = path.join(take.root.rootPath, `${take.token}.pcm`)
  if (await statusAt(source)) {
    await withSource(take, async () => undefined)
    onOperation?.("source-unlink-started")
    await unlink(source)
    onOperation?.("source-unlinked")
  }
  await verifyRoot(take.root)
  const directory = await open(take.root.rootPath, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    await directory.sync()
    onOperation?.("source-directory-synced")
  } finally { await directory.close() }
  take.state = "released"
}

export const createRecordingSpoolRegistry = (input: Pick<RecordingIntent, "userData" | "verifyDirectory"> & {
  beforeReleaseUnlink?: () => Promise<void>
  observeRelease?: (event: RecordingSpoolReleaseEvent) => void
}) => {
  let releaseOrdinal = 0
  const takes = new Map<string, RetainedTake>()
  const tokens = new Set<string>()
  const projectTakes = new Map<string, string[]>()
  const register = (take: RetainedTake) => {
    const ids = projectTakes.get(take.manifest.projectIntent) ?? []
    take.projectIndex = ids.length
    ids.push(take.takeId)
    projectTakes.set(take.manifest.projectIntent, ids)
    takes.set(take.takeId, take)
    tokens.add(take.token)
  }
  let current: RecordingScope | undefined
  const assertScope = (scope: RecordingScope, take?: RetainedTake) => {
    if (!current || current.projectId !== scope.projectId || current.projectGeneration !== scope.projectGeneration
      || current.rendererGeneration !== scope.rendererGeneration || (take && take.manifest.projectIntent !== scope.projectId))
      throw new Error("Recording scope changed.")
  }
  const lookup = (scope: RecordingScope, takeId: string) => {
    const take = takes.get(takeId)
    if (!take) throw new Error("Recording take is unavailable.")
    assertScope(scope, take)
    return take
  }
  const discover = async () => {
    const root = await privateRoot(input)
    const directory = await opendir(root.rootPath)
    for await (const entry of directory) {
      if (!/^[a-f0-9]{64}\.json$/.test(entry.name)) continue
      const token = entry.name.slice(0, 64)
      if (tokens.has(token)) continue
      const manifest = await readManifest(root, entry.name, intentSchema).catch(() => undefined)
      if (!manifest || manifest.token !== token) continue // never guess a malformed intent's project
      const take: RetainedTake = { takeId: randomUUID(), token, manifest, root, state: "pending" }
      const resolvedPath = path.join(root.rootPath, `${token}.resolved.json`)
      if (await statusAt(resolvedPath)) {
        const resolved = await readManifest(root, `${token}.resolved.json`, resolvedSchema)
        if (JSON.stringify(resolved.manifest) !== JSON.stringify(manifest)
          || BigInt(resolved.rootDevice) !== root.root.device || BigInt(resolved.rootInode) !== root.root.inode)
          throw new Error("Recording resolved receipt scope mismatch.")
        await assertAbsentSources(take)
        tokens.add(token)
        continue
      }
      const completed = await readManifest(root, `${token}.complete.json`, proofSchema).catch(() => undefined)
      if (completed) {
        try {
          const proof = completed
          const ready = await readyFor(take)
          assertTotals(proof)
          if (proof.generation !== take.manifest.generation || proof.sessionId !== take.manifest.sessionId
            || proof.channelCount !== ready.channelCount || proof.sampleRateHz !== ready.sampleRateHz
            || BigInt(proof.rootDevice) !== root.root.device || BigInt(proof.rootInode) !== root.root.inode)
            throw new Error("Recording recovery binding mismatch.")
          take.proof = proof
          take.state = "complete"
          await withSource(take, async () => undefined)
        } catch { take.state = "pending"; take.proof = undefined }
      }
      const receiptPath = path.join(root.rootPath, `${token}.released.json`)
      if (await statusAt(receiptPath)) {
        // Validate proof independently of source presence: receipt-first crashes
        // must converge both matching-file and already-absent-file cases.
        if (!completed) throw new Error("Recording receipt has no Complete identity proof.")
        const ready = await readyFor(take)
        assertTotals(completed)
        if (completed.generation !== manifest.generation || completed.sessionId !== manifest.sessionId
          || completed.sampleRateHz !== ready.sampleRateHz || completed.channelCount !== ready.channelCount
          || BigInt(completed.rootDevice) !== root.root.device || BigInt(completed.rootInode) !== root.root.inode)
          throw new Error("Recording receipt identity mismatch.")
        take.proof = completed
        take.state = "complete"
        const receipt = await readManifest(root, `${token}.released.json`, receiptSchema)
        validateReceipt(take, receipt)
        take.acknowledgment = receipt.acknowledgment
        await finishRelease(take)
        tokens.add(token)
        continue
      }
      register(take)
    }
  }
  return {
    bind(scope: RecordingScope) { current = { ...scope } },
    isCurrent(scope: RecordingScope) {
      return current?.projectId === scope.projectId && current.projectGeneration === scope.projectGeneration
        && current.rendererGeneration === scope.rendererGeneration
    },
    invalidate() { current = undefined },
    admit(prepared: Awaited<ReturnType<typeof prepareRecordingSpool>>, scope: RecordingScope) {
      assertScope(scope)
      if (prepared.manifest.projectIntent !== scope.projectId || prepared.manifest.projectGeneration !== scope.projectGeneration
        || prepared.manifest.rendererGeneration !== scope.rendererGeneration) throw new Error("Recording scope changed.")
      const takeId = randomUUID()
      register({ takeId, token: prepared.token, manifest: { ...prepared.manifest }, root: prepared, state: "pending" })
      return takeId
    },
    async complete(takeId: string, status: NativeMainRecordingStatus) {
      const take = takes.get(takeId)
      if (!take) throw new Error("Recording take is unavailable.")
      if (take.completion) return take.completion
      const operation = (async () => {
        const spool = status.spool
        if (!spool || spool.state !== 2 || !spool.published || spool.partialRetained || spool.error !== 0 || spool.systemError !== 0
          || status.active || status.fatal || status.queuedBlocks !== 0 || status.droppedFrames !== 0 || status.droppedBlocks !== 0
          || status.generation !== take.manifest.generation || status.sessionId.toString() !== take.manifest.sessionId
          || status.capturedFrames !== spool.writtenFrames) throw new Error("Recording Complete binding mismatch.")
        const ready = await readyFor(take)
        if (ready.sampleRateHz !== spool.sampleRateHz || ready.channelCount !== spool.channelCount)
          throw new Error("Recording Complete negotiated format mismatch.")
        const proof = proofSchema.parse({ generation: status.generation, sessionId: status.sessionId.toString(),
          channelCount: spool.channelCount, sampleRateHz: spool.sampleRateHz, frames: spool.writtenFrames,
          bytes: spool.writtenBytes, blocks: spool.writtenBlocks, fileDevice: status.fileDevice.toString(),
          fileInode: status.fileInode.toString(), rootDevice: take.root.root.device.toString(), rootInode: take.root.root.inode.toString() })
        assertTotals(proof)
        // Validate native identities before granting reads, then persist the proof
        // so a renderer reload or a host exit cannot erase a finalized source.
        await withSource({ ...take, proof, state: "complete" }, async () => undefined)
        await persistManifest(take.root, `${take.token}.complete.json`, proof)
        take.proof = proof
        take.state = "complete"
      })()
      take.completion = operation
      await operation
    },
    discover,
    async waitForSettlement() {
      // Lifecycle owns settlement only. The original complete() caller retains
      // its rejecting outcome and main publishes that recording-only failure.
      await Promise.all([...takes.values()].map((take) => take.completion?.then(() => undefined, () => undefined)))
    },
    async resolveTerminal(takeId: string, status: NativeMainRecordingStatus) {
      const take = takes.get(takeId)
      const spool = status.spool
      if (!take || !spool || (spool.state !== 3 && spool.state !== 4) || spool.published || spool.partialRetained
        || status.active || status.generation !== take.manifest.generation || status.sessionId.toString() !== take.manifest.sessionId)
        throw new Error("Recording terminal ownership is unresolved; source retained.")
      await assertAbsentSources(take)
      const receipt = { manifest: take.manifest, rootDevice: take.root.root.device.toString(),
        rootInode: take.root.root.inode.toString(), state: spool.state, error: spool.error, systemError: spool.systemError }
      const parsed = resolvedSchema.parse(receipt)
      const target = path.join(take.root.rootPath, `${take.token}.resolved.json`)
      if (await statusAt(target)) {
        const stored = await readManifest(take.root, `${take.token}.resolved.json`, resolvedSchema)
        if (JSON.stringify(stored) !== JSON.stringify(parsed)) throw new Error("Recording resolved receipt changed.")
      } else await persistManifest(take.root, `${take.token}.resolved.json`, parsed)
      take.state = "resolved"
    },
    async list(scope: RecordingScope, cursor?: string): Promise<{ takes: NativeRecordingTake[]; nextCursor: string | null }> {
      assertScope(scope)
      const previous = cursor ? lookup(scope, cursor) : undefined
      const ids = projectTakes.get(scope.projectId) ?? []
      const result: NativeRecordingTake[] = []
      // Project-local cursor offsets prevent rescanning every earlier page.
      for (let index = previous ? (previous.projectIndex ?? -1) + 1 : 0; index < ids.length; index += 1) {
        const take = takes.get(ids[index] ?? "")
        if (!take || take.state === "released" || take.state === "resolved") continue
        if (result.length === 100) return { takes: result, nextCursor: result.at(-1)?.takeId ?? null }
        const proof = take.proof
        result.push({ takeId: take.takeId, state: take.state, sampleRateHz: proof?.sampleRateHz ?? null,
          channelCount: take.manifest.channelCount, frames: proof?.frames ?? null, bytes: proof?.bytes ?? null, blocks: proof?.blocks ?? null })
      }
      return { takes: result, nextCursor: null }
    },
    async read(scope: RecordingScope, takeId: string, offset: number, length: number) {
      const take = lookup(scope, takeId)
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 1 || length > 1048576
        || !take.proof || offset > take.proof.bytes || take.release) throw new Error("Recording read range is invalid.")
      const bytes = await withSource(take, async (handle) => {
        const bytes = new Uint8Array(Math.min(length, (take.proof?.bytes ?? 0) - offset))
        const result = await handle.read(bytes, 0, bytes.length, offset)
        if (result.bytesRead !== bytes.length) throw new Error("Recording read was truncated.")
        assertScope(scope, take)
        return bytes
      })
      assertScope(scope, take)
      return bytes
    },
    async release(scope: RecordingScope, takeId: string, acknowledgment: NativeRecordingRelease) {
      const take = lookup(scope, takeId)
      const receipt = releaseSchema.parse(acknowledgment)
      const proof = take.proof
      if (!proof) throw new Error("Recording ownership is unresolved; source retained.")
      if (receipt.reason === "imported" && (receipt.frames !== proof.frames || receipt.bytes !== proof.bytes || receipt.blocks !== proof.blocks
        || receipt.sampleRateHz !== proof.sampleRateHz || receipt.channelCount !== proof.channelCount))
        throw new Error("Recording import acknowledgment mismatch.")
      if (take.acknowledgment && JSON.stringify(take.acknowledgment) !== JSON.stringify(receipt))
        throw new Error("Recording release acknowledgment changed.")
      if (take.release) return take.release
      if (take.state === "released") return
      // Normalize at admission, before any await, so a conflicting concurrent
      // caller cannot join the first caller's deletion operation.
      take.acknowledgment = receipt
      const observer = input.observeRelease
      const ordinal = observer ? ++releaseOrdinal : 0
      let sequence = 0
      const emit = observer ? (kind: RecordingSpoolReleaseEvent["kind"]) => {
        try {
          observer({ version: 1, releaseOrdinal: ordinal, sequence: ++sequence, kind, succeeded: true,
            frames: proof.frames, bytes: proof.bytes, blocks: proof.blocks,
            sampleRateHz: proof.sampleRateHz, channelCount: proof.channelCount })
        } catch { /* Missing diagnostics must not change release behavior. */ }
      } : undefined
      const operation = (async () => {
        const target = path.join(take.root.rootPath, `${take.token}.released.json`)
        if (await statusAt(target)) {
          validateReceipt(take, await readManifest(take.root, `${take.token}.released.json`, receiptSchema))
        } else {
          await withSource(take, async () => undefined)
          assertScope(scope, take)
          await persistManifest(take.root, `${take.token}.released.json`, { manifest: take.manifest, proof, acknowledgment: receipt }, emit)
        }
        await input.beforeReleaseUnlink?.()
        assertScope(scope, take)
        await finishRelease(take, emit)
      })()
      take.release = operation
      try { await operation } catch (error) { take.release = undefined; throw error }
    },
  }
}


// Registry errors are recording-only failures: never abort DAW startup or repair
// an unsafe root. The caller must refuse admission before writing any intent.
export const initializeRecordingSpoolRegistry = async (input: Parameters<typeof createRecordingSpoolRegistry>[0]) => {
  const registry = createRecordingSpoolRegistry(input)
  try { await registry.discover(); return { registry, error: undefined } }
  catch (cause) { return { registry: undefined, error: cause instanceof Error ? cause : new Error("Recording registry discovery failed.", { cause }) } }
}
