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

export const utilityWorklet = {
  processorName: 'daw-utility-processor',
  modulePath: 'audio-worklets/daw-utility-processor-v1.js',
}

export const autoFilterWorklet = {
  processorName: 'daw-autofilter-processor',
  modulePath: 'audio-worklets/daw-autofilter-processor-v1.js',
}

export const gateWorklet = {
  processorName: 'daw-gate-processor',
  modulePath: 'audio-worklets/daw-gate-processor-v1.js',
}

export const limiterWorklet = {
  processorName: 'daw-limiter-processor',
  modulePath: 'audio-worklets/daw-limiter-processor-v1.js',
}

export const loFiWorklet = {
  processorName: 'daw-lofi-processor',
  modulePath: 'audio-worklets/daw-lofi-processor-v1.js',
}

export const modulationWorklet = {
  processorName: 'daw-modulation-processor',
  modulePath: 'audio-worklets/daw-modulation-processor-v1.js',
}

export function resolveWorkletModuleUrl(modulePath: string, baseUrl = import.meta.env.BASE_URL ?? '/'): string {
  const normalizedBase = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`
  return `${normalizedBase}${modulePath}`
}
