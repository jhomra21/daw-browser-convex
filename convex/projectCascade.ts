import type { Id, TableNames, Doc } from "./_generated/dataModel";
import type { MutationCtx } from "./_generated/server";

type ProjectKeyedTable = {
  [Table in TableNames]: Doc<Table> extends { projectId: string } ? Table : never
}[TableNames];

/** Tables keyed by projectId that survive a project deletion: the R2 delete queue is the retention ledger for the project's blobs. */
export const retainedProjectTables = ["r2DeleteQueue"] as const;

type CascadedTable = Exclude<ProjectKeyedTable, (typeof retainedProjectTables)[number]>;

const deleteRows = async <Table extends TableNames>(ctx: MutationCtx, rows: Promise<{ _id: Id<Table> }[]>) => {
  await Promise.all((await rows).map((row) => ctx.db.delete(row._id)));
};

/**
 * One deleter per projectId-keyed table, each using that table's own projectId index.
 * The mapped type makes a new projectId table a compile error until it is listed here (or retained above).
 */
const projectRowDeleters = {
  samples: (ctx, projectId) => deleteRows(ctx, ctx.db.query("samples").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  assetFolders: (ctx, projectId) => deleteRows(ctx, ctx.db.query("assetFolders").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()),
  assetUploadReceipts: (ctx, projectId) => deleteRows(ctx, ctx.db.query("assetUploadReceipts").withIndex("by_project_status_updatedAt", (q) => q.eq("projectId", projectId)).collect()),
  assetUploadSessions: (ctx, projectId) => deleteRows(ctx, ctx.db.query("assetUploadSessions").withIndex("by_project_status", (q) => q.eq("projectId", projectId)).collect()),
  assetUploadParts: (ctx, projectId) => deleteRows(ctx, ctx.db.query("assetUploadParts").withIndex("by_upload", (q) => q.eq("projectId", projectId)).collect()),
  exports: (ctx, projectId) => deleteRows(ctx, ctx.db.query("exports").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  effects: (ctx, projectId) => deleteRows(ctx, ctx.db.query("effects").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  projectMessages: (ctx, projectId) => deleteRows(ctx, ctx.db.query("projectMessages").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  shareInvites: (ctx, projectId) => deleteRows(ctx, ctx.db.query("shareInvites").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  cloudBackups: (ctx, projectId) => deleteRows(ctx, ctx.db.query("cloudBackups").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  mixerChannels: (ctx, projectId) => deleteRows(ctx, ctx.db.query("mixerChannels").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  clips: (ctx, projectId) => deleteRows(ctx, ctx.db.query("clips").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  tracks: (ctx, projectId) => deleteRows(ctx, ctx.db.query("tracks").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  projectMixerSettings: (ctx, projectId) => deleteRows(ctx, ctx.db.query("projectMixerSettings").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  automationEnvelopes: (ctx, projectId) => deleteRows(ctx, ctx.db.query("automationEnvelopes").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()),
  sidechainRoutes: (ctx, projectId) => deleteRows(ctx, ctx.db.query("sidechainRoutes").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  controlCommits: (ctx, projectId) => deleteRows(ctx, ctx.db.query("controlCommits").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()),
  controlApprovals: (ctx, projectId) => deleteRows(ctx, ctx.db.query("controlApprovals").withIndex("by_project", (q) => q.eq("projectId", projectId)).collect()),
  controlRecoveries: (ctx, projectId) => deleteRows(ctx, ctx.db.query("controlRecoveries").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()),
  sharedOperationResults: (ctx, projectId) => deleteRows(ctx, ctx.db.query("sharedOperationResults").withIndex("by_room_user_operation", (q) => q.eq("projectId", projectId)).collect()),
  clipDeletionRecoveries: (ctx, projectId) => deleteRows(ctx, ctx.db.query("clipDeletionRecoveries").withIndex("by_project_expiresAt", (q) => q.eq("projectId", projectId)).collect()),
  clipDeletionRecoveryReceipts: (ctx, projectId) => deleteRows(ctx, ctx.db.query("clipDeletionRecoveryReceipts").withIndex("by_project_createdAt", (q) => q.eq("projectId", projectId)).collect()),
  ownerships: (ctx, projectId) => deleteRows(ctx, ctx.db.query("ownerships").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
  projects: (ctx, projectId) => deleteRows(ctx, ctx.db.query("projects").withIndex("by_room", (q) => q.eq("projectId", projectId)).collect()),
} satisfies { [Table in CascadedTable]: (ctx: MutationCtx, projectId: string) => Promise<void> };

export const cascadedProjectTables = Object.keys(projectRowDeleters);

export async function deleteProjectRows(ctx: MutationCtx, projectId: string) {
  await Promise.all(Object.values(projectRowDeleters).map((deleteTable) => deleteTable(ctx, projectId)));
}
