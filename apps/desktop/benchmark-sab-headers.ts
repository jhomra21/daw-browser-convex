// Cross-origin isolation is scoped to the disposable packaged benchmark.
export const benchmarkSabHeaders = (url: string, enabled: boolean): Record<string, string[]> => (
  enabled && new URL(url).protocol === 'daw:' && new URL(url).hostname === 'app'
    ? {
        'Cross-Origin-Opener-Policy': ['same-origin'],
        'Cross-Origin-Embedder-Policy': ['require-corp'],
      }
    : {}
)
