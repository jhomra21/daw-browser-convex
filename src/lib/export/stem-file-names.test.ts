import { expect, test } from 'bun:test'

import { createUniqueStemFileName, sanitizeStemFileName } from './stem-file-names'

test('sanitizes stem names and adds suffixes without collisions', () => {
  const usedNames = new Set<string>()

  expect(sanitizeStemFileName(`  Drums / Kick: "Close"  `)).toBe('Drums - Kick- -Close-')
  expect(createUniqueStemFileName('Drums / Kick', '.wav', usedNames)).toBe('Drums - Kick.wav')
  expect(createUniqueStemFileName('Drums / Kick', '.wav', usedNames)).toBe('Drums - Kick 2.wav')
  expect(createUniqueStemFileName('   ', '.wav', usedNames)).toBe('stem.wav')
})
