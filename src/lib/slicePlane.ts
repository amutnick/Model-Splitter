/**
 * slicePlane.ts — Constructive Solid Geometry: half-space partition of a
 * triangle soup by an arbitrary plane, with watertight cap generation and
 * per-triangle colour propagation.
 *
 * Algorithm
 *  1. Signed distance of every vertex to the plane (snapped by epsilon so we
 *     never emit sub-epsilon slivers that would break manifoldness).
 *  2. Sutherland–Hodgman clip of each triangle into the +half and -half; every
 *     emitted fragment inherits its parent triangle's colour.
 *  3. Every straddling triangle contributes exactly one cut segment. Segments
 *     are welded with a spatial hash and walked into closed loops.
 *  4. Loops are projected onto the plane basis, classified into outer contours
 *     and holes by even/odd nesting, then triangulated (earcut via
 *     THREE.ShapeUtils) to produce the flat cap. The cap is emitted twice with
 *     opposite winding so BOTH resulting solids stay closed / waterproof.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { MeshData } from './stlIO';

export interface CutPlane {
  /** Unit normal. */
  normal: [number, number, number];
  /** Plane satisfies dot(normal, p) = constant. */
  constant: number;
}

export interface SliceResult {
  positive: MeshData | null;
  negative: MeshData | null;
  /** Area of the generated cap — used for print-bed contact scoring. */
  capArea: number;
  /** True when the cut produced a properly closed boundary. */
  manifold: boolean;
}

type V3 = [number, number, number];

const dot = (n: V3, x: number, y: number, z: number) => n[0] * x + n[1] * y + n[2] * z;

/** Build an orthonormal basis (u, v) such that u × v = n. */
function planeBasis(n: V3): { u: V3; v: V3 } {
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = n[1] * helper[2] - n[2] * helper[1];
  let uy = n[2] * helper[0] - n[0] * helper[2];
  let uz = n[0] * helper[1] - n[1] * helper[0];
  const l = Math.hypot(ux, uy, uz) || 1;
  ux /= l; uy /= l; uz /= l;
  return {
    u: [ux, uy, uz],
    v: [n[1] * uz - n[2] * uy, n[2] * ux - n[0] * uz, n[0] * uy - n[1] * ux],
  };
}

function polygonArea2(pts: Vector2[]): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += (pts[j].x + pts[i].x) * (pts[j].y - pts[i].y);
  }
  return a / 2;
}

function pointInPolygon(pt: Vector2, poly: Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
    if ((yi > pt.y) !== (yj > pt.y) && pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Partition `mesh` by `plane`. `eps` is an absolute tolerance in model units. */
export function slicePlane(mesh: MeshData, plane: CutPlane, eps = 1e-5): SliceResult {
  const p = mesh.positions;
  const src = mesh.colors;
  const n = plane.normal;
  const c = plane.constant;
  const triCount = p.length / 9;

  const pos: number[] = [];
  const neg: number[] = [];
  const posC: number[] = [];
  const negC: number[] = [];
  const segs: number[] = [];

  const tri: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const col: V3 = [0.7, 0.7, 0.72];

  for (let t = 0; t < triCount; t++) {
    const b = t * 9;
    let nPos = 0, nNeg = 0;
    for (let i = 0; i < 3; i++) {
      const x = p[b + i * 3], y = p[b + i * 3 + 1], z = p[b + i * 3 + 2];
      let d = dot(n, x, y, z) - c;
      if (d > -eps && d < eps) d = 0;
      else if (d > 0) nPos++;
      else nNeg++;
      tri[i][0] = x; tri[i][1] = y; tri[i][2] = z; tri[i][3] = d;
    }
    if (src) { col[0] = src[t * 3]; col[1] = src[t * 3 + 1]; col[2] = src[t * 3 + 2]; }

    if (nNeg === 0) { pushTri(pos, tri); if (src) posC.push(col[0], col[1], col[2]); continue; }
    if (nPos === 0) { pushTri(neg, tri); if (src) negC.push(col[0], col[1], col[2]); continue; }

    // Straddling: clip both ways and record the cut chord.
    const above = clip(tri, 1);
    const below = clip(tri, -1);
    fanTriangulate(pos, above, src ? posC : null, col);
    fanTriangulate(neg, below, src ? negC : null, col);
    collectSegment(segs, above);
  }

  // ---- Cap construction -------------------------------------------------
  let capArea = 0;
  let manifold = true;
  if (segs.length >= 6 && pos.length && neg.length) {
    try {
      const cap = buildCap(segs, n, eps);
      capArea = cap.area;
      manifold = cap.closed;
      const posMean = meanColor(posC);
      const negMean = meanColor(negC);
      for (let i = 0; i < cap.tris.length; i += 9) {
        // Positive solid's cap faces −n → reversed winding.
        pos.push(
          cap.tris[i], cap.tris[i + 1], cap.tris[i + 2],
          cap.tris[i + 6], cap.tris[i + 7], cap.tris[i + 8],
          cap.tris[i + 3], cap.tris[i + 4], cap.tris[i + 5],
        );
        for (let k = 0; k < 9; k++) neg.push(cap.tris[i + k]);
        if (src) { posC.push(...posMean); negC.push(...negMean); }
      }
    } catch {
      manifold = false; // cap failed; geometry still usable but open
    }
  }

  const build = (v: number[], cc: number[]): MeshData | null =>
    v.length >= 9
      ? { positions: new Float32Array(v), ...(src ? { colors: new Float32Array(cc) } : {}) }
      : null;

  return { positive: build(pos, posC), negative: build(neg, negC), capArea, manifold };
}

function meanColor(c: number[]): V3 {
  if (!c.length) return [0.7, 0.7, 0.72];
  let r = 0, g = 0, b = 0;
  for (let i = 0; i < c.length; i += 3) { r += c[i]; g += c[i + 1]; b += c[i + 2]; }
  const n = c.length / 3;
  return [r / n, g / n, b / n];
}

function pushTri(out: number[], tri: number[][]) {
  for (let i = 0; i < 3; i++) out.push(tri[i][0], tri[i][1], tri[i][2]);
}

/** Sutherland–Hodgman half-space clip. side = +1 keeps d >= 0. */
function clip(poly: number[][], side: 1 | -1): number[][] {
  const out: number[][] = [];
  const len = poly.length;
  for (let i = 0; i < len; i++) {
    const cur = poly[i];
    const nxt = poly[(i + 1) % len];
    const dc = cur[3] * side;
    const dn = nxt[3] * side;
    if (dc >= 0) out.push(cur);
    if ((dc > 0 && dn < 0) || (dc < 0 && dn > 0)) {
      const tt = dc / (dc - dn);
      out.push([
        cur[0] + (nxt[0] - cur[0]) * tt,
        cur[1] + (nxt[1] - cur[1]) * tt,
        cur[2] + (nxt[2] - cur[2]) * tt,
        0,
      ]);
    }
  }
  return out;
}

function fanTriangulate(out: number[], poly: number[][], colOut: number[] | null, col: V3) {
  for (let i = 2; i < poly.length; i++) {
    out.push(
      poly[0][0], poly[0][1], poly[0][2],
      poly[i - 1][0], poly[i - 1][1], poly[i - 1][2],
      poly[i][0], poly[i][1], poly[i][2],
    );
    if (colOut) colOut.push(col[0], col[1], col[2]);
  }
}

/** The two on-plane vertices of a clipped polygon form the cut chord. */
function collectSegment(segs: number[], poly: number[][]) {
  const onPlane = poly.filter((v) => v[3] === 0);
  if (onPlane.length !== 2) return;
  const [a, b] = onPlane;
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) === 0) return;
  segs.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

/* ------------------------------------------------------------------ */
/* Loop extraction + cap triangulation                                 */
/* ------------------------------------------------------------------ */

function buildCap(segs: number[], n: V3, eps: number) {
  // Spatial-hash weld. A plain rounding hash would split coincident points that
  // straddle a cell boundary, leaving loops open, so every insertion also
  // probes the 26 neighbouring cells for an existing node within tol.
  const tol = Math.max(eps * 4, 1e-9);
  const cell = tol * 2;
  const buckets = new Map<string, number[]>();
  const nodes: { pt: V3; edges: number[] }[] = [];

  const weld = (x: number, y: number, z: number): number => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    const tol2 = tol * tol;
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const ni of list) {
            const q = nodes[ni].pt;
            const ddx = q[0] - x, ddy = q[1] - y, ddz = q[2] - z;
            if (ddx * ddx + ddy * ddy + ddz * ddz <= tol2) return ni;
          }
        }
    const idx = nodes.length;
    nodes.push({ pt: [x, y, z], edges: [] });
    const k = `${cx},${cy},${cz}`;
    const list = buckets.get(k);
    if (list) list.push(idx); else buckets.set(k, [idx]);
    return idx;
  };

  const edges: { a: number; b: number; used: boolean }[] = [];
  for (let i = 0; i < segs.length; i += 6) {
    const ka = weld(segs[i], segs[i + 1], segs[i + 2]);
    const kb = weld(segs[i + 3], segs[i + 4], segs[i + 5]);
    if (ka === kb) continue;
    const idx = edges.length;
    edges.push({ a: ka, b: kb, used: false });
    nodes[ka].edges.push(idx);
    nodes[kb].edges.push(idx);
  }

  // Walk undirected edges into closed loops.
  const loops3: V3[][] = [];
  let closed = true;
  for (let e = 0; e < edges.length; e++) {
    if (edges[e].used) continue;
    const start = edges[e].a;
    let cur = edges[e].b;
    edges[e].used = true;
    const loop: V3[] = [nodes[start].pt, nodes[cur].pt];
    let guard = 0;
    let wrapped = false;
    while (guard++ < 1_000_000) {
      const cand = nodes[cur].edges.find((ei: number) => !edges[ei].used);
      if (cand === undefined) break;
      edges[cand].used = true;
      cur = edges[cand].a === cur ? edges[cand].b : edges[cand].a;
      if (cur === start) { wrapped = true; break; }
      loop.push(nodes[cur].pt);
    }
    if (!wrapped) closed = false;
    if (loop.length >= 3) loops3.push(loop);
  }

  // Project onto the plane basis.
  const { u, v } = planeBasis(n);
  const loops2 = loops3.map((l) => l.map((pt) => new Vector2(dot(u, ...pt), dot(v, ...pt))));

  // Even/odd nesting → outer contours vs. holes.
  const meta = loops2.map((l, i) => ({ i, abs: Math.abs(polygonArea2(l)) }));
  meta.sort((a, b) => b.abs - a.abs);
  const isHole = new Array(loops2.length).fill(false);
  const holeOf = new Array<number>(loops2.length).fill(-1);
  for (let mi = 0; mi < meta.length; mi++) {
    const i = meta[mi].i;
    let depth = 0;
    let parent = -1;
    for (let mj = 0; mj < mi; mj++) {
      const j = meta[mj].i;
      if (pointInPolygon(loops2[i][0], loops2[j])) { depth++; parent = j; }
    }
    if (depth % 2 === 1) { isHole[i] = true; holeOf[i] = parent; }
  }

  const tris: number[] = [];
  let area = 0;

  for (let i = 0; i < loops2.length; i++) {
    if (isHole[i]) continue;
    let contour2 = loops2[i];
    let contour3 = loops3[i];
    if (polygonArea2(contour2) < 0) {
      contour2 = [...contour2].reverse();
      contour3 = [...contour3].reverse();
    }

    const holes2: Vector2[][] = [];
    const holes3: V3[][] = [];
    for (let j = 0; j < loops2.length; j++) {
      if (!isHole[j] || holeOf[j] !== i) continue;
      let h2 = loops2[j];
      let h3 = loops3[j];
      if (polygonArea2(h2) > 0) { h2 = [...h2].reverse(); h3 = [...h3].reverse(); }
      holes2.push(h2);
      holes3.push(h3);
    }

    const all3 = [...contour3, ...holes3.flat()];
    const faces = ShapeUtils.triangulateShape(contour2, holes2);
    for (const f of faces) {
      const a = all3[f[0]], b = all3[f[1]], d = all3[f[2]];
      if (!a || !b || !d) continue;
      tris.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
      const e1: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const e2: V3 = [d[0] - a[0], d[1] - a[1], d[2] - a[2]];
      area += 0.5 * Math.hypot(
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      );
    }
  }

  return { tris, area, closed };
}
