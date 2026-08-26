import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";
import { setTrackNameRow } from "./tracks";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./projects.ts": () => import("./projects"),
  "./tracks.ts": () => import("./tracks"),
};

test("track row helpers leave revision advancement to authenticated wrappers", async () => {
  const t = convexTest(schema, modules);
  const owner = "owner-1";
  const projectId = "project-1";
  await t.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId });
  const trackId = await t.run(async (ctx) => {
    const id = await ctx.db.insert("tracks", {
      projectId,
      name: "Track 1",
      index: 0,
    });
    await ctx.db.insert("mixerChannels", {
      projectId,
      trackId: id,
      volume: 0.8,
      channelRole: "track",
      sends: [],
    });
    await ctx.db.insert("ownerships", {
      projectId,
      ownerUserId: owner,
      trackId: id,
    });
    return id;
  });

  expect(await t.run((ctx) => setTrackNameRow(ctx, {
    projectId,
    trackId,
    name: "  Row rename  ",
  }))).toEqual({
    changed: true,
    status: "applied",
    name: "Row rename",
  });
  expect(await t.run(async (ctx) => (await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .unique())?.revision)).toBe(0);

  await t.withIdentity({ subject: owner }).mutation(api.tracks.setName, {
    trackId,
    name: "Wrapper rename",
  });
  expect(await t.run(async (ctx) => (await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .unique())?.revision)).toBe(1);
});
