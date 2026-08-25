import { expect, test } from "bun:test"
import { createRendererLifecycleOwner } from "./renderer-lifecycle"

test("invalidates one active renderer generation at most once", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.activateCommittedDocument()
  expect(lifecycle.invalidateActiveDocument()).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.invalidateActiveDocument()).toBeUndefined()
  expect(lifecycle.generation()).toBe(1)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
})

test("a newly committed document can be invalidated after the first loss", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.activateCommittedDocument()
  lifecycle.invalidateActiveDocument()
  lifecycle.activateCommittedDocument()
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.invalidateActiveDocument()).toEqual({ previousGeneration: 1, generation: 2 })
})

test("committing a document does not change its generation or reactivate a dead document twice", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.activateCommittedDocument()
  lifecycle.activateCommittedDocument()
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
  lifecycle.activateCommittedDocument()
  expect(lifecycle.beginMainFrameNavigation("https://app.test/a")).toEqual({ previousGeneration: 0, generation: 1 })
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(false)
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(true)
  expect(lifecycle.generation()).toBe(1)
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
  expect(lifecycle.failMainFrameNavigation("https://app.test/a")).toBe(false)
})

test("successful and crashed pending navigations are idempotent", () => {
  const committed = createRendererLifecycleOwner()
  committed.activateCommittedDocument()
  committed.beginMainFrameNavigation("https://app.test/committed")
  committed.commitMainFrameNavigation("https://app.test/committed")
  committed.commitMainFrameNavigation("https://app.test/committed")
  expect(committed.generation()).toBe(1)
  expect(committed.acceptsPrivilegedRequests()).toBe(true)

  const crashed = createRendererLifecycleOwner()
  crashed.activateCommittedDocument()
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
  lifecycle.activateCommittedDocument()
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
  lifecycle.activateCommittedDocument()
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
  lifecycle.activateCommittedDocument()
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
    lifecycle.activateCommittedDocument()
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

test("same-document and subframe lifecycle events do not affect ownership", () => {
  const lifecycle = createRendererLifecycleOwner()
  lifecycle.activateCommittedDocument()
  lifecycle.commitMainFrameNavigation("https://app.test/current#hash")
  lifecycle.failMainFrameNavigation("https://app.test/frame")
  expect(lifecycle.acceptsPrivilegedRequests()).toBe(true)
})
