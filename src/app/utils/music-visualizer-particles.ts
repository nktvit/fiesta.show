// Ported from Monochrome (Apache-2.0), js/visualizers/particles.js - adapted for Fiesta.
import { VizFrame, VizPreset, VizEnv } from './music-visualizer-types';

interface Particle { x: number; y: number; vx: number; vy: number; baseSize: number }

export class ParticlesPreset implements VizPreset {
  private ctx: CanvasRenderingContext2D | null = null;
  private particles: Particle[] = [];
  private readonly count = 180;

  attach(canvas: HTMLCanvasElement, _env: VizEnv): Promise<boolean> {
    this.ctx = canvas.getContext('2d');
    return Promise.resolve(!!this.ctx);
  }

  resize(): void {
    // Boundaries are read from the canvas each frame.
  }

  draw(f: VizFrame): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const { width, height } = f.canvas;
    const { kick, intensity } = f.stats;
    const sensitivity = f.stats.sensitivity || 1;

    ctx.clearRect(0, 0, width, height);
    if (!f.blended) {
      ctx.fillStyle = '#050505';
      ctx.fillRect(0, 0, width, height);
    }

    if (this.particles.length !== this.count) {
      this.particles = Array.from({ length: this.count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 2,
        vy: (Math.random() - 0.5) * 2,
        baseSize: Math.random() * 3 + 1,
      }));
    }

    ctx.save();
    if (kick > 0.1) {
      const shake = kick * 8 * sensitivity;
      ctx.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
    }
    ctx.fillStyle = f.color;
    ctx.strokeStyle = f.color;

    const maxDist = 150 + intensity * 50 + kick * 50 * sensitivity;
    const maxDistSq = maxDist * maxDist;
    const ps = this.particles;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i];
      const speed = 1 + intensity * 2 + kick * 8 * sensitivity;
      p.x += p.vx * speed;
      p.y += p.vy * speed;
      if (kick > 0.3) {
        p.x += (Math.random() - 0.5) * kick * 2 * sensitivity;
        p.y += (Math.random() - 0.5) * kick * 2 * sensitivity;
      }
      if (p.x < 0) p.x = width;
      if (p.x > width) p.x = 0;
      if (p.y < 0) p.y = height;
      if (p.y > height) p.y = 0;

      ctx.globalAlpha = 0.4 + intensity * 0.2 + kick * 0.15 * sensitivity;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.baseSize * (1 + intensity * 0.5 + kick * 0.8 * sensitivity), 0, Math.PI * 2);
      ctx.fill();

      for (let j = i + 1; j < ps.length; j++) {
        const q = ps[j];
        const dx = p.x - q.x;
        if (Math.abs(dx) > maxDist) continue;
        const dy = p.y - q.y;
        const d2 = dx * dx + dy * dy;
        if (d2 < maxDistSq) {
          const k = 1 - Math.sqrt(d2) / maxDist;
          ctx.beginPath();
          ctx.lineWidth = k * (1 + kick * 1.5 * sensitivity);
          ctx.globalAlpha = k * (0.3 + intensity * 0.2 + kick * 0.3 * sensitivity);
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
      }
    }
    ctx.restore();
  }

  destroy(): void {
    this.ctx = null;
    this.particles = [];
  }
}
