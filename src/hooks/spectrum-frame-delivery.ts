import type { SpectrumFrame } from "@daw-browser/audio-engine/audio-engine";

type SpectrumFrameScheduler = {
  request: (callback: () => void) => number;
  cancel: (id: number) => void;
};

type SpectrumFrameDeliveryOptions = {
  isNativePrepared: () => boolean;
  subscribeNative: (listener: (frame: SpectrumFrame | null) => void) => () => void;
  readBrowserFrame: () => SpectrumFrame | null;
  scheduler: SpectrumFrameScheduler;
  deliver: (frame: SpectrumFrame | null) => void;
};

export const createSpectrumFrameDelivery = ({
  isNativePrepared,
  subscribeNative,
  readBrowserFrame,
  scheduler,
  deliver,
}: SpectrumFrameDeliveryOptions) => {
  let browserFrame: number | null = null;
  let nativeFrame: SpectrumFrame | null = null;
  let nativeFramePending = false;
  let nativeDeliveryFrame: number | null = null;
  let released = false;

  function scheduleBrowserSample() {
    if (released || isNativePrepared() || browserFrame !== null) return;
    browserFrame = scheduler.request(sampleBrowser);
  }

  function sampleBrowser() {
    browserFrame = null;
    if (released || isNativePrepared()) return;
    try {
      deliver(readBrowserFrame());
    } catch {
      deliver(null);
    }
    scheduleBrowserSample();
  }

  function deliverNativeFrame() {
    nativeDeliveryFrame = null;
    if (released || !nativeFramePending) return;
    if (!isNativePrepared()) {
      nativeFramePending = false;
      scheduleBrowserSample();
      return;
    }
    nativeFramePending = false;
    deliver(nativeFrame);
  }

  const unsubscribeNative = subscribeNative((frame) => {
    if (released) return;
    if (isNativePrepared()) {
      if (browserFrame !== null) {
        scheduler.cancel(browserFrame);
        browserFrame = null;
      }
      nativeFrame = frame;
      nativeFramePending = true;
      if (nativeDeliveryFrame === null) {
        nativeDeliveryFrame = scheduler.request(deliverNativeFrame);
      }
      return;
    }
    scheduleBrowserSample();
  });

  scheduleBrowserSample();

  return () => {
    if (released) return;
    released = true;
    unsubscribeNative();
    if (browserFrame !== null) scheduler.cancel(browserFrame);
    if (nativeDeliveryFrame !== null) scheduler.cancel(nativeDeliveryFrame);
    browserFrame = null;
    nativeDeliveryFrame = null;
    nativeFramePending = false;
  };
};
