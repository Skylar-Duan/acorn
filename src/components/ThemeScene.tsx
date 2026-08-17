// 主题风景水印：六款主题各一幅极淡的风景，铺在主区底部；设置页的主题卡用同一幅当预览。
// 配色全部取自主题 token（--ink-2/--ink-3/--accent/--warn/--ok/--bg/--card），
// 所以「6 主题 × 深浅」12 套配色自动成立——改 themes.css 的颜色，风景跟着变。
// 图形是算出来的（不是手抄的一大串坐标），随机量走固定种子，每次渲染落点一致。

import type { ThemeName } from "../core/model";

const W = 1200;
const H = 420;

/** 固定种子伪随机（mulberry32）：星星、雪花、树的落点每次都一样，不会闪 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const n = (v: number) => Number(v.toFixed(1));

/** 把一串顶点收成一块「填到画布底边」的剪影 */
function silhouette(pts: [number, number][]): string {
  const body = pts.map(([x, y]) => `${n(x)} ${n(y)}`).join(" L ");
  return `M ${body} L ${n(W + 60)} ${H} L -60 ${H} Z`;
}

// ---------- 森林：针叶树 ----------

/** 三层针叶的杉树剪影 */
function fir(x: number, base: number, h: number, w: number): string {
  const p = (dx: number, dy: number) => `${n(x + dx)} ${n(base - dy)}`;
  return [
    `M ${p(0, h)}`,
    `L ${p(w * 0.4, h * 0.6)} L ${p(w * 0.22, h * 0.6)}`,
    `L ${p(w * 0.72, h * 0.3)} L ${p(w * 0.46, h * 0.3)}`,
    `L ${p(w * 1.05, 0)} L ${p(-w * 1.05, 0)}`,
    `L ${p(-w * 0.46, h * 0.3)} L ${p(-w * 0.72, h * 0.3)}`,
    `L ${p(-w * 0.22, h * 0.6)} L ${p(-w * 0.4, h * 0.6)}`,
    "Z",
  ].join(" ");
}

function firRow(seed: number, count: number, base: number, h: number): string[] {
  const r = seeded(seed);
  return Array.from({ length: count }, (_, i) => {
    const x = ((i + 0.5) / count) * (W + 160) - 80 + (r() - 0.5) * 26;
    const hh = h * (0.72 + r() * 0.56);
    return fir(x, base + (r() - 0.5) * 10, hh, hh * 0.26);
  });
}

/** 平缓的丘陵线（正弦叠加，看着像手画的） */
function hill(seed: number, base: number, amp: number): string {
  const r = seeded(seed);
  const a = r() * 6.28;
  const b = r() * 6.28;
  const pts: [number, number][] = [[-60, base]];
  for (let x = -60; x <= W + 60; x += 40) {
    pts.push([x, base - amp * (0.55 + 0.45 * Math.sin(x / 260 + a)) - amp * 0.3 * Math.sin(x / 90 + b)]);
  }
  pts.push([W + 60, base]);
  return silhouette(pts);
}

// ---------- 海洋：浪 ----------

function waveY(baseY: number, amp: number, period: number, phase: number, x: number): number {
  return baseY + amp * Math.sin(x / period + phase) + amp * 0.35 * Math.sin(x / (period * 0.42) + phase * 2);
}

function wave(baseY: number, amp: number, period: number, phase: number): string {
  const pts: [number, number][] = [];
  for (let x = -60; x <= W + 60; x += 12) pts.push([x, waveY(baseY, amp, period, phase, x)]);
  return silhouette(pts);
}

/** 浪尖上的碎白沫 */
function foam(seed: number, baseY: number, amp: number, period: number, phase: number, count: number) {
  const r = seeded(seed);
  return Array.from({ length: count }, () => {
    const x = r() * W;
    const y = baseY + amp * Math.sin(x / period + phase) + amp * 0.35 * Math.sin(x / (period * 0.42) + phase * 2);
    const w = 10 + r() * 26;
    return { x: n(x), y: n(y + 3 + r() * 8), w: n(w) };
  });
}

// ---------- 沙漠：沙丘 ----------

function duneY(base: number, amp: number, phase: number, skew: number, x: number): number {
  const t = x / W;
  return base - amp * Math.sin(t * Math.PI * 1.15 + phase) - amp * 0.28 * Math.sin(t * Math.PI * 3.1 + phase * 1.7) + skew * t;
}

/** 一道沙丘：长长的 S 形脊线 */
function dune(base: number, amp: number, phase: number, skew: number): string {
  const pts: [number, number][] = [];
  for (let x = -60; x <= W + 60; x += 16) pts.push([x, duneY(base, amp, phase, skew, x)]);
  return silhouette(pts);
}

/** 只要脊线本身（描一条亮边，沙丘才有棱） */
function crest(yAt: (x: number) => number): string {
  const pts: string[] = [];
  for (let x = -60; x <= W + 60; x += 16) pts.push(`${n(x)} ${n(yAt(x))}`);
  return `M ${pts.join(" L ")}`;
}

/** 沙面上的风纹 */
function ripples(seed: number, base: number, amp: number, phase: number, skew: number, count: number) {
  const r = seeded(seed);
  return Array.from({ length: count }, () => {
    const x = r() * W;
    const t = x / W;
    const crest = base - amp * Math.sin(t * Math.PI * 1.15 + phase) - amp * 0.28 * Math.sin(t * Math.PI * 3.1 + phase * 1.7) + skew * t;
    const y = crest + 14 + r() * 90;
    const w = 26 + r() * 52;
    return `M ${n(x - w)} ${n(y)} q ${n(w)} ${n(-5 - r() * 5)} ${n(w * 2)} 0`;
  });
}

// ---------- 雪山 / 南极：山脊与浮冰 ----------

/** 锯齿山脊 */
function peaks(seed: number, count: number, base: number, minH: number, maxH: number): [number, number][] {
  const r = seeded(seed);
  const step = (W + 120) / count;
  const pts: [number, number][] = [[-60, base]];
  for (let i = 0; i < count; i++) {
    const x = -60 + step * (i + 0.5) + (r() - 0.5) * step * 0.34;
    pts.push([x, base - (minH + r() * (maxH - minH))]);
    if (i < count - 1) pts.push([x + step * (0.4 + r() * 0.24), base - minH * (0.1 + r() * 0.28)]);
  }
  pts.push([W + 60, base]);
  return pts;
}

/** 山尖上的雪盖：取山脊顶点附近切一小块 */
function snowCaps(pts: [number, number][], base: number, drop: number) {
  return pts
    .filter(([, y]) => base - y > drop * 1.6)
    .map(([x, y]) => {
      const w = drop * 0.62;
      return `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y + drop)} L ${n(x + w * 0.42)} ${n(y + drop * 0.72)} L ${n(x + w * 0.1)} ${n(y + drop)} L ${n(x - w * 0.34)} ${n(y + drop * 0.66)} L ${n(x - w * 0.72)} ${n(y + drop)} Z`;
    });
}

/** 浮冰：不规则四边形 + 水下倒影 */
function floes(seed: number, waterY: number, count: number) {
  const r = seeded(seed);
  return Array.from({ length: count }, () => {
    const x = -40 + r() * (W + 80);
    const w = 40 + r() * 130;
    const h = 12 + r() * 34;
    const y = waterY - 60 + r() * 120;
    const top = `M ${n(x)} ${n(y)} L ${n(x + w * 0.34)} ${n(y - h)} L ${n(x + w * 0.72)} ${n(y - h * 0.55)} L ${n(x + w)} ${n(y)} Z`;
    const shadow = `M ${n(x)} ${n(y)} L ${n(x + w)} ${n(y)} L ${n(x + w * 0.8)} ${n(y + h * 0.42)} L ${n(x + w * 0.16)} ${n(y + h * 0.42)} Z`;
    return { top, shadow };
  });
}

// ---------- 星空 ----------

function stars(seed: number, count: number, maxY: number) {
  const r = seeded(seed);
  return Array.from({ length: count }, () => ({
    x: n(r() * W),
    y: n(r() * maxY),
    r: n(0.7 + r() * r() * 2.1),
    o: n(0.28 + r() * 0.72),
  }));
}

// ---------- 各主题的画 ----------

const FOREST = {
  hill: hill(7, 330, 74),
  back: firRow(11, 34, 336, 62),
  mid: firRow(23, 24, 382, 104),
  front: firRow(31, 15, 430, 170),
};

const OCEAN = {
  w1: wave(250, 15, 230, 0.4),
  w2: wave(296, 12, 186, 2.1),
  w3: wave(340, 10, 148, 3.6),
  w4: wave(384, 8, 116, 5.2),
  c1: crest((x) => waveY(250, 15, 230, 0.4, x)),
  c2: crest((x) => waveY(296, 12, 186, 2.1, x)),
  c3: crest((x) => waveY(340, 10, 148, 3.6, x)),
  foam1: foam(5, 250, 15, 230, 0.4, 18),
  foam2: foam(9, 296, 12, 186, 2.1, 15),
};

const NIGHT = {
  stars: stars(17, 280, 360),
  hill: hill(3, 404, 40),
  hill2: hill(21, 418, 26),
};

const DESERT = {
  d1: dune(268, 46, 0.5, 22),
  d2: dune(322, 40, 2.4, -16),
  d3: dune(378, 30, 4.3, 12),
  c2: crest((x) => duneY(322, 40, 2.4, -16, x)),
  c3: crest((x) => duneY(378, 30, 4.3, 12, x)),
  ripples: ripples(13, 378, 30, 4.3, 12, 30),
};

const SNOW_BACK = peaks(29, 5, 400, 150, 250);
const SNOW_FRONT = peaks(41, 7, 420, 90, 170);
const SNOW = {
  back: silhouette(SNOW_BACK),
  front: silhouette(SNOW_FRONT),
  caps: snowCaps(SNOW_BACK, 400, 44).concat(snowCaps(SNOW_FRONT, 420, 32)),
  flakes: stars(53, 70, 340),
};

const POLAR = {
  floes: floes(37, 356, 9),
  berg: "M 120 356 L 176 214 L 238 262 L 292 196 L 372 356 Z",
  bergFace: "M 176 214 L 238 262 L 292 196 L 372 356 L 262 356 Z",
};

// ---------- 组件 ----------

interface Props {
  theme: ThemeName;
  /** scene = 主区底部大水印；card = 设置页主题卡里的小预览 */
  variant?: "scene" | "card";
}

export default function ThemeScene({ theme, variant = "scene" }: Props) {
  const uid = `${theme}-${variant}`;
  const card = variant === "card";

  return (
    <svg
      className={card ? "theme-scene card" : "theme-scene"}
      viewBox={`0 0 ${W} ${H}`}
      // 卡片要看全整幅（略压扁无妨）；主区那幅按宽度铺满、从底边裁
      preserveAspectRatio={card ? "none" : "xMidYMax slice"}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={`mist-${uid}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--bg)" stopOpacity="0" />
          <stop offset="50%" stopColor="var(--bg)" stopOpacity="1" />
          <stop offset="100%" stopColor="var(--bg)" stopOpacity="0" />
        </linearGradient>
        <radialGradient id={`glow-${uid}`}>
          <stop offset="0%" stopColor="var(--warn)" stopOpacity=".85" />
          <stop offset="100%" stopColor="var(--warn)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`way-${uid}`}>
          <stop offset="0%" stopColor="var(--accent)" stopOpacity=".9" />
          <stop offset="55%" stopColor="var(--accent)" stopOpacity=".45" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`aurora-${uid}`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--ok)" stopOpacity="0" />
          <stop offset="30%" stopColor="var(--ok)" stopOpacity=".9" />
          <stop offset="70%" stopColor="var(--accent)" stopOpacity=".8" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </linearGradient>
      </defs>

      {theme === "forest" && (
        <g>
          <circle cx="905" cy="212" r="46" fill="var(--warn)" opacity=".3" />
          <path d={FOREST.hill} fill="var(--ink-3)" opacity=".4" />
          {FOREST.back.map((d, i) => <path key={i} d={d} fill="var(--ink-3)" opacity=".6" />)}
          <rect x="0" y="300" width={W} height="52" fill={`url(#mist-${uid})`} opacity=".7" />
          {FOREST.mid.map((d, i) => <path key={i} d={d} fill="var(--accent)" opacity=".72" />)}
          <rect x="0" y="356" width={W} height="46" fill={`url(#mist-${uid})`} opacity=".5" />
          {FOREST.front.map((d, i) => <path key={i} d={d} fill="var(--ink-2)" opacity=".95" />)}
        </g>
      )}

      {theme === "ocean" && (
        <g>
          <circle cx="930" cy="206" r="120" fill={`url(#glow-${uid})`} opacity=".5" />
          <circle cx="930" cy="206" r="44" fill="var(--warn)" opacity=".42" />
          <path d={OCEAN.w1} fill="var(--ink-3)" opacity=".38" />
          <path d={OCEAN.c1} stroke="var(--bg)" strokeWidth="2" fill="none" opacity=".55" />
          <path d={OCEAN.w2} fill="var(--accent)" opacity=".42" />
          <path d={OCEAN.c2} stroke="var(--bg)" strokeWidth="2.2" fill="none" opacity=".6" />
          {OCEAN.foam1.map((f, i) => (
            <rect key={i} x={f.x} y={f.y} width={f.w} height="2" rx="1" fill="var(--card)" opacity=".8" />
          ))}
          <path d={OCEAN.w3} fill="var(--accent)" opacity=".62" />
          <path d={OCEAN.c3} stroke="var(--bg)" strokeWidth="2.4" fill="none" opacity=".65" />
          {OCEAN.foam2.map((f, i) => (
            <rect key={i} x={f.x} y={f.y} width={f.w} height="2.2" rx="1.1" fill="var(--card)" opacity=".9" />
          ))}
          <path d={OCEAN.w4} fill="var(--ink-2)" opacity=".9" />
        </g>
      )}

      {theme === "night" && (
        <g>
          <ellipse cx="620" cy="238" rx="660" ry="126" transform="rotate(-10 620 238)" fill={`url(#way-${uid})`} opacity=".85" />
          {NIGHT.stars.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r} fill="var(--ink)" opacity={s.o} />
          ))}
          <path d="M 232 186 a 42 42 0 1 0 31 65 a 34 34 0 1 1 -31 -65 Z" fill="var(--ink)" opacity=".75" />
          <path d="M 742 172 L 872 232" stroke="var(--ink)" strokeWidth="1.6" opacity=".5" strokeLinecap="round" />
          <path d={NIGHT.hill} fill="var(--accent)" opacity=".65" />
          <path d={NIGHT.hill2} fill="var(--ink-2)" opacity=".95" />
        </g>
      )}

      {theme === "desert" && (
        <g>
          <circle cx="900" cy="238" r="158" fill={`url(#glow-${uid})`} opacity=".6" />
          <circle cx="900" cy="238" r="62" fill="var(--warn)" opacity=".55" />
          <path d={DESERT.d1} fill="var(--ink-3)" opacity=".5" />
          <path d={DESERT.d2} fill="var(--accent)" opacity=".58" />
          <path d={DESERT.c2} stroke="var(--bg)" strokeWidth="2.4" fill="none" opacity=".7" />
          <path d={DESERT.d3} fill="var(--ink-2)" opacity=".85" />
          <path d={DESERT.c3} stroke="var(--bg)" strokeWidth="2.6" fill="none" opacity=".75" />
          {DESERT.ripples.map((d, i) => (
            <path key={i} d={d} stroke="var(--bg)" strokeWidth="1.8" fill="none" opacity=".55" strokeLinecap="round" />
          ))}
        </g>
      )}

      {theme === "snow" && (
        <g>
          <circle cx="286" cy="196" r="120" fill={`url(#glow-${uid})`} opacity=".35" />
          <circle cx="286" cy="196" r="44" fill="var(--warn)" opacity=".28" />
          {SNOW.flakes.map((s, i) => (
            <circle key={i} cx={s.x} cy={s.y} r={s.r * 0.7} fill="var(--ink-3)" opacity={Number(s.o) * 0.6} />
          ))}
          <path d={SNOW.back} fill="var(--ink-3)" opacity=".55" />
          <path d={SNOW.front} fill="var(--ink-2)" opacity=".8" />
          {SNOW.caps.map((d, i) => (
            <path key={i} d={d} fill="var(--card)" opacity=".95" />
          ))}
        </g>
      )}

      {theme === "polar" && (
        <g>
          <path d="M -60 190 C 220 112 430 238 700 162 S 1040 110 1260 182" stroke={`url(#aurora-${uid})`} strokeWidth="44" fill="none" opacity=".55" strokeLinecap="round" />
          <path d="M -60 224 C 240 154 440 268 720 196 S 1060 148 1260 214" stroke={`url(#aurora-${uid})`} strokeWidth="20" fill="none" opacity=".8" strokeLinecap="round" />
          <path d="M -60 254 C 260 194 460 290 740 228 S 1080 186 1260 244" stroke={`url(#aurora-${uid})`} strokeWidth="7" fill="none" opacity="1" strokeLinecap="round" />
          <path d={POLAR.berg} fill="var(--ink-3)" opacity=".62" />
          <path d={POLAR.bergFace} fill="var(--accent)" opacity=".6" />
          <rect x="-60" y="356" width={W + 120} height={H - 356} fill="var(--accent)" opacity=".34" />
          {POLAR.floes.map((f, i) => (
            <g key={i}>
              <path d={f.shadow} fill="var(--ink-2)" opacity=".38" />
              <path d={f.top} fill="var(--ink-2)" opacity=".9" />
            </g>
          ))}
        </g>
      )}
    </svg>
  );
}
