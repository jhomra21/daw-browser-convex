import { z } from "zod";
import {
  consumeSharedOutboxCompletion,
  readSharedOutboxOperation,
  subscribeToSharedOutboxSettlements,
  type DurableEffectsPublication,
} from "~/lib/shared-outbox";
import { decodeEffectsOperationResult } from "~/lib/shared-timeline-operations-api";

export type ParameterSaveResult =
  | { kind: "committed"; through: number }
  | { kind: "committed-unordered" }
  | { kind: "admitted"; entryId: string }
  | { kind: "rejected"; reason: string };
type SettledParameterSaveResult = Exclude<ParameterSaveResult, { kind: "admitted" }>;

const decodedEffectsResult = z.object({
  status: z.literal("applied"),
  effectId: z.string(),
  revision: z.union([
    z.object({ kind: z.literal("committed-unordered") }),
    z.object({ kind: z.literal("ordered"), revision: z.number().int().positive() }),
  ]),
});

export const parameterSaveResult = (result: DurableEffectsPublication | { row: object; sequence: number }): ParameterSaveResult => {
  if ("sequence" in result) return { kind: "committed", through: result.sequence };
  if (result.kind !== "applied") return result;
  const alreadyDecoded = decodedEffectsResult.safeParse(result.result);
  const decoded = alreadyDecoded.success ? alreadyDecoded.data : decodeEffectsOperationResult(result.result);
  if (decoded.status === "invalid") return { kind: "rejected", reason: "The effect target no longer exists." };
  return decoded.revision.kind === "ordered"
    ? { kind: "committed", through: decoded.revision.revision }
    : { kind: "committed-unordered" };
};

// How a gesture owner follows an admitted effect write to its settlement: `read` is undefined while it is pending.
export const effectAdmission = {
  read: async (projectId: string, userId: string, entryId: string): Promise<SettledParameterSaveResult | undefined> => {
    const result = await readSharedOutboxOperation(projectId, userId, entryId);
    if (result.status === "pending") return undefined;
    if (result.status === "rejected") return { kind: "rejected", reason: result.lastError ?? "The effect could not be saved." };
    if (result.status === "missing") return { kind: "committed-unordered" };
    if (result.status !== "applied") return undefined;
    const settled = parameterSaveResult({ kind: "applied", entryId, result: result.result });
    return settled.kind === "admitted" ? undefined : settled;
  },
  subscribe: subscribeToSharedOutboxSettlements,
  consume: consumeSharedOutboxCompletion,
};
export type EffectAdmission = typeof effectAdmission;
