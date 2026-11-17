export const registerRendererNavigationCommit = (
  webContents: {
    on: (event: "did-navigate", listener: (event: { preventDefault: () => void; readonly defaultPrevented: boolean }, url: string) => void) => void
  },
  commit: (url: string) => void,
) => {
  webContents.on("did-navigate", (_event, url) => commit(url))
}
