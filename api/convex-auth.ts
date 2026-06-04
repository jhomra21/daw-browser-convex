import { importJWK, SignJWT } from 'jose'
import type { ApiContext, App } from './app-types'
import type { Session } from './auth'

const algorithm = 'ES256'
const keyId = 'daw-browser-convex-auth'
const defaultAudience = 'daw-browser-convex'
const tokenTtlSeconds = 60 * 60

type ConvexAuthEnv = {
  CONVEX_AUTH_PRIVATE_JWK?: string;
  CONVEX_AUTH_ISSUER?: string;
  BETTER_AUTH_URL?: string;
}

type ConvexAuthUser = Pick<Session['user'], 'id' | 'email' | 'name'> & {
  image?: Session['user']['image']
}

const maintenanceWorkerUser: ConvexAuthUser = {
  id: 'daw-worker',
  email: 'worker@daw-browser-convex.local',
  name: 'DAW Worker',
}

const readEnv = (c: ApiContext): ConvexAuthEnv => c.env

const readIssuer = (c: ApiContext) => {
  const env = readEnv(c)
  const baseUrl = env.CONVEX_AUTH_ISSUER ?? (env.BETTER_AUTH_URL ? `${env.BETTER_AUTH_URL}/api/convex-auth` : null)
  return baseUrl ?? `${new URL(c.req.url).origin}/api/convex-auth`
}

const readPrivateJwk = (c: ApiContext) => {
  const raw = readEnv(c).CONVEX_AUTH_PRIVATE_JWK
  if (!raw) throw new Error('Convex auth private key is not configured.')
  return JSON.parse(raw)
}

const readJwks = async (c: ApiContext) => {
  const privateJwk = readPrivateJwk(c)
  const publicJwk = {
    kty: privateJwk.kty,
    crv: privateJwk.crv,
    x: privateJwk.x,
    y: privateJwk.y,
  }
  return { keys: [{ ...publicJwk, kid: keyId, alg: algorithm, use: 'sig' }] }
}

const issueConvexAuthToken = async (
  c: ApiContext,
  user: ConvexAuthUser,
  options?: { worker?: boolean },
) => {
  const now = Math.floor(Date.now() / 1000)
  const privateKey = await importJWK(readPrivateJwk(c), algorithm)
  return await new SignJWT({
    email: user.email,
    name: user.name,
    picture: user.image,
    dawWorker: options?.worker ? true : undefined,
  })
    .setProtectedHeader({ alg: algorithm, kid: keyId, typ: 'JWT' })
    .setIssuer(readIssuer(c))
    .setAudience(defaultAudience)
    .setSubject(user.id)
    .setIssuedAt(now)
    .setExpirationTime(now + tokenTtlSeconds)
    .sign(privateKey)
}

const createConvexClientWithAuth = async (
  c: ApiContext,
  user: ConvexAuthUser,
  options?: { worker?: boolean },
) => {
  const { ConvexHttpClient } = await import('convex/browser')
  const convex = new ConvexHttpClient(c.env.VITE_CONVEX_URL)
  convex.setAuth(await issueConvexAuthToken(c, user, options))
  return convex
}

export const createAuthenticatedConvexClient = async (c: ApiContext, user: Session['user']) => (
  createConvexClientWithAuth(c, user)
)

export const createWorkerConvexClient = async (c: ApiContext, user: Session['user']) => (
  createConvexClientWithAuth(c, user, { worker: true })
)

export const createMaintenanceWorkerConvexClient = async (c: ApiContext) => (
  createConvexClientWithAuth(c, maintenanceWorkerUser, { worker: true })
)

export function registerConvexAuthRoutes(app: App) {
  app.get('/api/convex-auth/.well-known/jwks.json', async (c) => {
    try {
      return c.json(await readJwks(c))
    } catch (error) {
      console.error('Convex JWKS error', error)
      return c.json({ error: 'Convex auth is not configured.' }, 500)
    }
  })

  app.get('/api/convex-auth/token', async (c) => {
    try {
      const user = c.get('user')
      if (!user) return c.json({ token: null }, 401)
      const token = await issueConvexAuthToken(c, user)
      return c.json({ token })
    } catch (error) {
      console.error('Convex token error', error)
      return c.json({ error: 'Failed to issue Convex auth token.' }, 500)
    }
  })
}
