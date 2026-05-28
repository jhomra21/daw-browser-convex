import type { Context, Hono } from 'hono'
import type { Session } from './auth'

export type Variables = {
  user: Session['user'] | null;
  session: Session['session'] | null;
}

export type ApiBindings = {
  Bindings: Env;
  Variables: Variables;
}

export type ApiContext = Context<ApiBindings>
export type App = Hono<ApiBindings>
