import type { DesktopBridge } from "./desktop-bridge"

declare global {
  // Declaration merging requires an interface for the DOM Window surface.
  // oxlint-disable-next-line typescript/consistent-type-definitions
  interface Window {
    dawDesktop?: DesktopBridge
  }
}
