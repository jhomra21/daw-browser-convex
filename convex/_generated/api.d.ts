/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as chat from "../chat.js";
import type * as clips from "../clips.js";
import type * as effects from "../effects.js";
import type * as exports from "../exports.js";
import type * as ownerships from "../ownerships.js";
import type * as projects from "../projects.js";
import type * as samples from "../samples.js";
import type * as sharedChat from "../sharedChat.js";
import type * as timeline from "../timeline.js";
import type * as tracks from "../tracks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

/**
 * A utility for referencing Convex functions in your app's API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  clips: typeof clips;
  effects: typeof effects;
  exports: typeof exports;
  ownerships: typeof ownerships;
  projects: typeof projects;
  samples: typeof samples;
  sharedChat: typeof sharedChat;
  timeline: typeof timeline;
  tracks: typeof tracks;
}>;
declare const fullApiWithMounts: typeof fullApi;

export declare const api: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "public">
>;
export declare const internal: FilterApi<
  typeof fullApiWithMounts,
  FunctionReference<any, "internal">
>;

export declare const components: {};
