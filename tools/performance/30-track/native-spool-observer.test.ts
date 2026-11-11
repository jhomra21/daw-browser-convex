import { expect, test } from "bun:test"
import { instrumentSavedSpoolRelease, instrumentSpoolImport, instrumentSpoolScriptResponse, parseSpoolEvaluation } from "./native-spool-observer"

test("instruments exactly the saved-release call without changing arguments or other gates", () => {
  const source = "async function save(){await b.release(n.scope,n.takeId,{...n.acknowledgment,savedClip:c})}"
  const observed = instrumentSavedSpoolRelease(source)
  expect(observed).toContain("globalThis.__nativeSpoolObservedRelease");
  expect(observed).toContain("()=>b.release(n.scope,n.takeId,{...n.acknowledgment,savedClip:c})")
  expect(() => instrumentSavedSpoolRelease("async function unrelated(){}")).toThrow()
  expect(() => instrumentSavedSpoolRelease(source + source)).toThrow()
})
test("requires saved-clip receipt, never generic importer or discard release", () => {
  expect(() => instrumentSavedSpoolRelease("await b.release(n.scope,n.takeId,n.acknowledgment)")).toThrow()
  expect(() => instrumentSavedSpoolRelease("await b.release(n.scope,n.takeId,{reason:'discard'})")).toThrow()
})
test("observes actual importer invocation and exact awaited result without replacing it", () => {
  const source = "return await(e.importRecordingSpool??r)({bridge:b,scope:n.scope,isCurrent:()=>x===n})"
  expect(instrumentSpoolImport(source)).toBe("return await globalThis.__nativeSpoolObservedImport(()=>(e.importRecordingSpool??r)({bridge:b,scope:n.scope,isCurrent:()=>x===n}))")
  expect(() => instrumentSpoolImport("no importer boundary")).toThrow()
})
test("response-stage observation preserves all code except the two exact invocation wrappers", () => {
  const source = "/*saved recording source retained*/async function saved(){await b.release(n.scope,n.takeId,{...n.acknowledgment,savedClip:c})};async function importTake(){return await(e.importRecordingSpool??r)({bridge:b})}"
  const observed = Buffer.from(instrumentSpoolScriptResponse(Buffer.from(source).toString("base64"), true), "base64").toString()
  expect(observed).toContain("/*saved recording source retained*/")
  expect(observed).toContain("globalThis.__nativeSpoolObservedRelease")
  expect(observed).toContain("globalThis.__nativeSpoolObservedImport")
})
test("saved-content observation uses independent inspector values while browser waits", () => {
  expect(parseSpoolEvaluation({ result: { value: '{"frames":12}' } })).toBe('{"frames":12}')
  expect(() => parseSpoolEvaluation({ result: {}, exceptionDetails: { text: "failed" } })).toThrow("observation evaluation")
})
