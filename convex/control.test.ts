import { expect, test } from "bun:test";
import { convexTest } from "convex-test";

import { api } from "./_generated/api";
import schema from "./schema";

const modules = {
  "./_generated/api.ts": () => import("./_generated/api"),
  "./control.ts": () => import("./control"),
};

test("control preview returns a structured authorization error without an identity", async () => {
  const t = convexTest(schema, modules);
  await expect(t.query(api.control.previewV1, {
    request: {
      version: "v1",
      projectId: "project-1",
      actions: [{ kind: "project.rename", name: "Project" }],
    },
  })).rejects.toThrow("Authentication is required.");
});
