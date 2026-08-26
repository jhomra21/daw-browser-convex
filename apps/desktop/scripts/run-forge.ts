import { spawnSync } from "node:child_process"
import { accessSync, constants } from "node:fs"
import path from "node:path"

const forgeCli = path.resolve(import.meta.dirname, "../../../node_modules/@electron-forge/cli/dist/electron-forge.js")
const affectedNodeVersion = (version: string) => {
  const [majorText, minorText] = version.split(".")
  const major = Number(majorText)
  const minor = Number(minorText)
  return major >= 26 || (major === 24 && minor >= 16)
}
const nodeCandidates = () => {
  const configured = process.env.DAW_FORGE_NODE
  if (configured) return [configured]
  const fromPath = (process.env.PATH ?? "").split(path.delimiter).map((directory) => path.join(directory, "node"))
  return [...fromPath, "/usr/local/bin/node", "/opt/homebrew/bin/node"]
}
const forgeNode = nodeCandidates().find((candidate) => {
  try {
    accessSync(candidate, constants.X_OK)
  } catch {
    return false
  }
  const result = spawnSync(candidate, ["--version"], { encoding: "utf8" })
  return result.status === 0 && !affectedNodeVersion(result.stdout.trim().replace(/^v/, ""))
})

if (!forgeNode) {
  console.error("Electron Forge packaging requires Node.js <24.16 or <26.1 because its ZIP extractor is incompatible with newer Node releases.")
  console.error("Install a supported Node.js runtime or set DAW_FORGE_NODE to its executable path.")
  process.exit(1)
}

const result = spawnSync(forgeNode, [forgeCli, ...process.argv.slice(2)], { stdio: "inherit" })
process.exit(result.status ?? 1)
