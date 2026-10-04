export const benchmarkStartupStage = (
  enabled: string | undefined,
  stage: "before-native-helper" | "after-native-helper" | "before-socket" | "after-socket" | "window-created" | "window-loaded" | "unexpected-window-loaded",
  log: (line: string) => void,
) => {
  if (enabled === "1") log(`[benchmark-startup] ${stage}`)
}

export const benchmarkLoadFailure = (
  enabled: string | undefined, code: number, _url: string, log: (line: string) => void,
) => {
  if (enabled === "1") log(`[benchmark-startup] load-failed code=${code}`)
}
