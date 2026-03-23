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
import type * as clipWrites from "../clipWrites.js";
import type * as clips from "../clips.js";
import type * as effects from "../effects.js";
import type * as exports from "../exports.js";
import type * as mixerChannels from "../mixerChannels.js";
import type * as ownerships from "../ownerships.js";
import type * as projects from "../projects.js";
import type * as roomAccess from "../roomAccess.js";
import type * as sampleRows from "../sampleRows.js";
import type * as samples from "../samples.js";
import type * as sharedChat from "../sharedChat.js";
import type * as timeline from "../timeline.js";
import type * as trackRouting from "../trackRouting.js";
import type * as trackWrites from "../trackWrites.js";
import type * as tracks from "../tracks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  chat: typeof chat;
  clipWrites: typeof clipWrites;
  clips: typeof clips;
  effects: typeof effects;
  exports: typeof exports;
  mixerChannels: typeof mixerChannels;
  ownerships: typeof ownerships;
  projects: typeof projects;
  roomAccess: typeof roomAccess;
  sampleRows: typeof sampleRows;
  samples: typeof samples;
  sharedChat: typeof sharedChat;
  timeline: typeof timeline;
  trackRouting: typeof trackRouting;
  trackWrites: typeof trackWrites;
  tracks: typeof tracks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
