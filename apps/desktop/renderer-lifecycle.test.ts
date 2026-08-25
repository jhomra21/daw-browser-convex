import { expect, test } from "bun:test"
import { createRendererLifecycleOwner } from "./renderer-lifecycle"

test("invalidates one active renderer generation at most once", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.invalidateActiveDocument()).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.invalidateActiveDocument()).toBeUndefined()
  expect(lifecycle.generation()).toBe(1)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("a newly committed document can be invalidated after the first loss", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.invalidateActiveDocument()
  lifecycle.beginMainFrameNavigation("https://app.test/recovered")
  lifecycle.commitMainFrameNavigation("https://app.test/recovered")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.invalidateActiveDocument()).toEqual({ previousGeneration: 1, generation: 2 })
})

test("committing a document does not change its generation or reactivate a dead document twice", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.generation()).toBe(0)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("the initial did-navigate commit activates the first document without a pending attempt", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.generation()).toBe(0)
})

test("an unmatched did-navigate after activation cannot reactivate a dead document", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.invalidateActiveDocument()
  lifecycle.commitMainFrameNavigation("https://app.test/stale")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("failed main-frame navigation restores the live document without restoring its old generation", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.beginMainFrameNavigation("https://app.test/a")).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(true)
  expect(lifecycle.generation()).toBe(1)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(false)
})

test("successful and crashed pending navigations are idempotent", () => {
  const committed = createRendererLifecycleOwner()
  committed.commitMainFrameNavigation("https://app.test/initial")
  committed.beginMainFrameNavigation("https://app.test/committed")
  committed.commitMainFrameNavigation("https://app.test/committed")
  committed.commitMainFrameNavigation("https://app.test/committed")
  expect(committed.generation()).toBe(1)
  expect(committed.acceptsPrivilegedRequests()).toBe(true)

  const crashed = createRendererLifecycleOwner()
  crashed.commitMainFrameNavigation("https://app.test/initial")
  crashed.beginMainFrameNavigation("https://app.test/crashed")
  expect(crashed.invalidateAfterCrash()).toEqual({ previousGeneration: 1, generation: 2 })
  expect(crashed.invalidateAfterCrash()).toBeUndefined()
  expect(crashed.acceptsPrivilegedRequests()).toBe(false)
  crashed.commitMainFrameNavigation("https://app.test/crashed")
  expect(crashed.failMainFrameNavigation("https://app.test/crashed")).toBe(false)
  expect(crashed.acceptsPrivilegedRequests()).toBe(false)
})

test("a crash before the first document commit does not activate a replacement", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.beginMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.invalidateAfterCrash()).toEqual({ previousGeneration: 0, generation: 1 })
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("a failed initial navigation does not activate an uncommitted document", () => {
  const lifecycle = createRendererLifecycleOwner()
  expect(lifecycle.beginMainFrameNavigation("https://app.test/initial")).toBeUndefined()
  expect(lifecycle.failMainFrameNavigation("https://app.test/initial")).toBe(false)
  lifecycle.commitMainFrameNavigation("https://app.test/stale")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("overlapping navigations ignore stale failures and commits", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  expect(lifecycle.beginMainFrameNavigation("https://app.test/a")).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.beginMainFrameNavigation("https://app.test/b")).toBeUndefined()
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  lifecycle.commitMainFrameNavigation("https://app.test/a")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  lifecycle.commitMainFrameNavigation("https://app.test/b")
  expect(lifecycle.confirmMainFrameNavigation()).toBe(true)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("an overlapping navigation failure remains fail-closed after all outcomes are known", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.beginMainFrameNavigation("https://app.test/a")
  lifecycle.beginMainFrameNavigation("https://app.test/b")
  expect(lifecycle.failMainFrameNavigation("https://app.test/b")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(false)
  expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("a stale failure cannot restore a newer overlapping navigation", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.beginMainFrameNavigation("https://app.test/a")
  lifecycle.beginMainFrameNavigation("https://app.test/b")
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/b")).toBe(false)
  expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("same-url overlapping outcomes remain fail-closed", () => {
  for (const outcomes of [["fail", "commit"], ["commit", "fail"], ["commit", "commit"], ["fail", "fail"]] as const) {
    const lifecycle = createRendererLifecycleOwner()
    lifecycle.commitMainFrameNavigation("https://app.test/initial")
    lifecycle.beginMainFrameNavigation("https://app.test/same")
    lifecycle.beginMainFrameNavigation("https://app.test/same")
    for (const outcome of outcomes) {
      if (outcome === "commit") lifecycle.commitMainFrameNavigation("https://app.test/same")
      else lifecycle.failMainFrameNavigation("https://app.test/same")
      expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
    }
    expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
    expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  }
})

test("retired events cannot interfere with a pending recovery navigation", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.beginMainFrameNavigation("https://app.test/same")
  lifecycle.beginMainFrameNavigation("https://app.test/same")
  lifecycle.commitMainFrameNavigation("https://app.test/same")
  lifecycle.failMainFrameNavigation("https://app.test/same")
  expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)

  lifecycle.beginMainFrameNavigation("https://app.test/recovered")
  lifecycle.commitMainFrameNavigation("https://app.test/same")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/same")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  lifecycle.commitMainFrameNavigation("https://app.test/recovered")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("a direct navigation to a retired identity requires an independent recovery", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.beginMainFrameNavigation("https://app.test/same")
  lifecycle.beginMainFrameNavigation("https://app.test/same")
  lifecycle.commitMainFrameNavigation("https://app.test/same")
  lifecycle.failMainFrameNavigation("https://app.test/same")
  expect(lifecycle.confirmMainFrameNavigation()).toBe(false)

  lifecycle.beginMainFrameNavigation("https://app.test/same")
  lifecycle.commitMainFrameNavigation("https://app.test/redirected")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/same")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)

  lifecycle.beginMainFrameNavigation("https://app.test/recovered")
  lifecycle.commitMainFrameNavigation("https://app.test/recovered")
  expect(lifecycle.confirmMainFrameNavigation()).toBe(true)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.commitMainFrameNavigation("https://app.test/same")).toBeUndefined()
  expect(lifecycle.failMainFrameNavigation("https://app.test/same")).toBe(false)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("consecutive ambiguous batches retain every retired identity until recovery", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  for (const identity of ["https://app.test/a", "https://app.test/b"]) {
    lifecycle.beginMainFrameNavigation(identity)
    lifecycle.beginMainFrameNavigation(identity)
    lifecycle.commitMainFrameNavigation(identity)
    lifecycle.failMainFrameNavigation(identity)
    expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
    expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  }

  lifecycle.beginMainFrameNavigation("https://app.test/recovered")
  lifecycle.commitMainFrameNavigation("https://app.test/a")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  lifecycle.commitMainFrameNavigation("https://app.test/recovered")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("retired identity overflow stays bounded and fail-closed until crash", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  for (let index = 0; index <= 128; index += 1) {
    const identity = `https://app.test/ambiguous/${index}`
    lifecycle.beginMainFrameNavigation(identity)
    lifecycle.beginMainFrameNavigation(identity)
    lifecycle.commitMainFrameNavigation(identity)
    lifecycle.failMainFrameNavigation(identity)
    expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
  }

  for (let index = 0; index < 1_000; index += 1) {
    const identity = `https://app.test/recovery/${index}`
    lifecycle.beginMainFrameNavigation(identity)
    lifecycle.commitMainFrameNavigation(identity)
    expect(lifecycle.confirmMainFrameNavigation()).toBe(false)
    expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  }
  lifecycle.invalidateAfterCrash()
  lifecycle.beginMainFrameNavigation("https://app.test/post-crash")
  lifecycle.commitMainFrameNavigation("https://app.test/post-crash")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})

test("same-document and subframe lifecycle events do not affect ownership", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.commitMainFrameNavigation("https://app.test/initial")
  lifecycle.commitMainFrameNavigation("https://app.test/current#hash")
  lifecycle.failMainFrameNavigation("https://app.test/frame")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})
