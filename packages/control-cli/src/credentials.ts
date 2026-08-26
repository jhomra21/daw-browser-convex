import { watch } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"
import { normalizeControlOrigin } from "@daw-browser/control-sdk"
import { z } from "zod"

const credentialVersion = "v1"

const controlCredentialsSchema = z.object({
  version: z.literal(credentialVersion),
  baseUrl: z.string().min(1),
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: z.number().finite().positive(),
  scopes: z.array(z.string().min(1)).min(1),
  resource: z.string().min(1),
  tokenEndpoint: z.string().url(),
  revocationEndpoint: z.string().url(),
}).strict()

export type ControlCredentials = z.infer<typeof controlCredentialsSchema>

export type ControlCredentialIdentity = Pick<ControlCredentials, "version" | "baseUrl" | "clientId" | "resource">

type RefreshLock = {
  owner: string;
  pid: number;
  createdAt: number;
}

const refreshLockLifetimeMs = 300_000
const refreshLockSchema = z.object({
  owner: z.string().min(1),
  pid: z.number().int().positive(),
  createdAt: z.number().finite(),
}).strict()

const hasErrorCode = (cause: unknown, code: string): cause is NodeJS.ErrnoException => (
  cause instanceof Error && "code" in cause && cause.code === code
)

const parseCredentials = (value: ControlCredentials): ControlCredentials => {
  const baseUrl = normalizeControlOrigin(value.baseUrl)
  if (value.resource !== `${baseUrl}/api`) throw new Error("Credential file has an invalid resource.")
  const tokenEndpoint = new URL(value.tokenEndpoint)
  const revocationEndpoint = new URL(value.revocationEndpoint)
  if (tokenEndpoint.origin !== baseUrl || revocationEndpoint.origin !== baseUrl) throw new Error("Credential file has invalid endpoints.")
  return {
    version: credentialVersion,
    baseUrl,
    clientId: value.clientId,
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    expiresAt: value.expiresAt,
    scopes: value.scopes,
    resource: value.resource,
    tokenEndpoint: tokenEndpoint.toString(),
    revocationEndpoint: revocationEndpoint.toString(),
  }
}

const missing = (cause: unknown) => hasErrorCode(cause, "ENOENT")

const privateMode = (mode: number) => (mode & 0o077) === 0

const configuredHome = () => {
  const configured = process.env.XDG_CONFIG_HOME
  if (configured) return configured
  const home = process.env.HOME
  if (!home) throw new Error("HOME is not set.")
  return join(home, ".config")
}

export const credentialPath = () => (
  process.env.DAW_CONTROL_AUTH_PATH ?? join(configuredHome(), "daw-browser", "control-auth.json")
)

export const credentialIdentity = (credentials: ControlCredentials): ControlCredentialIdentity => ({
  version: credentials.version,
  baseUrl: credentials.baseUrl,
  clientId: credentials.clientId,
  resource: credentials.resource,
})

export const sameCredentialIdentity = (
  expected: ControlCredentialIdentity,
  received: ControlCredentials,
) => (
  expected.version === received.version
  && expected.baseUrl === received.baseUrl
  && expected.clientId === received.clientId
  && expected.resource === received.resource
)

const safeExistingFile = async (path: string) => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat.mode)) throw new Error("Credential file permissions are unsafe.")
  } catch (cause) {
    if (!missing(cause)) throw cause
  }
}

const readRefreshLock = async (path: string): Promise<RefreshLock | undefined> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat.mode)) throw new Error("Credential refresh lock is unsafe.")
    return refreshLockSchema.parse(JSON.parse(await readFile(path, "utf8")))
  } catch (cause) {
    if (missing(cause)) return undefined
    throw cause
  }
}

const processIsDead = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (cause) {
    return hasErrorCode(cause, "ESRCH")
  }
}

const waitForRefreshLockChange = (directory: string, lockPath: string, wakeMs: number, deadlineMs: number) => (
  new Promise<void>((resolve, reject) => {
    let finished = false
    const watcher = watch(directory, () => finish())
    const wake = setTimeout(() => finish(wakeMs === deadlineMs ? new Error("Timed out waiting for credential refresh.") : undefined), wakeMs)
    const finish = (failure?: Error) => {
      if (finished) return
      finished = true
      clearTimeout(wake)
      watcher.close()
      if (failure) reject(failure)
      else resolve()
    }
    watcher.on("error", finish)
    void lstat(lockPath).catch((cause: unknown) => {
      if (missing(cause)) finish()
      else finish(cause instanceof Error ? cause : new Error("Credential refresh lock is unavailable."))
    })
  })
)

export const createCredentialStore = (path = credentialPath()) => {
  const directory = dirname(path)
  const lockPath = `${path}.refresh.lock`

  const read = async (): Promise<ControlCredentials | undefined> => {
    await safeExistingFile(path)
    try {
      const file = Bun.file(path)
      const content = await file.text()
      let value: unknown
      try {
        value = JSON.parse(content)
      } catch {
        throw new Error("Credential file is invalid.")
      }
      return parseCredentials(controlCredentialsSchema.parse(value))
    } catch (cause) {
      if (missing(cause)) return undefined
      throw cause
    }
  }

  const write = async (credentials: ControlCredentials) => {
    const parsed = parseCredentials(credentials)
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const directoryStat = await lstat(directory)
    if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink() || !privateMode(directoryStat.mode)) {
      throw new Error("Credential directory permissions are unsafe.")
    }
    await safeExistingFile(path)
    const temporary = join(directory, `.${crypto.randomUUID()}.tmp`)
    const handle = await open(temporary, "wx", 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(parsed)}\n`)
      await handle.sync()
    } finally {
      await handle.close()
    }
    await chmod(temporary, 0o600)
    try {
      await safeExistingFile(path)
      await rename(temporary, path)
    } catch (cause) {
      await unlink(temporary).catch(() => undefined)
      throw cause
    }
  }

  const remove = async () => {
    await safeExistingFile(path)
    try {
      await unlink(path)
    } catch (cause) {
      if (!missing(cause)) throw cause
    }
  }

  const removeIfRefreshTokenMatches = async (refreshToken: string) => {
    const current = await read()
    if (current?.refreshToken === refreshToken) await remove()
  }

  const removeIfMatches = async (identity: ControlCredentialIdentity, refreshToken: string, accessToken: string) => {
    const current = await read()
    if (current && sameCredentialIdentity(identity, current)
      && current.refreshToken === refreshToken && current.accessToken === accessToken) await remove()
  }

  const acquireRefreshLock = async (timeoutMs = refreshLockLifetimeMs) => {
    await mkdir(directory, { recursive: true, mode: 0o700 })
    await chmod(directory, 0o700)
    const deadline = Date.now() + timeoutMs
    const owner: RefreshLock = { owner: crypto.randomUUID(), pid: process.pid, createdAt: Date.now() }
    for (;;) {
      try {
        const handle = await open(lockPath, "wx", 0o600)
        try {
          await handle.writeFile(JSON.stringify(owner))
          await handle.sync()
        } finally {
          await handle.close()
        }
        return {
          release: async () => {
            const current = await readRefreshLock(lockPath)
            if (current?.owner === owner.owner) await unlink(lockPath).catch((cause: unknown) => {
              if (!missing(cause)) throw cause
            })
          },
        }
      } catch (cause) {
        if (!hasErrorCode(cause, "EEXIST")) throw cause
        const existing = await readRefreshLock(lockPath)
        if (existing && Date.now() - existing.createdAt > refreshLockLifetimeMs && processIsDead(existing.pid)) {
          const current = await readRefreshLock(lockPath)
          if (current?.owner === existing.owner) await unlink(lockPath).catch((cause: unknown) => {
            if (!missing(cause)) throw cause
          })
          continue
        }
        const remaining = deadline - Date.now()
        if (remaining <= 0) throw new Error("Timed out waiting for credential refresh.")
        const staleWait = existing && processIsDead(existing.pid)
          ? Math.max(0, existing.createdAt + refreshLockLifetimeMs - Date.now())
          : remaining
        await waitForRefreshLockChange(directory, lockPath, Math.min(remaining, staleWait), remaining)
      }
    }
  }

  return { path, read, write, remove, removeIfRefreshTokenMatches, removeIfMatches, acquireRefreshLock }
}
