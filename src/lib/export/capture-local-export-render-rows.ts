import { normalizeLocalAutomationEnvelopes } from "~/lib/local-automation"
import { isLocalEffectRow, type LocalEffectRow } from "~/lib/local-effects"
import { openLocalProjectDb } from "~/lib/local-project-db"
import { flushLocalProjectPendingWrites } from "~/lib/local-project-pending-writes"
import type { JsonValue } from "@daw-browser/shared"

type LocalExportRenderRowsSnapshot = {
  effects: LocalEffectRow<JsonValue>[]
  automationEnvelopes: ReturnType<typeof normalizeLocalAutomationEnvelopes>
}

export const captureLocalExportRenderRowsSnapshot = async (
  projectId: string,
): Promise<LocalExportRenderRowsSnapshot> => {
  await flushLocalProjectPendingWrites(projectId)
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction("entities", "readonly")
  const index = tx.store.index("by-kind")
  const [effectRows, automationRows] = await Promise.all([
    index.getAll("effect"),
    index.getAll("automation-envelope"),
  ])
  await tx.done
  return {
    effects: effectRows.flatMap((row) => isLocalEffectRow(row.value) ? [row.value] : []),
    automationEnvelopes: normalizeLocalAutomationEnvelopes(automationRows.map((row) => row.value)),
  }
}
