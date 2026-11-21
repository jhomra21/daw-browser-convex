import { createSignal } from "solid-js"
import {
  canUseVst3CatalogAction,
  hasVst3TrustAcknowledgement,
  saveVst3TrustAcknowledgement,
} from "~/lib/external-plugin-ui"
import { desktopBridge } from "~/lib/runtime"

const catalogChangedEvent = "daw-plugin-catalog-changed"

export const notifyPluginCatalogChanged = () => {
  globalThis.window?.dispatchEvent?.(new Event(catalogChangedEvent))
}

export const onPluginCatalogChanged = (listener: () => void) => {
  window.addEventListener(catalogChangedEvent, listener)

  return () => window.removeEventListener(catalogChangedEvent, listener)
}

const trustStorage = () => {
  try {
    return window.localStorage
  } catch {
    return undefined
  }
}

export const readVst3TrustAcknowledged = () => hasVst3TrustAcknowledgement(trustStorage())

export const createVst3Trust = () => {
  const storage = trustStorage()
  const [acknowledged, setAcknowledged] = createSignal(hasVst3TrustAcknowledgement(storage))

  return {
    acknowledged,
    set: (value: boolean) => {
      setAcknowledged(value)

      if (value) saveVst3TrustAcknowledgement(storage)
    },
  }
}

export const createVst3CatalogScan = (input: {
  trust: Pick<ReturnType<typeof createVst3Trust>, "acknowledged">
  onScanned: () => void
}) => {
  let activeScan: Promise<void> | undefined

  const scan = async () => {
    const bridge = desktopBridge()?.pluginCatalog

    if (!bridge) {
      throw new Error("Plug-in rescanning requires the desktop app.")
    }

    if (!canUseVst3CatalogAction("scan", input.trust.acknowledged())) {
      throw new Error("Acknowledge the VST3 plug-in disclosure before rescanning.")
    }

    const result = await bridge.scan()

    if ("catalog" in result) {
      notifyPluginCatalogChanged()
      input.onScanned()

      return
    }

    if (!result.ok) throw new Error(result.error)
  }

  return async () => {
    if (activeScan) return activeScan

    const promise = scan()
    activeScan = promise

    try {
      await promise
    } finally {
      activeScan = undefined
    }
  }
}
