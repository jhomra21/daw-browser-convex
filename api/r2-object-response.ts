export const createR2ObjectResponse = (
  object: R2ObjectBody,
  cacheControl: string,
) => {
  const headers = new Headers()
  headers.set('Content-Type', object.httpMetadata?.contentType || 'application/octet-stream')
  headers.set('Cache-Control', cacheControl)
  headers.set('Access-Control-Allow-Origin', '*')
  headers.set('Accept-Ranges', 'bytes')
  if (object.httpMetadata?.contentDisposition) {
    headers.set('Content-Disposition', object.httpMetadata.contentDisposition)
  }
  if (object.range) {
    const start = "suffix" in object.range ? object.size - object.range.suffix : object.range.offset ?? 0
    const length = "suffix" in object.range ? object.range.suffix : object.range.length ?? object.size - start
    headers.set('Content-Range', `bytes ${start}-${start + length - 1}/${object.size}`)
    headers.set('Content-Length', String(length))
    return new Response(object.body, { status: 206, headers })
  }
  headers.set('Content-Length', String(object.size))
  return new Response(object.body, { headers })
}
