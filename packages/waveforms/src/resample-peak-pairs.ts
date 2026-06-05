export function resamplePeakPairs(source: Uint8Array, targetBins: number) {
  const normalizedTargetBins = Math.max(1, Math.floor(targetBins))
  const sourceBins = Math.max(1, Math.floor(source.length / 2))
  if (sourceBins === normalizedTargetBins) return source

  const output = new Uint8Array(normalizedTargetBins * 2)
  const ratio = sourceBins / normalizedTargetBins
  for (let index = 0; index < normalizedTargetBins; index++) {
    const start = Math.floor(index * ratio)
    const end = Math.max(start + 1, Math.min(sourceBins, Math.ceil((index + 1) * ratio)))
    let min = 255
    let max = 0
    for (let sourceIndex = start; sourceIndex < end; sourceIndex++) {
      const sourceMin = source[sourceIndex * 2]
      const sourceMax = source[sourceIndex * 2 + 1]
      if (sourceMin < min) min = sourceMin
      if (sourceMax > max) max = sourceMax
    }
    output[index * 2] = min
    output[index * 2 + 1] = max
  }

  return output
}
