import { expect, test } from 'bun:test'
import { convexTest } from 'convex-test'
import { dispatchControlOperation } from '@daw-browser/control'
import { createCloudControlHandlers } from './control-handler'
import {
  normalizeControlError,
  runControlConformance,
} from '../src/lib/test/control-conformance'
import { api } from '../convex/_generated/api'
import schema from '../convex/schema'

const modules = {
  './_generated/api.ts': () => import('../convex/_generated/api'),
  './control.ts': () => import('../convex/control'),
  './controlProjection.ts': () => import('../convex/controlProjection'),
  './controlSnapshot.ts': () => import('../convex/controlSnapshot'),
  './controlPreflight.ts': () => import('../convex/controlPreflight'),
  './controlExecution.ts': () => import('../convex/controlExecution'),
  './controlRecovery.ts': () => import('../convex/controlRecovery'),
  './projects.ts': () => import('../convex/projects'),
  './projectAccess.ts': () => import('../convex/projectAccess'),
  './projectRows.ts': () => import('../convex/projectRows'),
  './r2Deletes.ts': () => import('../convex/r2Deletes'),
}

test('cloud canonical handlers conform to the control operation contract', async () => {
  const owner = 'cloud-conformance-user'
  const projectId = `cloud-conformance-${crypto.randomUUID()}`
  const convex = convexTest(schema, modules)
  await convex.withIdentity({ subject: owner }).mutation(api.projects.createOwnedRoom, { projectId })
  const trackId = await convex.run(async (ctx) => {
    const track = await ctx.db.insert('tracks', {
      projectId,
      name: 'Conformance track',
      index: 0,
      kind: 'audio',
    })
    await ctx.db.insert('mixerChannels', {
      projectId,
      trackId: track,
      volume: 0.8,
      channelRole: 'track',
      sends: [],
    })
    await ctx.db.insert('ownerships', { projectId, ownerUserId: owner, trackId: track })
    return track
  })
  const gateway = {
    query: (reference: unknown, args: unknown) => (
      convex.withIdentity({ subject: owner }).query(reference, args)
    ),
    mutation: (reference: unknown, args: unknown) => (
      convex.withIdentity({ subject: owner }).mutation(reference, args)
    ),
  }
  const handlers = createCloudControlHandlers({ gateway })
  const invoke = async (operation: string, input: unknown, target: 'cloud' | 'desktop') => {
    try {
      return await dispatchControlOperation(
        handlers,
        operation,
        input,
        { target, principal: { subject: 'untrusted-request-subject' } },
      )
    } catch (error) {
      throw normalizeControlError(error) ?? error
    }
  }
  await runControlConformance({
    invoke,
    projectId,
    target: 'cloud',
    missingProjectErrorCode: 'forbidden',
    destructiveRequest: {
      version: 'v1',
      projectId,
      actions: [{ kind: 'track.delete', track: { source: 'persisted', id: String(trackId) } }],
    },
  })
  await expect(invoke('project.current', {}, 'cloud')).rejects.toThrow()
})
