/** The principal and JWT claim names the API worker mints and the Convex functions read. */
export const WORKER_USER_ID = 'daw-worker'

export const convexIdentityClaims = {
  worker: 'dawWorker',
  actorIssuer: 'dawControlActorIssuer',
  actorTokenIdentifier: 'dawControlActorTokenIdentifier',
} as const
