export const compressorWorklet = {
  processorName: 'daw-compressor-processor',
  modulePath: 'audio-worklets/daw-compressor-processor-v1.js',
}

export const trackMeterWorklet = {
  processorName: 'track-meter-processor',
  modulePath: 'audio-worklets/track-meter-processor-v1.js',
}

export const recorderWorklet = {
  processorName: 'daw-recorder-processor',
  modulePath: 'audio-worklets/daw-recorder-processor-v1.js',
}

export function resolveWorkletModuleUrl(modulePath: string, baseUrl = import.meta.env.BASE_URL ?? '/'): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBase}${modulePath}`
}
