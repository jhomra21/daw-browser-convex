const localWorkerOrigin = "http://localhost:3000"

export const createContentSecurityPolicy = (isDevelopment: boolean) => {
  const localWorkerSource = isDevelopment ? ` ${localWorkerOrigin}` : ""
  return `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob: https:${localWorkerSource}; connect-src 'self' https: wss:${localWorkerSource}; worker-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`
}
