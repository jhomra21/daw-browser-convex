import type { AudioEffectRuntimeInstance } from './runtime-instance'
import { PROCESSOR_RESOURCE_LIMITS } from './processor-release-contract'
import type { StaticWorkletKind } from './static-worklet-chain'

type ReservationState = {
  id: number
  count: number
}

export type LiveWorkletReservation = {
  owner: string
  id: number
  previous: ReservationState | undefined
}

export const isStaticWorkletKind = (kind: AudioEffectRuntimeInstance['kind']): kind is StaticWorkletKind =>
  kind === 'utility' || kind === 'autofilter' || kind === 'gate' || kind === 'limiter' || kind === 'lofi' ||
  kind === 'chorus' || kind === 'flanger' || kind === 'phaser' || kind === 'tremolo' || kind === 'autopan' || kind === 'ensemble' ||
  kind === 'spectral'

export const countStaticWorklets = (instances: readonly AudioEffectRuntimeInstance[]) =>
  instances.filter((instance) => isStaticWorkletKind(instance.kind)).length

export function createLiveWorkletBudget(limit: number = PROCESSOR_RESOURCE_LIMITS.liveOwnedWorklets) {
  const reservations = new Map<string, ReservationState>()
  let nextId = 0

  const reservedCount = () => [...reservations.values()].reduce((count, reservation) => count + reservation.count, 0)

  return {
    reserve: (owner: string, count: number): LiveWorkletReservation => {
      const previous = reservations.get(owner)
      if (reservedCount() - (previous?.count ?? 0) + count > limit) {
        throw new Error(`Live processing is limited to ${limit} static worklets.`)
      }
      const reservation = { owner, id: ++nextId, previous }
      reservations.set(owner, { id: reservation.id, count })
      return reservation
    },
    rollback: (reservation: LiveWorkletReservation) => {
      if (reservations.get(reservation.owner)?.id !== reservation.id) return
      if (reservation.previous) reservations.set(reservation.owner, reservation.previous)
      else reservations.delete(reservation.owner)
    },
    releaseOwner: (owner: string) => {
      reservations.delete(owner)
    },
    reservedCount,
  }
}
