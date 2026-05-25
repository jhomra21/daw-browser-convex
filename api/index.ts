import { Hono, type Context } from 'hono'
import { cors } from 'hono/cors'
import { createAuth, type Session } from './auth'
import { streamText } from 'ai'
import { createOpenRouter } from '@openrouter/ai-sdk-provider'
import { ConvexHttpClient } from 'convex/browser'
import { api as convexApi } from '../convex/_generated/api'
import { CommandsEnvelopeSchema } from '../src/lib/agent-commands'
import { createAgentActions } from './agent-actions'
import { parseProjectManifest, type ProjectManifest, withProjectManifestAssetKeys } from '../src/lib/project-manifest-contract'
import type { ProjectRole } from '../convex/projectAccess'

type Variables = {
  user: Session['user'] | null;
  session: Session['session'] | null;
}

type ApiContext = Context<{
  Bindings: Env;
  Variables: Variables;
}>

type CloudBackupRow = {
  manifest: Omit<ProjectManifest, 'syncState'> & {
    syncState?: ProjectManifest['syncState']
  }
  manifestVersion: string
}

type BackupConflict = {
  localUpdatedAt: number
  cloudUpdatedAt: number
  localEntityCount: number
  cloudEntityCount: number
  localAssetCount: number
  cloudAssetCount: number
}

type BackupUpsertResult = {
  ok: boolean
  manifestVersion?: string
  conflict?: BackupConflict
  supersededCloudKeys?: string[]
}

type BackupAssetUploadValidation =
  | { ok: true; manifestAssetIds: Set<string> }
  | { ok: false; error: string }

const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)

const readAgentExecuteBody = (value: unknown) => {
  if (!isRecord(value) || typeof value.projectId !== 'string' || value.commands === undefined) return null
  return {
    projectId: value.projectId,
    commands: value.commands,
  }
}

const readAgentChatBody = (value: unknown) => {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null
  return {
    messages: value.messages,
    projectId: typeof value.projectId === 'string' ? value.projectId : undefined,
    bpm: typeof value.bpm === 'number' ? value.bpm : undefined,
  }
}

const projectExistsForBackup = async (convex: ConvexHttpClient, projectId: string): Promise<boolean> => (
  await convex.query(convexApi.projects.exists, { projectId })
)

const ensureOwnedProjectForBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
) => {
  await convex.mutation(convexApi.projects.ensureOwnedRoom, { projectId, userId })
}

const checkBackupConflict = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  manifest: ProjectManifest,
): Promise<BackupConflict | null> => (
  await convex.query(convexApi.cloudBackups.checkConflict, { projectId, userId, manifest })
)

const upsertLatestBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
  manifest: ProjectManifest,
  conflictAction: 'detect' | 'overwrite',
): Promise<BackupUpsertResult> => (
  await convex.mutation(convexApi.cloudBackups.upsertLatest, {
    projectId,
    userId,
    manifest,
    conflictAction,
  })
)

const getLatestBackup = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
): Promise<CloudBackupRow | null> => (
  await convex.query(convexApi.cloudBackups.getLatest, { projectId, userId })
)

const deleteCloudProjectAsOwner = async (
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
) => (
  await convex.mutation(convexApi.projects.deleteRoomAsOwner, { projectId, userId })
)

async function canAccessAgentRoom(
  convex: ConvexHttpClient,
  projectId: string,
  userId: string,
) {
  const canAccess = await convex.query(convexApi.projectAccess.canAccess, { projectId, userId })
  return canAccess
}

async function requireProjectRoleForApi(
  c: ApiContext,
  projectId: string,
  roles: ProjectRole[],
) {
  const user = c.get('user')
  if (!user) return null
  const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
  const role = await convex.query(convexApi.projectAccess.roleForUser, { projectId, userId: user.id })
  return role && roles.includes(role) ? user : null
}

const hashFile = async (file: File) => {
  const hash = await crypto.subtle.digest('SHA-256', await file.arrayBuffer())
  return Array.from(new Uint8Array(hash)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

const deleteR2Prefix = async (bucket: R2Bucket, prefix: string) => {
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 })
    const keys = page.objects.map((entry) => entry.key).filter(Boolean)
    if (keys.length > 0) await bucket.delete(keys)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
}

const deleteR2Keys = async (bucket: R2Bucket, keys: string[]) => {
  if (keys.length === 0) return
  await bucket.delete(keys)
}

const validateBackupAssetUploads = (form: FormData, manifest: ProjectManifest): BackupAssetUploadValidation => {
  const manifestAssetIds = new Set(manifest.assets.map((asset) => asset.id))
  const uploadedAssetIds = new Set<string>()
  for (const [key, value] of form.entries()) {
    if (!key.startsWith('asset:') || !(value instanceof File)) continue
    const assetId = key.slice('asset:'.length)
    if (!manifestAssetIds.has(assetId)) continue
    if (uploadedAssetIds.has(assetId)) {
      return { ok: false, error: 'Duplicate backup asset upload' }
    }
    uploadedAssetIds.add(assetId)
  }
  if (manifest.assets.some((asset) => !asset.missing && !uploadedAssetIds.has(asset.id))) {
    return { ok: false, error: 'Missing backup asset upload' }
  }
  return { ok: true, manifestAssetIds }
}

const app = new Hono<{
  Bindings: Env;
  Variables: Variables;
}>()

// CORS middleware must be registered before routes
app.use('/api/auth/*', cors({
  origin: (origin) => origin || '*', // Allow all origins for now, restrict in production
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// Session middleware - adds user and session to context
app.use('*', async (c, next) => {
  // Skip auth middleware for auth routes to avoid circular calls
  if (c.req.path.startsWith('/api/auth/')) {
    return next();
  }

  try {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      c.set('user', null);
      c.set('session', null);
    } else {
      c.set('user', session.user);
      c.set('session', session.session);
    }
  } catch (error) {
    console.error('Session middleware error:', error);
    c.set('user', null);
    c.set('session', null);
  }

  return next();
});

// Better Auth routes - use on() method as recommended
app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session endpoint to check current user
app.get('/api/session', (c) => {
  const session = c.get('session');
  const user = c.get('user');

  if (!user) {
    return c.json({ user: null, session: null }, 200);
  }

  return c.json({ session, user });
})

// Execute JSON commands (no tool-calls path)
app.post('/api/agent/execute', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const body = readAgentExecuteBody(await c.req.json().catch(() => null))
    if (!body) {
      return c.json({ error: 'Invalid body' }, 400)
    }
    const projectId = body.projectId
    const parsed = CommandsEnvelopeSchema.safeParse({ commands: body.commands })
    if (!parsed.success) {
      return c.json({ error: 'Invalid commands', issues: parsed.error.issues }, 400)
    }
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    if (!(await canAccessAgentRoom(convex, projectId, user.id))) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    const trackList = await convex.query(convexApi.tracks.listByRoom, { projectId, userId: user.id })
    const agentActions = createAgentActions({
      convex,
      convexApi,
      projectId,
      userId: user.id,
      getTracks: async () => trackList,
      refreshTracks: async () => {
        const updated = await convex.query(convexApi.tracks.listByRoom, { projectId, userId: user.id })
        trackList.splice(0, trackList.length, ...updated)
        return trackList
      },
    })

    const results: Array<Record<string, unknown>> = []
    for (const cmd of parsed.data.commands) {
      try {
        switch (cmd.type) {
          case 'createTrack': {
            results.push({ type: cmd.type, ...(await agentActions.createTrack(cmd)) })
            break
          }
          case 'setTrackRouting': {
            results.push({ type: cmd.type, ...(await agentActions.setTrackRouting(cmd)) })
            break
          }
          case 'addSampleClips': {
            results.push({ type: cmd.type, ...(await agentActions.addSampleClips(cmd)) })
            break
          }
          case 'setTrackVolume': {
            results.push({ type: cmd.type, ...(await agentActions.setTrackVolume(cmd)) })
            break
          }
          case 'addMidiClip': {
            results.push({ type: cmd.type, ...(await agentActions.addMidiClip(cmd)) })
            break
          }
          case 'setEqParams': {
            results.push({ type: cmd.type, ...(await agentActions.setEqParams(cmd)) })
            break
          }
          case 'setReverbParams': {
            results.push({ type: cmd.type, ...(await agentActions.setReverbParams(cmd)) })
            break
          }
          case 'setSynthParams': {
            results.push({ type: cmd.type, ...(await agentActions.setSynthParams(cmd)) })
            break
          }
          case 'deleteTrack': {
            results.push({ type: cmd.type, ...(await agentActions.deleteTrack(cmd)) })
            break
          }
          case 'moveClip': {
            results.push({ type: cmd.type, ...(await agentActions.moveClip(cmd)) })
            break
          }
          case 'removeClip': {
            results.push({ type: cmd.type, ...(await agentActions.removeClip(cmd)) })
            break
          }
          case 'setArpeggiatorParams': {
            results.push({ type: cmd.type, ...(await agentActions.setArpeggiatorParams(cmd)) })
            break
          }
          case 'setTiming': {
            results.push({ type: cmd.type, ...(await agentActions.setTiming(cmd)) })
            break
          }
          case 'moveClips': {
            results.push({ type: cmd.type, ...(await agentActions.moveClips(cmd)) })
            break
          }
          case 'copyClips': {
            results.push({ type: cmd.type, ...(await agentActions.copyClips(cmd)) })
            break
          }
          case 'removeMany': {
            results.push({ type: cmd.type, ...(await agentActions.removeMany(cmd)) })
            break
          }
          case 'setMute': {
            results.push({ type: cmd.type, ...(await agentActions.setMute(cmd)) })
            break
          }
          case 'setSolo': {
            results.push({ type: cmd.type, ...(await agentActions.setSolo(cmd)) })
            break
          }
          default:
            results.push({ error: 'Unsupported' })
        }
      } catch (e) {
        results.push({ type: cmd.type, error: 'Execution failed' })
      }
    }

    return c.json({ ok: true, results })
  } catch (err) {
    console.error('Agent execute error', err)
    return c.json({ error: 'Failed to execute commands' }, 500)
  }
})

// Protected route example
app.get('/api/protected', (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({ message: 'This is a protected route', user });
})

// Upload a sample to R2 (protected route)
app.post('/api/samples', async (c) => {
  try {
    const user = c.get('user');
    if (!user) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const assetKey = form.get('assetKey')?.toString()
    const file = form.get('file')
    const durationStr = form.get('duration')?.toString()

    if (!projectId || !assetKey || !(file instanceof File)) {
      return c.json({ error: 'Missing projectId, assetKey or file' }, 400)
    }
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Sanitize filename for use as a key segment
    const baseName = file.name?.toString() || 'audio'
    const sanitized = baseName
      .replace(/\\/g, '/')              // normalize separators
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')  // safe chars
      .slice(0, 180)                      // keep key short-ish
    // Primary layout: rooms/<projectId>/clips/<filename>
    // Handle collisions by appending " (n)" or timestamp.
    const contentHash = await hashFile(file)
    const clipsPrefix = `projects/${projectId}/assets/${assetKey}/${contentHash}/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = clipsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.get(probeKey)
      if (!existing) {
        break
      }
      const existingAssetKey = existing.customMetadata?.assetKey
      if (existingAssetKey === assetKey) {
        break
      }
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = clipsPrefix + chosenName
    await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'application/octet-stream',
        contentDisposition: `inline; filename="${file.name}"`,
      },
      customMetadata: {
        projectId,
        assetKey,
        filename: chosenName,
        originalFilename: file.name,
        mimeType: file.type || 'application/octet-stream',
        durationSec: durationStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    // Return a URL that includes the exact key so the GET route can fetch without indirection
    const url = `/api/samples/${projectId}/${encodeURIComponent(assetKey)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url })
  } catch (err) {
    console.error('Upload error', err)
    return c.json({ error: 'Failed to upload sample' }, 500)
  }
})

// Stream a sample from R2
app.get('/api/samples/:projectId/:sourceId', async (c) => {
  try {
    // Require exact key so we don't list buckets or rely on pointers
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    const projectId = c.req.param('projectId')
    if (!key.startsWith(`projects/${projectId}/assets/`)) return c.json({ error: 'Invalid key' }, 400)
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor', 'viewer'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Fetch error', err)
    return c.json({ error: 'Failed to fetch sample' }, 500)
  }
})

app.get('/api/default-samples', async (c) => {
  try {
    const bucket = c.env.daw_audio_samples
    if (!bucket) {
      return c.json({ samples: [] })
    }
    const prefix = 'default/'
    let cursor: string | undefined
    const objects: R2Object[] = []

    do {
      const page = await bucket.list({
        prefix,
        cursor,
        limit: 1000,
      })
      objects.push(...page.objects)
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)

    const samples: Array<Record<string, unknown>> = []
    for (const obj of objects) {
      if (!obj || typeof obj.key !== 'string' || !obj.key.startsWith(prefix)) continue
      if (obj.key === prefix || obj.key.endsWith('/')) continue
      const key: string = obj.key
      const metadata = obj.customMetadata
      const duration = Number(metadata?.durationSec)
      const sampleRate = Number(metadata?.sampleRate)
      const channelCount = Number(metadata?.channelCount)
      const hasMetadata = Number.isFinite(duration) && duration > 0
        && Number.isFinite(sampleRate) && sampleRate > 0
        && Number.isFinite(channelCount) && channelCount > 0
      const rawName = key.slice(prefix.length)
      let decodedName = rawName || key
      try {
        decodedName = decodeURIComponent(decodedName)
      } catch {}
      const url = `/api/default-sample?key=${encodeURIComponent(key)}`
      samples.push({
        key,
        assetKey: `asset:default:${key}`,
        sourceKind: 'url',
        name: decodedName,
        url,
        duration: hasMetadata ? duration : undefined,
        source: hasMetadata
          ? {
              durationSec: duration,
              sampleRate,
              channelCount,
            }
          : undefined,
        sizeBytes: typeof obj.size === 'number' ? obj.size : undefined,
      })
    }

    samples.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { sensitivity: 'base' }))

    return c.json({ samples })
  } catch (err) {
    console.error('Default samples list error', err)
    return c.json({ error: 'Failed to list default samples' }, 500)
  }
})

app.post('/api/cloud-backups', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const manifestRaw = form.get('manifest')?.toString()
    const conflictAction = form.get('conflictAction') === 'overwrite' ? 'overwrite' : 'detect'
    if (!projectId || !manifestRaw) return c.json({ error: 'Missing projectId or manifest' }, 400)

    let manifest: ProjectManifest
    try {
      manifest = parseProjectManifest(manifestRaw)
    } catch {
      return c.json({ error: 'Invalid manifest' }, 400)
    }
    if (manifest.projectId !== projectId) {
      return c.json({ error: 'Manifest projectId mismatch' }, 400)
    }
    const uploadValidation = validateBackupAssetUploads(form, manifest)
    if (!uploadValidation.ok) {
      return c.json({ error: uploadValidation.error }, 400)
    }

    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const projectExists = await projectExistsForBackup(convex, projectId)
    if (!projectExists) {
      await ensureOwnedProjectForBackup(convex, projectId, user.id)
    } else if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }
    if (conflictAction === 'detect') {
      const conflict = await checkBackupConflict(convex, projectId, user.id, manifest)
      if (conflict) return c.json({ ok: false, conflict }, 409)
    }
    const uploadedAssetKeys: Record<string, string> = {}
    const uploadedR2Keys: string[] = []
    try {
      for (const [key, value] of form.entries()) {
        if (!key.startsWith('asset:') || !(value instanceof File)) continue
        const assetId = key.slice('asset:'.length)
        if (!uploadValidation.manifestAssetIds.has(assetId)) continue
        const hash = await hashFile(value)
        const ext = value.name.includes('.') ? value.name.slice(value.name.lastIndexOf('.')) : ''
        const r2Key = `projects/${projectId}/assets/${assetId}/${crypto.randomUUID()}-${hash}${ext}`
        await c.env.daw_audio_samples.put(r2Key, value.stream(), {
          httpMetadata: { contentType: value.type || 'application/octet-stream' },
          customMetadata: {
            projectId,
            assetId,
            contentHash: hash,
            uploadedBy: user.id,
            uploadedAt: new Date().toISOString(),
          },
        })
        uploadedAssetKeys[assetId] = r2Key
        uploadedR2Keys.push(r2Key)
      }
      manifest = withProjectManifestAssetKeys(manifest, uploadedAssetKeys)

      const result = await upsertLatestBackup(convex, projectId, user.id, manifest, conflictAction)
      if (result?.conflict) {
        await deleteR2Keys(c.env.daw_audio_samples, uploadedR2Keys)
        return c.json({ ok: false, conflict: result.conflict }, 409)
      }
      try {
        await deleteR2Keys(c.env.daw_audio_samples, result?.supersededCloudKeys ?? [])
      } catch (cleanupError) {
        console.warn('Failed to delete superseded backup assets', cleanupError)
      }
      return c.json({ ok: true, manifestVersion: result?.manifestVersion, uploadedAssetKeys })
    } catch (err) {
      await deleteR2Keys(c.env.daw_audio_samples, uploadedR2Keys)
      throw err
    }
  } catch (err) {
    console.error('Cloud backup error', err)
    return c.json({ error: 'Failed to back up project' }, 500)
  }
})

app.get('/api/cloud-backups/:projectId', async (c) => {
  try {
    const projectId = c.req.param('projectId')
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const row = await getLatestBackup(convex, projectId, user.id)
    if (!row) return c.json({ error: 'Not found' }, 404)
    return c.json({ manifest: row.manifest, manifestVersion: row.manifestVersion })
  } catch (err) {
    console.error('Cloud backup fetch error', err)
    return c.json({ error: 'Failed to fetch backup' }, 500)
  }
})

app.delete('/api/cloud-projects/:projectId', async (c) => {
  try {
    const projectId = c.req.param('projectId')
    const user = await requireProjectRoleForApi(c, projectId, ['owner'])
    if (!user) return c.json({ error: 'Forbidden' }, 403)
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    const result = await deleteCloudProjectAsOwner(convex, projectId, user.id)
    if (result?.status !== 'deleted') return c.json({ ok: false, result }, 409)
    await deleteR2Prefix(c.env.daw_audio_samples, `projects/${projectId}/`)
    return c.json({ ok: true, result })
  } catch (err) {
    console.error('Cloud project delete error', err)
    return c.json({ error: 'Failed to delete cloud project' }, 500)
  }
})

app.get('/api/default-sample', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    if (!key.startsWith('default/')) return c.json({ error: 'Invalid key' }, 400)

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Default sample fetch error', err)
    return c.json({ error: 'Failed to fetch default sample' }, 500)
  }
})

// Upload an export to R2 (protected route)
app.post('/api/exports', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const form = await c.req.formData()
    const projectId = form.get('projectId')?.toString()
    const format = 'wav'
    const durationStr = form.get('duration')?.toString()
    const sampleRateStr = form.get('sampleRate')?.toString()
    const file = form.get('file')
    let name = form.get('name')?.toString()

    if (!projectId || !(file instanceof File)) {
      return c.json({ error: 'Missing projectId or file' }, 400)
    }
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    // Sanitize filename or generate one
    if (!name) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      name = `export_${ts}.wav`
    }
    const sanitized = name
      .replace(/\\/g, '/')
      .split('/')
      .pop()!
      .replace(/[^A-Za-z0-9._-]/g, '_')
      .slice(0, 180)

    const exportsPrefix = `projects/${projectId}/exports/`
    const splitIdx = sanitized.lastIndexOf('.')
    const base = splitIdx > 0 ? sanitized.slice(0, splitIdx) : sanitized
    const ext = splitIdx > 0 ? sanitized.slice(splitIdx) : ''
    let chosenName = sanitized
    let attempts = 0
    while (attempts < 5) {
      const probeKey = exportsPrefix + chosenName
      const existing = await c.env.daw_audio_samples.get(probeKey)
      if (!existing) break
      attempts++
      chosenName = `${base} (${attempts})${ext}`
    }
    if (attempts >= 5) {
      const ts = new Date().toISOString().replace(/[-:TZ.]/g, '')
      chosenName = `${base}_${ts}${ext}`
    }
    const key = exportsPrefix + chosenName

    const putRes = await c.env.daw_audio_samples.put(key, file.stream(), {
      httpMetadata: {
        contentType: file.type || 'audio/wav',
        contentDisposition: `inline; filename="${chosenName}"`,
      },
      customMetadata: {
        projectId,
        format,
        durationSec: durationStr || '',
        sampleRate: sampleRateStr || '',
        uploadedAt: new Date().toISOString(),
        uploadedBy: user.id,
      },
    })

    const url = `/api/export/${encodeURIComponent(projectId)}?key=${encodeURIComponent(key)}`
    return c.json({ key, url, sizeBytes: putRes.size })
  } catch (err) {
    console.error('Export upload error', err)
    return c.json({ error: 'Failed to upload export' }, 500)
  }
})

// Stream an export from R2 by project-scoped key
app.get('/api/export/:projectId', async (c) => {
  try {
    const key = c.req.query('key')
    if (!key) return c.json({ error: 'Missing key query parameter' }, 400)
    const projectId = c.req.param('projectId')
    if (!key.startsWith(`projects/${projectId}/exports/`)) return c.json({ error: 'Invalid key' }, 400)
    if (!await requireProjectRoleForApi(c, projectId, ['owner', 'editor', 'viewer'])) {
      return c.json({ error: 'Forbidden' }, 403)
    }

    const obj = await c.env.daw_audio_samples.get(key)
    if (!obj) return c.json({ error: 'Not found' }, 404)

    const headers = new Headers()
    headers.set('Content-Type', obj.httpMetadata?.contentType || 'application/octet-stream')
    headers.set('Cache-Control', 'public, max-age=31536000, immutable')
    headers.set('Access-Control-Allow-Origin', '*')
    headers.set('Access-Control-Allow-Credentials', 'true')
    if (obj.httpMetadata?.contentDisposition) {
      headers.set('Content-Disposition', obj.httpMetadata.contentDisposition)
    }
    headers.set('X-R2-Key', key)

    return new Response(obj.body, { headers })
  } catch (err) {
    console.error('Export fetch error', err)
    return c.json({ error: 'Failed to fetch export' }, 500)
  }
})

// AI Agent chat endpoint (streams SSE)
app.post('/api/agent/chat', async (c) => {
  try {
    const user = c.get('user')
    if (!user) return c.json({ error: 'Unauthorized' }, 401)

    const body = readAgentChatBody(await c.req.json().catch(() => null))
    if (!body) {
      return c.json({ error: 'Invalid body' }, 400)
    }

    const projectId = body.projectId
    const clientBpm = (typeof body.bpm === 'number') ? Math.max(20, Math.min(300, Number(body.bpm))) : undefined

    const openrouter = createOpenRouter({ apiKey: c.env.OPENROUTER_API_KEY })
    const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
    if (projectId) {
      if (!(await canAccessAgentRoom(convex, projectId, user.id))) {
        return c.json({ error: 'Forbidden' }, 403)
      }
    }

    const modelName = 'openai/gpt-oss-20b:free'
    const today = new Date().toISOString().slice(0, 10)

    let system = `You are a DAW assistant for MediaBunny. Date: ${today}.${projectId ? ` Room: ${projectId}.` : ''}`
    // Optional context: include current BPM and sample names to improve sample matching
    let contextNote = ''
    try {
      const list = projectId ? (await convex.query(convexApi.samples.listByRoom, { projectId, userId: user.id })) : []
      const sampleNames = Array.isArray(list) && list.length ? list.map((sample) => (sample.name || sample.url || '')).filter(Boolean).slice(0, 20) : []

      let tracksLine = ''
      let clipsLine = ''
      let effectsLine = ''
      if (projectId) {
        try {
          const tracks = await convex.query(convexApi.tracks.listByRoom, { projectId, userId: user.id })
          const clips = await convex.query(convexApi.clips.listByRoom, { projectId, userId: user.id })
          const audioCount = tracks.filter((track) => (track.kind ?? 'audio') === 'audio').length
          const instrumentCount = tracks.filter((track) => (track.kind ?? 'audio') === 'instrument').length
          const perTrackCounts = (() => {
            const counts = new Map<string, number>()
            for (const clip of clips) {
              const key = String(clip.trackId)
              counts.set(key, (counts.get(key) || 0) + 1)
            }
            return tracks.map((track) => counts.get(String(track._id)) || 0)
          })()

          let synthCount = 0
          let eqCount = 0
          let reverbCount = 0
          let arpCount = 0
          let hasMasterEq = false
          let hasMasterReverb = false
          const effects = await convex.query(convexApi.effects.listByRoom, { projectId, userId: user.id }).catch(() => [])
          for (const row of effects) {
            if (row?.targetType === 'master') {
              if (row.type === 'eq') hasMasterEq = true
              if (row.type === 'reverb') hasMasterReverb = true
              continue
            }
            if (row?.type === 'synth') synthCount += 1
            if (row?.type === 'eq') eqCount += 1
            if (row?.type === 'reverb') reverbCount += 1
            if (row?.type === 'arpeggiator') arpCount += 1
          }

          tracksLine = tracks.length ? `Tracks: ${tracks.length} (audio ${audioCount}, instrument ${instrumentCount}).` : ''
          clipsLine = (clips.length || tracks.length) ? `Clips: ${clips.length} total; per track: [${perTrackCounts.join(', ')}].` : ''
          effectsLine = tracks.length ? `Effects: synth ${synthCount}, eq ${eqCount}, reverb ${reverbCount}, arp ${arpCount}; master eq: ${hasMasterEq ? 'yes' : 'no'}, master reverb: ${hasMasterReverb ? 'yes' : 'no'}.` : ''
        } catch {}
      }

      const bpmLine = clientBpm ? `Current timeline BPM: ${clientBpm}.` : ''
      const samplesLine = sampleNames.length ? `Samples in project: ${sampleNames.join(', ')}.` : ''
      const snapshot = [tracksLine, clipsLine, effectsLine].filter(Boolean).join(' ')
      const pieces = [bpmLine, snapshot, samplesLine].filter(Boolean)
      if (pieces.length) contextNote = `\n${pieces.join(' ')}`
    } catch {}
    system += `
Decide between two modes based on USER intent:

1) Explain mode (default): If the USER asks informational/descriptive questions (e.g., "what can you tell me about this project", "explain", "how does X work"), respond with natural language ONLY. Do NOT include any JSON or code blocks.

2) Edit mode: If the USER explicitly asks to make changes (verbs like add, create, move, copy, delete, remove, set, insert, enable, mute, solo), append a single JSON code block at the END of your reply with ONLY commands, like:
\`\`\`json
{
  "commands": [
    { "type": "createTrack", "kind": "instrument" }
  ]
}
\`\`\`
Supported commands: createTrack, setTrackRouting, setTrackVolume, addMidiClip, setEqParams, setReverbParams, setSynthParams, deleteTrack, moveClip, moveClips, copyClips, removeClip, setArpeggiatorParams, setTiming, removeMany, setMute, setSolo, addSampleClips.
Rules (apply only in Edit mode):
- Use one-based indices for trackIndex (first track is 1). We will convert internally.
- Use one-based indices for clipIndices as well (first clip is 1 on its track, sorted by start time). We will convert internally.
- For setTrackRouting, omit a field to preserve it. Use outputTrackIndex: null to route to master, and sends: [] to clear sends.
- For setSynthParams, use wave1 and wave2 for oscillator waves. If the user asks for a single synth waveform, set both to the same value.
- For deleteTrack/moveClip/removeClip/setTiming/removeMany you MUST include a trackIndex.
- Prefer specifying clipIndex for clip operations; otherwise use clipAtOrAfterSec.
- For setTrackVolume, if trackIndex is omitted, it applies to the most recently created track.
- For setMute/setSolo, you may specify trackIndex or trackIndices; if omitted, it applies to the most recently created track. For exclusive soloing, include exclusive: true.
- For solo requests, never use setMute. Use setSolo exclusively (and include exclusive: true when the user says "solo track N" meaning only that track should be audible).
- For addSampleClips: Prefer exact sample names from the project list when available.${contextNote}

Output policy:
- If the user didn't ask for changes, output ONLY text (no JSON).
- If the user asked for changes, output text THEN exactly one JSON commands block, and nothing after it.`

    const options = {
      model: openrouter(modelName),
      messages: body.messages,
      temperature: 0.4,
      system,
    }

    const result = await streamText(options)

    // AI SDK v5: stream text response helper
    return result.toTextStreamResponse()
  } catch (err) {
    console.error('Agent chat error', err)
    return c.json({ error: 'Failed to process agent chat' }, 500)
  }
})

export default app
