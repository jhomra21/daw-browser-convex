export const executeNativeEditorRoute = <Result>(routes: {
  isolated: (() => Promise<Result>) | undefined
  playback: (() => Promise<Result>) | undefined
}) => {
  if (routes.isolated) return routes.isolated()
  if (routes.playback) return routes.playback()
  return Promise.resolve(undefined)
}
