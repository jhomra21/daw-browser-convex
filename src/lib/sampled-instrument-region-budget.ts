type PhysicalRecord = {
  readonly physical: AudioBuffer
  readonly owners: Set<BudgetEntry>
  chargeBytes: number
}

type BudgetEntry = {
  bytes: number
  pins: number
  onEvict: () => void
  physical?: AudioBuffer
  record: PhysicalRecord | undefined
}

export type SampledInstrumentRegionReservation = {
  release: () => void
  commit: () => void
}

export type SampledInstrumentRegionPin = {
  release: () => void
}

export type SampledInstrumentBufferLeaseInput = {
  key: string
  buffer: AudioBuffer
  bytes: number
}

export type SampledInstrumentRegionLease = {
  release: () => void
}

export type SampledInstrumentRegionBudgetScope = {
  reserve: (key: string, bytes: number) => SampledInstrumentRegionReservation
  ensureCapacityFor: (requested: ReadonlyMap<string, number>) => void
  set: (key: string, bytes: number, onEvict: () => void, physical?: AudioBuffer) => void
  touch: (key: string) => void
  pin: (key: string) => SampledInstrumentRegionPin | undefined
  unpin: (pin: SampledInstrumentRegionPin) => void
  lease: (buffers: readonly SampledInstrumentBufferLeaseInput[]) => SampledInstrumentRegionLease
  isLeased: (buffer: AudioBuffer) => boolean
  release: () => void
}

export type SampledInstrumentRegionBudget = ReturnType<typeof createSampledInstrumentRegionBudget>

const RETIRED_KEY_MARKER = '\u0000retired\u0000'

const validateBudgetValue = (value: number, label: string) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} is invalid.`)
}

export function createSampledInstrumentRegionBudget(maxBytes: number) {
  validateBudgetValue(maxBytes, 'Sampled instrument aggregate decode budget')
  const entries = new Map<string, BudgetEntry>()
  const physicalRecords = new Map<AudioBuffer, PhysicalRecord>()
  const reservations = new Map<number, { key: string; bytes: number }>()
  const retiredAliases = new Map<string, string>()
  const pinEntries = new WeakMap<SampledInstrumentRegionPin, BudgetEntry>()
  let nextInternalId = 1
  let totalBytes = 0
  let disposed = false

  const assertTotalInvariant = () => {
    if (totalBytes < 0 || totalBytes > maxBytes) {
      throw new Error('Sampled instrument budget accounting invariant failed.')
    }
  }

  const reservedBytes = () => {
    let total = 0
    for (const reservation of reservations.values()) total += reservation.bytes
    if (!Number.isSafeInteger(total)) {
      throw new Error('Sampled instrument reserved byte count is outside the safe range.')
    }
    return total
  }

  const resolveKey = (key: string) => entries.has(key) ? key : retiredAliases.get(key) ?? key

  const recordCharge = (record: PhysicalRecord) => {
    let chargeBytes = 0
    for (const owner of record.owners) chargeBytes = Math.max(chargeBytes, owner.bytes)
    return chargeBytes
  }

  const refreshRecordCharge = (record: PhysicalRecord) => {
    const nextCharge = recordCharge(record)
    totalBytes += nextCharge - record.chargeBytes
    record.chargeBytes = nextCharge
    assertTotalInvariant()
  }

  const getOrCreatePhysicalRecord = (physical: AudioBuffer) => {
    const existing = physicalRecords.get(physical)
    if (existing) return existing
    const record: PhysicalRecord = { physical, owners: new Set(), chargeBytes: 0 }
    physicalRecords.set(physical, record)
    return record
  }

  const createEntry = (
    key: string,
    bytes: number,
    onEvict: () => void,
    physical: AudioBuffer | undefined,
    pins = 0,
  ) => {
    const record = physical ? getOrCreatePhysicalRecord(physical) : undefined
    const entry: BudgetEntry = { bytes, pins, onEvict, physical, record }
    entries.set(key, entry)
    record?.owners.add(entry)
    if (record) refreshRecordCharge(record)
    else {
      totalBytes += bytes
      assertTotalInvariant()
    }
    return entry
  }

  const removeEntry = (key: string, notify: boolean) => {
    const entry = entries.get(key)
    if (!entry) return
    entries.delete(key)
    for (const [alias, target] of retiredAliases) {
      if (target === key) retiredAliases.delete(alias)
    }
    if (entry.record) {
      entry.record.owners.delete(entry)
      refreshRecordCharge(entry.record)
      if (entry.record.owners.size === 0) physicalRecords.delete(entry.record.physical)
    } else {
      totalBytes -= entry.bytes
      assertTotalInvariant()
    }
    if (notify) entry.onEvict()
  }

  const findEntryKey = (entry: BudgetEntry) => {
    for (const [key, candidate] of entries) {
      if (candidate === entry) return key
    }
    return undefined
  }

  const retirePinnedEntry = (key: string, entry: BudgetEntry) => {
    const retiredKey = `${key}${RETIRED_KEY_MARKER}${nextInternalId}`
    nextInternalId += 1
    entries.delete(key)
    entries.set(retiredKey, entry)
    retiredAliases.set(key, retiredKey)
    entry.onEvict = () => undefined
    return retiredKey
  }

  const touch = (key: string, entry: BudgetEntry) => {
    entries.delete(key)
    entries.set(key, entry)
  }

  const evict = (protectedKeys: ReadonlySet<string>, additionalBytes = 0) => {
    while (totalBytes + reservedBytes() + additionalBytes > maxBytes) {
      const candidate = [...entries].find(([key, entry]) => entry.pins === 0 && !protectedKeys.has(key))
      if (!candidate) return
      removeEntry(candidate[0], true)
    }
  }

  const additionalBytesForRequest = (key: string, bytes: number) => {
    const existing = entries.get(key)
    return existing ? Math.max(0, bytes - existing.bytes) : bytes
  }

  const additionalBytesForReservation = (key: string, bytes: number) => {
    const existing = entries.get(key)
    if (!existing) return bytes
    return existing.pins > 0 ? bytes : Math.max(0, bytes - existing.bytes)
  }

  const ensureCapacity = (
    requested: ReadonlyMap<string, number>,
    protectedKeys: ReadonlySet<string> = new Set(),
  ) => {
    let additionalBytes = 0
    for (const [key, bytes] of requested) {
      validateBudgetValue(bytes, 'Sampled instrument region byte count')
      additionalBytes += additionalBytesForRequest(key, bytes)
    }
    if (!Number.isSafeInteger(additionalBytes)) {
      throw new Error('Sampled instrument aggregate byte count is outside the safe range.')
    }
    evict(protectedKeys, additionalBytes)
    while (totalBytes + reservedBytes() + additionalBytes > maxBytes) {
      const candidate = [...entries].find(([key, entry]) => (
        entry.pins === 0
        && !protectedKeys.has(key)
        && !requested.has(key)
      ))
      if (!candidate) throw new Error(`Sampled instrument regions exceed the ${maxBytes} byte aggregate limit.`)
      removeEntry(candidate[0], true)
      additionalBytes = 0
      for (const [key, bytes] of requested) additionalBytes += additionalBytesForRequest(key, bytes)
    }
  }

  const projectedSetTotal = (
    key: string,
    bytes: number,
    physical: AudioBuffer | undefined,
  ) => {
    const existing = entries.get(key)
    const keepExisting = existing !== undefined
      && existing.pins > 0
      && existing.physical !== physical
    const affected = new Set<PhysicalRecord>()
    if (existing?.record) affected.add(existing.record)
    const targetRecord = physical ? physicalRecords.get(physical) : undefined
    if (targetRecord) affected.add(targetRecord)
    let projected = totalBytes
    for (const record of affected) {
      let nextCharge = 0
      for (const owner of record.owners) {
        if (owner === existing && !keepExisting) continue
        nextCharge = Math.max(nextCharge, owner.bytes)
      }
      if (record === targetRecord) nextCharge = Math.max(nextCharge, bytes)
      projected += nextCharge - record.chargeBytes
    }
    if (existing && !keepExisting && !existing.record) projected -= existing.bytes
    if (!targetRecord) projected += bytes
    return projected
  }

  const ensureCapacityForSet = (
    key: string,
    bytes: number,
    physical: AudioBuffer | undefined,
  ) => {
    while (projectedSetTotal(key, bytes, physical) + reservedBytes() > maxBytes) {
      const candidate = [...entries].find(([candidateKey, entry]) => (
        candidateKey !== key && entry.pins === 0
      ))
      if (!candidate) throw new Error(`Sampled instrument regions exceed the ${maxBytes} byte aggregate limit.`)
      removeEntry(candidate[0], true)
    }
  }

  const pin = (key: string) => {
    key = resolveKey(key)
    const entry = entries.get(key)
    if (!entry) return undefined
    const token = createPin(entry)
    touch(key, entry)
    return token
  }

  const pinEntry = (entry: BudgetEntry) => {
    entry.pins += 1
  }

  const unpinEntry = (entry: BudgetEntry) => {
    if (entry.pins === 0) return
    entry.pins -= 1
    if (entry.pins === 0) {
      const key = findEntryKey(entry)
      if (key?.includes(RETIRED_KEY_MARKER)) removeEntry(key, false)
    }
  }

  const releasePin = (token: SampledInstrumentRegionPin) => {
    const entry = pinEntries.get(token)
    if (!entry) return
    pinEntries.delete(token)
    if (disposed) return
    unpinEntry(entry)
    evict(new Set())
  }

  const createPin = (entry: BudgetEntry): SampledInstrumentRegionPin => {
    const token: SampledInstrumentRegionPin = { release: () => releasePin(token) }
    pinEntries.set(token, entry)
    entry.pins += 1
    return token
  }

  const unpin = (token: SampledInstrumentRegionPin) => {
    token.release()
  }

  const set = (
    key: string,
    bytes: number,
    onEvict: () => void,
    physical?: AudioBuffer,
  ) => {
    validateBudgetValue(bytes, 'Sampled instrument region byte count')
    ensureCapacityForSet(key, bytes, physical)
    const existing = entries.get(key)
    const samePhysical = existing !== undefined && existing.physical === physical
    if (samePhysical && existing) {
      const previousBytes = existing.bytes
      existing.bytes = bytes
      existing.onEvict = onEvict
      if (existing.record) refreshRecordCharge(existing.record)
      else {
        totalBytes += bytes - previousBytes
        assertTotalInvariant()
      }
      touch(key, existing)
      return existing
    }
    if (existing?.pins && existing.physical !== physical) retirePinnedEntry(key, existing)
    else if (existing) removeEntry(key, false)
    const pins = existing && existing.physical === physical ? existing.pins : 0
    const entry = createEntry(key, bytes, onEvict, physical, pins)
    touch(key, entry)
    return entry
  }

  const reserve = (key: string, bytes: number) => {
    validateBudgetValue(bytes, 'Sampled instrument region byte count')
    const additionalBytes = additionalBytesForReservation(key, bytes)
    evict(new Set(), additionalBytes)
    if (totalBytes + reservedBytes() + additionalBytes > maxBytes) {
      throw new Error(`Sampled instrument regions exceed the ${maxBytes} byte aggregate limit.`)
    }
    const id = nextInternalId
    nextInternalId += 1
    reservations.set(id, { key, bytes })
    let settled = false
    return {
      release: () => {
        if (settled) return
        settled = true
        reservations.delete(id)
      },
      commit: () => {
        if (settled) return
        settled = true
        reservations.delete(id)
      },
    } satisfies SampledInstrumentRegionReservation
  }

  const dispose = () => {
    disposed = true
    for (const entry of entries.values()) entry.onEvict()
    entries.clear()
    physicalRecords.clear()
    retiredAliases.clear()
    reservations.clear()
    totalBytes = 0
  }

  const createScope = (namespace: string): SampledInstrumentRegionBudgetScope => {
    const reservations = new Set<SampledInstrumentRegionReservation>()
    const pinnedKeys = new Map<string, SampledInstrumentRegionPin[]>()
    const ownedEntries = new Set<BudgetEntry>()
    const leaseEntries = new Set<BudgetEntry>()
    const leasedBuffers = new Map<AudioBuffer, number>()
    const leaseReleases = new Set<() => void>()
    const scopedKey = (key: string) => `${namespace}\u0000${key}`
    const recordPin = (key: string, pin: SampledInstrumentRegionPin) => {
      const owned = pinnedKeys.get(key) ?? []
      owned.push(pin)
      pinnedKeys.set(key, owned)
    }
    const pinOwned = (key: string) => {
      const entry = entries.get(key)
      if (!entry) return
      const pin = createPin(entry)
      touch(key, entry)
      recordPin(key, pin)
    }
    const removeOwnedEntry = (entry: BudgetEntry) => {
      const key = findEntryKey(entry)
      if (!key) return
      if (entry.pins > 0) {
        if (!key.includes(RETIRED_KEY_MARKER)) retirePinnedEntry(key, entry)
        return
      }
      removeEntry(key, false)
    }
    return {
      reserve: (key, bytes) => {
        const owned = reserve(scopedKey(key), bytes)
        reservations.add(owned)
        return owned
      },
      ensureCapacityFor: (requested) => {
        ensureCapacity(
          new Map([...requested].map(([key, bytes]) => [scopedKey(key), bytes])),
          new Set([...requested.keys()].map(scopedKey)),
        )
      },
      set: (key, bytes, onEvict, physical) => {
        const nextKey = scopedKey(key)
        const previouslyPinned = pinnedKeys.get(nextKey)
        const entry = set(nextKey, bytes, onEvict, physical)
        ownedEntries.add(entry)
        if (!previouslyPinned) {
          pinOwned(nextKey)
          return
        }
        if (previouslyPinned.every((pin) => pinEntries.get(pin) === entry)) return
        for (const pin of previouslyPinned) pin.release()
        pinnedKeys.delete(nextKey)
        for (const _ of previouslyPinned) {
          recordPin(nextKey, createPin(entry))
        }
      },
      touch: (key) => {
        const nextKey = resolveKey(scopedKey(key))
        const entry = entries.get(nextKey)
        if (entry) touch(nextKey, entry)
      },
      pin: (key) => {
        const nextKey = scopedKey(key)
        const resolvedKey = resolveKey(nextKey)
        const entry = entries.get(resolvedKey)
        if (!entry) return undefined
        const pin = createPin(entry)
        touch(resolvedKey, entry)
        recordPin(nextKey, pin)
        return pin
      },
      unpin: (pin) => {
        pin.release()
        for (const [key, owned] of pinnedKeys) {
          const index = owned.indexOf(pin)
          if (index < 0) continue
          owned.splice(index, 1)
          if (owned.length === 0) pinnedKeys.delete(key)
          break
        }
      },
      lease: (buffers) => {
        const leased = new Set<BudgetEntry>()
        try {
          for (const input of buffers) {
            validateBudgetValue(input.bytes, 'Sampled instrument buffer byte count')
            const nextKey = scopedKey(`lease\u0000${input.key}\u0000${nextInternalId}`)
            nextInternalId += 1
            const entry = set(nextKey, input.bytes, () => undefined, input.buffer)
            pinEntry(entry)
            ownedEntries.add(entry)
            leaseEntries.add(entry)
            leased.add(entry)
            leasedBuffers.set(input.buffer, (leasedBuffers.get(input.buffer) ?? 0) + 1)
          }
        } catch (error) {
          for (const entry of leased) {
            unpinEntry(entry)
            leaseEntries.delete(entry)
            removeOwnedEntry(entry)
            if (entry.physical) {
              const count = leasedBuffers.get(entry.physical) ?? 0
              if (count <= 1) leasedBuffers.delete(entry.physical)
              else leasedBuffers.set(entry.physical, count - 1)
            }
          }
          throw error
        }
        let released = false
        const release = () => {
          if (released) return
          released = true
          for (const entry of leased) {
            unpinEntry(entry)
            leaseEntries.delete(entry)
            removeOwnedEntry(entry)
            if (entry.physical) {
              const count = leasedBuffers.get(entry.physical) ?? 0
              if (count <= 1) leasedBuffers.delete(entry.physical)
              else leasedBuffers.set(entry.physical, count - 1)
            }
          }
        }
        leaseReleases.add(release)
        return {
          release: () => {
            release()
            leaseReleases.delete(release)
          },
        }
      },
      isLeased: (buffer) => (leasedBuffers.get(buffer) ?? 0) > 0,
      release: () => {
        for (const releaseLease of leaseReleases) releaseLease()
        leaseReleases.clear()
        for (const reservation of reservations) reservation.release()
        reservations.clear()
        for (const owned of pinnedKeys.values()) for (const pin of owned) pin.release()
        pinnedKeys.clear()
        for (const entry of ownedEntries) {
          if (!leaseEntries.has(entry)) removeOwnedEntry(entry)
        }
        ownedEntries.clear()
        leaseEntries.clear()
        leasedBuffers.clear()
      },
    }
  }

  return {
    touch: (key: string) => {
      const entry = entries.get(key)
      if (entry) touch(key, entry)
    },
    ensureCapacity: (key: string, bytes: number) => ensureCapacity(new Map([[key, bytes]])),
    ensureCapacityFor: (requested: ReadonlyMap<string, number>) => ensureCapacity(requested, new Set(requested.keys())),
    reserve,
    set: (key: string, bytes: number, onEvict: () => void, physical?: AudioBuffer) => {
      set(key, bytes, onEvict, physical)
    },
    pin,
    unpin,
    release: (key: string) => {
      key = resolveKey(key)
      const entry = entries.get(key)
      if (!entry) return
      if (entry.pins > 0) {
        if (key.includes(RETIRED_KEY_MARKER)) return
        retirePinnedEntry(key, entry)
        return
      }
      removeEntry(key, false)
    },
    totalBytes: () => totalBytes,
    maxBytes: () => maxBytes,
    keys: () => [...entries.keys()],
    reservedBytes,
    createScope,
    dispose,
  }
}
