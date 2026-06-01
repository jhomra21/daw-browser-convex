export const createR2ObjectResponse = (
  object: R2ObjectBody,
  key: string,
  cacheControl: string,
) => {
  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('Access-Control-Allow-Origin', '*')
  if (object.httpMetadata?.contentDisposition) {
    headers.set('Content-Disposition', object.httpMetadata.contentDisposition)
  }
  headers.set('X-R2-Key', key)
  return new Response(object.body, { headers })
}
