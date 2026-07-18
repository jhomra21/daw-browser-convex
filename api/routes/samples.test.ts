import { expect, test } from "bun:test";
import { Hono } from "hono";
import type { ApiBindings } from "../app-types";
import { registerSampleRoutes } from "./samples";

const file = (contents = "audio") => new File([contents], "Kick.wav", { type: "audio/wav" });

const request = (assetKey: string, contents = "audio") => {
  const form = new FormData();
  form.append("projectId", "project-1");
  form.append("assetKey", assetKey);
  form.append("file", file(contents));
  return new Request("https://control.example/api/samples", {
    method: "POST",
    headers: { "Content-Length": "1000" },
    body: form,
  });
};

test("browser uploads derive a stable server idempotency key and return the authoritative asset", async () => {
  const idempotencyKeys: string[] = [];
  let puts = 0;
  let begins = 0;
  const application = new Hono<ApiBindings>();
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: {
        query: async () => null,
        mutation: async (_reference, args) => {
          if (typeof args !== "object" || args === null || !("name" in args)) {
            return { asset: { id: "asset-authoritative" } };
          }
          const input = args;
          if (typeof input.idempotencyKey === "string") idempotencyKeys.push(input.idempotencyKey);
          begins += 1;
          return begins === 1
            ? { status: "pending", assetKey: "asset-authoritative", r2Key: "asset-namespaces/namespace/object" }
            : { status: "completed", assetKey: "asset-authoritative", r2Key: "asset-namespaces/namespace/object" };
        },
      },
    }),
    putObject: async () => { puts += 1; },
  });

  const first = await application.request(request("client-stable-asset-key"));
  const second = await application.request(request("client-stable-asset-key"));
  expect(first.status).toBe(201);
  expect(second.status).toBe(201);
  expect(await first.json()).toEqual({
    assetKey: "asset-authoritative",
    url: "/api/samples/project-1/asset-authoritative",
  });
  expect(idempotencyKeys).toHaveLength(2);
  expect(idempotencyKeys[0]).toBe(idempotencyKeys[1]);
  expect(idempotencyKeys[0]).not.toContain("client-stable-asset-key");
  expect(puts).toBe(1);
});

test("browser uploads require the stable client asset key", async () => {
  const application = new Hono<ApiBindings>();
  registerSampleRoutes(application);
  const form = new FormData();
  form.append("projectId", "project-1");
  form.append("file", file());
  const response = await application.request(new Request("https://control.example/api/samples", {
    method: "POST",
    headers: { "Content-Length": "1000" },
    body: form,
  }));
  expect(response.status).toBe(400);
});

test("an outbox retry with changed bytes conflicts before writing another object", async () => {
  let puts = 0;
  const application = new Hono<ApiBindings>();
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: {
        query: async () => null,
        mutation: async () => {
          throw {
            data: {
              version: "v1",
              code: "idempotency-conflict",
              message: "Idempotency key is already bound to another request.",
            },
          };
        },
      },
    }),
    putObject: async () => { puts += 1; },
  });
  const response = await application.request(request("client-stable-asset-key", "changed-audio"));
  expect(response.status).toBe(409);
  expect(puts).toBe(0);
});
