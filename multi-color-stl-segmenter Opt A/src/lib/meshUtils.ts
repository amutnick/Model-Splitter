/**
 * meshUtils.ts — Lightweight geometry analytics on triangle soups.
 * No dependency on three.js so the heavy lifting can run in a worker later.
 */
import type { MeshData } from './stlIO';

export interface Bounds {
  min: [number, number, number];
  max: [number, number, number];
  size: [number, number, number];
  center: [number, number, number];
}

export function computeBounds(mesh: MeshData): Bounds {
  const p = mesh.positions;
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      const v = p[i + a];
      if (v < min[a]) min[a] = v;
      if (v > max[a]) max[a] = v;
    }
  }
  const size: [number, number, number] = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const center: [number, number, number] = [
    (max[0] + min[0]) / 2,
    (max[1] + min[1]) / 2,
    (max[2] + min[2]) / 2,
  ];
  return { min, max, size, center };
}

/** In-place translation (returns a new MeshData sharing no buffers). */
export function translate(mesh: MeshData, dx: number, dy: number, dz: number): MeshData {
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) {
    p[i] += dx; p[i + 1] += dy; p[i + 2] += dz;
  }
  return { positions: p };
}

export function surfaceArea(mesh: MeshData): number {
  const p = mesh.positions;
  let total = 0;
  for (let b = 0; b < p.length; b += 9) {
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    total += 0.5 * Math.hypot(cx, cy, cz);
  }
  return total;
}

/** Signed volume via the divergence theorem — also a manifold sanity check. */
export function signedVolume(mesh: MeshData): number {
  const p = mesh.positions;
  let vol = 0;
  for (let b = 0; b < p.length; b += 9) {
    vol +=
      (p[b] * (p[b + 4] * p[b + 8] - p[b + 5] * p[b + 7]) -
        p[b + 1] * (p[b + 3] * p[b + 8] - p[b + 5] * p[b + 6]) +
        p[b + 2] * (p[b + 3] * p[b + 7] - p[b + 4] * p[b + 6])) /
      6;
  }
  return vol;
}

export function centroid(mesh: MeshData): [number, number, number] {
  const p = mesh.positions;
  let x = 0, y = 0, z = 0, wsum = 0;
  for (let b = 0; b < p.length; b += 9) {
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    const w = 0.5 * Math.hypot(cx, cy, cz);
    x += ((p[b] + p[b + 3] + p[b + 6]) / 3) * w;
    y += ((p[b + 1] + p[b + 4] + p[b + 7]) / 3) * w;
    z += ((p[b + 2] + p[b + 5] + p[b + 8]) / 3) * w;
    wsum += w;
  }
  if (wsum === 0) return [0, 0, 0];
  return [x / wsum, y / wsum, z / wsum];
}

/* ------------------------------------------------------------------ */
/* Connected component extraction (union-find over welded vertices)    */
/* ------------------------------------------------------------------ */

/**
 * Splits a soup into topologically disconnected shells. Vertices are welded on
 * a quantized grid so that STL's duplicated float vertices merge reliably.
 */
export function splitConnectedComponents(mesh: MeshData, maxParts = 64): MeshData[] {
  const p = mesh.positions;
  const triCount = p.length / 9;
  if (triCount === 0) return [];

  // Quantization scale relative to model size to survive float noise.
  const b = computeBounds(mesh);
  const diag = Math.hypot(b.size[0], b.size[1], b.size[2]) || 1;
  const q = 1e6 / diag;

  const vertexOwner = new Map<string, number>();
  const parent = new Int32Array(triCount);
  for (let i = 0; i < triCount; i++) parent[i] = i;

  const find = (a: number): number => {
    let r = a;
    while (parent[r] !== r) r = parent[r];
    while (parent[a] !== r) { const nx = parent[a]; parent[a] = r; a = nx; }
    return r;
  };
  const union = (a: number, b2: number) => {
    const ra = find(a), rb = find(b2);
    if (ra !== rb) parent[rb] = ra;
  };

  for (let t = 0; t < triCount; t++) {
    const base = t * 9;
    for (let v = 0; v < 3; v++) {
      const o = base + v * 3;
      const key = `${Math.round(p[o] * q)},${Math.round(p[o + 1] * q)},${Math.round(p[o + 2] * q)}`;
      const owner = vertexOwner.get(key);
      if (owner === undefined) vertexOwner.set(key, t);
      else union(owner, t);
    }
  }

  const groups = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    const r = find(t);
    let g = groups.get(r);
    if (!g) { g = []; groups.set(r, g); }
    g.push(t);
  }

  const parts = [...groups.values()]
    .sort((a, c) => c.length - a.length)
    .slice(0, maxParts)
    .map((tris) => extractTriangles(mesh, tris));

  return parts;
}

/** Build a sub-mesh from a list of triangle indices, preserving colours. */
export function extractTriangles(mesh: MeshData, tris: ArrayLike<number>): MeshData {
  const p = mesh.positions;
  const c = mesh.colors;
  const out = new Float32Array(tris.length * 9);
  const outC = c ? new Float32Array(tris.length * 3) : undefined;
  for (let i = 0; i < tris.length; i++) {
    const t = tris[i];
    out.set(p.subarray(t * 9, t * 9 + 9), i * 9);
    if (c && outC) outC.set(c.subarray(t * 3, t * 3 + 3), i * 3);
  }
  return outC ? { positions: out, colors: outC } : { positions: out };
}

/** Merge many soups into one, preserving colours when every input has them. */
export function mergeMeshes(meshes: MeshData[]): MeshData {
  const total = meshes.reduce((s, m) => s + m.positions.length, 0);
  const out = new Float32Array(total);
  const colored = meshes.length > 0 && meshes.every((m) => m.colors);
  const outC = colored ? new Float32Array(total / 3) : undefined;
  let o = 0, oc = 0;
  for (const m of meshes) {
    out.set(m.positions, o); o += m.positions.length;
    if (outC && m.colors) { outC.set(m.colors, oc); oc += m.colors.length; }
  }
  return outC ? { positions: out, colors: outC } : { positions: out };
}

/** Area-weighted mean colour of a mesh (falls back to neutral grey). */
export function meanColor(mesh: MeshData): [number, number, number] {
  const c = mesh.colors;
  if (!c || !c.length) return [0.7, 0.7, 0.72];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < c.length; i += 3) { r += c[i]; g += c[i + 1]; b += c[i + 2]; }
  const n = c.length / 3;
  return [r / n, g / n, b / n];
}

export const rgbToHex = (c: [number, number, number]) =>
  '#' + c.map((v) => Math.round(Math.min(1, Math.max(0, v)) * 255).toString(16).padStart(2, '0')).join('');
