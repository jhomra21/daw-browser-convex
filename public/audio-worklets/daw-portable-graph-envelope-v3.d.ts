import type { AudioCoreGraphSnapshot } from "../../packages/audio-core-contract/src"

export declare const stableId: (value: string) => bigint
export declare const writeId: (view: DataView, offset: number, id: string) => void
export declare const graphEnvelope: (snapshot: AudioCoreGraphSnapshot) => Uint8Array
