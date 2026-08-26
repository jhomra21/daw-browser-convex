import { resolve } from 'node:path'

const packageRoot = resolve(import.meta.dir, '..')
const schemaPath = resolve(packageRoot, 'processor-contract.schema.json')
const graphSchemaPath = resolve(packageRoot, 'graph-contract.schema.json')
const typeScriptOutputPath = resolve(packageRoot, 'src/generated/processor-contract-metadata.ts')
const cppOutputPath = resolve(packageRoot, '../../native/audio-core/generated/processor_contract_generated.h')

type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject
type JsonObject = { [key: string]: JsonValue }

const isObject = (value: JsonValue): value is JsonObject => (
  typeof value === 'object' && value !== null && !Array.isArray(value)
)
const isBoolean = (value: JsonValue): value is boolean => typeof value === 'boolean'
const isNumber = (value: JsonValue): value is number => typeof value === 'number'
const isString = (value: JsonValue): value is string => typeof value === 'string'

const canonicalize = (value: JsonValue): string => {
  if (value === null || isBoolean(value) || isNumber(value) || isString(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`
  if (isObject(value)) {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalize(entry)}`).join(',')}}`
  }
  throw new Error('Processor contract schema contains an unsupported value.')
}

const sha256 = (value: string) => new Bun.CryptoHasher('sha256').update(value).digest('hex')

type ProcessorParameterMetadata = {
  id: string
  defaultValue: number
  minValue: number
  maxValue: number
}

type ProcessorMetadata = {
  name: string
  id: number
  schemaVersion: number
  stateBytes: number
  tombstone: boolean
  parameters: readonly ProcessorParameterMetadata[]
}

const isRecord = isObject

const readParameters = (name: string, definition: JsonObject): ProcessorParameterMetadata[] => {
  const state = definition.properties
  if (!isRecord(state)) return []
  const stateDefinition = state.state
  if (!isRecord(stateDefinition) || !isRecord(stateDefinition.properties)) return []
  const stateProperties = stateDefinition.properties
  const visit = (properties: JsonObject, prefix: string): ProcessorParameterMetadata[] =>
    Object.entries(properties).flatMap(([id, property]) => {
      if (!isRecord(property)) return []
      const fullId = prefix.length > 0 ? `${prefix}.${id}` : id
      if (property.portableParameter === true) {
        if (!isNumber(property.default) || !isNumber(property.minimum) || !isNumber(property.maximum)) throw new Error(`Processor contract schema is missing numeric ${name} metadata for ${fullId}.`)
        const alias = property.portableParameterId
        if (alias !== undefined && (!isString(alias) || alias.length === 0 || alias.includes('.'))) {
          throw new Error(`Processor contract schema has invalid portableParameterId for ${name}.${fullId}.`)
        }
        return [{ id: prefix.length > 0 ? `${prefix}.${alias ?? id}` : alias ?? id, defaultValue: property.default, minValue: property.minimum, maxValue: property.maximum }]
      }
      const nested = property.properties
      return isRecord(nested) ? visit(nested, fullId) : []
    })
  return visit(stateProperties, '')
}

const readProcessorRegistry = (schema: JsonValue): ProcessorMetadata[] => {
  if (!isRecord(schema) || !isRecord(schema.properties) || !isRecord(schema.properties.processors)
    || !isRecord(schema.properties.processors.properties)) throw new Error('Processor contract schema is missing processor registry declarations.')
  const registry = schema.properties.processors.properties
  const processors = Object.entries(registry).map(([name, declaration]) => {
    if (!isRecord(declaration) || !isRecord(declaration.properties)) throw new Error(`Processor declaration ${name} is invalid.`)
    const properties = declaration.properties
    const id = isRecord(properties.id) ? properties.id.const : undefined
    const schemaVersion = isRecord(properties.schemaVersion) ? properties.schemaVersion.const : undefined
    const stateBytes = isRecord(properties.stateBytes) ? properties.stateBytes.const : undefined
    const tombstone = isRecord(properties.tombstone) ? properties.tombstone.const : undefined
    if (!isNumber(id) || !Number.isSafeInteger(id) || id <= 0
      || !isNumber(schemaVersion) || !Number.isSafeInteger(schemaVersion) || schemaVersion <= 0
      || !isNumber(stateBytes) || !Number.isSafeInteger(stateBytes) || stateBytes < 0 || stateBytes > 256 || !isBoolean(tombstone)) {
      throw new Error(`Processor declaration ${name} has invalid stable metadata.`)
    }
    return { name, id, schemaVersion, stateBytes, tombstone, parameters: readParameters(name, declaration) }
  }).sort((left, right) => left.id - right.id)
  for (let index = 1; index < processors.length; ++index) {
    if (processors[index - 1]?.id === processors[index]?.id) throw new Error(`Processor registry has duplicate id ${processors[index]?.id}.`)
  }
  for (const processor of processors) {
    const ids = new Set(processor.parameters.map((parameter) => parameter.id))
    if (ids.size !== processor.parameters.length) throw new Error(`Processor ${processor.name} has duplicate portable parameter ids.`)
  }
  if (processors.some((processor) => processor.tombstone && processor.parameters.length > 0)) {
    throw new Error('Tombstoned processors cannot declare parameters.')
  }
  return processors
}

const createTypeScript = (
  canonicalSchema: string,
  hash: string,
  graphCanonicalSchema: string,
  graphHash: string,
  processors: readonly ProcessorMetadata[],
) => `// Generated by scripts/generate-contract.ts. Do not edit.
export const processorContractHash = '${hash}'
export const processorContractSchemaJson = ${JSON.stringify(canonicalSchema)}
export const portableGraphContractHash = '${graphHash}'
export const portableGraphContractSchemaJson = ${JSON.stringify(graphCanonicalSchema)}
export const processorRegistry = ${JSON.stringify(processors)}
export const utilityParameterMetadata = processorRegistry.find((processor) => processor.name === 'utility')?.parameters ?? []
`

const toMacroName = (id: string) => id.replaceAll(/[A-Z]/g, (character) => `_${character}`).replaceAll(/[^a-zA-Z0-9_]/g, '_').toUpperCase()
const toCppFloat = (value: number) => `${value}${Number.isInteger(value) ? '.0' : ''}F`

const createCppHeader = (hash: string, graphHash: string, processors: readonly ProcessorMetadata[]) => `// Generated by packages/audio-core-contract/scripts/generate-contract.ts. Do not edit.
#pragma once

#define DAW_AUDIO_CORE_PROCESSOR_CONTRACT_HASH "${hash}"
#define DAW_AUDIO_CORE_PORTABLE_GRAPH_CONTRACT_HASH "${graphHash}"
#define DAW_AUDIO_CORE_PROCESSOR_CONTRACT_VERSION 1u
#define DAW_AUDIO_CORE_PROCESSOR_REGISTRY_COUNT ${processors.length}u
${processors.map((processor) => `#define DAW_AUDIO_CORE_PROCESSOR_${toMacroName(processor.name)}_ID ${processor.id}u
#define DAW_AUDIO_CORE_PROCESSOR_${toMacroName(processor.name)}_SCHEMA_VERSION ${processor.schemaVersion}u
#define DAW_AUDIO_CORE_PROCESSOR_${toMacroName(processor.name)}_STATE_BYTES ${processor.stateBytes}u
#define DAW_AUDIO_CORE_PROCESSOR_${toMacroName(processor.name)}_TOMBSTONE ${processor.tombstone ? 1 : 0}u`).join('\n')}
${processors.flatMap((processor) => processor.parameters.map((parameter) => `#define DAW_AUDIO_CORE_${toMacroName(processor.name)}_${toMacroName(parameter.id)}_DEFAULT ${toCppFloat(parameter.defaultValue)}
#define DAW_AUDIO_CORE_${toMacroName(processor.name)}_${toMacroName(parameter.id)}_ID "${processor.name}.${parameter.id}"
#define DAW_AUDIO_CORE_${toMacroName(processor.name)}_${toMacroName(parameter.id)}_MIN ${toCppFloat(parameter.minValue)}
#define DAW_AUDIO_CORE_${toMacroName(processor.name)}_${toMacroName(parameter.id)}_MAX ${toCppFloat(parameter.maxValue)}`)).join('\n')}
`

const writeOrCheck = async (path: string, content: string, check: boolean) => {
  const existing = Bun.file(path)
  if (check) {
    if (!existing.size || await existing.text() !== content) throw new Error(`Generated contract artifact is stale: ${path}`)
    return
  }
  await Bun.write(path, content)
}

const schema = await Bun.file(schemaPath).json()
const graphSchema = await Bun.file(graphSchemaPath).json()
const canonicalSchema = canonicalize(schema)
const graphCanonicalSchema = canonicalize(graphSchema)
const hash = sha256(canonicalSchema)
const graphHash = sha256(graphCanonicalSchema)
const processors = readProcessorRegistry(schema)
const check = Bun.argv.includes('--check')
await writeOrCheck(typeScriptOutputPath, createTypeScript(canonicalSchema, hash, graphCanonicalSchema, graphHash, processors), check)
await writeOrCheck(cppOutputPath, createCppHeader(hash, graphHash, processors), check)
