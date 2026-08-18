import { ConvexClient } from "convex/browser";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createEffect, onCleanup, untrack } from "solid-js";
import { z } from "zod";

import { api } from "../../convex/_generated/api";
import type {
  FunctionReference,
  FunctionArgs,
} from "convex/server";

const convexUrl = z.string().min(1).parse(import.meta.env.VITE_CONVEX_URL);
const convex = new ConvexClient(convexUrl);
let convexAuthConfigured = false;
const convexAccessTokenSchema = z.object({ token: z.string() });

const fetchConvexAccessToken = async () => {
  let response: Response;
  try {
    response = await fetch('/api/convex-auth/token', { credentials: 'include' });
  } catch {
    if (import.meta.env.VITE_DESKTOP) return null;
    throw new Error('Failed to fetch Convex auth token');
  }
  if (response.status === 401) return null;
  if (!response.ok) {
    if (import.meta.env.VITE_DESKTOP) return null;
    throw new Error('Failed to fetch Convex auth token');
  }
  const body = convexAccessTokenSchema.safeParse(await response.json());
  return body.success ? body.data.token : null;
};

const configureConvexAuth = () => {
  if (convexAuthConfigured) return;
  convexAuthConfigured = true;
  convex.setAuth(fetchConvexAccessToken);
};

if (globalThis.window) {
  configureConvexAuth();
}

// Type-safe Convex query hook using TanStack Query with real-time subscriptions
export function useConvexQuery<
  Query extends FunctionReference<"query">,
>(
  query: Query,
  args: () => FunctionArgs<Query> | null | undefined,
  queryKey: () => (string | number | boolean | null | undefined)[],
) {
  const queryClient = useQueryClient();

  const tanstackQuery = useQuery(() => ({
    queryKey: ['convex', ...queryKey()],
    queryFn: async () => {
      const currentArgs = args();
      if (currentArgs === null || currentArgs === undefined) {
        throw new Error('Query args are null or undefined');
      }
      return await convex.query(query, currentArgs);
    },
    enabled: () => {
      const currentArgs = args();
      return currentArgs !== null && currentArgs !== undefined;
    },
    staleTime: 1000 * 60 * 5, // 5 minutes - we rely on real-time invalidation
    refetchOnWindowFocus: false, // Rely on real-time updates instead
    refetchOnReconnect: true, // Refetch when connection is restored
  }));

  // Set up Convex real-time subscription to invalidate TanStack Query cache
  createEffect(() => {
    const currentArgs = args();
    if (currentArgs === null || currentArgs === undefined) {
      return;
    }

    let unsubscribe: (() => void) | undefined;

    try {
      unsubscribe = convex.onUpdate(
        query,
        currentArgs,
        (newData) => {
          // Update TanStack Query cache with new data from Convex
          // Wrap in untrack to avoid Solid tracking these writes and re-running this effect
          untrack(() => {
            queryClient.setQueryData(['convex', ...queryKey()], newData);
          });
        },
        (error: Error) => {
          // Handle subscription errors by invalidating the query
          console.warn('Convex subscription error:', error);
          untrack(() => {
            queryClient.invalidateQueries({ queryKey: ['convex', ...queryKey()] });
          });
        }
      );
    } catch (error) {
      console.warn('Failed to set up Convex subscription:', error);
    }

    onCleanup(() => {
      if (unsubscribe) {
        try {
          unsubscribe();
        } catch (error) {
          console.warn('Failed to cleanup Convex subscription:', error);
        }
      }
    });
  });

  return tanstackQuery;
}

// Direct access to Convex client for advanced use cases
export const convexClient = convex;
export const convexApi = api;
