import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import { createMidiClipRow, requireSingleProjectId, setClipNameRow } from "./clips";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./clips.ts": () => import("./clips"),
};
const newTest = () => convexTest(schema, modules);
type TestConvex = ReturnType<typeof newTest>;

const owner = "owner-1";

const projectRevision = async (
  t: TestConvex,
  projectId: string,
) => await t.run(async (ctx) => {
  const project = await ctx.db
    .query("projects")
    .withIndex("by_room", (q) => q.eq("projectId", projectId))
    .unique();
  return project?.revision;
});

test("accepts empty and single-project clip batches", () => {
  expect(requireSingleProjectId([])).toBeUndefined();
  expect(requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-1" },
  ])).toBe("project-1");
});

test("rejects mixed-project clip batches before mutation work", () => {
  expect(() => requireSingleProjectId([
    { projectId: "project-1" },
    { projectId: "project-2" },
  ])).toThrow("Batch clip writes must target one project.");
});

test("row helpers leave revision ownership to authenticated mutation wrappers", async () => {
  const t = newTest();
  const { clipId } = await t.run(async (ctx) => {
    await ctx.db.insert("projects", {
      projectId: "project-1",
      ownerUserId: owner,
      name: "Project",
      createdAt: 1,
      updatedAt: 1,
      revision: 0,
      tempoBpm: 120,
      timeSignatureNumerator: 4,
      timeSignatureDenominator: 4,
      loopEnabled: false,
      loopStartSec: 0,
      loopEndSec: 0,
    });
    const trackId = await ctx.db.insert("tracks", {
      projectId: "project-1",
      name: "MIDI",
      index: 0,
      kind: "instrument",
    });
    await ctx.db.insert("mixerChannels", {
      projectId: "project-1",
      trackId,
      volume: 0.8,
      channelRole: "track",
      sends: [],
    });
    const creation = await createMidiClipRow(ctx, {
      projectId: "project-1",
      trackId,
      startSec: 0,
      duration: 1,
      ownerUserId: owner,
      midi: { wave: "sine", notes: [] },
    });
    if (!creation.value) throw new Error("Clip was not created.");
    return { clipId: creation.value };
  });

  expect(await t.run(async (ctx) => await ctx.db
    .query("ownerships")
    .withIndex("by_clip", (q) => q.eq("clipId", clipId))
    .unique())).toMatchObject({ projectId: "project-1", ownerUserId: owner, clipId });
  expect(await t.run(async (ctx) => await ctx.db
    .query("samples")
    .withIndex("by_room", (q) => q.eq("projectId", "project-1"))
    .collect())).toHaveLength(0);
  expect(await projectRevision(t, "project-1")).toBe(0);

  expect(await t.run(async (ctx) => await setClipNameRow(ctx, {
    projectId: "project-1",
    clipId,
    name: "Helper rename",
  }))).toEqual({ changed: true });
  expect(await projectRevision(t, "project-1")).toBe(0);

  expect(await t.withIdentity({ subject: owner }).mutation(api.clips.setName, {
    clipId,
    name: "Wrapper rename",
  })).toBeNull();
  expect(await projectRevision(t, "project-1")).toBe(1);
});
