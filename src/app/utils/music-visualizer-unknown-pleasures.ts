// Ported from Monochrome (Apache-2.0), js/visualizers/unknown_pleasures_webgl.js - adapted for Fiesta.
// The geometry, history and palette are Monochrome's; its multi-pass bloom is replaced by a soft
// wide copy of every line, and a canvas-2D renderer covers browsers without WebGL.
import { VizEnv, VizFrame, VizPreset, getGl, parseHex } from './music-visualizer-types';

const HISTORY = 25;
const POINTS = 96;
const PROPAGATION_SPEED = 0.7;
const ROTATION = Math.PI / 6;

const LINE_VS = `attribute vec3 a_posEdge; varying float v_edge;
void main(){ gl_Position = vec4(a_posEdge.xy, 0.0, 1.0); v_edge = a_posEdge.z; }`;
const LINE_FS = `precision mediump float; uniform vec3 u_color; uniform float u_soft; varying float v_edge;
void main(){
  float e = abs(v_edge);
  float hard = 1.0 - smoothstep(0.6, 1.0, e);
  float soft = pow(1.0 - e, 2.0) * 0.35;
  float aa = mix(hard, soft, u_soft);
  gl_FragColor = vec4(u_color * aa, aa);
}`;

export class UnknownPleasuresPreset implements VizPreset {
  private readonly history: Float32Array[] = Array.from({ length: HISTORY }, () => new Float32Array(POINTS));
  private writeIndex = 0;
  private accum = 0;
  private readonly xLookup = new Float32Array(POINTS);
  private readonly pLookup = new Float32Array(POINTS);
  private palette: [number, number, number][] = [];
  private paletteColor = '';
  private readonly px = new Float32Array(POINTS);
  private readonly py = new Float32Array(POINTS);
  private readonly verts = new Float32Array(HISTORY * POINTS * 6 * 3 * 2);

  private ctx2d: CanvasRenderingContext2D | null = null;
  private gl: WebGLRenderingContext | null = null;
  private program: WebGLProgram | null = null;
  private buffer: WebGLBuffer | null = null;
  private aPos = -1;
  private uColor: WebGLUniformLocation | null = null;
  private uSoft: WebGLUniformLocation | null = null;
  /** 'webgl' or '2d' once attached (tests and the debug attribute read it). */
  mode: 'webgl' | '2d' | null = null;

  constructor() {
    const inv = 1 / (POINTS - 1);
    for (let i = 0; i < POINTS; i++) {
      const p = Math.abs(i * inv - 0.5) * 2;
      this.pLookup[i] = 1 - p * p * p;
      this.xLookup[i] = i * inv;
    }
  }

  attach(canvas: HTMLCanvasElement, _env: VizEnv): Promise<boolean> {
    const gl = getGl(canvas, { alpha: true, antialias: true, premultipliedAlpha: true, preserveDrawingBuffer: true });
    if (gl) {
      // A canvas that already has a WebGL context can't give a 2D one, so a shader failure is final.
      const ok = this.initGl(gl);
      this.mode = ok ? 'webgl' : null;
      return Promise.resolve(ok);
    }
    this.ctx2d = canvas.getContext('2d');
    this.mode = this.ctx2d ? '2d' : null;
    return Promise.resolve(!!this.ctx2d);
  }

  private initGl(gl: WebGLRenderingContext): boolean {
    const sh = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) return null;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return gl.getShaderParameter(s, gl.COMPILE_STATUS) ? s : null;
    };
    const vs = sh(gl.VERTEX_SHADER, LINE_VS);
    const fs = sh(gl.FRAGMENT_SHADER, LINE_FS);
    const prog = gl.createProgram();
    if (!vs || !fs || !prog) return false;
    gl.attachShader(prog, vs);
    gl.attachShader(prog, fs);
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return false;
    this.gl = gl;
    this.program = prog;
    this.buffer = gl.createBuffer();
    this.aPos = gl.getAttribLocation(prog, 'a_posEdge');
    this.uColor = gl.getUniformLocation(prog, 'u_color');
    this.uSoft = gl.getUniformLocation(prog, 'u_soft');
    return true;
  }

  resize(): void {
    // The viewport follows the canvas size every frame.
  }

  private buildPalette(color: string): void {
    const [r, g, b] = parseHex(color);
    const gray = 0.299 * r + 0.587 * g + 0.114 * b;
    this.palette = [];
    for (let i = 0; i < HISTORY; i++) {
      const sat = 3 - 2 * (i / (HISTORY - 1));
      const ch = (v: number) => Math.max(0, Math.min(255, (gray + (v - gray) * sat) | 0)) / 255;
      this.palette.push([ch(r), ch(g), ch(b)]);
    }
    this.paletteColor = color;
  }

  private propagate(data: Uint8Array, analyser: AnalyserNode | null): void {
    this.accum += PROPAGATION_SPEED;
    if (this.accum < 1) return;
    this.accum -= 1;
    const nyquist = (analyser?.context.sampleRate || 48000) / 2;
    const len = Math.floor(data.length * Math.min(1, 22000 / nyquist));
    const line = this.history[this.writeIndex];
    for (let i = 0; i < POINTS; i++) line[i] = (data[(this.xLookup[i] * len) | 0] / 255) * this.pLookup[i];
    this.writeIndex = (this.writeIndex + 1) % HISTORY;
  }

  draw(f: VizFrame): void {
    this.propagate(f.data, f.analyser);
    if (this.paletteColor !== f.color) this.buildPalette(f.color);
    if (this.gl) this.drawGl(f);
    else if (this.ctx2d) this.draw2d(f);
  }

  /** Perspective-projected points of history line `i` (0 = newest/front) into px/py; returns its line width. */
  private project(i: number, width: number, height: number, kick: number): number {
    const cos = Math.cos(ROTATION);
    const sin = Math.sin(ROTATION);
    const size = Math.max(Math.abs(width * cos) + Math.abs(height * sin), Math.abs(width * sin) + Math.abs(height * cos)) * 1.15;
    const horizon = size * 0.05;
    const front = size * 0.9;
    const depth = 2;
    const B = (front - horizon) / (1 - 1 / (1 + depth));
    const A = front - B;
    const line = this.history[(this.writeIndex + i) % HISTORY];
    const p = 1 - i / (HISTORY - 1);
    const z = 1 + p * depth;
    const scale = 1 / z;
    const y = A + B / z;
    const lw = size * scale * 1.5;
    const margin = (size - lw) * 0.5;
    const amp = 200 * scale * (height / 800);
    for (let j = 0; j < POINTS; j++) {
      const dx = margin + this.xLookup[j] * lw - size / 2;
      const dy = y - line[j] * amp - size / 2;
      this.px[j] = dx * cos - dy * sin + width / 2;
      this.py[j] = dx * sin + dy * cos + height / 2;
    }
    return Math.max(1, (8 * scale + kick * 3) * (height / 800));
  }

  private quads(thickness: number, width: number, height: number, at: number): number {
    const { px, py, verts } = this;
    const wInv = 2 / width;
    const hInv = 2 / height;
    let ptr = at;
    const nrm = (a: number, b: number): [number, number] => {
      const dx = px[b] - px[a];
      const dy = py[b] - py[a];
      const l = Math.hypot(dx, dy);
      return l < 0.001 ? [0, -1] : [-dy / l, dx / l];
    };
    const miter = (ax: number, ay: number, bx: number, by: number): [number, number] => {
      const mx = ax + bx;
      const my = ay + by;
      const l = Math.hypot(mx, my);
      return l > 0.001 ? [mx / l, my / l] : [mx, my];
    };
    for (let i = 0; i < POINTS - 1; i++) {
      const [nx, ny] = nrm(i, i + 1);
      const [pnx, pny] = i > 0 ? nrm(i - 1, i) : [nx, ny];
      const [qnx, qny] = i < POINTS - 2 ? nrm(i + 1, i + 2) : [nx, ny];
      const [m1x, m1y] = miter(nx, ny, pnx, pny);
      const [m2x, m2y] = miter(nx, ny, qnx, qny);
      const v = (x: number, y: number, e: number) => {
        verts[ptr++] = x * wInv - 1;
        verts[ptr++] = 1 - y * hInv;
        verts[ptr++] = e;
      };
      const a1x = px[i] - m1x * thickness, a1y = py[i] - m1y * thickness;
      const b1x = px[i] + m1x * thickness, b1y = py[i] + m1y * thickness;
      const a2x = px[i + 1] - m2x * thickness, a2y = py[i + 1] - m2y * thickness;
      const b2x = px[i + 1] + m2x * thickness, b2y = py[i + 1] + m2y * thickness;
      v(a1x, a1y, -1); v(b1x, b1y, 1); v(a2x, a2y, -1);
      v(b1x, b1y, 1); v(b2x, b2y, 1); v(a2x, a2y, -1);
    }
    return ptr - at;
  }

  private drawGl(f: VizFrame): void {
    const gl = this.gl;
    if (!gl || !this.program) return;
    const { width, height } = f.canvas;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    if (f.blended) gl.clearColor(0, 0, 0, 0.4);
    else gl.clearColor(0.02, 0.02, 0.02, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
    gl.enableVertexAttribArray(this.aPos);
    gl.vertexAttribPointer(this.aPos, 3, gl.FLOAT, false, 0, 0);

    // Soft pass first (wider, dimmer), then the crisp lines on top; back (oldest) to front.
    for (const soft of [1, 0]) {
      gl.uniform1f(this.uSoft, soft);
      for (let i = HISTORY - 1; i >= 0; i--) {
        const lw = this.project(i, width, height, f.stats.kick);
        const n = this.quads((soft ? lw * 3.2 : lw) / 2, width, height, 0);
        gl.bufferData(gl.ARRAY_BUFFER, this.verts.subarray(0, n), gl.DYNAMIC_DRAW);
        const c = this.palette[i] ?? [1, 1, 1];
        gl.uniform3f(this.uColor, c[0], c[1], c[2]);
        gl.drawArrays(gl.TRIANGLES, 0, n / 3);
      }
    }
    gl.disable(gl.BLEND);
  }

  private draw2d(f: VizFrame): void {
    const ctx = this.ctx2d;
    if (!ctx) return;
    const { width, height } = f.canvas;
    ctx.globalCompositeOperation = 'source-over';
    ctx.clearRect(0, 0, width, height);
    if (!f.blended) {
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'lighter';
    ctx.lineJoin = 'round';
    for (let i = HISTORY - 1; i >= 0; i--) {
      const lw = this.project(i, width, height, f.stats.kick);
      const c = this.palette[i] ?? [1, 1, 1];
      const css = `rgb(${(c[0] * 255) | 0},${(c[1] * 255) | 0},${(c[2] * 255) | 0})`;
      ctx.strokeStyle = css;
      // A wide, dim pass for the glow (shadowBlur is far too slow on a software canvas), then the crisp line.
      ctx.globalAlpha = 0.18;
      ctx.lineWidth = lw * 3.2;
      this.strokeLine(ctx);
      ctx.globalAlpha = 1;
      ctx.lineWidth = lw;
      this.strokeLine(ctx);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
  }

  private strokeLine(ctx: CanvasRenderingContext2D): void {
    ctx.beginPath();
    ctx.moveTo(this.px[0], this.py[0]);
    for (let j = 1; j < POINTS; j++) ctx.lineTo(this.px[j], this.py[j]);
    ctx.stroke();
  }

  destroy(): void {
    const gl = this.gl;
    if (gl) {
      if (this.program) gl.deleteProgram(this.program);
      if (this.buffer) gl.deleteBuffer(this.buffer);
      try {
        gl.getExtension('WEBGL_lose_context')?.loseContext();
      } catch {
        // already lost
      }
    }
    this.gl = null;
    this.program = null;
    this.buffer = null;
    this.ctx2d = null;
    this.mode = null;
    for (const l of this.history) l.fill(0);
    this.writeIndex = 0;
  }
}
