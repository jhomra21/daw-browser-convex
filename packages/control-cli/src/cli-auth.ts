import { canonicalJson } from "@daw-browser/control"
import { createCanonicalControlMethodsFromLegacy, createControlClient } from "@daw-browser/control-sdk"
import { createAccessTokenProvider, login, logout, normalizeBaseUrl } from "./auth"
import { credentialIdentity, createCredentialStore } from "./credentials"
import type { CliIo } from "./input"

const baseUrlFor = (arguments_: string[]) => {
  if (arguments_.length !== 0 && (arguments_.length !== 2 || arguments_[0] !== "--base-url")) {
    throw new Error("auth login accepts only --base-url <origin>.")
  }
  const explicit = arguments_.length === 2 ? arguments_[1] : undefined
  const configured = explicit ?? process.env.DAW_CONTROL_BASE_URL
  if (!configured) throw new Error("Provide --base-url.")
  return normalizeBaseUrl(configured)
}

export const cloudClient = async () => {
  const store = createCredentialStore()
  const credentials = await store.read()
  if (!credentials) throw new Error("Run daw-control auth login first.")
  return createControlClient({
    baseUrl: credentials.baseUrl,
    accessToken: createAccessTokenProvider(credentialIdentity(credentials), store),
  })
}

export const cloudCanonicalControlMethods = async () => (
  createCanonicalControlMethodsFromLegacy(await cloudClient())
)

export const runAuthCommand = async (command: string, arguments_: string[], io: CliIo) => {
  if (command === "auth login") {
    const store = createCredentialStore()
    const baseUrl = baseUrlFor(arguments_)
    await login(baseUrl, { store, writeStderr: io.stderr })
    io.stdout(canonicalJson({ version: "v1", ok: true, command, data: { baseUrl } }))
    return 0
  }
  if (command === "auth status") {
    if (arguments_.length !== 0) throw new Error("auth status accepts no arguments.")
    const credentials = await createCredentialStore().read()
    io.stdout(canonicalJson({
      version: "v1",
      ok: true,
      command,
      data: credentials
        ? { authenticated: true, baseUrl: credentials.baseUrl, expiresAt: credentials.expiresAt, scopes: credentials.scopes }
        : { authenticated: false },
    }))
    return 0
  }
  if (command === "auth logout") {
    if (arguments_.length !== 0) throw new Error("auth logout accepts no arguments.")
    const result = await logout(createCredentialStore())
    io.stdout(canonicalJson({ version: "v1", ok: true, command, data: result }))
    return 0
  }
  return undefined
}
