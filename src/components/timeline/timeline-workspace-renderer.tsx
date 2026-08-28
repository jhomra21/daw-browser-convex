import type { JSX } from "solid-js";
import { TimelineLeftBrowser } from "./browser/timeline-left-browser";
import type { TimelineLeftBrowserModel } from "./browser/browser-types";

export type TimelineWorkspaceRenderContext = Readonly<{
  leftBrowser: TimelineLeftBrowserModel;
}>;

export type TimelineWorkspaceRenderer = (
  context: TimelineWorkspaceRenderContext,
) => JSX.Element;

export const renderBuiltinTimelineBrowserWorkspace: TimelineWorkspaceRenderer = (
  context,
) => <TimelineLeftBrowser browser={context.leftBrowser} />;
