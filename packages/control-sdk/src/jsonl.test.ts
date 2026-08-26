import { expect, test } from "bun:test";
import {
  createJsonlRpcAdapter,
  decodeJsonlLines,
  maxJsonlLineBytes,
} from "./jsonl";
import { ControlApiError } from "./index";
import {
  canonicalControlCapabilities,
  createDirectControlInvoker,
  type ControlInvoker,
  type ControlOperationHandlers,
  type ControlErrorV1,
} from "@daw-browser/control";
import { z } from "zod";

const handlers: ControlOperationHandlers<"cloud"> = {
  "project.list": async () => ({ projects: [] }),
  "control.capabilities": async () => canonicalControlCapabilities,
  "control.snapshot": async () => { throw new Error("not used"); },
  "control.preview": async () => { throw new Error("not used"); },
  "control.requestApproval": async () => { throw new Error("not used"); },
  "control.commit": async () => { throw new Error("not used"); },
  "control.history": async () => { throw new Error("not used"); },
  "control.recoveries": async () => { throw new Error("not used"); },
};
const invoker: ControlInvoker<"cloud"> = createDirectControlInvoker({
  handlers,
  context: { target: "cloud", principal: { subject: "test" } },
});

const responseSchema = z.object({
  id: z.union([z.string(), z.number()]).nullable(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
}).passthrough();
const responseFor = async (line: string) => responseSchema.parse(JSON.parse(
  await createJsonlRpcAdapter({ invoker }).processLine(line) ?? "",
));

test("processes valid requests sequentially and exposes target support", async () => {
  const adapter = createJsonlRpcAdapter({ invoker });
  expect(adapter.methods()).toContain("project.list");
  expect(adapter.methods()).not.toContain("project.current");
  const first = responseFor('{"jsonrpc":"2.0","id":"a","method":"project.list","params":{}}');
  const second = responseFor('{"jsonrpc":"2.0","id":"b","method":"project.list","params":{}}');
  expect((await first).id).toBe("a");
  expect((await second).id).toBe("b");
});

test("rejects malformed, unsupported, and invalid requests while recovering", async () => {
  expect((await responseFor("{"))).toMatchObject({ id: null, error: { code: -32700 } });
  expect((await responseFor('{"jsonrpc":"2.0","id":"x","method":"project.current","params":{}}'))).toMatchObject({ error: { code: -32601 } });
  expect((await responseFor('{"jsonrpc":"2.0","id":"x","method":"project.list","params":{"unexpected":true}}'))).toMatchObject({ error: { code: -32602 } });
  expect((await responseFor('{"jsonrpc":"2.0","id":"x","method":"project.list","params":{}}')).result).toEqual({ projects: [] });
  expect((await responseFor("x".repeat(maxJsonlLineBytes + 1)))).toMatchObject({ id: null, error: { code: -32600 } });
});

test("executes notifications without responses and rejects batches", async () => {
  const adapter = createJsonlRpcAdapter({ invoker });
  await expect(adapter.processLine('{"jsonrpc":"2.0","method":"project.list","params":{}}')).resolves.toBeUndefined();
  await expect(adapter.processLine('{"jsonrpc":"2.0","method":"missing.method","params":{}}')).resolves.toBeUndefined();
  expect((await responseFor("[]"))).toMatchObject({ id: null, error: { code: -32600 } });
});

test("decodes bounded UTF-8 JSONL lines across chunks and recovers after oversize", async () => {
  const chunks = [
    new Uint8Array(Buffer.from('{"jsonrpc":"2.0","id":"é', "utf8").subarray(0, -1)),
    new Uint8Array(Buffer.concat([
      Buffer.from('é', "utf8").subarray(1),
      Buffer.from('"}\r\n', "utf8"),
    ])),
    new Uint8Array(Buffer.from("x".repeat(maxJsonlLineBytes), "utf8")),
    new Uint8Array(Buffer.from("y\n", "utf8")),
    new Uint8Array(Buffer.from('{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}', "utf8")),
  ];
  const lines = [];
  async function* inputChunks() {
    yield* chunks;
  }
  for await (const line of decodeJsonlLines(inputChunks())) lines.push(line);
  expect(lines).toEqual([
    '{"jsonrpc":"2.0","id":"é"}',
    { kind: "too-large" },
    '{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}',
  ]);
});

test("preserves every canonical domain error and sanitizes unknown failures", async () => {
  const errors = [
    { code: "approval-required", message: "Approval required." },
    { code: "revision-conflict", message: "Revision changed." },
    { code: "idempotency-conflict", message: "Idempotency key reused." },
    { code: "forbidden", message: "Write forbidden." },
    { code: "validation", message: "Invalid action.", actionIndex: 2, details: { field: "name" } },
    { code: "not-found", message: "Project not found." },
  ] as const;
  for (const [index, error] of errors.entries()) {
    const details = "details" in error
      ? { ...error.details, safe: "value", extra: 42 }
      : { safe: "value", extra: 42 };
    const domainInvoker: ControlInvoker<"cloud"> = {
      target: "cloud",
      invoke: async () => {
        throw {
          data: {
            version: "v1",
            ...error,
            secret: "must be removed",
            details,
          },
          stack: "secret stack",
        };
      },
    };
    const domain = JSON.parse(await createJsonlRpcAdapter({ invoker: domainInvoker }).processLine(
      `{"jsonrpc":"2.0","id":${index},"method":"project.list","params":{}}`,
    ) ?? "");
    expect(domain.error).toEqual({
      code: -32000,
      message: "Control operation failed.",
      data: {
        version: "v1",
        ...error,
        details: "details" in error ? { ...error.details, safe: "value" } : { safe: "value" },
      },
    });
  }
  const apiErrorInvoker: ControlInvoker<"cloud"> = {
    target: "cloud",
    invoke: async () => {
      throw new ControlApiError(409, {
        version: "v1",
        code: "revision-conflict",
        message: "Revision changed.",
        actionIndex: 1,
        details: { field: "expectedRevision" },
      });
    },
  };
  const apiError = JSON.parse(await createJsonlRpcAdapter({ invoker: apiErrorInvoker }).processLine(
    '{"jsonrpc":"2.0","id":7,"method":"project.list","params":{}}',
  ) ?? "");
  expect(apiError.error.data).toEqual({
    version: "v1",
    code: "revision-conflict",
    message: "Revision changed.",
    actionIndex: 1,
    details: { field: "expectedRevision" },
  });
  const directError: ControlErrorV1 = {
    version: "v1",
    code: "forbidden",
    message: "Write forbidden.",
  };
  const directInvoker: ControlInvoker<"cloud"> = {
    target: "cloud",
    invoke: async () => { throw directError; },
  };
  const direct = JSON.parse(await createJsonlRpcAdapter({ invoker: directInvoker }).processLine(
    '{"jsonrpc":"2.0","id":8,"method":"project.list","params":{}}',
  ) ?? "");
  expect(direct.error.data).toEqual(directError);
  const unknownInvoker: ControlInvoker<"cloud"> = {
    target: "cloud",
    invoke: async () => { throw new Error("token and transport details"); },
  };
  const unknown = JSON.parse(await createJsonlRpcAdapter({ invoker: unknownInvoker }).processLine(
    '{"jsonrpc":"2.0","id":1,"method":"project.list","params":{}}',
  ) ?? "");
  expect(unknown.error).toEqual({
    code: -32603,
    message: "Internal error.",
    data: { version: "v1", code: "internal", message: "Control method failed." },
  });
});
