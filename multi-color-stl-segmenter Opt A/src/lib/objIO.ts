/**
 * objIO.ts — Wavefront OBJ + MTL ingestion with colour recognition.
 *
 * Colour is resolved per-triangle with the following precedence:
 *   1. Extended vertex colours   "v x y z r g b"          (averaged per face)
 *   2. MTL diffuse               "usemtl name" → Kd r g b
 *   3. Group / object name hints ("hair", "eye", "skin" …)
 *   4. Neutral grey
 *
 * The resulting per-triangle colour array feeds the segmentation planner so
 * cuts can be snapped to real colour boundaries, and enables the dedicated
 * "Colour regions" strategy which needs no geometric cutting at all.
 */
import type { MeshData } from './stlIO';

export class ObjParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ObjParseError';
  }
}

export type Rgb = [number, number, number];
export type MaterialMap = Map<string, Rgb>;

const MAX_TRIANGLES = 4_000_000;

/* ------------------------------------------------------------------ */
/* MTL                                                                 */
/* ------------------------------------------------------------------ */

export function parseMTL(text: string): MaterialMap {
  const map: MaterialMap = new Map();
  let current: string | null = null;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    const sp = line.indexOf(' ');
    const key = (sp < 0 ? line : line.slice(0, sp)).toLowerCase();
    const rest = sp < 0 ? '' : line.slice(sp + 1).trim();
    if (key === 'newmtl') {
      current = rest;
      if (!map.has(current)) map.set(current, [0.72, 0.72, 0.75]);
    } else if (current && (key === 'kd' || key === 'ka')) {
      const p = rest.split(/\s+/).map(Number);
      if (p.length >= 3 && p.every(Number.isFinite)) {
        if (key === 'kd' || !map.get(current)) map.set(current, [p[0], p[1], p[2]]);
      }
    }
  }
  return map;
}

/* ------------------------------------------------------------------ */
/* Semantic colour hints (for OBJs with named groups but no materials)  */
/* ------------------------------------------------------------------ */

const NAME_HINTS: [RegExp, Rgb][] = [
  [/eye|iris|pupil|sclera/i, [0.15, 0.35, 0.85]],
  [/hair|mane|fur|beard|brow/i, [0.35, 0.22, 0.14]],
  [/tooth|teeth|fang|tusk|nail|claw|horn|bone|skull/i, [0.94, 0.93, 0.88]],
  [/tongue|mouth|lip|gum/i, [0.85, 0.32, 0.38]],
  [/nose|snout|muzzle|ear/i, [0.92, 0.68, 0.58]],
  [/skin|body|face|head|flesh/i, [0.88, 0.72, 0.6]],
  [/cloth|shirt|cape|robe|dress|armor|armour/i, [0.28, 0.42, 0.72]],
  [/base|plinth|stand|ground|rock/i, [0.45, 0.5, 0.58]],
  [/metal|blade|sword|steel/i, [0.62, 0.66, 0.72]],
  [/wood|staff|handle|stick/i, [0.5, 0.34, 0.19]],
];

/** Deterministic pleasant fallback colour derived from a material/group name. */
function hashColor(name: string): Rgb {
  for (const [re, c] of NAME_HINTS) if (re.test(name)) return c;
  let h = 2166136261;
  for (let i = 0; i < name.length; i++) {
    h ^= name.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const hue = ((h >>> 0) % 360) / 360;
  return hslToRgb(hue, 0.5, 0.58);
}

function hslToRgb(h: number, s: number, l: number): Rgb {
  const f = (n: number) => {
    const k = (n + h * 12) % 12;
    const a = s * Math.min(l, 1 - l);
    return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [f(0), f(8), f(4)];
}

/* ------------------------------------------------------------------ */
/* OBJ                                                                 */
/* ------------------------------------------------------------------ */

export interface ObjParseResult extends MeshData {
  /** Distinct source materials / groups discovered in the file. */
  materials: { name: string; color: Rgb; triangles: number }[];
  hasVertexColors: boolean;
  usedMtl: boolean;
}

export function parseOBJ(text: string, mtl?: MaterialMap): ObjParseResult {
  if (!text || !text.trim()) throw new ObjParseError('OBJ file is empty.');

  const vx: number[] = [];
  const vcol: number[] = [];
  let hasVertexColors = false;

  const positions: number[] = [];
  const colors: number[] = [];

  let currentName = 'default';
  let currentColor: Rgb | null = null;
  const usage = new Map<string, { color: Rgb; triangles: number }>();
  let usedMtl = false;

  const resolveColor = (name: string): Rgb => {
    const fromMtl = mtl?.get(name);
    if (fromMtl) { usedMtl = true; return fromMtl; }
    return hashColor(name);
  };

  // Face index token → absolute 0-based vertex index.
  const vertIndex = (token: string): number => {
    const slash = token.indexOf('/');
    const raw = slash < 0 ? token : token.slice(0, slash);
    let i = parseInt(raw, 10);
    if (!Number.isFinite(i)) return -1;
    if (i < 0) i = vx.length / 3 + i;
    else i -= 1;
    return i;
  };

  const lines = text.split('\n');
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line || line[0] === '#') continue;
    const sp = line.indexOf(' ');
    if (sp < 0) continue;
    const key = line.slice(0, sp);
    const rest = line.slice(sp + 1).trim();

    if (key === 'v') {
      const p = rest.split(/\s+/);
      vx.push(+p[0], +p[1], +p[2]);
      if (p.length >= 6) {
        hasVertexColors = true;
        let r = +p[3], g = +p[4], b = +p[5];
        if (r > 1.001 || g > 1.001 || b > 1.001) { r /= 255; g /= 255; b /= 255; }
        vcol.push(r, g, b);
      } else {
        vcol.push(-1, -1, -1);
      }
    } else if (key === 'usemtl' || key === 'g' || key === 'o') {
      // A material always wins; g/o only names the group if no material set yet.
      if (key === 'usemtl' || currentColor === null) {
        currentName = rest || 'default';
        currentColor = resolveColor(currentName);
      }
    } else if (key === 'f') {
      const toks = rest.split(/\s+/).filter(Boolean);
      if (toks.length < 3) continue;
      const idx = toks.map(vertIndex);
      // Fan-triangulate the (possibly concave-ish) polygon.
      for (let k = 1; k + 1 < idx.length; k++) {
        const tri = [idx[0], idx[k], idx[k + 1]];
        if (tri.some((i) => i < 0 || i * 3 + 2 >= vx.length)) continue;

        let cr = 0, cg = 0, cb = 0, cn = 0;
        for (const i of tri) {
          positions.push(vx[i * 3], vx[i * 3 + 1], vx[i * 3 + 2]);
          if (hasVertexColors && vcol[i * 3] >= 0) {
            cr += vcol[i * 3]; cg += vcol[i * 3 + 1]; cb += vcol[i * 3 + 2]; cn++;
          }
        }
        const col: Rgb = cn === 3 ? [cr / 3, cg / 3, cb / 3] : (currentColor ?? [0.72, 0.72, 0.75]);
        colors.push(col[0], col[1], col[2]);

        const bucketName = cn === 3 && !currentColor ? 'vertex-colour' : currentName;
        const u = usage.get(bucketName);
        if (u) u.triangles++;
        else usage.set(bucketName, { color: col, triangles: 1 });

        if (positions.length / 9 > MAX_TRIANGLES)
          throw new ObjParseError('OBJ exceeds the supported triangle limit.');
      }
    }
  }

  if (positions.length < 9) throw new ObjParseError('No triangular faces found in this OBJ.');

  const mesh = scrubColored(
    new Float32Array(positions),
    new Float32Array(colors),
  );

  return {
    ...mesh,
    materials: [...usage.entries()]
      .map(([name, v]) => ({ name, color: v.color, triangles: v.triangles }))
      .sort((a, b) => b.triangles - a.triangles),
    hasVertexColors,
    usedMtl,
  };
}

/** Drop NaN / zero-area triangles while keeping the colour array in sync. */
function scrubColored(p: Float32Array, c: Float32Array): MeshData {
  const n = p.length / 9;
  const keepP = new Float32Array(p.length);
  const keepC = new Float32Array(c.length);
  let wp = 0, wc = 0;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    let ok = true;
    for (let k = 0; k < 9; k++) if (!Number.isFinite(p[b + k])) { ok = false; break; }
    if (!ok) continue;
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    if (cx * cx + cy * cy + cz * cz <= 1e-26) continue;
    keepP.set(p.subarray(b, b + 9), wp); wp += 9;
    keepC.set(c.subarray(i * 3, i * 3 + 3), wc); wc += 3;
  }
  if (wp === 0) throw new ObjParseError('OBJ contains no valid triangles after cleanup.');
  return { positions: keepP.slice(0, wp), colors: keepC.slice(0, wc) };
}
