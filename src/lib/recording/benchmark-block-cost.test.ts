import { expect, test } from "bun:test"
import { createBenchmarkBlockCost } from "./benchmark-block-cost"

test("reports bounded native block costs without retaining PCM", () => {
  const cost = createBenchmarkBlockCost()
  expect(cost.add(0, 2, 3, 4)).toBeNull()
  expect(cost.add(5000, 5, 6, 7)).toEqual({
    blocks: 2, copyMaxMs: 5, enqueueMaxMs: 6, totalMaxMs: 7,
  })
  expect(cost.add(5001, 1, 1, 1)).toBeNull()
})
