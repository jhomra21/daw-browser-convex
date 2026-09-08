import { expect, test } from "bun:test";
import { Hono } from "hono";
import { z } from "zod";
import { controlLimitsV1 } from "@daw-browser/control";
import type { ApiBindings } from "../app-types";
import { AudioUploadValidationError } from "../control-upload-audio-metadata";
import { registerPublicSampleRoutes, registerSampleRoutes } from "./samples";

const file = (contents = "audio") => {
  const sampleBytes = new Uint8Array(contents.length * 2)
  const view = new DataView(sampleBytes.buffer)
  for (let index = 0; index < contents.length; index += 1) view.setInt16(index * 2, contents.charCodeAt(index), true)
  const bytes = new Uint8Array(44 + sampleBytes.byteLength)
  const header = new DataView(bytes.buffer)
  header.setUint32(0, 0x52494646)
  header.setUint32(4, bytes.byteLength - 8, true)
  header.setUint32(8, 0x57415645)
  header.setUint32(12, 0x666d7420)
  header.setUint32(16, 16, true)
  header.setUint16(20, 1, true)
  header.setUint16(22, 1, true)
  header.setUint32(24, 44_100, true)
  header.setUint32(28, 88_200, true)
  header.setUint16(32, 2, true)
  header.setUint16(34, 16, true)
  header.setUint32(36, 0x64617461)
  header.setUint32(40, sampleBytes.byteLength, true)
  bytes.set(sampleBytes, 44)
  return new File([bytes], "Kick.wav", { type: "audio/wav" })
};

const request = (assetKey: string, contents = "audio") => {
  const form = new FormData();
  form.append("projectId", "project-1");
  form.append("assetKey", assetKey);
  form.append("file", file(contents));
  return new Request("https://control.example/api/samples?projectId=project-1", {
    method: "POST",
    headers: { "Content-Length": "1000" },
    body: form,
  });
};

const requestWithFile = (assetKey: string, upload: File) => {
  const form = new FormData();
  form.append("projectId", "project-1");
  form.append("assetKey", assetKey);
  form.append("file", upload);
  return new Request("https://control.example/api/samples?projectId=project-1", {
    method: "POST",
    headers: { "Content-Length": String(upload.size) },
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
          const beginUpload = z.object({
            name: z.string(),
            idempotencyKey: z.string(),
          }).passthrough().safeParse(args);
          if (!beginUpload.success) {
            return { asset: { id: "asset-authoritative" } };
          }
          idempotencyKeys.push(beginUpload.data.idempotencyKey);
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
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: { query: async () => null, mutation: async () => ({}) },
    }),
  });
  const form = new FormData();
  form.append("projectId", "project-1");
  form.append("file", file());
  const response = await application.request(new Request("https://control.example/api/samples?projectId=project-1", {
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

test("maps known invalid sample media to a validation response", async () => {
  const application = new Hono<ApiBindings>();
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: { query: async () => null, mutation: async () => ({}) },
    }),
    inspectAudioMetadata: async () => {
      throw new AudioUploadValidationError("Uploaded audio could not be parsed.");
    },
  });

  const response = await application.request(request("invalid-media"));
  expect(response.status).toBe(422);
});

test("keeps unexpected sample backend failures as internal errors", async () => {
  const application = new Hono<ApiBindings>();
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: { query: async () => null, mutation: async () => ({}) },
    }),
    inspectAudioMetadata: async () => {
      throw new Error("backend failure");
    },
  });

  const response = await application.request(request("backend-failure"));
  expect(response.status).toBe(500);
});

test("rejects oversized sample requests before multipart parsing or hashing", async () => {
  const application = new Hono<ApiBindings>();
  let hashed = false;
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => {
      throw new Error("authorization should not run after request rejection");
    },
    hashFile: async () => {
      hashed = true;
      return "a".repeat(64);
    },
  });

  const response = await application.request(new Request("https://control.example/api/samples?projectId=project-1", {
    method: "POST",
    headers: { "Content-Length": String(controlLimitsV1.maxAssetUploadRequestBytes + 1) },
    body: "not multipart",
  }));
  expect(response.status).toBe(413);
  expect(hashed).toBeFalse();
  const unsafeLength = await application.request(new Request("https://control.example/api/samples?projectId=project-1", {
    method: "POST",
    headers: { "Content-Length": String(Number.MAX_SAFE_INTEGER + 1) },
    body: "not multipart",
  }));
  expect(unsafeLength.status).toBe(400);
});

test("rejects oversized sample files after authorization and before hashing", async () => {
  const application = new Hono<ApiBindings>();
  let hashed = false;
  const large = new File([new Uint8Array(controlLimitsV1.maxAssetUploadBytes + 1)], "large.wav", { type: "audio/wav" });
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: { query: async () => null, mutation: async () => ({}) },
    }),
    hashFile: async () => {
      hashed = true;
      return "a".repeat(64);
    },
  });
  const response = await application.request(requestWithFile("large", large));
  expect(response.status).toBe(413);
  expect(hashed).toBeFalse();
});

test("checks project authorization before hashing or inspecting the upload", async () => {
  const application = new Hono<ApiBindings>();
  let hashed = false;
  let inspected = false;
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => null,
    hashFile: async () => {
      hashed = true;
      return "a".repeat(64);
    },
    inspectAudioMetadata: async () => {
      inspected = true;
      throw new Error("should not inspect");
    },
  });

  const response = await application.request(request("unauthorized"));
  expect(response.status).toBe(403);
  expect(hashed).toBeFalse();
  expect(inspected).toBeFalse();
});

test("returns an internal error and records failed upload when R2 fails", async () => {
  const application = new Hono<ApiBindings>();
  let mutationCalls = 0;
  registerSampleRoutes(application, {
    requireProjectRoleContext: async () => ({
      user: { id: "user-1" },
      convex: {
        query: async () => null,
        mutation: async () => {
          mutationCalls += 1;
          return mutationCalls === 1
            ? { status: "pending", assetKey: "asset", r2Key: "asset" }
            : {};
        },
      },
    }),
    putObject: async () => {
      throw new Error("r2 failure");
    },
    inspectAudioMetadata: async () => ({
      durationSec: 1,
      sampleRate: 48_000,
      channelCount: 1,
      detectedFormat: "WAVE",
      detectedMimeType: "audio/wav",
      detectedCodec: "pcm-s16",
    }),
  });

  const response = await application.request(request("r2-failure"));
  expect(response.status).toBe(500);
  expect(mutationCalls).toBe(2);
});

test("default sample catalog CORS only permits trusted Electron origins", async () => {
  const application = new Hono<ApiBindings>();
  registerPublicSampleRoutes(application, {
    listDefaultSamples: async () => ({ samples: [] }),
  });

  const allowed = await application.request(new Request("https://control.example/api/default-samples", {
    headers: { Origin: "daw://app" },
  }));
  expect(allowed.status).toBe(200);
  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("daw://app");
  expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();

  const head = await application.request(new Request("https://control.example/api/default-samples", {
    method: "HEAD",
    headers: { Origin: "daw://app" },
  }));
  expect(head.status).toBe(200);
  expect(head.headers.get("Access-Control-Allow-Origin")).toBe("daw://app");

  const rejected = await application.request(new Request("https://control.example/api/default-samples", {
    headers: { Origin: "https://untrusted.example" },
  }));
  expect(rejected.status).toBe(200);
  expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
});

test("default sample media CORS preflight only permits trusted Electron origins", async () => {
  const application = new Hono<ApiBindings>();
  registerPublicSampleRoutes(application);

  const allowed = await application.request(new Request("https://control.example/api/default-sample", {
    method: "OPTIONS",
    headers: { Origin: "http://localhost:5173" },
  }));
  expect(allowed.status).toBe(204);
  expect(allowed.headers.get("Access-Control-Allow-Origin")).toBe("http://localhost:5173");
  expect(allowed.headers.get("Access-Control-Allow-Credentials")).toBeNull();

  const rejected = await application.request(new Request("https://control.example/api/default-sample", {
    method: "OPTIONS",
    headers: { Origin: "https://untrusted.example" },
  }));
  expect(rejected.status).toBe(403);
  expect(rejected.headers.get("Access-Control-Allow-Origin")).toBeNull();
});
