// Ported from Monochrome (Apache-2.0), js/visualizers/lcd.js - adapted for Fiesta.
import { VizEnv, VizFrame, VizPreset, getGl, scaleColor } from './music-visualizer-types';

const GRID_COLS = 48;
const VS = `attribute vec2 a_position; varying vec2 v_uv;
void main(){ v_uv = a_position * 0.5 + 0.5; gl_Position = vec4(a_position, 0.0, 1.0); }`;
const FS = `precision highp float; varying vec2 v_uv; uniform vec2 u_resolution; uniform float u_time;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 uv = v_uv; float aspect = u_resolution.x / u_resolution.y;
  vec2 centered = uv - 0.5; mat2 skew = mat2(1.0, 0.0, 0.20, 1.0); vec2 skewed = skew * centered + 0.5;
  float perspScale = mix(1.0, 0.5, skewed.x);
  float blurAmount = smoothstep(0.0, 0.6, abs(skewed.x - 0.25));
  vec2 pUV = skewed; pUV.y = (pUV.y - 0.5) * perspScale + 0.5; pUV.x *= aspect;
  float cell = 0.0078 * perspScale; vec2 gridUV = pUV / cell; vec2 gv = fract(gridUV) - 0.5; vec2 id = floor(gridUV);
  float d = length(gv); float sharp = mix(0.08, 0.25, blurAmount);
  float dotEdge = smoothstep(0.35 - sharp, 0.35 + sharp * 0.3, d);
  dotEdge *= 0.75 + hash(id) * 0.25;
  float grain = hash(uv * u_resolution + u_time) * 0.015;
  gl_FragColor = vec4(0.0, 0.0, 0.0, clamp(dotEdge * 0.5 + grain, 0.0, 0.5));
}`;

export class LcdPreset implements VizPreset {
  private ctx: CanvasRenderingContext2D | null = null;
  private maxVol = 100;
  private readonly prev = new Float32Array(GRID_COLS);
  private overlay: HTMLCanvasElement | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private uRes: WebGLUniformLocation | null = null;
  private uTime: WebGLUniformLocation | null = null;
  private t0 = 0;

  attach(canvas: HTMLCanvasElement, _env: VizEnv): Promise<boolean> {
    this.ctx = canvas.getContext('2d');
    if (this.ctx) this.initGrid(canvas);
    return Promise.resolve(!!this.ctx);
  }

  resize(): void {
    // Sizes are read from the canvas each frame.
  }

  /** The dot-matrix overlay is decoration: without WebGL the bars simply draw without it. */
  private initGrid(canvas: HTMLCanvasElement): void {
    const overlay = document.createElement('canvas');
    overlay.className = 'pointer-events-none absolute inset-0 h-full w-full';
    overlay.style.mixBlendMode = 'multiply';
    overlay.setAttribute('aria-hidden', 'true');
    const gl = getGl(overlay, { alpha: true, premultipliedAlpha: false });
    if (!gl) return;
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, VS);
    const fs = sh(gl.FRAGMENT_SHADER, FS);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return;
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'a_position');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    this.uRes = gl.getUniformLocation(prog, 'u_resolution');
    this.uTime = gl.getUniformLocation(prog, 'u_time');
    this.gl = gl;
    this.program = prog;
    this.overlay = overlay;
    this.t0 = performance.now();
    canvas.parentElement?.appendChild(overlay);
  }

  private renderGrid(w: number, h: number): void {
    const gl = this.gl;
    const o = this.overlay;
    if (!gl || !o || !this.program) return;
    if (o.width !== w || o.height !== h) {
      o.width = w;
      o.height = h;
      gl.viewport(0, 0, w, h);
    }
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform2f(this.uRes, w, h);
    gl.uniform1f(this.uTime, (performance.now() - this.t0) / 1000);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  draw(f: VizFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = f.canvas;
    const kick = f.stats.kick;
    ctx.clearRect(0, 0, width, height);
    if (!f.blended) {
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, width, height);
    }
    const data = this.process(f.data, f.analyser);

    const cx = width / 2;
    const cy = height * 0.35;
    const startX = width * 0.05;
    const totalW = width * 0.9;
    const startScale = 2;
    const endScale = 0.05;

    ctx.save();
    ctx.translate(cx, cy);
    ctx.transform(1, -0.08, 0.2, 1, 0, 0);
    ctx.translate(-cx, -cy);
    if (kick > 0.1) {
      const shake = kick * 8;
      ctx.translate((Math.random() - 0.5) * 2 * shake, (Math.random() - 0.5) * shake);
    }
    const baseW = (totalW / GRID_COLS) * 0.7;
    const delta = endScale - startScale;
    const totalIntegral = startScale + 0.5 * delta;
    for (let c = 0; c < GRID_COLS; c++) {
      const p = c / (GRID_COLS - 1);
      const scale = startScale + delta * p;
      const x = startX + ((startScale * p + 0.5 * delta * p * p) / totalIntegral) * totalW;
      const v = data[c];
      if (v < 0.01) continue;
      const h = v * height * scale;
      if (h < 1) continue;
      ctx.fillStyle = scaleColor(f.color, 0.75 + Math.abs(Math.sin(c * 127.1)) * 0.25);
      ctx.shadowBlur = 30 + v * 50;
      ctx.shadowColor = f.color;
      this.capsule(ctx, x, cy, baseW * scale, h);
    }
    ctx.restore();
    this.renderGrid(width, height);
  }

  private process(data: Uint8Array, analyser: AnalyserNode | null): Float32Array {
    const out = new Float32Array(GRID_COLS);
    const center = GRID_COLS / 2;
    const bins = data.length;
    let peak = 0;
    const binSize = (analyser?.context.sampleRate || 48000) / (bins * 2);
    const minF = 40;
    const maxF = 22000;
    for (let i = 0; i < center; i++) {
      const p = i / (center - 1);
      const f0 = minF * Math.pow(maxF / minF, p);
      const f1 = minF * Math.pow(maxF / minF, (i + 1) / (center - 1));
      const a = Math.max(1, Math.floor(f0 / binSize));
      const b = Math.max(a + 1, Math.floor(f1 / binSize));
      let sum = 0;
      let n = 0;
      for (let k = a; k < b && k < bins; k++) {
        sum += data[k];
        n++;
      }
      let val = n > 0 ? sum / n : a < bins ? data[a] : 0;
      val *= 1 + p * 1.8;
      if (val > peak) peak = val;
      for (const idx of [center - 1 - i, center + i]) {
        const prev = this.prev[idx];
        this.prev[idx] = prev + (val - prev) * (val > prev ? 0.25 : 0.08);
      }
    }
    this.maxVol = Math.max(this.maxVol * 0.995, peak, 40);
    const norm = 200 / this.maxVol;
    for (let c = 0; c < GRID_COLS; c++) {
      let v = (this.prev[c] * norm) / 255;
      v = v < 0.5 ? 0 : (v - 0.5) / 0.5;
      out[c] = Math.pow(Math.min(1, v), 2.2);
    }
    return out;
  }

  private capsule(ctx: CanvasRenderingContext2D, cx: number, cy: number, w: number, h: number): void {
    if (h < w) {
      ctx.beginPath();
      ctx.arc(cx, cy, Math.max(0.5, h / 2), 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    const half = h / 2;
    const r = w / 2;
    ctx.beginPath();
    ctx.arc(cx, cy - half + r, r, Math.PI, 0);
    ctx.lineTo(cx + r, cy + half - r);
    ctx.arc(cx, cy + half - r, r, 0, Math.PI);
    ctx.lineTo(cx - r, cy - half + r);
    ctx.closePath();
    ctx.fill();
  }

  destroy(): void {
    this.overlay?.remove();
    this.overlay = null;
    try {
      this.gl?.getExtension('WEBGL_lose_context')?.loseContext();
    } catch {
      // already lost
    }
    this.gl = null;
    this.program = null;
    this.ctx = null;
    this.prev.fill(0);
    this.maxVol = 100;
  }
}
