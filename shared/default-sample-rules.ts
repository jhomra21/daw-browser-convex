const DEFAULT_SAMPLE_ASSET_PREFIX = 'asset:default:'

export function toDefaultSampleAssetKey(key: string) {
  return `${DEFAULT_SAMPLE_ASSET_PREFIX}${key}`
}

export function defaultSampleUrl(key: string) {
  return key ? `/api/default-sample?key=${encodeURIComponent(key)}` : undefined
}

export function defaultSampleKeyFromAssetKey(assetKey: string | undefined) {
  return typeof assetKey === 'string' && assetKey.startsWith(DEFAULT_SAMPLE_ASSET_PREFIX)
    ? assetKey.slice(DEFAULT_SAMPLE_ASSET_PREFIX.length)
    : undefined
}
