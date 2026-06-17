import type { Context, Hono } from 'hono'
import type { Session } from './auth'

export type Variables = {
  user: Session['user'] | null;
  session: Session['session'] | null;
}

type ApiEnv = Env & {
  AUTH_CORS_ORIGINS?: string;
  R2_DELETE_QUEUE_DRAIN_TOKEN?: string;
}

export type ApiBindings = {
  Bindings: ApiEnv;
  Variables: Variables;
}

export type ApiContext = Context<ApiBindings>
export type App = Hono<ApiBindings>
