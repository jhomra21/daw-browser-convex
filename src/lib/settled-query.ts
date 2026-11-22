import { merge } from 'solid-js'
import type { UseQueryResult } from '@tanstack/solid-query'

export type SettledQueryResult<TData, TError> = Omit<UseQueryResult<TData, TError>, 'data'> & {
  readonly data: TData | undefined
}

// Query 6 `data` is an async read that suspends into the nearest <Loading> while a query is
// pending or disabled. Callers here read it from plain memos and effects, so expose it as
// `undefined` until a value exists, as Query 5 did.
export const withSettledData = <TData, TError>(
  query: UseQueryResult<TData, TError>,
): SettledQueryResult<TData, TError> =>
  merge(query, {
    get data(): TData | undefined {
      return query.isPending || query.isLoadingError ? undefined : query.data
    },
  })
