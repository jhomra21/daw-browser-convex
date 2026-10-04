type EventListenerLike = EventListenerOrEventListenerObject
const originalFetch = globalThis.fetch
const relevantDatabase = (name: string) => (
  name === 'daw-browser-projects' || name.startsWith('daw-browser-project-')
)

type HermeticWindow = {
  addEventListener: (
    type: string,
    listener: EventListenerLike,
    options?: AddEventListenerOptions | boolean,
  ) => void
  removeEventListener: (
    type: string,
    listener: EventListenerLike,
    options?: EventListenerOptions | boolean,
  ) => void
  dispatchEvent: (event: Event) => boolean
  clearEventListeners: () => void
}

type IndexedDbWithDatabases = IDBFactory & {
  databases: () => Promise<readonly IDBDatabaseInfo[]>
}

const hasDatabaseEnumeration = (
  value: IDBFactory,
): value is IndexedDbWithDatabases => (
  typeof value.databases === 'function'
)

export const installHermeticWindow = <Value extends object>(value: Value): (() => void) => {
  const target = new EventTarget()
  const registrations = new Map<EventListenerLike, Set<string>>()
  const browserWindow = Object.assign(value, {
    addEventListener: (
      type: string,
      listener: EventListenerLike,
      options?: AddEventListenerOptions | boolean,
    ) => {
      target.addEventListener(type, listener, options)
      const types = registrations.get(listener) ?? new Set<string>()
      types.add(type)
      registrations.set(listener, types)
    },
    removeEventListener: (
      type: string,
      listener: EventListenerLike,
      options?: EventListenerOptions | boolean,
    ) => {
      target.removeEventListener(type, listener, options)
      const types = registrations.get(listener)
      types?.delete(type)
      if (types?.size === 0) registrations.delete(listener)
    },
    dispatchEvent: (event: Event) => target.dispatchEvent(event),
    clearEventListeners: () => {
      for (const [listener, types] of registrations) {
        for (const type of types) target.removeEventListener(type, listener)
      }
      registrations.clear()
    },
  }) satisfies HermeticWindow
  const previousWindow = Object.getOwnPropertyDescriptor(globalThis, 'window')
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: browserWindow,
  })

  return () => {
    browserWindow.clearEventListeners()
    if (previousWindow) Object.defineProperty(globalThis, 'window', previousWindow)
    else Reflect.deleteProperty(globalThis, 'window')
  }
}

const clearStorage = (storage: Storage | undefined) => {
  try {
    storage?.clear()
  } catch {}
}

const clearDatabase = (name: string): Promise<void> => new Promise((resolve, reject) => {
  const request = indexedDB.open(name)
  request.onerror = () => reject(request.error)
  request.onsuccess = () => {
    const db = request.result
    const storeNames = Array.from(db.objectStoreNames)
    if (storeNames.length === 0) {
      db.close()
      resolve()
      return
    }
    const transaction = db.transaction(storeNames, 'readwrite')
    transaction.onerror = () => {
      db.close()
      reject(transaction.error)
    }
    transaction.onabort = () => {
      db.close()
      reject(transaction.error)
    }
    transaction.oncomplete = () => {
      db.close()
      resolve()
    }
    for (const storeName of storeNames) {
      transaction.objectStore(storeName).clear()
    }
  }
})

export const resetHermeticBrowserEnvironment = async (): Promise<void> => {
  globalThis.fetch = originalFetch
  clearStorage(globalThis.localStorage)
  clearStorage(globalThis.sessionStorage)
  if (!hasDatabaseEnumeration(indexedDB)) return
  const databases = await indexedDB.databases()
  await Promise.all(databases.flatMap((database) => (
    database.name === undefined || !relevantDatabase(database.name) ? [] : [clearDatabase(database.name)]
  )))
}
