import { expect, test } from "bun:test";
import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";
import { createSpectrumFrameDelivery } from "./spectrum-frame-delivery";

const frame = (value: number): SpectrumFrame => ({
  data: new Float32Array([value]),
  sampleRate: 44100,
});

test("coalesces native frames and cancels pending delivery on cleanup", () => {
  const callbacks: Array<() => void> = [];
  const cancelled: number[] = [];
  const delivered: Array<SpectrumFrame | null> = [];
  const nativePrepared = true;
  let nativeListener: ((value: SpectrumFrame | null) => void) | undefined;
  let nextId = 0;
  const unsubscribe = createSpectrumFrameDelivery({
    isNativePrepared: () => nativePrepared,
    subscribeNative: (listener) => {
      nativeListener = listener;
      return () => {
        nativeListener = undefined;
      };
    },
    readBrowserFrame: () => null,
    scheduler: {
      request: (callback) => {
        callbacks.push(callback);
        nextId += 1;
        return nextId;
      },
      cancel: (id) => cancelled.push(id),
    },
    deliver: (value) => delivered.push(value),
  });

  nativeListener?.(frame(1));
  nativeListener?.(frame(2));
  expect(callbacks).toHaveLength(1);
  callbacks.shift()?.();
  expect(delivered).toEqual([frame(2)]);

  nativeListener?.(frame(3));
  unsubscribe();
  expect(cancelled).toEqual([2]);
  callbacks.shift()?.();
  expect(delivered).toEqual([frame(2)]);
});

test("owns one browser sampling frame and cancels it on native takeover", () => {
  const callbacks: Array<() => void> = [];
  const cancelled: number[] = [];
  const delivered: Array<SpectrumFrame | null> = [];
  let nativePrepared = false;
  let nativeListener: ((value: SpectrumFrame | null) => void) | undefined;
  const unsubscribe = createSpectrumFrameDelivery({
    isNativePrepared: () => nativePrepared,
    subscribeNative: (listener) => {
      nativeListener = listener;
      return () => {
        nativeListener = undefined;
      };
    },
    readBrowserFrame: () => frame(4),
    scheduler: {
      request: (callback) => {
        callbacks.push(callback);
        return callbacks.length;
      },
      cancel: (id) => cancelled.push(id),
    },
    deliver: (value) => delivered.push(value),
  });

  expect(callbacks).toHaveLength(1);
  nativePrepared = true;
  nativeListener?.(frame(5));
  expect(cancelled).toEqual([1]);
  expect(callbacks).toHaveLength(2);
  callbacks.shift()?.();
  expect(delivered).toEqual([]);
  callbacks.shift()?.();
  expect(delivered).toEqual([frame(5)]);
  unsubscribe();
});
