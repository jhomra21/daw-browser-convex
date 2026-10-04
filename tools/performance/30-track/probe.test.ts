import { expect, test } from "bun:test"
import { summarizeIntervals, summarizeThresholds } from "./probe"

test("probe quantiles interpolate deterministically", () => {
  expect(summarizeIntervals([1, 2, 3, 4])).toEqual({
    p50: 2.5,
    p95: 3.8499999999999996,
    p99: 3.9699999999999998,
    max: 4,
  })
  expect(summarizeIntervals([])).toEqual({ p50: null, p95: null, p99: null, max: null })
})

test("probe threshold counts use strict greater-than boundaries", () => {
  expect(summarizeThresholds([8.33, 8.34, 16.67, 16.68, 33.3, 33.31, 50, 50.01])).toEqual({
    over8_33Ms: 7,
    over16_67Ms: 5,
    over33_3Ms: 3,
    over50Ms: 1,
  })
})
