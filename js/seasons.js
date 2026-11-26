// Animated seasonal backdrop: snow (winter), cherry blossoms (spring), fireflies/sun glints (summer), leaves (autumn).
// Canvas based, sits behind the chat. Pauses when hidden, scales particle count to screen/device,
// respects prefers-reduced-motion (draws one still frame), and backs off if frames get slow.

export const SEASONS = {
  winter: { name: 'Winter', emoji: '❄️', accent: '#60a5fa',
    wall: { dark: 'linear-gradient(180deg,#0a1424 0%,#13223a 55%,#1e3150 100%)', light: 'linear-gradient(180deg,#b9cbe3 0%,#d6e2f1 60%,#eaf1f9 100%)' } },
  spring: { name: 'Spring', emoji: '🌸', accent: '#ec4899',
    wall: { dark: 'linear-gradient(170deg,#1c1322 0%,#2a1a2d 60%,#18261e 100%)', light: 'linear-gradient(170deg,#fde4ee 0%,#fbeef3 50%,#ecf6e8 100%)' } },
  summer: { name: 'Summer', emoji: '✨', accent: '#f59e0b',
    wall: { dark: 'radial-gradient(at 80% 0%, #3a2a0f 0, transparent 55%), linear-gradient(180deg,#0b1220 0%,#0f1a14 100%)', light: 'radial-gradient(at 85% 0%, #ffe6a0 0, transparent 55%), linear-gradient(180deg,#fff6df 0%,#eef6ff 100%)' } },
  autumn: { name: 'Autumn', emoji: '🍂', accent: '#ea580c',
    wall: { dark: 'linear-gradient(170deg,#1e130b 0%,#2a190f 55%,#15180f 100%)', light: 'linear-gradient(170deg,#fde9d4 0%,#fadfc2 55%,#f2e8d4 100%)' } },
};

export function seasonForDate(d = new Date()) {
  const m = d.getMonth(); // northern hemisphere
  return m === 11 || m <= 1 ? 'winter' : m <= 4 ? 'spring' : m <= 7 ? 'summer' : 'autumn';
}

const rand = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

export class SeasonFX {
  constructor(host) {
    this.host = host;
    this.canvas = document.createElement('canvas');
    this.canvas.id = 'seasonCanvas';
    this.canvas.setAttribute('aria-hidden', 'true');
    host.prepend(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.season = null; this.light = false; this.parts = []; this.running = false;
    this.t = 0; this.last = 0; this.wind = 0; this.windTarget = 0; this.slowFrames = 0; this.density = 1;
    this.reduced = matchMedia('(prefers-reduced-motion: reduce)');
    this.mobile = matchMedia('(max-width: 820px)').matches || navigator.maxTouchPoints > 1;
    this.sprites = new Map();
    this._loop = (ts) => this.loop(ts);
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    document.addEventListener('visibilitychange', () => this.updateRunning());
    this.reduced.addEventListener?.('change', () => this.set(this.season, this.light));
  }
  set(season, light) {
    const changed = season !== this.season || light !== this.light;
    this.season = season; this.light = light;
    this.canvas.hidden = !season;
    if (changed) { this.sprites.clear(); this.resize(true); }
    this.updateRunning();
  }
  resize(force = false) {
    const r = this.host.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, this.mobile ? 1.5 : 2);
    const w = Math.max(1, Math.round(r.width)), h = Math.max(1, Math.round(r.height));
    if (!force && w === this.w && h === this.h) return;
    this.w = w; this.h = h; this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr); this.canvas.height = Math.round(h * dpr);
    this.canvas.style.width = w + 'px'; this.canvas.style.height = h + 'px';
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ground = new Float32Array(Math.ceil(w / 6) + 2);
    this.spawnAll();
    if (!this.running && this.season) this.draw(0); // still frame (reduced motion / paused)
  }
  count() {
    const area = (this.w * this.h) / (1280 * 800);
    const base = { winter: 150, spring: 46, summer: 38, autumn: 34 }[this.season] || 0;
    return Math.round(Math.max(12, base * Math.min(1.6, Math.max(0.35, area)) * (this.mobile ? 0.55 : 1) * this.density));
  }
  spawnAll() {
    this.parts = [];
    if (!this.season) return;
    const n = this.count();
    for (let i = 0; i < n; i++) this.parts.push(this.spawn(true));
  }
  spawn(anywhere) {
    const w = this.w, h = this.h, s = this.season;
    if (s === 'winter') {
      const z = Math.random(); // depth 0 (far) .. 1 (near)
      const layer = z < 0.5 ? 0 : z < 0.85 ? 1 : 2;
      const r = [rand(0.8, 1.6), rand(1.6, 2.8), rand(2.8, 4.6)][layer];
      return { x: rand(-20, w + 20), y: anywhere ? rand(-h * 0.1, h) : rand(-40, -5), r, layer,
        vy: [rand(14, 24), rand(26, 40), rand(42, 62)][layer], sway: rand(6, 22) * (layer + 1) / 2, f: rand(0.4, 1.2), ph: rand(0, 6.28),
        a: [0.45, 0.7, 0.9][layer] * rand(0.75, 1) };
    }
    if (s === 'spring') {
      const z = Math.random();
      return { x: rand(-30, w + 30), y: anywhere ? rand(-h * 0.1, h) : rand(-40, -10), z, size: 5 + z * 8,
        vy: 18 + z * 30, vx: rand(8, 26), rot: rand(0, 6.28), vr: rand(-1.2, 1.2), flip: rand(0, 6.28), vf: rand(1.5, 3.5),
        ph: rand(0, 6.28), hue: pick([340, 345, 350, 355, 330]), light: rand(82, 92), a: 0.55 + z * 0.4 };
    }
    if (s === 'summer') {
      return { x: rand(0, w), y: anywhere ? rand(h * 0.15, h) : h + 10, r: rand(1.2, 2.8), vx: rand(-6, 6), vy: rand(-10, -2),
        ph: rand(0, 6.28), pf: rand(0.6, 1.6), wander: rand(0, 6.28) };
    }
    if (s === 'autumn') {
      const z = Math.random();
      return { x: rand(-40, w + 40), y: anywhere ? rand(-h * 0.1, h) : rand(-60, -15), z, size: 9 + z * 12,
        vy: 26 + z * 34, vx: rand(-6, 14), rot: rand(0, 6.28), vr: rand(-2, 2), flip: rand(0, 6.28), vf: rand(1.2, 3),
        ph: rand(0, 6.28), sway: rand(16, 40), color: pick(['#e4572e', '#f3a712', '#d1495b', '#c75000', '#a8461b', '#e9b44c', '#b5651d']), a: 0.6 + z * 0.35 };
    }
  }
  updateRunning() {
    const should = !!this.season && !document.hidden && !this.reduced.matches;
    if (should && !this.running) { this.running = true; this.last = 0; requestAnimationFrame(this._loop); }
    else if (!should) { this.running = false; if (this.season && !document.hidden) this.draw(0); }
  }
  loop(ts) {
    if (!this.running) return;
    const dt = this.last ? Math.min(0.05, (ts - this.last) / 1000) : 0.016;
    // adaptive quality: if frames are consistently slow, use fewer particles
    if (this.last && ts - this.last > 26) { if (++this.slowFrames > 90 && this.density > 0.4) { this.density *= 0.75; this.parts.length = this.count(); this.slowFrames = 0; } }
    else this.slowFrames = Math.max(0, this.slowFrames - 1);
    this.last = ts;
    this.update(dt);
    this.draw(dt);
    requestAnimationFrame(this._loop);
  }
  update(dt) {
    this.t += dt;
    // gentle gusts
    if (Math.random() < dt * 0.15) this.windTarget = rand(-12, 22);
    this.wind += (this.windTarget - this.wind) * dt * 0.4;
    const { w, h, t } = this; const s = this.season;
    for (let i = 0; i < this.parts.length; i++) {
      const p = this.parts[i];
      if (s === 'winter') {
        p.y += p.vy * dt;
        p.x += (Math.sin(t * p.f + p.ph) * p.sway * 0.6 + this.wind * (0.4 + p.layer * 0.4)) * dt;
        if (p.layer === 2 && p.y >= h - this.groundAt(p.x)) { this.settle(p.x, p.r); this.parts[i] = this.spawn(false); continue; }
        if (p.y > h + 10) { if (p.layer === 1) this.settle(p.x, p.r * 0.5); this.parts[i] = this.spawn(false); }
      } else if (s === 'spring') {
        p.y += p.vy * dt; p.x += (p.vx + Math.sin(t * 0.9 + p.ph) * 18 + this.wind) * dt;
        p.rot += p.vr * dt; p.flip += p.vf * dt;
        if (p.y > h + 20 || p.x > w + 40) this.parts[i] = this.spawn(false);
      } else if (s === 'summer') {
        p.wander += rand(-1.5, 1.5) * dt;
        p.vx += Math.cos(p.wander) * 8 * dt; p.vy += Math.sin(p.wander) * 8 * dt - 0.6 * dt;
        p.vx *= 0.99; p.vy *= 0.99;
        p.x += p.vx * dt; p.y += p.vy * dt;
        if (p.y < -10 || p.x < -20 || p.x > w + 20 || p.y > h + 20) this.parts[i] = this.spawn(false);
      } else if (s === 'autumn') {
        p.y += p.vy * dt; p.x += (p.vx + Math.sin(t * 0.8 + p.ph) * p.sway + this.wind * 1.4) * dt;
        p.rot += (p.vr + this.wind * 0.02) * dt; p.flip += p.vf * dt;
        if (p.y > h + 30 || p.x > w + 60 || p.x < -60) this.parts[i] = this.spawn(false);
      }
    }
    // snow slowly melts so it never piles up too high
    if (s === 'winter' && this.ground) for (let i = 0; i < this.ground.length; i++) this.ground[i] = Math.max(0, this.ground[i] - dt * 0.12);
  }
  groundAt(x) { const g = this.ground; if (!g) return 0; const i = Math.max(0, Math.min(g.length - 1, Math.round(x / 6))); return g[i]; }
  settle(x, r) {
    const g = this.ground; if (!g) return;
    const max = this.mobile ? 12 : 16;
    const c = Math.round(x / 6);
    for (let k = -2; k <= 2; k++) { const i = c + k; if (i >= 0 && i < g.length) g[i] = Math.min(max, g[i] + r * 0.35 * (1 - Math.abs(k) / 3)); }
  }
  sprite(r, layer) {
    const key = r.toFixed(1) + ':' + layer + (this.light ? 'l' : 'd');
    let c = this.sprites.get(key);
    if (c) return c;
    const blur = layer === 0 ? 2.2 : layer === 1 ? 1.4 : 1.1; // far flakes look softer
    const size = Math.ceil(r * 2 * blur + 4);
    c = document.createElement('canvas'); c.width = c.height = size;
    const g = c.getContext('2d'), m = size / 2;
    const grd = g.createRadialGradient(m, m, 0, m, m, r * blur);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.45, 'rgba(255,255,255,0.85)');
    grd.addColorStop(1, this.light ? 'rgba(170,195,230,0)' : 'rgba(220,235,255,0)');
    g.fillStyle = grd; g.beginPath(); g.arc(m, m, r * blur, 0, Math.PI * 2); g.fill();
    if (this.light) { g.globalCompositeOperation = 'destination-over'; g.fillStyle = 'rgba(110,140,185,0.25)'; g.beginPath(); g.arc(m, m + 0.6, r * blur * 0.9, 0, Math.PI * 2); g.fill(); }
    this.sprites.set(key, c);
    return c;
  }
  draw() {
    const ctx = this.ctx, { w, h } = this; if (!w) return;
    ctx.clearRect(0, 0, w, h);
    const s = this.season; if (!s) return;
    if (s === 'winter') {
      for (const p of this.parts) { const sp = this.sprite(Math.round(p.r * 2) / 2, p.layer); ctx.globalAlpha = p.a; ctx.drawImage(sp, p.x - sp.width / 2, p.y - sp.height / 2); }
      ctx.globalAlpha = 1;
      // settled snow
      const g = this.ground; if (g && g.some(v => v > 0.3)) {
        ctx.beginPath(); ctx.moveTo(0, h);
        for (let i = 0; i < g.length; i++) ctx.lineTo(i * 6, h - g[i]);
        ctx.lineTo(w, h); ctx.closePath();
        const grd = ctx.createLinearGradient(0, h - 18, 0, h);
        grd.addColorStop(0, this.light ? 'rgba(255,255,255,0.95)' : 'rgba(235,242,255,0.85)');
        grd.addColorStop(1, this.light ? 'rgba(225,235,248,1)' : 'rgba(190,210,240,0.9)');
        ctx.fillStyle = grd; ctx.shadowColor = this.light ? 'rgba(90,120,170,.35)' : 'rgba(180,210,255,.5)'; ctx.shadowBlur = 6; ctx.fill(); ctx.shadowBlur = 0;
      }
    } else if (s === 'spring') {
      for (const p of this.parts) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(Math.cos(p.flip) * 0.9 + 0.1, 1);
        ctx.globalAlpha = p.a;
        const sz = p.size;
        const grd = ctx.createLinearGradient(0, -sz, 0, sz);
        grd.addColorStop(0, `hsl(${p.hue},85%,${p.light}%)`); grd.addColorStop(1, `hsl(${p.hue},70%,${p.light - 12}%)`);
        ctx.fillStyle = grd;
        ctx.beginPath(); // petal with a notch at the tip
        ctx.moveTo(0, sz); ctx.bezierCurveTo(sz * 0.9, sz * 0.4, sz * 0.7, -sz * 0.8, sz * 0.15, -sz);
        ctx.lineTo(0, -sz * 0.75); ctx.lineTo(-sz * 0.15, -sz);
        ctx.bezierCurveTo(-sz * 0.7, -sz * 0.8, -sz * 0.9, sz * 0.4, 0, sz); ctx.fill();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    } else if (s === 'summer') {
      ctx.globalCompositeOperation = this.light ? 'source-over' : 'lighter';
      for (const p of this.parts) {
        const pulse = 0.35 + 0.65 * Math.max(0, Math.sin(this.t * p.pf * 2 + p.ph));
        const R = p.r * (this.light ? 4 : 6);
        const grd = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, R);
        if (this.light) { grd.addColorStop(0, `rgba(255,200,70,${0.75 * pulse})`); grd.addColorStop(0.3, `rgba(255,214,120,${0.35 * pulse})`); grd.addColorStop(1, 'rgba(255,230,160,0)'); }
        else { grd.addColorStop(0, `rgba(255,250,190,${0.95 * pulse})`); grd.addColorStop(0.25, `rgba(220,255,120,${0.45 * pulse})`); grd.addColorStop(1, 'rgba(160,255,80,0)'); }
        ctx.fillStyle = grd; ctx.beginPath(); ctx.arc(p.x, p.y, R, 0, Math.PI * 2); ctx.fill();
      }
      ctx.globalCompositeOperation = 'source-over';
    } else if (s === 'autumn') {
      for (const p of this.parts) {
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.scale(Math.cos(p.flip) * 0.85 + 0.15, 1);
        ctx.globalAlpha = p.a; ctx.fillStyle = p.color;
        const z = p.size;
        ctx.beginPath(); // simple maple-ish leaf
        ctx.moveTo(0, -z);
        ctx.lineTo(z * 0.22, -z * 0.45); ctx.lineTo(z * 0.62, -z * 0.62); ctx.lineTo(z * 0.48, -z * 0.18);
        ctx.lineTo(z * 0.9, z * 0.02); ctx.lineTo(z * 0.42, z * 0.2); ctx.lineTo(z * 0.5, z * 0.55);
        ctx.lineTo(0, z * 0.38);
        ctx.lineTo(-z * 0.5, z * 0.55); ctx.lineTo(-z * 0.42, z * 0.2); ctx.lineTo(-z * 0.9, z * 0.02);
        ctx.lineTo(-z * 0.48, -z * 0.18); ctx.lineTo(-z * 0.62, -z * 0.62); ctx.lineTo(-z * 0.22, -z * 0.45);
        ctx.closePath(); ctx.fill();
        ctx.strokeStyle = 'rgba(80,35,10,0.45)'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(0, -z * 0.8); ctx.lineTo(0, z * 0.85); ctx.stroke();
        ctx.restore();
      }
      ctx.globalAlpha = 1;
    }
  }
}
