import { QueryClient } from '@tanstack/solid-query'

// Centralized QueryClient so routes and components share the same cache
export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 1000 * 60 * 15, // 15 minutes
      refetchOnWindowFocus: false,
      retry: false,
    },
  },
})
