import { expect, test } from 'bun:test'
import { mkdir, rm } from 'node:fs/promises'
import { build } from 'bun'
import { z } from 'zod'

test('live gain ramps stay continuous in Chromium offline rendering', async () => {
  const directory = `/tmp/daw-audio-param-ramp-${crypto.randomUUID()}`
  const session = `audio-param-ramp-${crypto.randomUUID()}`
  const browser = async (...args: string[]) => {
    const env = { ...process.env }
    delete env.AGENT_BROWSER_CDP
    delete env.AGENT_BROWSER_SESSION
    env.AGENT_BROWSER_ALLOW_FILE_ACCESS = '1'
    const child = Bun.spawn(['agent-browser', '--session', session, ...args], {
      env,
      stdout: 'pipe',
      stderr: 'pipe',
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    if (exitCode !== 0) throw new Error(`agent-browser ${args[0]}: ${stderr || stdout}`)
    return stdout.trim()
  }

  await mkdir(directory, { recursive: true })
  try {
    const entry = `${directory}/fixture.ts`
    await Bun.write(entry, `import * as ramp from '${new URL('./audio-param-ramp.ts', import.meta.url).pathname}'
import { applyLiveMixerGraph } from '${new URL('./mixer/apply-live-routing.ts', import.meta.url).pathname}'
import { createLiveMixerRuntime } from '${new URL('./live-mixer-runtime.ts', import.meta.url).pathname}'
import { resolveLiveMixerGraph } from '${new URL('./live-mixer-runtime.ts', import.meta.url).pathname}'
import { AudioEngine } from '${new URL('./audio-engine.ts', import.meta.url).pathname}'
Object.assign(window, { gainRamp: ramp, applyLiveMixerGraph, createLiveMixerRuntime, resolveLiveMixerGraph, AudioEngine })`)
    const bundle = await build({
      entrypoints: [entry],
      target: 'browser',
      format: 'iife',
    })
    expect(bundle.success).toBe(true)
    const script = await bundle.outputs[0]?.text()
    if (!script) throw new Error('Audio parameter ramp bundle is missing.')
    const browserScript = script
      .replaceAll('import.meta.url', JSON.stringify(`file://${directory}/bundle.js`))
      .replaceAll('import.meta.env.BASE_URL', JSON.stringify('/'))
    await Bun.write(`${directory}/index.html`, `<!doctype html><script>${browserScript}</script><script>
      window.renderRamp = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
        const source = context.createConstantSource();
        const gain = context.createGain();
        source.offset.value = 1;
        gain.gain.value = 1;
        source.connect(gain);
        gain.connect(context.destination);
        source.start();
        window.gainRamp.rampAudioParam(gain.gain, 0.25, 0.05);
        const rendered = await context.startRendering();
        const samples = rendered.getChannelData(0);
        const before = samples[Math.floor(0.055 * sampleRate)];
        const after = samples[Math.floor(0.061 * sampleRate)];
        const largestAdjacentStep = samples.reduce((largest, sample, index) =>
          index <= sampleRate * 0.015 ? largest : Math.max(largest, Math.abs(sample - samples[index - 1])), 0);
        const curveContext = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
        const curveSource = curveContext.createConstantSource();
        const curveGain = curveContext.createGain();
        curveSource.offset.value = 1;
        curveGain.gain.value = 0;
        curveSource.connect(curveGain);
        curveGain.connect(curveContext.destination);
        const curve = Float32Array.of(0, 1);
        curveGain.gain.setValueCurveAtTime(curve, 0.05, 0.01);
        curve[1] = 0;
        curveSource.start();
        const curveRendered = await curveContext.startRendering();
        const copiedCurveSample = curveRendered.getChannelData(0)[Math.floor(0.055 * sampleRate)];
        return { before, after, largestAdjacentStep, copiedCurveSample, duration: window.gainRamp.LIVE_GAIN_RAMP_SEC };
      };
      window.renderMixerAutomation = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
        const source = context.createConstantSource();
        const track = {
          input: context.createGain(),
          postFx: context.createGain(),
          mute: context.createGain(),
          gain: context.createGain(),
          output: context.createGain(),
        };
        const masterInput = context.createGain();
        const edgeRuntimes = new Map();
        source.offset.value = 1;
        source.connect(track.input);
        track.input.connect(track.postFx);
        masterInput.connect(context.destination);
        source.start();
        const automationOwnedTargets = new Set();
        const graph = (muted) => ({
          channels: [{
            channel: { id: 'track', volume: 0.8, muted, soloed: false },
            gain: muted ? 0 : 0.8,
            outputGain: 1,
            sends: [],
          }],
          master: { volume: 0.7, instances: [] },
        });
        const apply = (nextGraph, currentTime, gainChanged, outputChanged) =>
          window.applyLiveMixerGraph({
            graph: nextGraph,
            masterInput,
            trackNodes: new Map([['track', track]]),
            edgeRuntimes,
            staticGainSync: new Map([['track', {
              gain: gainChanged,
              outputGain: outputChanged,
              muteGain: true,
              created: false,
            }]]),
            automatedVolumeTargets: automationOwnedTargets,
            createGain: () => context.createGain(),
            createDelay: () => context.createDelay(),
            currentTime,
            sampleRate,
            reconnectTrackMeters: () => {},
          });
        apply(graph(false), 0, true, true);
        let unchangedGainEvents = 0;
        const originalCancel = track.gain.gain.cancelScheduledValues.bind(track.gain.gain);
        track.gain.gain.cancelScheduledValues = (time) => {
          unchangedGainEvents += 1;
          originalCancel(time);
        };
        const originalMasterCancel = masterInput.gain.cancelScheduledValues.bind(masterInput.gain);
        masterInput.gain.cancelScheduledValues = (time) => {
          unchangedGainEvents += 1;
          originalMasterCancel(time);
        };
        apply(graph(false), 0.01, true, true);
        const unchangedRefreshCancelCount = unchangedGainEvents;
        automationOwnedTargets.add('master');
        automationOwnedTargets.add('track');
        track.gain.gain.setValueAtTime(0.2, 0.05);
        track.gain.gain.linearRampToValueAtTime(0.8, 0.45);
        masterInput.gain.setValueAtTime(0.5, 0.05);
        masterInput.gain.linearRampToValueAtTime(1, 0.45);
        apply(graph(false), 0.1, true, false);
        const automationRefreshCancelCount = unchangedGainEvents;
        apply(graph(true), 0.2, true, true);
        apply(graph(false), 0.3, true, true);
        const rendered = await context.startRendering();
        const samples = rendered.getChannelData(0);
        const preMute = samples[Math.floor(0.15 * sampleRate)];
        const muteMid = samples[Math.floor(0.205 * sampleRate)];
        const muted = samples[Math.floor(0.25 * sampleRate)];
        const restoreMid = samples[Math.floor(0.305 * sampleRate)];
        const restored = samples[Math.floor(0.4 * sampleRate)];
        const faderContext = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
        const faderSource = faderContext.createConstantSource();
        const faderGain = faderContext.createGain();
        faderSource.offset.value = 1;
        faderGain.gain.value = 1;
        faderSource.connect(faderGain);
        faderGain.connect(faderContext.destination);
        faderSource.start();
        window.gainRamp.rampAudioParam(faderGain.gain, 0.25, 0.05);
        const faderRendered = await faderContext.startRendering();
        const faderSamples = faderRendered.getChannelData(0);
        const faderMidpoint = faderSamples[Math.floor(0.055 * sampleRate)];
        const faderEnd = faderSamples[Math.floor(0.07 * sampleRate)];
        const largestFaderStep = faderSamples.reduce((largest, sample, index) =>
          index <= sampleRate * 0.015 ? largest : Math.max(largest, Math.abs(sample - faderSamples[index - 1])), 0);
        return {
          unchangedRefreshCancelCount,
          automationRefreshCancelCount,
          preMute,
          muteMid,
          muted,
          restoreMid,
          restored,
          faderMidpoint,
          faderEnd,
          largestFaderStep,
        };
      };
      window.renderLiveMixerRuntime = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate, sampleRate);
        const masterInput = context.createGain();
        masterInput.connect(context.destination);
        let now = 0;
        const audioClock = {
          get currentTime() { return now; },
          sampleRate,
          destination: context.destination,
          createGain: () => context.createGain(),
          createDelay: () => context.createDelay(),
        };
        const acquired = new Set();
        const runtime = window.createLiveMixerRuntime({
          ensureAudio: () => {},
          getAudioContext: () => audioClock,
          getMasterInput: () => masterInput,
          getDestination: () => context.destination,
          reconnectTrackMeters: () => {},
          disposeTrackMeters: () => {},
          disposeSynthTrack: () => {},
          getMasterFx: () => ({ masterVolume: 1 }),
          getFaultGeneration: () => 0,
          workletBudget: {
            begin: () => ({}),
            commit: () => true,
            isCurrent: () => true,
            rollback: () => {},
            releaseOwner: () => {},
          },
          resourceObserver: {
            acquire: (kind, id) => {
              if (kind === 'audio-nodes') acquired.add(id);
              return () => acquired.delete(id);
            },
          },
        });
        const sourceTrack = (muted = false) => ({
          id: 'source',
          name: 'Source',
          volume: 0.8,
          muted,
          clips: [],
          sends: [
            { targetId: 'return-pre-fx', amount: 0.2, tap: 'pre-fx' },
            { targetId: 'return-pre-fader', amount: 0.3, tap: 'pre-fader' },
            { targetId: 'return-post-fader', amount: 0.5 },
          ],
        });
        const tracks = (muted = false) => [
          sourceTrack(muted),
          { id: 'return-pre-fx', name: 'Pre FX', channelRole: 'return', volume: 1, clips: [], sends: [] },
          { id: 'return-pre-fader', name: 'Pre Fader', channelRole: 'return', volume: 1, clips: [], sends: [] },
          { id: 'return-post-fader', name: 'Post Fader', channelRole: 'return', volume: 1, clips: [], sends: [] },
        ];
        const tone = context.createConstantSource();
        tone.offset.value = 1;
        tone.connect(runtime.ensureTrackInput('source'));
        tone.start();
        runtime.updateTrackGains(tracks());
        runtime.previewTrackVolume('source', 0.8, false);
        const ownedAutomation = {
          enabled: true,
          parameterId: 'volume',
          target: { kind: 'track', trackId: 'source' },
        };
        runtime.setAutomatedVolumeTargets([ownedAutomation]);
        const [volumeBinding] = runtime.resolveTrackAutomationBindings('source', 'volume');
        volumeBinding.param.setValueAtTime(0.2, 0.05);
        volumeBinding.param.linearRampToValueAtTime(0.1, 0.2);
        const nodeCountBeforeRefresh = acquired.size;
        runtime.updateTrackGains(tracks());
        const nodeCountAfterRefresh = acquired.size;
        runtime.setAutomatedVolumeTargets([]);
        const restoredAtRelease = volumeBinding.param.value;
        runtime.setAutomatedVolumeTargets([ownedAutomation]);
        runtime.updateTrackGains(tracks());
        const afterReenable = volumeBinding.param.value;
        runtime.setAutomatedVolumeTargets([]);
        let automationRefreshWrites = 0;
        const originalCancel = volumeBinding.param.cancelScheduledValues.bind(volumeBinding.param);
        volumeBinding.param.cancelScheduledValues = (time) => {
          automationRefreshWrites += 1;
          originalCancel(time);
        };
        runtime.setAutomatedVolumeTargets([ownedAutomation]);
        const writesAfterReenable = automationRefreshWrites;
        runtime.updateTrackGains(tracks());
        const writesAfterOwnedRefresh = automationRefreshWrites;
        runtime.setAutomatedVolumeTargets([]);
        now = 0.3;
        runtime.updateTrackGains(tracks(true));
        const resourcesDuringSendFade = acquired.size;
        now = 0.311;
        runtime.updateTrackGains(tracks(true));
        const resourcesAfterSendFadeCleanup = acquired.size;
        now = 0.32;
        runtime.updateTrackGains(tracks());
        const resourcesAfterSendRecreate = acquired.size;
        now = 0.33;
        runtime.updateTrackGains(tracks(true));
        const rendered = await context.startRendering();
        runtime.updateTrackGains([]);
        const countAfterStripRemoval = acquired.size;
        runtime.clear();
        runtime.updateTrackGains(tracks());
        const countAfterProjectRecreate = acquired.size;
        runtime.clear();
        return {
          configuredGainAfterRelease: restoredAtRelease,
          configuredGainAfterReenableCycle: afterReenable,
          nodeCountBeforeRefresh,
          nodeCountAfterRefresh,
          resourcesDuringSendFade,
          resourcesAfterSendFadeCleanup,
          resourcesAfterSendRecreate,
          countAfterStripRemoval,
          countAfterProjectRecreate,
          countAfterProjectClear: acquired.size,
          writesAfterReenable,
          writesAfterOwnedRefresh,
        };
      };
      window.renderSendEdgeTransitions = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate / 2, sampleRate);
        const source = context.createConstantSource();
        const sourceNodes = {
          input: context.createGain(),
          postFx: context.createGain(),
          mute: context.createGain(),
          gain: context.createGain(),
          output: context.createGain(),
        };
        const returns = ['return-zero', 'return-removed'].map(() => ({
          input: context.createGain(),
          postFx: context.createGain(),
          mute: context.createGain(),
          gain: context.createGain(),
          output: context.createGain(),
        }));
        const masterInput = context.createGain();
        const edgeRuntimes = new Map();
        source.offset.value = 1;
        source.connect(sourceNodes.input);
        sourceNodes.input.connect(sourceNodes.postFx);
        sourceNodes.postFx.connect(sourceNodes.mute);
        sourceNodes.mute.connect(sourceNodes.gain);
        sourceNodes.gain.connect(sourceNodes.output);
        returns.forEach((nodes) => {
          nodes.input.connect(nodes.postFx);
          nodes.postFx.connect(nodes.mute);
          nodes.mute.connect(nodes.gain);
          nodes.gain.connect(nodes.output);
        });
        masterInput.connect(context.destination);
        source.start();
        const tracks = new Map([
          ['source', sourceNodes],
          ['return-zero', returns[0]],
          ['return-removed', returns[1]],
        ]);
        const graph = (sendState) => window.resolveLiveMixerGraph([
          {
            id: 'source',
            name: 'Source',
            volume: 1,
            clips: [],
            sends: sendState === 'all'
              ? [
                  { targetId: 'return-zero', amount: 0.4 },
                  { targetId: 'return-removed', amount: 0.4 },
                ]
              : sendState === 'zero'
                ? [
                    // The resolver drops zero-amount sends before routing is applied.
                    { targetId: 'return-zero', amount: 0 },
                    { targetId: 'return-removed', amount: 0.4 },
                  ]
                : [],
          },
          ...['return-zero', 'return-removed'].map((id) => ({
            id,
            name: id,
            channelRole: 'return',
            volume: 1,
            clips: [],
            sends: [],
          })),
        ], {});
        const apply = (sendState, currentTime) => window.applyLiveMixerGraph({
          graph: graph(sendState),
          masterInput,
          trackNodes: tracks,
          edgeRuntimes,
          createGain: () => context.createGain(),
          createDelay: () => context.createDelay(),
          currentTime,
          sampleRate,
          reconnectTrackMeters: () => {},
        });
        apply('all', 0);
        const initialEdgeCount = edgeRuntimes.size;
        const renderedPromise = context.startRendering();
        await context.suspend(0.1);
        apply('none', context.currentTime);
        await context.resume();
        await context.suspend(0.105);
        apply('all', context.currentTime);
        const reusedEdgeCount = edgeRuntimes.size;
        await context.resume();
        await context.suspend(0.2);
        apply('zero', context.currentTime);
        const countDuringFade = edgeRuntimes.size;
        await context.resume();
        await context.suspend(0.215);
        apply('zero', context.currentTime);
        const countAfterZeroCleanup = edgeRuntimes.size;
        await context.resume();
        await context.suspend(0.22);
        apply('none', context.currentTime);
        await context.resume();
        await context.suspend(0.235);
        apply('none', context.currentTime);
        const countAfterRemovalCleanup = edgeRuntimes.size;
        await context.resume();
        const rendered = await renderedPromise;
        const samples = rendered.getChannelData(0);
        const largestStep = samples.reduce((largest, sample, index) =>
          index === 0 ? largest : Math.max(largest, Math.abs(sample - samples[index - 1])), 0);
        return {
          initialEdgeCount,
          reusedEdgeCount,
          countDuringFade,
          countAfterZeroCleanup,
          countAfterRemovalCleanup,
          largestStep,
          midpointAfterRampReversal: samples[Math.floor(0.108 * sampleRate)],
          afterFade: samples[Math.floor(0.232 * sampleRate)],
        };
      };
      window.renderSendTapMutes = async () => {
        const renderTap = async (tap) => {
          const sampleRate = 48000;
          const context = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
          const source = context.createConstantSource();
          const nodes = () => ({
            input: context.createGain(),
            postFx: context.createGain(),
            mute: context.createGain(),
            gain: context.createGain(),
            output: context.createGain(),
          });
          const track = nodes();
          const returnTrack = nodes();
          const masterInput = context.createGain();
          const edgeRuntimes = new Map();
          source.offset.value = 1;
          source.connect(track.input);
          track.input.connect(track.postFx);
          track.postFx.connect(track.mute);
          track.mute.connect(track.gain);
          track.gain.connect(track.output);
          returnTrack.input.connect(returnTrack.postFx);
          returnTrack.postFx.connect(returnTrack.mute);
          returnTrack.mute.connect(returnTrack.gain);
          returnTrack.gain.connect(returnTrack.output);
          masterInput.connect(context.destination);
          source.start();
          const graph = (muted) => window.resolveLiveMixerGraph([
            {
              id: 'source',
              name: 'Source',
              volume: 1,
              muted,
              clips: [],
              sends: [{ targetId: 'return', amount: 0.5, ...(tap ? { tap } : {}) }],
            },
            { id: 'return', name: 'Return', channelRole: 'return', volume: 1, clips: [], sends: [] },
          ], {});
          const apply = (muted, currentTime) => window.applyLiveMixerGraph({
            graph: graph(muted),
            masterInput,
            trackNodes: new Map([['source', track], ['return', returnTrack]]),
            edgeRuntimes,
            staticGainSync: new Map([
              ['source', { gain: true, outputGain: true, muteGain: true, created: currentTime === 0 }],
              ['return', { gain: true, outputGain: true, muteGain: true, created: currentTime === 0 }],
            ]),
            createGain: () => context.createGain(),
            createDelay: () => context.createDelay(),
            currentTime,
            sampleRate,
            reconnectTrackMeters: () => {},
          });
          apply(false, 0);
          const renderedPromise = context.startRendering();
          await context.suspend(0.1);
          apply(true, context.currentTime);
          await context.resume();
          const rendered = await renderedPromise;
          const samples = rendered.getChannelData(0);
          return {
            before: samples[Math.floor(0.09 * sampleRate)],
            midpoint: samples[Math.floor(0.105 * sampleRate)],
            after: samples[Math.floor(0.13 * sampleRate)],
          };
        };
        return {
          preFx: await renderTap('pre-fx'),
          preFader: await renderTap('pre-fader'),
          postFaderDefault: await renderTap(undefined),
        };
      };
      window.renderSourceTrackMute = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
        const source = context.createConstantSource();
        const track = {
          input: context.createGain(),
          postFx: context.createGain(),
          mute: context.createGain(),
          gain: context.createGain(),
          output: context.createGain(),
        };
        const masterInput = context.createGain();
        source.offset.value = 1;
        source.connect(track.input);
        track.input.connect(track.postFx);
        track.postFx.connect(track.mute);
        track.mute.connect(track.gain);
        track.gain.connect(track.output);
        masterInput.connect(context.destination);
        source.start();
        const graph = (muted) => window.resolveLiveMixerGraph([{
          id: 'source',
          name: 'Source',
          volume: 0.8,
          muted,
          clips: [],
          sends: [],
        }], {});
        const apply = (muted, currentTime) => window.applyLiveMixerGraph({
          graph: graph(muted),
          masterInput,
          trackNodes: new Map([['source', track]]),
          edgeRuntimes: new Map(),
          staticGainSync: new Map([['source', {
            gain: true,
            outputGain: true,
            muteGain: true,
            created: currentTime === 0,
          }]]),
          createGain: () => context.createGain(),
          createDelay: () => context.createDelay(),
          currentTime,
          sampleRate,
          reconnectTrackMeters: () => {},
        });
        apply(false, 0);
        const renderedPromise = context.startRendering();
        await context.suspend(0.1);
        apply(true, context.currentTime);
        await context.resume();
        const rendered = await renderedPromise;
        const samples = rendered.getChannelData(0);
        return {
          before: samples[Math.floor(0.09 * sampleRate)],
          midpoint: samples[Math.floor(0.105 * sampleRate)],
          after: samples[Math.floor(0.13 * sampleRate)],
        };
      };
      window.renderStoppedMasterManualChange = async () => {
        const sampleRate = 48000;
        const context = new OfflineAudioContext(1, sampleRate / 5, sampleRate);
        const engine = new window.AudioEngine();
        const master = context.createGain();
        master.gain.value = 0.7;
        master.connect(context.destination);
        engine.audioCtx = context;
        engine.masterGain = master;
        engine.destination = context.destination;
        engine.masterVolume = 0.7;
        const source = context.createConstantSource();
        source.offset.value = 1;
        source.connect(master);
        source.start();
        engine.setAutomationEnvelopes([{
          enabled: true,
          parameterId: 'volume',
          target: { kind: 'master' },
        }]);
        engine.setAutomationEnvelopes([]);
        engine.setMasterVolume(0.2);
        const rendered = await context.startRendering();
        const samples = rendered.getChannelData(0);
        return {
          before: samples[Math.floor(0.0002 * sampleRate)],
          after: samples[Math.floor(0.08 * sampleRate)],
        };
      };
    </script>`)
    await browser('open', `file://${directory}/index.html`)
    const rendered = z.object({
      before: z.number(),
      after: z.number(),
      largestAdjacentStep: z.number(),
      copiedCurveSample: z.number(),
      duration: z.number(),
    }).parse(JSON.parse(await browser('eval', 'window.renderRamp()')))
    expect(rendered.duration).toBe(0.01)
    expect(rendered.before).toBeLessThan(1)
    expect(rendered.after).toBeCloseTo(0.25, 2)
    expect(rendered.largestAdjacentStep).toBeLessThan(0.01)
    expect(rendered.copiedCurveSample).toBeGreaterThan(0.4)
    const mixer = z.object({
      unchangedRefreshCancelCount: z.number(),
      automationRefreshCancelCount: z.number(),
      preMute: z.number(),
      muteMid: z.number(),
      muted: z.number(),
      restoreMid: z.number(),
      restored: z.number(),
      faderMidpoint: z.number(),
      faderEnd: z.number(),
      largestFaderStep: z.number(),
    }).parse(JSON.parse(await browser('eval', 'window.renderMixerAutomation()')))
    expect(mixer.unchangedRefreshCancelCount).toBe(0)
    expect(mixer.automationRefreshCancelCount).toBe(0)
    expect(mixer.preMute).toBeGreaterThan(0.05)
    expect(mixer.muteMid).toBeGreaterThan(Math.abs(mixer.muted))
    expect(mixer.muteMid).toBeLessThan(mixer.preMute)
    expect(Math.abs(mixer.muted)).toBeLessThan(0.0001)
    expect(mixer.restoreMid).toBeGreaterThan(Math.abs(mixer.muted))
    expect(mixer.restoreMid).toBeLessThan(mixer.restored)
    expect(mixer.restored).toBeGreaterThan(0.4)
    expect(mixer.faderMidpoint).toBeGreaterThan(0.4)
    expect(mixer.faderEnd).toBeCloseTo(0.25, 2)
    expect(mixer.largestFaderStep).toBeLessThan(0.01)
    const runtime = z.object({
      configuredGainAfterRelease: z.number(),
      configuredGainAfterReenableCycle: z.number(),
      nodeCountBeforeRefresh: z.number(),
      nodeCountAfterRefresh: z.number(),
      resourcesDuringSendFade: z.number(),
      resourcesAfterSendFadeCleanup: z.number(),
      resourcesAfterSendRecreate: z.number(),
      countAfterStripRemoval: z.number(),
      countAfterProjectRecreate: z.number(),
      countAfterProjectClear: z.number(),
      writesAfterReenable: z.number(),
      writesAfterOwnedRefresh: z.number(),
    }).parse(JSON.parse(await browser('eval', 'window.renderLiveMixerRuntime()')))
    expect(runtime.configuredGainAfterRelease).toBeCloseTo(0.8, 2)
    expect(runtime.configuredGainAfterReenableCycle).toBeCloseTo(0.8, 2)
    expect(runtime.nodeCountAfterRefresh).toBe(runtime.nodeCountBeforeRefresh)
    expect(runtime.resourcesDuringSendFade).toBe(runtime.nodeCountBeforeRefresh)
    expect(runtime.resourcesAfterSendFadeCleanup).toBe(runtime.nodeCountBeforeRefresh - 6)
    expect(runtime.resourcesAfterSendRecreate).toBe(runtime.nodeCountBeforeRefresh)
    expect(runtime.countAfterStripRemoval).toBe(0)
    expect(runtime.countAfterProjectRecreate).toBe(runtime.nodeCountBeforeRefresh)
    expect(runtime.countAfterProjectClear).toBe(0)
    expect(runtime.writesAfterOwnedRefresh).toBe(runtime.writesAfterReenable)
    const sendEdges = z.object({
      initialEdgeCount: z.number(),
      reusedEdgeCount: z.number(),
      countDuringFade: z.number(),
      countAfterZeroCleanup: z.number(),
      countAfterRemovalCleanup: z.number(),
      largestStep: z.number(),
      midpointAfterRampReversal: z.number(),
      afterFade: z.number(),
    }).parse(JSON.parse(await browser('eval', 'window.renderSendEdgeTransitions()')))
    expect(sendEdges.initialEdgeCount).toBe(5)
    expect(sendEdges.reusedEdgeCount).toBe(sendEdges.initialEdgeCount)
    expect(sendEdges.countDuringFade).toBe(sendEdges.initialEdgeCount)
    expect(sendEdges.countAfterZeroCleanup).toBe(4)
    expect(sendEdges.countAfterRemovalCleanup).toBe(3)
    expect(sendEdges.largestStep).toBeLessThan(0.05)
    expect(sendEdges.midpointAfterRampReversal).toBeGreaterThan(0.6)
    expect(sendEdges.afterFade).toBeCloseTo(1, 2)
    const tapMutes = z.object({
      preFx: z.object({ before: z.number(), midpoint: z.number(), after: z.number() }),
      preFader: z.object({ before: z.number(), midpoint: z.number(), after: z.number() }),
      postFaderDefault: z.object({ before: z.number(), midpoint: z.number(), after: z.number() }),
    }).parse(JSON.parse(await browser('eval', 'window.renderSendTapMutes()')))
    for (const tap of [tapMutes.preFx, tapMutes.preFader, tapMutes.postFaderDefault]) {
      expect(tap.before).toBeGreaterThan(tap.after)
      expect(tap.midpoint).toBeGreaterThan(tap.after)
      expect(tap.after).toBeLessThan(0.001)
    }
    const sourceMute = z.object({ before: z.number(), midpoint: z.number(), after: z.number() })
      .parse(JSON.parse(await browser('eval', 'window.renderSourceTrackMute()')))
    expect(sourceMute.before).toBeGreaterThan(0.7)
    expect(sourceMute.midpoint).toBeGreaterThan(sourceMute.after)
    expect(sourceMute.after).toBeLessThan(0.001)
    const master = z.object({ before: z.number(), after: z.number() })
      .parse(JSON.parse(await browser('eval', 'window.renderStoppedMasterManualChange()')))
    expect(master.before).toBeGreaterThan(0.6)
    expect(master.after).toBeCloseTo(0.2, 2)
  } finally {
    await browser('close').catch(() => undefined)
    await rm(directory, { recursive: true, force: true })
  }
}, 60_000)
