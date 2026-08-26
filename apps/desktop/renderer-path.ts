import path from "node:path"

export const packagedRendererRoot = (appPath: string) => path.join(appPath, ".vite", "renderer", "main_window")

export const rendererAssetPath = (rendererRoot: string, requestUrl: string) => {
  let relative: string
  try {
    relative = decodeURIComponent(new URL(requestUrl).pathname)
  } catch {
    return undefined
  }
  const root = path.resolve(rendererRoot)
  const safePath = path.resolve(root, `.${relative === "/" ? "/index.html" : relative}`)
  return safePath !== root && safePath.startsWith(`${root}${path.sep}`) ? safePath : undefined
}
