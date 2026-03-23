import type { Doc } from "./_generated/dataModel";

type RoomSummary = {
  roomId: string;
  name: string;
};

type RoomProject = Doc<"projects">;
type RoomOwnership = Doc<"ownerships">;

async function listRoomProjectsByUser(
  ctx: any,
  roomId: string,
  userId: string,
) {
  return await ctx.db
    .query("projects")
    .withIndex("by_room_owner", (q: any) => q.eq("roomId", roomId).eq("ownerUserId", userId))
    .collect();
}

function buildProjectNameByRoom(projects: RoomProject[]) {
  const nameByRoomId = new Map<string, string>();
  for (const project of projects) {
    if (!nameByRoomId.has(project.roomId)) {
      nameByRoomId.set(project.roomId, project.name);
    }
  }
  return nameByRoomId;
}

function pickRoomName(projects: RoomProject[]) {
  if (projects.length === 0) return "Untitled";
  const sorted = projects
    .slice()
    .sort((left, right) => left.createdAt - right.createdAt);
  for (const project of sorted) {
    const trimmed = project.name.trim();
    if (trimmed) return trimmed;
  }
  return "Untitled";
}

export async function listAccessibleRooms(
  ctx: any,
  userId: string,
): Promise<RoomSummary[]> {
  const [projectsRaw, ownershipsRaw] = await Promise.all([
    ctx.db
      .query("projects")
      .withIndex("by_owner", (q: any) => q.eq("ownerUserId", userId))
      .collect(),
    ctx.db
      .query("ownerships")
      .withIndex("by_owner", (q: any) => q.eq("ownerUserId", userId))
      .collect(),
  ]);

  const projects = projectsRaw as RoomProject[];
  const ownerships = ownershipsRaw as RoomOwnership[];
  const nameByRoomId = buildProjectNameByRoom(projects);
  const roomIds = new Set<string>();

  for (const project of projects) {
    roomIds.add(project.roomId);
  }
  for (const ownership of ownerships) {
    roomIds.add(ownership.roomId);
  }

  const missingRoomIds = Array.from(roomIds).filter((roomId) => !nameByRoomId.has(roomId));
  if (missingRoomIds.length > 0) {
    const missingNames = await Promise.all(
      missingRoomIds.map(async (roomId) => {
        const roomProjectsRaw = await ctx.db
          .query("projects")
          .withIndex("by_room", (q: any) => q.eq("roomId", roomId))
          .collect();
        return [roomId, pickRoomName(roomProjectsRaw as RoomProject[])] as const;
      }),
    );
    for (const [roomId, name] of missingNames) {
      nameByRoomId.set(roomId, name);
    }
  }

  return Array.from(roomIds)
    .map((roomId) => ({
      roomId,
      name: nameByRoomId.get(roomId) ?? "Untitled",
    }))
    .sort((left, right) => left.roomId.localeCompare(right.roomId));
}

export async function hasRoomAccess(
  ctx: any,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const [projectsRaw, ownershipsRaw] = await Promise.all([
    listRoomProjectsByUser(ctx, roomId, userId),
    ctx.db
      .query("ownerships")
      .withIndex("by_room_owner", (q: any) => q.eq("roomId", roomId).eq("ownerUserId", userId))
      .collect(),
  ]);

  return projectsRaw.length > 0 || ownershipsRaw.length > 0;
}

export async function requireRoomAccess(
  ctx: any,
  roomId: string,
  userId: string,
) {
  if (await hasRoomAccess(ctx, roomId, userId)) return;
  throw new Error("You do not have access to this room.");
}

export async function hasRoomAdminCapability(
  ctx: any,
  roomId: string,
  userId: string,
): Promise<boolean> {
  const projects = await listRoomProjectsByUser(ctx, roomId, userId);
  return projects.length > 0;
}

export async function requireRoomAdminCapability(
  ctx: any,
  roomId: string,
  userId: string,
) {
  if (await hasRoomAdminCapability(ctx, roomId, userId)) return;
  throw new Error("Only project owners can update room-level settings.");
}

export async function requireMasterBusWriteAccess(
  ctx: any,
  roomId: string,
  userId: string,
) {
  await requireRoomAdminCapability(ctx, roomId, userId);
}
