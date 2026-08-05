import { createOneShotEqFrameScheduler, smoothSpectrumLinear } from "./eq-render-work";
import { expect, test } from "bun:test";

test("coalesces invalidations into one display frame and cancels pending work", () => {
  const callbacks: Array<(time: number) => void> = [];
  const cancelled: number[] = [];
  const scheduler = createOneShotEqFrameScheduler(
    {
      request: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: (id) => cancelled.push(id),
    },
    () => undefined,
  );

  scheduler.invalidate();
  scheduler.invalidate();
  expect(callbacks).toHaveLength(1);
  scheduler.dispose();
  expect(cancelled).toEqual([1]);
});

test("smooths spectrum with a bounded reusable linear pass", () => {
  const values = new Float32Array([0, 3, 0, 3]);
  const output = new Float32Array(values.length);

  expect(smoothSpectrumLinear(values, output, 1)).toBe(output);
  expect([...output]).toEqual([1.5, 1, 2, 1.5]);
});
