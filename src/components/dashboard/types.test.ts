import { describe, expect, test } from "bun:test"
import { parseDashboardView } from "./types"

describe("parseDashboardView", () => {
  test("accepts the audio dashboard route", () => {
    expect(parseDashboardView("audio")).toBe("audio")
    expect(parseDashboardView("unknown")).toBeNull()
  })
})
