import 'fake-indexeddb/auto'
import { test } from 'bun:test'
import {
  canonicalProjectSnapshotSchema,
  dispatchControlOperation,
  type ControlOperationTarget,
} from '@daw-browser/control'
import { createLocalProject } from '~/lib/local-project-db'
import { createLocalControlHandlers } from './local-control-handlers'
import {
  normalizeControlError,
  runControlConformance,
} from '../test/control-conformance'

test('local canonical handlers conform to the control operation contract', async () => {
  const project = await createLocalProject(`Handler conformance ${crypto.randomUUID()}`)
  const handlers = createLocalControlHandlers({
    projectId: project.id,
    actor: { subject: 'local:conformance-user' },
  })
  const invoke = async (operation: string, input: unknown, target: ControlOperationTarget) => {
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
  const initial = await invoke('control.snapshot', { projectId: project.id }, 'desktop')
  const track = canonicalProjectSnapshotSchema.parse(initial).tracks[0]
  if (!track) throw new Error('Expected the local fixture to contain a track.')
  await runControlConformance({
    invoke,
    projectId: project.id,
    target: 'desktop',
    missingProjectErrorCode: 'invalid-request',
    destructiveRequest: {
      version: 'v1',
      projectId: project.id,
      actions: [{ kind: 'track.delete', track: { source: 'persisted', id: track.id } }],
    },
  })
})
