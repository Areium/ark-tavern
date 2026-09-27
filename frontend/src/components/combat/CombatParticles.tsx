import { useEffect, useRef, useState } from "react";

interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; maxLife: number; size: number; color: string;
  streak: boolean;
}
interface EmitterConfig {
  type: "spark" | "heal" | "death" | "victory";
  x: number; y: number; count?: number;
  damageType?: string; critical?: boolean; angle?: number;
}
const DEFAULTS = {
  spark: { count: 12, speed: 125, size: 2, life: 340, colors: ["#ffd6a0", "#ff925b", "#fff0d6"] },
  heal: { count: 7, speed: 23, size: 2.5, life: 700, colors: ["#82dcb2", "#b5f0d1"] },
  death: { count: 14, speed: 35, size: 2, life: 580, colors: ["#9ba7ad", "#68767f", "#cad2d6"] },
  victory: { count: 24, speed: 55, size: 3, life: 1000, colors: ["#edce86", "#fff0bd", "#b79a60"] },
};
const PAD = 1.35;
interface Props {
  width?: number; height?: number;
  emitters: { id: string; config: EmitterConfig }[];
  onEmitterDone?: (id: string) => void;
}
export default function CombatParticles({ width, height, emitters, onEmitterDone }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const particles = useRef<Particle[]>([]);
  const wake = useRef<() => void>(() => {});
  const seen = useRef(new Set<string>());
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const done = useRef(onEmitterDone);
  done.current = onEmitterDone;
  const [size, setSize] = useState({ w: 600, h: 600 });
  useEffect(() => {
    const parent = containerRef.current?.parentElement;
    if (!parent || width) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.width && entry.contentRect.height)
        setSize({ w: entry.contentRect.width, h: entry.contentRect.height });
    });
    observer.observe(parent);
    return () => observer.disconnect();
  }, [width]);
  const w = width ?? Math.round(size.w * PAD);
  const h = height ?? Math.round(size.h * PAD);
  const px = width ? 0 : (w - size.w) / 2;
  const py = height ? 0 : (h - size.h) / 2;
  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = w * dpr; canvas.height = h * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    let frame = 0;
    let previous = 0;
    const tick = (now: number) => {
      frame = 0;
      const dt = previous ? Math.max(0, now - previous) : 0;
      previous = now;
      ctx.clearRect(0, 0, w, h);
      particles.current = particles.current.filter(p => {
        p.life -= dt;
        if (p.life <= 0) return false;
        p.x += p.vx * dt / 1000; p.y += p.vy * dt / 1000;
        const alpha = p.life / p.maxLife;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = p.color; ctx.strokeStyle = p.color;
        ctx.beginPath();
        if (p.streak) {
          ctx.lineWidth = p.size * Math.max(.35, alpha);
          ctx.moveTo(p.x + px, p.y + py);
          ctx.lineTo(p.x + px - p.vx * .035, p.y + py - p.vy * .035);
          ctx.stroke();
        } else {
          ctx.arc(p.x + px, p.y + py, p.size * (.4 + .6 * alpha), 0, Math.PI * 2);
          ctx.fill();
        }
        return true;
      });
      ctx.globalAlpha = 1;
      if (particles.current.length) frame = requestAnimationFrame(tick);
      else previous = 0;
    };
    wake.current = () => { if (!frame) frame = requestAnimationFrame(tick); };
    if (particles.current.length) wake.current();
    return () => { cancelAnimationFrame(frame); wake.current = () => {}; };
  }, [w, h, px, py]);
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    for (const { id, config } of emitters) {
      if (seen.current.has(id)) continue;
      seen.current.add(id);
      const def = DEFAULTS[config.type];
      const arts = config.damageType === "arts";
      const mixed = config.damageType === "mixed";
      const colors = arts ? ["#97c9ff", "#c7b8f7", "#e6e4ff"]
        : mixed ? ["#ffd6a0", "#b1b4ff", "#fff0d6"] : def.colors;
      const count = Math.min(60, Math.max(0, config.count ?? def.count) * (reduced ? .3 : config.critical ? 1.4 : 1));
      for (let i = 0; i < Math.floor(count); i++) {
        const angle = config.angle !== undefined && config.type === "spark"
          ? config.angle + (Math.random() - .5) * 2.4 : Math.random() * Math.PI * 2;
        const speed = def.speed * (.4 + Math.random() * .8) * (reduced ? .1 : 1);
        const life = def.life * (.65 + Math.random() * .35);
        particles.current.push({
          x: config.x + (config.type === "heal" ? (Math.random() - .5) * 24 : 0), y: config.y,
          vx: Math.cos(angle) * speed,
          vy: config.type === "heal" ? -speed : Math.sin(angle) * speed,
          life, maxLife: life, size: def.size * (config.critical ? 1.3 : 1),
          color: colors[i % colors.length], streak: config.type === "spark" && !arts && !reduced,
        });
      }
      wake.current();
      timers.current.set(id, setTimeout(() => {
        timers.current.delete(id);
        done.current?.(id);
      }, def.life + 50));
    }
    // IDs may leave props before their particles have finished.
    const present = new Set(emitters.map(e => e.id));
    for (const id of seen.current) if (!present.has(id) && !timers.current.has(id)) seen.current.delete(id);
  }, [emitters]);
  useEffect(() => () => {
    for (const timer of timers.current.values()) clearTimeout(timer);
    timers.current.clear(); seen.current.clear(); particles.current = [];
  }, []);
  return <div ref={containerRef} aria-hidden="true" className="absolute inset-0 pointer-events-none z-20" style={{ overflow: "visible" }}>
    <canvas ref={canvasRef} style={{ position: "absolute", width: w, height: h, left: -px, top: -py, pointerEvents: "none" }} />
  </div>;
}
