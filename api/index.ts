import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createAuth } from './auth'
import type { ApiBindings } from './app-types'
import { registerConvexAuthRoutes } from './convex-auth'
import { registerAgentRoutes } from './routes/agent'
import { registerCloudBackupRoutes } from './routes/cloud-backups'
import { registerExportRoutes } from './routes/exports'
import { registerSampleRoutes } from './routes/samples'
import { registerShareInviteRoutes } from './routes/share-invites'
import { registerTimelineOperationRoutes } from './routes/timeline-operations'

const app = new Hono<ApiBindings>()

// CORS middleware must be registered before routes
app.use('/api/auth/*', cors({
  origin: (origin) => origin || '*', // Allow all origins for now, restrict in production
  allowHeaders: ['Content-Type', 'Authorization'],
  allowMethods: ['POST', 'GET', 'OPTIONS'],
  exposeHeaders: ['Content-Length'],
  maxAge: 600,
  credentials: true,
}));

// Session middleware - adds user and session to context
app.use('*', async (c, next) => {
  // Skip auth middleware for auth routes to avoid circular calls
  if (c.req.path.startsWith('/api/auth/')) {
    return next();
  }

  try {
    const auth = createAuth(c.env);
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) {
      c.set('user', null);
      c.set('session', null);
    } else {
      c.set('user', session.user);
      c.set('session', session.session);
    }
  } catch (error) {
    console.error('Session middleware error:', error);
    c.set('user', null);
    c.set('session', null);
  }

  return next();
});

// Better Auth routes - use on() method as recommended
app.on(['POST', 'GET'], '/api/auth/*', async (c) => {
  const auth = createAuth(c.env);
  return auth.handler(c.req.raw);
});

// Session endpoint to check current user
app.get('/api/session', (c) => {
  const session = c.get('session');
  const user = c.get('user');

  if (!user) {
    return c.json({ user: null, session: null }, 200);
  }

  return c.json({ session, user });
})


registerShareInviteRoutes(app)
registerConvexAuthRoutes(app)
registerAgentRoutes(app)
// Protected route example
app.get('/api/protected', (c) => {
  const user = c.get('user');

  if (!user) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return c.json({ message: 'This is a protected route', user });
})


registerSampleRoutes(app)
registerCloudBackupRoutes(app)
registerExportRoutes(app)
registerTimelineOperationRoutes(app)

export default app
