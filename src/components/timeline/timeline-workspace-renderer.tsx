import type { Component } from "solid-js";
import { TimelineLeftBrowser } from "./browser/timeline-left-browser";
import type { TimelineLeftBrowserModel } from "./browser/browser-types";

export type TimelineWorkspaceRenderContext = Readonly<{
  leftBrowser: TimelineLeftBrowserModel;
}>;

export type TimelineWorkspaceRenderer = Component<TimelineWorkspaceRenderContext>;

export const renderBuiltinTimelineBrowserWorkspace: TimelineWorkspaceRenderer = (
  context,
) => <TimelineLeftBrowser browser={context.leftBrowser} />;
