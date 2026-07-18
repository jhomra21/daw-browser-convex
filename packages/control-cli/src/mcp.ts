#!/usr/bin/env bun
import { startControlMcp } from "./server"

try {
  await startControlMcp()
} catch {
  process.stderr.write(`${JSON.stringify({
    version: "v1",
    ok: false,
    command: "mcp",
    error: { version: "v1", code: "authorization", message: "Unable to start control MCP." },
  })}\n`)
  process.exitCode = 1
}
