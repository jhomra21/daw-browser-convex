import { describe, expect, test } from "bun:test";
import { createRoot } from "solid-js";

import { createTimelineVerticalScrollSync } from "./timeline-vertical-scroll-sync";

class TestScrollElement {
  scrollTop = 0;
  private listener: (() => void) | undefined;

  addEventListener(
    _type: "scroll",
    listener: () => void,
    _options?: AddEventListenerOptions,
  ) {
    this.listener = listener;
  }

  removeEventListener(_type: "scroll", listener: () => void) {
    if (this.listener === listener) this.listener = undefined;
  }

  scrollTo(value: number) {
    this.scrollTop = value;
    this.listener?.();
  }
}

describe("createTimelineVerticalScrollSync", () => {
  test("mirrors either surface without feedback writes", () => {
    const timeline = new TestScrollElement();
    const sidebar = new TestScrollElement();
    const canonicalValues: number[] = [];

    createRoot((dispose) => {
      const sync = createTimelineVerticalScrollSync({
        onCanonicalScrollTop: (value) => canonicalValues.push(value),
      });
      sync.bindTimeline(timeline);
      sync.bindSidebar(sidebar);

      timeline.scrollTo(120);
      expect(sidebar.scrollTop).toBe(120);
      expect(canonicalValues).toEqual([0, 120]);

      sidebar.scrollTo(360);
      expect(timeline.scrollTop).toBe(360);
      expect(canonicalValues).toEqual([0, 120, 360]);

      dispose();
    });
  });
});
