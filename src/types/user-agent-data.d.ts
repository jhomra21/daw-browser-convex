type NavigatorUserAgentData = {
  readonly platform: string
  readonly brands: readonly {
    readonly brand: string
    readonly version: string
  }[]
  readonly getHighEntropyValues?: (
    hints: readonly string[],
  ) => Promise<{ readonly platformVersion?: string }>
}

interface Navigator {
  readonly userAgentData?: NavigatorUserAgentData
}
