import { smoothSpectrumLinear } from "./eq-render-work";
import { expect, test } from "bun:test";

test("smooths spectrum with a bounded reusable linear pass", () => {
  const values = new Float32Array([0, 3, 0, 3]);
  const output = new Float32Array(values.length);

  expect(smoothSpectrumLinear(values, output, 1)).toBe(output);
  expect([...output]).toEqual([1.5, 1, 2, 1.5]);
});
