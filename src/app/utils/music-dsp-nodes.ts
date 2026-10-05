// Ported from Monochrome (Apache-2.0), js/audio-context.js (_createMSNodes, _createMSFilters, mono downmix) and
// js/binaural-dsp.js (_createCrossfeedNodes, _createWidenerNodes; stereo path only) - adapted for Fiesta.
import { crossfeedParams, widenerGains } from './music-dsp-math';
import type { EqBand } from './music-eq-core';

/** One processing block of the chain: connect to `input`, take audio from `output`. Internal wiring is permanent. */
export interface DspStage {
  readonly input: AudioNode;
  readonly output: AudioNode;
  dispose(): void;
}

/** Smoothing time constant for parameter changes (seconds): no zipper noise, still instant to the ear. */
export const PARAM_SMOOTHING = 0.01;

export function safeDisconnect(node: AudioNode | null | undefined): void {
  try {
    node?.disconnect();
  } catch {
    // already disconnected
  }
}

function mono1(g: GainNode): GainNode {
  g.channelCount = 1;
  g.channelCountMode = 'explicit';
  return g;
}

function gain(ctx: BaseAudioContext, value: number, oneChannel = false): GainNode {
  const g = ctx.createGain();
  g.gain.value = value;
  return oneChannel ? mono1(g) : g;
}

function disposeAll(nodes: AudioNode[]): void {
  for (const n of nodes) safeDisconnect(n);
}

/** True (L+R)/2 downmix, fed to both ears. */
export function createMonoStage(ctx: BaseAudioContext): DspStage {
  const down = ctx.createGain();
  down.channelCount = 1;
  down.channelCountMode = 'explicit';
  down.channelInterpretation = 'speakers';
  const up = ctx.createGain();
  up.channelCount = 2;
  up.channelCountMode = 'explicit';
  up.channelInterpretation = 'speakers';
  down.connect(up);
  return { input: down, output: up, dispose: () => disposeAll([down, up]) };
}

export interface CrossfeedStage extends DspStage {
  update(level: number, cutoff: number): void;
}

/** bs2b-style crossfeed: each channel leaks, low-passed and slightly delayed, into the other ear. */
export function createCrossfeedStage(ctx: BaseAudioContext, level: number, cutoff: number): CrossfeedStage {
  const p = crossfeedParams(level, cutoff);
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const directL = gain(ctx, p.direct, true);
  const directR = gain(ctx, p.direct, true);
  const makePath = () => {
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = p.cutoff;
    lp.Q.value = Math.SQRT1_2;
    lp.channelCount = 1;
    lp.channelCountMode = 'explicit';
    const delay = ctx.createDelay(0.01);
    delay.delayTime.value = p.delay;
    const cross = gain(ctx, p.cross, true);
    lp.connect(delay);
    delay.connect(cross);
    return { lp, delay, cross };
  };
  const lr = makePath();
  const rl = makePath();
  splitter.connect(directL, 0);
  splitter.connect(directR, 1);
  directL.connect(merger, 0, 0);
  directR.connect(merger, 0, 1);
  splitter.connect(lr.lp, 0);
  lr.cross.connect(merger, 0, 1);
  splitter.connect(rl.lp, 1);
  rl.cross.connect(merger, 0, 0);
  const all: AudioNode[] = [splitter, merger, directL, directR, lr.lp, lr.delay, lr.cross, rl.lp, rl.delay, rl.cross];
  return {
    input: splitter,
    output: merger,
    update(lv, co) {
      const q = crossfeedParams(lv, co);
      const now = ctx.currentTime;
      for (const path of [lr, rl]) {
        path.lp.frequency.setTargetAtTime(q.cutoff, now, PARAM_SMOOTHING);
        path.delay.delayTime.setTargetAtTime(q.delay, now, PARAM_SMOOTHING);
        path.cross.gain.setTargetAtTime(q.cross, now, PARAM_SMOOTHING);
      }
      directL.gain.setTargetAtTime(q.direct, now, PARAM_SMOOTHING);
      directR.gain.setTargetAtTime(q.direct, now, PARAM_SMOOTHING);
    },
    dispose: () => disposeAll(all),
  };
}

export interface WidenerStage extends DspStage {
  update(width: number): void;
}

/** Mid/side stereo widener: L/R -> M/S, scale the side by `width`, back to L/R. */
export function createWidenerStage(ctx: BaseAudioContext, width: number): WidenerStage {
  const splitter = ctx.createChannelSplitter(2);
  const merger = ctx.createChannelMerger(2);
  const midMix = gain(ctx, 1, true);
  const sideMix = gain(ctx, 1, true);
  const midL = gain(ctx, 0.5, true);
  const midR = gain(ctx, 0.5, true);
  const sideL = gain(ctx, 0.5, true);
  const sideR = gain(ctx, -0.5, true);
  const g = widenerGains(width);
  const midGain = gain(ctx, g.mid, true);
  const sideGain = gain(ctx, g.side, true);
  const sideInv = gain(ctx, -1, true);
  const lMix = gain(ctx, 1, true);
  const rMix = gain(ctx, 1, true);
  splitter.connect(midL, 0);
  splitter.connect(midR, 1);
  splitter.connect(sideL, 0);
  splitter.connect(sideR, 1);
  midL.connect(midMix);
  midR.connect(midMix);
  sideL.connect(sideMix);
  sideR.connect(sideMix);
  midMix.connect(midGain);
  sideMix.connect(sideGain);
  midGain.connect(lMix);
  sideGain.connect(lMix);
  midGain.connect(rMix);
  sideGain.connect(sideInv);
  sideInv.connect(rMix);
  lMix.connect(merger, 0, 0);
  rMix.connect(merger, 0, 1);
  const all: AudioNode[] = [splitter, merger, midMix, sideMix, midL, midR, sideL, sideR, midGain, sideGain, sideInv, lMix, rMix];
  return {
    input: splitter,
    output: merger,
    update(w) {
      const q = widenerGains(w);
      const now = ctx.currentTime;
      midGain.gain.setTargetAtTime(q.mid, now, PARAM_SMOOTHING);
      sideGain.gain.setTargetAtTime(q.side, now, PARAM_SMOOTHING);
    },
    dispose: () => disposeAll(all),
  };
}

export interface EqStage extends DspStage {
  readonly bandCount: number;
  readonly midSide: boolean;
  /** The stereo chain, or the mid chain when midSide. */
  readonly filters: BiquadFilterNode[];
  /** The side chain (empty unless midSide). */
  readonly sideFilters: BiquadFilterNode[];
  update(bands: readonly EqBand[], preampDb: number): void;
}

/** Preamp then a filter chain; or, with `midSide`, two parallel chains (mid and side) between an M/S encoder and decoder. */
export function createEqStage(ctx: BaseAudioContext, bandCount: number, midSide: boolean): EqStage {
  const pre = ctx.createGain();
  const out = ctx.createGain();
  const nodes: AudioNode[] = [pre, out];
  const makeChain = () => {
    const chain: BiquadFilterNode[] = [];
    for (let i = 0; i < bandCount; i++) {
      const f = ctx.createBiquadFilter();
      f.type = 'peaking';
      f.gain.value = 0;
      chain.push(f);
      nodes.push(f);
    }
    for (let i = 0; i < chain.length - 1; i++) chain[i].connect(chain[i + 1]);
    return chain;
  };
  const filters = makeChain();
  let sideFilters: BiquadFilterNode[] = [];

  if (!midSide) {
    pre.connect(filters[0]);
    filters[filters.length - 1].connect(out);
  } else {
    sideFilters = makeChain();
    const splitter = ctx.createChannelSplitter(2);
    const merger = ctx.createChannelMerger(2);
    const midIn = gain(ctx, 1, true);
    const sideIn = gain(ctx, 1, true);
    const midOut = ctx.createGain();
    const sideOut = ctx.createGain();
    const encMidL = gain(ctx, 0.5);
    const encMidR = gain(ctx, 0.5);
    const encSideL = gain(ctx, 0.5);
    const encSideR = gain(ctx, -0.5);
    const decSideToR = gain(ctx, -1);
    const lMix = gain(ctx, 1, true);
    const rMix = gain(ctx, 1, true);
    nodes.push(splitter, merger, midIn, sideIn, midOut, sideOut, encMidL, encMidR, encSideL, encSideR, decSideToR, lMix, rMix);
    pre.connect(splitter);
    splitter.connect(encMidL, 0);
    splitter.connect(encMidR, 1);
    splitter.connect(encSideL, 0);
    splitter.connect(encSideR, 1);
    encMidL.connect(midIn);
    encMidR.connect(midIn);
    encSideL.connect(sideIn);
    encSideR.connect(sideIn);
    midIn.connect(filters[0]);
    filters[filters.length - 1].connect(midOut);
    sideIn.connect(sideFilters[0]);
    sideFilters[sideFilters.length - 1].connect(sideOut);
    midOut.connect(lMix);
    sideOut.connect(lMix);
    midOut.connect(rMix);
    sideOut.connect(decSideToR);
    decSideToR.connect(rMix);
    lMix.connect(merger, 0, 0);
    rMix.connect(merger, 0, 1);
    merger.connect(out);
  }

  const nyquist = () => ctx.sampleRate / 2 - 1;
  const apply = (chain: BiquadFilterNode[], bands: readonly EqBand[], pick: (b: EqBand) => number) => {
    const now = ctx.currentTime;
    chain.forEach((f, i) => {
      const b = bands[i];
      if (!b) {
        f.gain.setTargetAtTime(0, now, PARAM_SMOOTHING);
        return;
      }
      if (f.type !== b.type) f.type = b.type;
      f.frequency.setTargetAtTime(Math.min(b.freq, nyquist()), now, PARAM_SMOOTHING);
      f.Q.setTargetAtTime(b.q, now, PARAM_SMOOTHING);
      f.gain.setTargetAtTime(pick(b), now, PARAM_SMOOTHING);
    });
  };

  return {
    input: pre,
    output: out,
    bandCount,
    midSide,
    filters,
    sideFilters,
    update(bands, preampDb) {
      pre.gain.setTargetAtTime(Math.pow(10, preampDb / 20), ctx.currentTime, PARAM_SMOOTHING);
      if (midSide) {
        apply(filters, bands, (b) => (b.channel === 'side' ? 0 : b.gain));
        apply(sideFilters, bands, (b) => (b.channel === 'mid' ? 0 : b.gain));
      } else {
        apply(filters, bands, (b) => b.gain);
      }
    },
    dispose: () => disposeAll(nodes),
  };
}
