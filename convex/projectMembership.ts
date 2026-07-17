import type { MutationCtx } from "./_generated/server";
import { isProjectOwnership } from "./projectAccess";
import { requireProjectRow } from "./projectRows";

type MembershipRemovalResult = {
  status: "removed" | "not-found";
};

async function readProjectOwnerUserId(ctx: MutationCtx, projectId: string) {
  return (await requireProjectRow(ctx, projectId)).ownerUserId;
}

export async function removeProjectMemberAccessAndTransferEntities(
  ctx: MutationCtx,
  projectId: string,
  targetUserId: string,
): Promise<MembershipRemovalResult> {
  const targetRows = await ctx.db
    .query("ownerships")
    .withIndex("by_room_owner", (q) => q.eq("projectId", projectId).eq("ownerUserId", targetUserId))
    .collect();
  const projectAccess = targetRows.find(isProjectOwnership);
  if (!projectAccess) return { status: "not-found" };
  if (projectAccess.role === "owner") {
    throw new Error("Project owner access cannot be removed through member access removal.");
  }

  const entityRows = targetRows.filter((row) => !isProjectOwnership(row));
  if (entityRows.length === 0) {
    await ctx.db.delete(projectAccess._id);
    return { status: "removed" };
  }

  const projectOwnerUserId = await readProjectOwnerUserId(ctx, projectId);
  await Promise.all([
    ...entityRows.map((row) => ctx.db.patch(row._id, { ownerUserId: projectOwnerUserId })),
    ctx.db.delete(projectAccess._id),
  ]);

  return { status: "removed" };
}
