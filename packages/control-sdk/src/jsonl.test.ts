import { expect, test } from "bun:test";
import {
  createJsonlRpcAdapter,
  maxJsonlLineBytes,
} from "./jsonl";
import type { ControlInvoker } from "@daw-browser/control";
import { createDirectControlInvoker, type ControlOperationHandlers } from "@daw-browser/control";
import { canonicalControlCapabilities } from "@daw-browser/control";
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
  await createJsonlRpcAdapter({ invoker }).processLine(line),
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

test("rejects notifications and batches without leaking failures", async () => {
  expect((await responseFor('{"jsonrpc":"2.0","method":"project.list","params":{}}'))).toMatchObject({ id: null, error: { code: -32600 } });
  expect((await responseFor("[]"))).toMatchObject({ id: null, error: { code: -32600 } });
});
