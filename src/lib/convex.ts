import { ConvexClient } from "convex/browser";
import { useQuery, useQueryClient } from "@tanstack/solid-query";
import { createEffect, onCleanup, untrack } from "solid-js";

import { api } from "../../convex/_generated/api";
import type {
  FunctionReference,
  FunctionArgs,
} from "convex/server";

const convex = new ConvexClient(import.meta.env.VITE_CONVEX_URL as string);
let convexAuthConfigured = false;

const fetchConvexAccessToken = async () => {
  const response = await fetch('/api/convex-auth/token', { credentials: 'include' });
  if (response.status === 401) return null;
  if (!response.ok) throw new Error('Failed to fetch Convex auth token');
  const body: unknown = await response.json();
  if (!body || typeof body !== 'object' || !('token' in body) || typeof body.token !== 'string') {
    return null;
  }
  return body.token;
};

const configureConvexAuth = () => {
  if (convexAuthConfigured) return;
  convexAuthConfigured = true;
  convex.setAuth(fetchConvexAccessToken);
};

if (typeof window !== 'undefined') {
  configureConvexAuth();
}

// Type-safe Convex query hook using TanStack Query with real-time subscriptions
export function useConvexQuery<
  Query extends FunctionReference<"query", "public", any, any>,
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
      return await convex.query(query as any, currentArgs as any);
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
        query as any,
        currentArgs as any,
        (newData: any) => {
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
