export type OpfsWritable = {
  write: (data: Uint8Array<ArrayBuffer>) => Promise<void>
  close: () => Promise<void>
  abort: () => Promise<void>
}

export type OpfsDirectoryEntry = {
  name: string
  kind: "file" | "directory"
}

export type OpfsDirectory<File> = {
  getDirectory: (name: string, create: boolean) => Promise<OpfsDirectory<File>>
  getFile: (name: string, create: boolean) => Promise<File>
  entries: () => AsyncIterable<OpfsDirectoryEntry>
  remove: (name: string, recursive: boolean) => Promise<void>
}

export type OpfsFilesystem<File> = {
  root: () => Promise<OpfsDirectory<File>>
}

export type OpfsLock = {
  name: string
  mode: "exclusive"
}

export type OpfsLockManager = {
  request: <Value>(
    name: string,
    options: { mode: "exclusive"; ifAvailable?: boolean },
    callback: (lock: OpfsLock | undefined) => Promise<Value>,
  ) => Promise<Value>
}

export type OpfsStorageFailure = "permission-denied" | "quota-exceeded" | "write-failed"

export const SAFE_SESSION_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/

export const isSafeSessionName = (value: string): boolean => SAFE_SESSION_NAME.test(value)

export const classifyStorageFailure = (cause: unknown): OpfsStorageFailure => {
  if (cause instanceof DOMException) {
    if (cause.name === "QuotaExceededError") return "quota-exceeded"

    if (cause.name === "NotAllowedError" || cause.name === "SecurityError") return "permission-denied"
  }

  return "write-failed"
}

export const createBrowserLockManager = (unsupported: () => Error): OpfsLockManager => ({
  request: (name, options, callback) => {
    const locks = globalThis.navigator?.locks

    if (!locks) return Promise.reject(unsupported())

    return locks.request(name, options, async (lock) => (
      await callback(lock ? { name: lock.name, mode: "exclusive" } : undefined)
    ))
  },
})

export const wrapOpfsWritable = async (
  handle: FileSystemFileHandle,
  unavailable: () => Error,
): Promise<OpfsWritable> => {
  const createWritable = handle.createWritable

  if (!createWritable) throw unavailable()

  const writable = await createWritable.call(handle)

  return {
    write: (data) => writable.write(data),
    close: () => writable.close(),
    abort: () => writable.abort(),
  }
}

export const wrapOpfsDirectory = <File>(
  directory: FileSystemDirectoryHandle,
  wrapFile: (handle: FileSystemFileHandle) => File,
): OpfsDirectory<File> => ({
  getDirectory: async (name, create) => wrapOpfsDirectory(await directory.getDirectoryHandle(name, { create }), wrapFile),
  getFile: async (name, create) => wrapFile(await directory.getFileHandle(name, { create })),
  entries: async function* () {
    for await (const [name, handle] of directory.entries()) {
      yield { name, kind: handle.kind }
    }
  },
  remove: (name, recursive) => directory.removeEntry(name, { recursive }),
})

export const createBrowserOpfsFilesystem = <File>(
  wrapFile: (handle: FileSystemFileHandle) => File,
): OpfsFilesystem<File> => ({
  root: async () => wrapOpfsDirectory(await navigator.storage.getDirectory(), wrapFile),
})
