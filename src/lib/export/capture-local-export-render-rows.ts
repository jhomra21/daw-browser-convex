import { normalizeLocalAutomationEnvelopes } from "~/lib/local-automation"
import { isLocalEffectRow, type LocalEffectRow } from "~/lib/local-effects"
import { openLocalProjectDb } from "~/lib/local-project-db"
import { AUTOMATION_ROW_KIND, EFFECT_ROW_KIND } from "~/lib/local-project-rows"
import type { JsonValue } from "@daw-browser/shared"

type LocalExportRenderRowsSnapshot = {
  effects: LocalEffectRow<JsonValue>[]
  automationEnvelopes: ReturnType<typeof normalizeLocalAutomationEnvelopes>
}

export const captureLocalExportRenderRowsSnapshot = async (
  projectId: string,
): Promise<LocalExportRenderRowsSnapshot> => {
  const db = await openLocalProjectDb(projectId)
  const tx = db.transaction("entities", "readonly")
  const index = tx.store.index("by-kind")

  const [effectRows, automationRows] = await Promise.all([
    index.getAll(EFFECT_ROW_KIND),
    index.getAll(AUTOMATION_ROW_KIND),
  ])

  await tx.done

  return {
    effects: effectRows.flatMap((row) => isLocalEffectRow(row.value) ? [row.value] : []),
    automationEnvelopes: normalizeLocalAutomationEnvelopes(automationRows.map((row) => row.value)),
  }
}
