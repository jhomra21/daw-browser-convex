/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import type * as clips from "../clips.js";
import type * as effects from "../effects.js";
import type * as projects from "../projects.js";
import type * as samples from "../samples.js";
import type * as timeline from "../timeline.js";
import type * as tracks from "../tracks.js";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  clips: typeof clips;
  effects: typeof effects;
  projects: typeof projects;
  samples: typeof samples;
  timeline: typeof timeline;
  tracks: typeof tracks;
}>;
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;
