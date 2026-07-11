import type { RecordingCalibration } from "./recording-preferences"

type CalibrationIdentityInput = {
  inputDeviceId: string
  outputDeviceId: string
  sampleRate: number
  platform: string
  userAgent?: string
  userAgentData?: {
    platform: string
    brands: readonly { brand: string; version: string }[]
  }
}

const unstableDeviceIds = new Set(["", "default", "communications"])

type NavigatorIdentitySource = {
  platform: string
  userAgent: string
  userAgentData?: {
    platform: string
    brands: readonly { brand: string; version: string }[]
    getHighEntropyValues?: (hints: readonly string[]) => Promise<{ platformVersion?: string }>
  }
}

const browserIdentityFromBrands = (brands: readonly { brand: string; version: string }[]): string | null => {
  const browser = brands.find((brand) => brand.brand === "Microsoft Edge")
    ?? brands.find((brand) => brand.brand === "Google Chrome")
    ?? brands.find((brand) => brand.brand === "Chromium")
  const major = browser?.version.split(".")[0]
  return browser && major && /^\d+$/.test(major) ? `${browser.brand}:${major}` : null
}

const browserIdentityFromUserAgent = (userAgent: string): string | null => {
  const match = userAgent.match(/(?:Edg|Chrome|CriOS|Firefox|FxiOS|Version)\/(\d+)/)
  if (!match?.[1]) return null
  const family = userAgent.includes("Edg/") ? "Microsoft Edge"
    : userAgent.includes("Firefox/") || userAgent.includes("FxiOS/") ? "Firefox"
    : userAgent.includes("Chrome/") || userAgent.includes("CriOS/") ? "Google Chrome"
    : userAgent.includes("Safari/") ? "Safari"
    : null
  return family ? `${family}:${match[1]}` : null
}

const osFamily = (platform: string, userAgent = ""): string | null => {
  const value = `${platform} ${userAgent}`
  if (/android/i.test(value)) return "Android"
  if (/iphone|ipad|ipod|ios/i.test(value)) return "iOS"
  if (/mac/i.test(value)) return "macOS"
  if (/win/i.test(value)) return "Windows"
  if (/linux|cros/i.test(value)) return /cros/i.test(value) ? "Chrome OS" : "Linux"
  return null
}

const createCalibrationPlatformIdentity = (
  input: Pick<CalibrationIdentityInput, "platform" | "userAgentData"> & { userAgent?: string },
): string | null => {
  const platform = input.userAgentData?.platform || input.platform
  const browser = input.userAgentData
    ? browserIdentityFromBrands(input.userAgentData.brands)
    : browserIdentityFromUserAgent(input.userAgent ?? "")
  const os = osFamily(platform, input.userAgent)
  return browser && os ? `${browser}:${os}` : null
}

export const resolveCalibrationPlatformIdentity = async (
  source: NavigatorIdentitySource,
): Promise<string | null> => {
  if (source.userAgentData?.getHighEntropyValues) {
    await source.userAgentData.getHighEntropyValues(["platformVersion"]).catch(() => undefined)
  }
  return createCalibrationPlatformIdentity(source)
}

const createCalibrationIdentity = (input: CalibrationIdentityInput): string | null => {
  if (
    unstableDeviceIds.has(input.inputDeviceId) ||
    unstableDeviceIds.has(input.outputDeviceId) ||
    !Number.isSafeInteger(input.sampleRate) ||
    input.sampleRate <= 0
  ) return null
  const platformIdentity = createCalibrationPlatformIdentity(input)
  return platformIdentity
    ? `${input.inputDeviceId}\n${input.outputDeviceId}\n${input.sampleRate}\n${platformIdentity}`
    : null
}

export const findExactCalibration = (
  calibrations: readonly RecordingCalibration[],
  input: CalibrationIdentityInput,
): RecordingCalibration | null => {
  const identity = createCalibrationIdentity(input)
  if (!identity) return null
  return calibrations.find((calibration) =>
    `${calibration.inputDeviceId}\n${calibration.outputDeviceId}\n${calibration.sampleRate}\n${calibration.platformIdentity}` === identity
  ) ?? null
}

export const replaceExactCalibration = (
  calibrations: readonly RecordingCalibration[],
  calibration: RecordingCalibration,
): RecordingCalibration[] => [
  calibration,
  ...calibrations.filter((candidate) =>
    candidate.inputDeviceId !== calibration.inputDeviceId ||
    candidate.outputDeviceId !== calibration.outputDeviceId ||
    candidate.sampleRate !== calibration.sampleRate ||
    candidate.platformIdentity !== calibration.platformIdentity
  ),
].sort((left, right) => right.createdAtMs - left.createdAtMs).slice(0, 32)

export const resolveRecordingOffsetFrames = (
  calibrations: readonly RecordingCalibration[],
  input: CalibrationIdentityInput,
  manualOffsetFrames: number,
): { frames: number; reusable: boolean } => {
  const calibration = findExactCalibration(calibrations, input)
  return calibration
    ? { frames: calibration.recordingOffsetFrames, reusable: true }
    : { frames: manualOffsetFrames, reusable: false }
}
