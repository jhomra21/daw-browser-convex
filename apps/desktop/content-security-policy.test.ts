import { describe, expect, test } from "bun:test"
import { createContentSecurityPolicy } from "./content-security-policy"

describe("desktop content security policy", () => {
  test("allows the local Worker only during development", () => {
    const policy = createContentSecurityPolicy(true)

    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(policy).not.toContain("'unsafe-eval'")
    expect(policy).toContain("media-src 'self' blob: https: http://localhost:3000")
    expect(policy).toContain("connect-src 'self' https: wss: http://localhost:3000")
    expect(policy).not.toMatch(/\bhttp:(?!\/\/localhost:3000)/)
  })

  test("supports HTTPS media without allowing HTTP origins in packaged builds", () => {
    const policy = createContentSecurityPolicy(false)

    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'")
    expect(policy).toContain("media-src 'self' blob: https:")
    expect(policy).toContain("connect-src 'self' https: wss:")
    expect(policy).not.toContain("http:")
  })
})
