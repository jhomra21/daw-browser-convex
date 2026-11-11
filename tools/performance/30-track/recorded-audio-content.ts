import { z } from "zod"

export const recordedAudioContentSchema = z.object({
  sizeBytes: z.number().int().nonnegative(), sha256: z.string().regex(/^[0-9a-f]{64}$/),
  formatTag: z.number().int(), channels: z.number().int(), sampleRate: z.number().int(), bitsPerSample: z.number().int(),
  frames: z.number().int().nonnegative(), nonzeroSamples: z.number().int().nonnegative(),
  nonFiniteSamples: z.number().int().nonnegative(), peakAbs: z.number().nonnegative(),
}).strict()
type RecordedAudioContent = z.infer<typeof recordedAudioContentSchema>
// Reads the persisted take inside the renderer so only a bounded summary crosses CDP.
export const recordedAudioContentScript = (projectId: string, assetId: string) => `(async()=>{const id=${JSON.stringify(assetId)};const root=await navigator.storage.getDirectory();const assets=await(await root.getDirectoryHandle(${JSON.stringify(projectId)})).getDirectoryHandle('assets');let handle=null;for await(const [name,entry] of assets.entries()){if(entry.kind==='file'&&(name===id||name.startsWith(id+'.'))){if(handle)throw new Error('Recorded asset file is ambiguous.');handle=entry}}if(!handle)throw new Error('Recorded asset file is missing from project storage.');const bytes=await(await handle.getFile()).arrayBuffer();const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');const view=new DataView(bytes);const tag=o=>String.fromCharCode(...new Uint8Array(bytes,o,4));if(bytes.byteLength<12||tag(0)!=='RIFF'||tag(8)!=='WAVE')throw new Error('Recorded asset is not RIFF/WAVE.');let offset=12,fmt=null,data=null;while(offset+8<=bytes.byteLength){const chunk=tag(offset),size=view.getUint32(offset+4,true),body=offset+8;if(body+size>bytes.byteLength)throw new Error('Recorded WAV chunk is truncated.');if(chunk==='fmt '){const tagValue=view.getUint16(body,true);fmt={formatTag:tagValue===65534&&size>=26?view.getUint16(body+24,true):tagValue,channels:view.getUint16(body+2,true),sampleRate:view.getUint32(body+4,true),blockAlign:view.getUint16(body+12,true),bitsPerSample:view.getUint16(body+14,true)}}if(chunk==='data'){data={offset:body,size};break}offset=body+size+(size&1)}if(!fmt||!data||fmt.blockAlign<1||data.size%fmt.blockAlign!==0)throw new Error('Recorded WAV is missing or has invalid fmt/data.');let nonzeroSamples=0,nonFiniteSamples=0,peakAbs=0;if(fmt.formatTag===3&&fmt.bitsPerSample===32){for(let at=data.offset;at+4<=data.offset+data.size;at+=4){const sample=view.getFloat32(at,true);if(!Number.isFinite(sample)){nonFiniteSamples+=1;continue}if(sample!==0)nonzeroSamples+=1;const magnitude=Math.abs(sample);if(magnitude>peakAbs)peakAbs=magnitude}}return JSON.stringify({sizeBytes:bytes.byteLength,sha256,formatTag:fmt.formatTag,channels:fmt.channels,sampleRate:fmt.sampleRate,bitsPerSample:fmt.bitsPerSample,frames:data.size/fmt.blockAlign,nonzeroSamples,nonFiniteSamples,peakAbs})})()`
type PersistedAsset = { sizeBytes: number; contentSha256: string; sampleRate?: number; channelCount?: number; durationSec?: number }
// Silence is reported through nonzeroSamples/peakAbs; it does not disprove byte persistence.
export const assessRecordedAudioContent = (
  asset: PersistedAsset, content: RecordedAudioContent, capturedFrames: number, activeSampleRate: number,
) => [
  content.sizeBytes !== asset.sizeBytes ? "size" : null,
  content.sha256 !== asset.contentSha256 ? "sha256" : null,
  content.formatTag !== 3 || content.bitsPerSample !== 32 ? "format" : null,
  content.channels !== asset.channelCount ? "channels" : null,
  content.sampleRate !== asset.sampleRate || content.sampleRate !== activeSampleRate ? "sample-rate" : null,
  content.frames !== capturedFrames ? "frames" : null,
  asset.durationSec === undefined || Math.abs(content.frames / content.sampleRate - asset.durationSec) > 0.001 ? "duration" : null,
  content.nonFiniteSamples > 0 ? "non-finite" : null,
].filter((failure) => failure !== null)

