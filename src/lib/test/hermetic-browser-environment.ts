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
  clearEventListeners: () => void
}

export const installHermeticWindow = <Value extends object>(value: Value): (() => void) => {
  const listeners = new Map<string, Set<EventListenerLike>>()
  const browserWindow = Object.assign(value, {
    addEventListener: (
      type: string,
      listener: EventListenerLike,
    ) => {
      const typeListeners = listeners.get(type) ?? new Set<EventListenerLike>()
      typeListeners.add(listener)
      listeners.set(type, typeListeners)
    },
    removeEventListener: (
      type: string,
      listener: EventListenerLike,
    ) => {
      const typeListeners = listeners.get(type)
      typeListeners?.delete(listener)
      if (typeListeners?.size === 0) listeners.delete(type)
    },
    clearEventListeners: () => {
      listeners.clear()
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
  if (typeof indexedDB.databases !== 'function') return
  const databases = await indexedDB.databases()
  await Promise.all(databases.flatMap((database) => (
    database.name === undefined || !relevantDatabase(database.name) ? [] : [clearDatabase(database.name)]
  )))
}
