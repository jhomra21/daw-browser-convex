import { watch } from "node:fs"
import { chmod, lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises"
import { dirname, join } from "node:path"

const credentialVersion = "v1"

export type ControlCredentials = {
  version: typeof credentialVersion;
  baseUrl: string;
  clientId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scopes: string[];
  resource: string;
  tokenEndpoint: string;
  revocationEndpoint: string;
}

export type ControlCredentialIdentity = Pick<ControlCredentials, "version" | "baseUrl" | "clientId" | "resource">

type RefreshLock = {
  owner: string;
  pid: number;
  createdAt: number;
}

const refreshLockLifetimeMs = 300_000
const isRecord = (value: unknown): value is Record<string, unknown> => (
  typeof value === "object" && value !== null && !Array.isArray(value)
)

const isStringArray = (value: unknown): value is string[] => (
  Array.isArray(value) && value.every((entry) => typeof entry === "string" && entry.length > 0)
)

const normalizeOrigin = (value: string) => {
  const url = new URL(value)
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("Base URL must be an origin.")
  if (url.protocol !== "https:" && !(url.protocol === "http:" && url.hostname === "127.0.0.1")) {
    throw new Error("Base URL must use HTTPS.")
  }
  return url.origin
}

const parseCredentials = (value: unknown): ControlCredentials => {
  if (!isRecord(value)
    || value.version !== credentialVersion
    || typeof value.baseUrl !== "string"
    || typeof value.clientId !== "string" || value.clientId.length === 0
    || typeof value.accessToken !== "string" || value.accessToken.length === 0
    || typeof value.refreshToken !== "string" || value.refreshToken.length === 0
    || typeof value.expiresAt !== "number" || !Number.isFinite(value.expiresAt) || value.expiresAt <= 0
    || !isStringArray(value.scopes)
    || typeof value.resource !== "string"
    || typeof value.tokenEndpoint !== "string"
    || typeof value.revocationEndpoint !== "string") throw new Error("Credential file is invalid.")
  const baseUrl = normalizeOrigin(value.baseUrl)
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

const missing = (error: unknown) => (
  typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
)

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
  } catch (error) {
    if (!missing(error)) throw error
  }
}

const isRefreshLock = (value: unknown): value is RefreshLock => (
  isRecord(value)
  && typeof value.owner === "string" && value.owner.length > 0
  && typeof value.pid === "number" && Number.isInteger(value.pid) && value.pid > 0
  && typeof value.createdAt === "number" && Number.isFinite(value.createdAt)
)

const readRefreshLock = async (path: string): Promise<RefreshLock | undefined> => {
  try {
    const stat = await lstat(path)
    if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat.mode)) throw new Error("Credential refresh lock is unsafe.")
    const value: unknown = JSON.parse(await readFile(path, "utf8"))
    if (!isRefreshLock(value)) throw new Error("Credential refresh lock is invalid.")
    return value
  } catch (error) {
    if (missing(error)) return undefined
    throw error
  }
}

const processIsDead = (pid: number) => {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
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
    void lstat(lockPath).catch((error: unknown) => {
      if (missing(error)) finish()
      else finish(error instanceof Error ? error : new Error("Credential refresh lock is unavailable."))
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
      return parseCredentials(value)
    } catch (error) {
      if (missing(error)) return undefined
      throw error
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
    } catch (error) {
      await unlink(temporary).catch(() => undefined)
      throw error
    }
  }

  const remove = async () => {
    await safeExistingFile(path)
    try {
      await unlink(path)
    } catch (error) {
      if (!missing(error)) throw error
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
            if (current?.owner === owner.owner) await unlink(lockPath).catch((error: unknown) => {
              if (!missing(error)) throw error
            })
          },
        }
      } catch (error) {
        if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) throw error
        const existing = await readRefreshLock(lockPath)
        if (existing && Date.now() - existing.createdAt > refreshLockLifetimeMs && processIsDead(existing.pid)) {
          const current = await readRefreshLock(lockPath)
          if (current?.owner === existing.owner) await unlink(lockPath).catch((unlinkError: unknown) => {
            if (!missing(unlinkError)) throw unlinkError
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
