import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { chmod, link, lstat, mkdir, open, realpath, rm } from "node:fs/promises"
import path from "node:path"

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const maxIdentityBytes = 1024

const hasErrorCode = (error: unknown, code: string) =>
  error instanceof Error && "code" in error && error.code === code

const validatePrivateDirectory = async (directory: string) => {
  const info = await lstat(directory)
  if (
    !info.isDirectory()
    || info.isSymbolicLink()
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Host actor directory is not private.")
  }
}

const ensurePrivateDirectory = async (directory: string) => {
  try {
    await validatePrivateDirectory(directory)
    return
  } catch (error) {
    if (!hasErrorCode(error, "ENOENT")) throw error
  }

  await mkdir(path.dirname(directory), { recursive: true, mode: 0o700 })
  let created = false
  try {
    await mkdir(directory, { mode: 0o700 })
    created = true
  } catch (error) {
    if (!hasErrorCode(error, "EEXIST")) throw error
  }
  if (created && process.platform !== "win32") await chmod(directory, 0o700)
  await validatePrivateDirectory(directory)
}

const readIdentity = async (file: string, directory: string) => {
  let info
  try {
    info = await lstat(file)
  } catch (error) {
    if (hasErrorCode(error, "ENOENT")) return undefined
    throw error
  }
  if (
    !info.isFile()
    || info.isSymbolicLink()
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)
  ) {
    throw new Error("Host actor identity is not private.")
  }

  const resolvedDirectory = await realpath(directory)
  const resolvedFile = await realpath(file)
  if (path.dirname(resolvedFile) !== resolvedDirectory) {
    throw new Error("Host actor identity is not contained by its directory.")
  }

  const handle = await open(
    file,
    process.platform === "win32" ? "r" : constants.O_RDONLY | constants.O_NOFOLLOW,
  )
  let contents: string
  try {
    const openedInfo = await handle.stat()
    if (
      !openedInfo.isFile()
      || (process.platform !== "win32" && (openedInfo.mode & 0o077) !== 0)
    ) {
      throw new Error("Host actor identity is not private.")
    }
    const buffer = Buffer.alloc(maxIdentityBytes + 1)
    let bytesRead = 0
    while (bytesRead < buffer.byteLength) {
      const result = await handle.read(
        buffer,
        bytesRead,
        buffer.byteLength - bytesRead,
        bytesRead,
      )
      if (result.bytesRead === 0) break
      bytesRead += result.bytesRead
    }
    if (bytesRead > maxIdentityBytes) throw new Error("Host actor identity is invalid.")
    contents = buffer.subarray(0, bytesRead).toString("utf8")
  } finally {
    await handle.close()
  }

  const parsed: unknown = JSON.parse(contents)
  if (
    typeof parsed !== "object"
    || parsed === null
    || Array.isArray(parsed)
    || Object.getPrototypeOf(parsed) !== Object.prototype
    || Object.keys(parsed).length !== 2
    || !("version" in parsed)
    || !("actorId" in parsed)
    || parsed.version !== "v1"
    || typeof parsed.actorId !== "string"
    || !uuid.test(parsed.actorId)
  ) {
    throw new Error("Host actor identity is invalid.")
  }
  return parsed.actorId
}

const syncDirectory = async (directory: string) => {
  if (process.platform === "win32") return
  let handle
  try {
    handle = await open(
      directory,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    )
    await handle.sync()
  } catch (error) {
    if (
      !hasErrorCode(error, "EINVAL")
      && !hasErrorCode(error, "ENOTSUP")
      && !hasErrorCode(error, "EOPNOTSUPP")
      && !hasErrorCode(error, "EBADF")
    ) {
      throw error
    }
  } finally {
    await handle?.close()
  }
}

const publishIdentity = async (file: string, directory: string) => {
  const temporary = path.join(directory, `.host-actor-${randomUUID()}.tmp`)
  let created = false
  try {
    const handle = await open(temporary, "wx", 0o600)
    created = true
    try {
      if (process.platform !== "win32") await handle.chmod(0o600)
      await handle.writeFile(JSON.stringify({ version: "v1", actorId: randomUUID() }))
      await handle.sync()
    } finally {
      await handle.close()
    }

    let won = true
    try {
      await link(temporary, file)
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error
      won = false
    }
    if (won) await syncDirectory(directory)

    const actorId = await readIdentity(file, directory)
    if (actorId === undefined) throw new Error("Host actor identity publication failed.")
    return actorId
  } finally {
    if (created) await rm(temporary, { force: true })
  }
}

const resolveHostActorPath = (defaultFile: string, configuredPath?: string) => (
  configuredPath ?? process.env.DAW_CONTROL_ACTOR_PATH ?? defaultFile
)

export const loadHostActorIdentity = (defaultFile: string, configuredPath?: string) => {
  const file = resolveHostActorPath(defaultFile, configuredPath)
  const directory = path.dirname(file)
  return ensurePrivateDirectory(directory).then(async () => {
    const actorId = await readIdentity(file, directory)
    if (actorId !== undefined) return actorId
    return publishIdentity(file, directory)
  })
}
