import { createEffect, type Accessor, type Setter } from "solid-js";
import type { useTimelineViewport } from "~/hooks/useTimelineViewport";

export const useTimelineFollow = (input: {
  preferences: {
    follow: Accessor<boolean>;
    setFollow: (enabled: boolean) => void;
  };
  viewport: ReturnType<typeof useTimelineViewport>;
  playback: {
    isPlaying: Accessor<boolean>;
    playheadSec: Accessor<number>;
  };
  gestureActive: Accessor<boolean>;
  followPaused: Accessor<boolean>;
  setFollowPaused: Setter<boolean>;
  scrollElement: Accessor<HTMLDivElement | undefined>;
  pixelsPerSecond: Accessor<number>;
}) => {
  createEffect(
    () => input.gestureActive(),
    (gestureActive) => {
      if (gestureActive) input.setFollowPaused(true);
    },
  );
  createEffect(
    () => input.playback.isPlaying(),
    (isPlaying) => {
      if (!isPlaying) input.setFollowPaused(false);
    },
  );
  createEffect(
    () => {
      const playhead = input.playback.playheadSec();

      if (!input.preferences.follow() || input.followPaused() || !input.playback.isPlaying()) return undefined;
      const scroll = input.scrollElement();

      if (!scroll) return undefined;
      const visibleStart = input.viewport.visibleRange().startSec;
      const visibleDuration = scroll.clientWidth / Math.max(1e-9, input.pixelsPerSecond());

      if (!(visibleDuration > 0)) return undefined;

      return { playhead, visibleStart, visibleDuration };
    },
    (follow) => {
      if (!follow) return;
      const { playhead, visibleStart, visibleDuration } = follow;
      const visibleEnd = visibleStart + visibleDuration;

      if (playhead < visibleStart || playhead >= visibleEnd) {
        input.viewport.setVisibleStart(Math.max(0, playhead - visibleDuration * 0.1));
      }
    },
  );

  return {
    toggle: () => {
      input.preferences.setFollow(!input.preferences.follow());
      input.setFollowPaused(false);
    },
  };
};
