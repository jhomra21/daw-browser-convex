import type { MutationCtx } from "./_generated/server";

export const readSharedOperationResult = async (
  ctx: MutationCtx,
  input: { projectId: string; userId: string; operationId?: string },
) => {
  if (!input.operationId) return null;
  const operationId = input.operationId;
  return await ctx.db
    .query("sharedOperationResults")
    .withIndex("by_room_user_operation", (q) => q
      .eq("projectId", input.projectId)
      .eq("userId", input.userId)
      .eq("operationId", operationId))
    .first();
};

export const writeSharedOperationResult = async (
  ctx: MutationCtx,
  input: { projectId: string; userId: string; operationId?: string; result: unknown },
) => {
  if (!input.operationId) return;
  await ctx.db.insert("sharedOperationResults", {
    projectId: input.projectId,
    userId: input.userId,
    operationId: input.operationId,
    result: input.result,
    createdAt: Date.now(),
  });
};

export const runSharedOperationOnce = async <T>(
  ctx: MutationCtx,
  input: {
    projectId?: string
    userId: string
    operationId?: string
    isResult: (value: unknown) => value is T
    run: () => Promise<T>
  },
) => {
  if (!input.projectId) return await input.run()
  const existingResult = await readSharedOperationResult(ctx, {
    projectId: input.projectId,
    userId: input.userId,
    operationId: input.operationId,
  })
  if (existingResult && input.isResult(existingResult.result)) return existingResult.result
  const result = await input.run()
  await writeSharedOperationResult(ctx, {
    projectId: input.projectId,
    userId: input.userId,
    operationId: input.operationId,
    result,
  })
  return result
}
