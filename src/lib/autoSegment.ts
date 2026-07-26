/**
 * autoSegment.ts — Recursive, multi-axis, feature-aware cut planning for
 * multi-colour 3D printing.
 *
 * Rather than firing N parallel planes down a single axis, the planner builds a
 * BSP TREE: it repeatedly picks the sub-piece that most "wants" to be divided,
 * evaluates all three axes on THAT piece alone, and applies the single best
 * plane. Because every recursion re-profiles a smaller volume, protruding
 * features become dominant signals — a head separates from a torso on Z, then
 * the nose separates from the face on Y, then ears/eyes on X. That is exactly
 * what a flat single-axis scheme can never do.
 *
 * Per-plane cost encodes the printing rules:
 *   R1 Overhang     penalise planes where the section grows in +axis (dA/dt>0)
 *   R2 Flat/feature reward planes on axis-perpendicular flats, penalise planes
 *                   through high normal-variance (detailed) surface
 *   R3 Bed contact  reward a usable, compact cross-section for the new base
 *   R4 Colour/necks reward local minima of section area ("necks") AND, when the
 *                   mesh carries colour, reward planes on colour boundaries
 *   R5 Isolation    reward planes that cleanly cut off a protruding lobe
 */
import type { MeshData } from './stlIO';
import {
  computeBounds, splitConnectedComponents, signedVolume, centroid,
  extractTriangles, meanColor, rgbToHex, type Bounds,
} from './meshUtils';
import { analyzeMeshTopology, repairBoundaryHoles, type MeshTopology } from './meshRepair';
import { slicePlane, type ConnectorOptions, type CutPlane } from './slicePlane';

export type Axis = 0 | 1 | 2;
export type AxisOption = 'auto' | 'x' | 'y' | 'z';
export type SegmentMode = 'auto' | 'uniform' | 'components' | 'color';

export const AXIS_NAME = ['X', 'Y', 'Z'] as const;

export interface PlannerOptions {
  parts: number;
  axis: AxisOption;
  mode: SegmentMode;
  /** 0..1 — how strongly to favour flats / necks / colour seams over even spacing. */
  featureBias: number;
  /** 0..1 — willingness to carve off small protruding features (nose, ears, eyes). */
  featureIsolation: number;
  /** Separate topologically disconnected shells (eyes, gems, loose props). */
  separateLooseParts: boolean;
  /** Allow the planner to change axis between recursion levels. */
  multiAxis: boolean;
  /** Weight of colour-boundary evidence when the mesh has colours. */
  colorWeight: number;
  /** Opt-in repair of simple boundary holes before planning and slicing. */
  repairOpenMeshes: boolean;
  /** Shared dimensions for per-cut cylindrical peg/socket connectors. */
  connectorCount: number;
  connectorDiameter: number;
  connectorDepth: number;
  connectorClearance: number;
}

export const DEFAULT_OPTIONS: PlannerOptions = {
  parts: 6,
  axis: 'auto',
  mode: 'auto',
  featureBias: 0.7,
  featureIsolation: 0.55,
  separateLooseParts: true,
  multiAxis: true,
  colorWeight: 0.7,
  repairOpenMeshes: false,
  connectorCount: 2,
  connectorDiameter: 4,
  connectorDepth: 3,
  connectorClearance: 0.25,
};

/* ------------------------------------------------------------------ */
/* Plan tree                                                           */
/* ------------------------------------------------------------------ */

export interface PlanLeaf {
  kind: 'leaf';
  id: string;
}

export interface PlanSplit {
  kind: 'split';
  id: string;
  axis: Axis;
  offset: number;
  enabled: boolean;
  /** Add automatically placed guide pegs and matching sockets to this cut. */
  connectors: boolean;
  /** 0..1, higher is a better seam. */
  quality: number;
  /** Human-readable justification shown in the cut list. */
  reason: string;
  /** Valid drag range for this cut, in model space. */
  range: [number, number];
  depth: number;
  a: PlanNode; // negative side
  b: PlanNode; // positive side
}

export type PlanNode = PlanLeaf | PlanSplit;

let uid = 0;
const nextId = (p: string) => `${p}${(++uid).toString(36)}`;

export function flattenSplits(node: PlanNode, out: PlanSplit[] = []): PlanSplit[] {
  if (node.kind === 'split') {
    out.push(node);
    flattenSplits(node.a, out);
    flattenSplits(node.b, out);
  }
  return out;
}

export function findSplit(node: PlanNode, id: string): PlanSplit | null {
  if (node.kind !== 'split') return null;
  if (node.id === id) return node;
  return findSplit(node.a, id) ?? findSplit(node.b, id);
}

/** Immutably replace a split node with a leaf (deleting it and its subtree). */
export function removeSplit(node: PlanNode, id: string): PlanNode {
  if (node.kind !== 'split') return node;
  if (node.id === id) return { kind: 'leaf', id: node.id };
  return { ...node, a: removeSplit(node.a, id), b: removeSplit(node.b, id) };
}

export function updateSplit(node: PlanNode, id: string, patch: Partial<PlanSplit>): PlanNode {
  if (node.kind !== 'split') return node;
  if (node.id === id) return { ...node, ...patch };
  return { ...node, a: updateSplit(node.a, id, patch), b: updateSplit(node.b, id, patch) };
}

/** Replace a leaf with a new split (used by "Split this part again"). */
export function replaceLeaf(node: PlanNode, leafId: string, replacement: PlanNode): PlanNode {
  if (node.kind === 'leaf') return node.id === leafId ? replacement : node;
  if (node.id === leafId) return replacement;
  return { ...node, a: replaceLeaf(node.a, leafId, replacement), b: replaceLeaf(node.b, leafId, replacement) };
}

export interface PreparedMesh {
  mesh: MeshData;
  topology: MeshTopology;
  warnings: string[];
  notes: string[];
}

/** Diagnose an input and optionally close simple boundary loops before cuts. */
export function prepareMeshForSlicing(mesh: MeshData, opts: PlannerOptions): PreparedMesh {
  const before = analyzeMeshTopology(mesh);
  const warnings: string[] = [];
  const notes: string[] = [];
  if (before.isSolid) {
    return { mesh, topology: before, warnings, notes };
  }

  if (!opts.repairOpenMeshes) {
    warnings.push(
      `Input is not solid (${before.boundaryEdges} boundary, ${before.nonManifoldEdges} non-manifold edge(s)). Enable “Repair open mesh” before slicing.`,
    );
    return { mesh, topology: before, warnings, notes };
  }

  const repair = repairBoundaryHoles(mesh);
  if (repair.repairedLoops) {
    notes.push(
      `Solid repair filled ${repair.repairedLoops} boundary loop(s) with ${repair.addedTriangles} triangle(s).`,
    );
  }
  if (repair.after.isSolid) {
    notes.push('Repaired mesh validated as watertight before slicing.');
  } else {
    warnings.push(
      `Repair was incomplete: ${repair.after.boundaryEdges} boundary, ${repair.after.nonManifoldEdges} non-manifold and ${repair.after.inconsistentEdges} inconsistent edge(s) remain.`,
    );
  }
  return { mesh: repair.mesh, topology: repair.after, warnings, notes };
}

/* ------------------------------------------------------------------ */
/* Axis profiling                                                      */
/* ------------------------------------------------------------------ */

const BINS = 160;

export interface AxisProfile {
  axis: Axis;
  t: Float32Array;
  crossArea: Float32Array;
  feature: Float32Array;
  flatness: Float32Array;
  colorEdge: Float32Array;
  cost: Float32Array;
  bounds: Bounds;
}

export function profileAxis(
  mesh: MeshData,
  axis: Axis,
  o: Pick<PlannerOptions, 'featureBias' | 'featureIsolation' | 'colorWeight'>,
): AxisProfile {
  const p = mesh.positions;
  const cols = mesh.colors;
  const bounds = computeBounds(mesh);
  const lo = bounds.min[axis];
  const span = Math.max(bounds.size[axis], 1e-9);

  const t = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) t[i] = lo + (span * (i + 0.5)) / BINS;

  const flux = new Float64Array(BINS);
  const areaBin = new Float64Array(BINS);
  const flatBin = new Float64Array(BINS);
  const nx = new Float64Array(BINS);
  const ny = new Float64Array(BINS);
  const nz = new Float64Array(BINS);
  const cr = new Float64Array(BINS);
  const cg = new Float64Array(BINS);
  const cb = new Float64Array(BINS);

  const triCount = p.length / 9;
  for (let i = 0; i < triCount; i++) {
    const b = i * 9;
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    let ux = ay * bz - az * by, uy = az * bx - ax * bz, uz = ax * by - ay * bx;
    const len = Math.hypot(ux, uy, uz);
    if (len === 0) continue;
    const area = 0.5 * len;
    ux /= len; uy /= len; uz /= len;

    const frac = ((p[b + axis] + p[b + 3 + axis] + p[b + 6 + axis]) / 3 - lo) / span;
    let bin = Math.floor(frac * BINS);
    if (bin < 0) bin = 0; else if (bin >= BINS) bin = BINS - 1;

    const nAxis = axis === 0 ? ux : axis === 1 ? uy : uz;
    flux[bin] += nAxis * area;
    areaBin[bin] += area;
    nx[bin] += ux * area; ny[bin] += uy * area; nz[bin] += uz * area;
    if (Math.abs(nAxis) > 0.94) flatBin[bin] += area;
    if (cols) {
      cr[bin] += cols[i * 3] * area;
      cg[bin] += cols[i * 3 + 1] * area;
      cb[bin] += cols[i * 3 + 2] * area;
    }
  }

  // Exact cross-section area via the divergence theorem.
  const crossArea = new Float32Array(BINS);
  let run = 0;
  for (let i = 0; i < BINS; i++) { run += flux[i]; crossArea[i] = Math.abs(run); }

  // Normal dispersion → surface detail / curvature density.
  const feature = new Float32Array(BINS);
  const flatness = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const a = areaBin[i];
    feature[i] = a > 0 ? 1 - Math.hypot(nx[i], ny[i], nz[i]) / a : 0;
    flatness[i] = a > 0 ? flatBin[i] / a : 0;
  }

  // Colour boundary strength: distance between neighbouring bins' mean colours.
  const colorEdge = new Float32Array(BINS);
  if (cols) {
    const mc: [number, number, number][] = [];
    let last: [number, number, number] = [0.7, 0.7, 0.72];
    for (let i = 0; i < BINS; i++) {
      if (areaBin[i] > 0) last = [cr[i] / areaBin[i], cg[i] / areaBin[i], cb[i] / areaBin[i]];
      mc.push(last);
    }
    for (let i = 1; i < BINS; i++) {
      const d = Math.hypot(mc[i][0] - mc[i - 1][0], mc[i][1] - mc[i - 1][1], mc[i][2] - mc[i - 1][2]);
      colorEdge[i] = Math.min(d / 0.55, 1);
    }
    smooth(colorEdge, 1);
    const mx = Math.max(...colorEdge, 1e-6);
    for (let i = 0; i < BINS; i++) colorEdge[i] /= mx;
  }

  smooth(crossArea, 3);
  smooth(feature, 4);
  smooth(flatness, 2);

  const maxCross = Math.max(...crossArea, 1e-9);
  const fb = clamp01(o.featureBias);
  const iso = clamp01(o.featureIsolation);
  const cw = cols ? clamp01(o.colorWeight) : 0;

  const cost = new Float32Array(BINS);
  for (let i = 0; i < BINS; i++) {
    const norm = crossArea[i] / maxCross;

    // R3/R4 base: small sections are cheap seams; sqrt keeps some bed contact.
    let c = 1.15 * Math.sqrt(norm);

    // R2 detail avoidance + flat-face reward.
    c += 0.85 * fb * feature[i];
    c -= 0.60 * fb * flatness[i];

    // R1 overhang: the upper piece flares outward above the seam.
    const prev = crossArea[Math.max(0, i - 3)];
    const next = crossArea[Math.min(BINS - 1, i + 3)];
    const slope = (next - prev) / maxCross;
    if (slope > 0) c += 0.55 * fb * Math.min(slope * 3, 1);

    // R4 neck: a true local minimum of the section curve.
    if (crossArea[i] <= prev && crossArea[i] <= next) c -= 0.30 * fb;

    // R4 colour: strong bonus on colour transitions — this is what turns
    // "hair vs. skin" into an actual cut.
    c -= 1.30 * cw * colorEdge[i];

    // R5 isolation: reward a deep, narrow waist relative to the lobes either
    // side of it (the classic nose / ear / head signature).
    const wide = Math.max(maxOf(crossArea, 0, i), maxOf(crossArea, i, BINS));
    const relief = wide > 1e-9 ? 1 - crossArea[i] / wide : 0;
    c -= 0.75 * iso * relief * relief;

    // Extremity guard — relaxed as isolation rises so tiny features can be cut.
    const edgeFrac = Math.min(i, BINS - 1 - i) / BINS;
    const guard = 0.075 * (1 - 0.75 * iso);
    if (edgeFrac < guard) c += (guard - edgeFrac) * 16;

    cost[i] = c;
  }

  return { axis, t, crossArea, feature, flatness, colorEdge, cost, bounds };
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

function maxOf(a: Float32Array, from: number, to: number) {
  let m = 0;
  for (let i = from; i < to; i++) if (a[i] > m) m = a[i];
  return m;
}

function smooth(arr: Float32Array, radius: number) {
  if (radius <= 0) return;
  const copy = Float32Array.from(arr);
  for (let i = 0; i < arr.length; i++) {
    let s = 0, w = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j < 0 || j >= arr.length) continue;
      s += copy[j]; w++;
    }
    arr[i] = s / w;
  }
}

/* ------------------------------------------------------------------ */
/* Best-cut search for a single piece                                  */
/* ------------------------------------------------------------------ */

export interface Candidate {
  axis: Axis;
  offset: number;
  cost: number;
  quality: number;
  reason: string;
  range: [number, number];
  profile: AxisProfile;
}

function allowedAxes(opts: PlannerOptions, depth: number): Axis[] {
  if (opts.axis === 'x') return [0];
  if (opts.axis === 'y') return [1];
  if (opts.axis === 'z') return [2];
  if (!opts.multiAxis) return [2];
  // Depth 0 favours the long axis anyway via the elongation term below.
  void depth;
  return [0, 1, 2];
}

export function bestCut(mesh: MeshData, opts: PlannerOptions, depth: number): Candidate | null {
  const bounds = computeBounds(mesh);
  const maxExtent = Math.max(...bounds.size, 1e-9);
  let best: Candidate | null = null;

  for (const axis of allowedAxes(opts, depth)) {
    const extent = bounds.size[axis];
    if (extent < maxExtent * 0.12) continue; // too thin to be worth cutting
    const profile = profileAxis(mesh, axis, opts);

    let bi = -1;
    let bc = Infinity;
    for (let i = 0; i < BINS; i++) {
      if (profile.cost[i] < bc) { bc = profile.cost[i]; bi = i; }
    }
    if (bi < 0) continue;

    // Prefer slicing across the piece's long axis (chunkier, stabler parts).
    let score = bc + 0.30 * (1 - extent / maxExtent);
    // Slight Z preference at the top level so new flats can meet the bed.
    if (axis === 2 && depth === 0) score -= 0.10;

    if (!best || score < best.cost) {
      best = {
        axis,
        offset: profile.t[bi],
        cost: score,
        quality: clamp01(1 - (bc + 0.35) / 1.6),
        reason: describe(profile, bi, !!mesh.colors),
        range: [
          bounds.min[axis] + bounds.size[axis] * 0.02,
          bounds.max[axis] - bounds.size[axis] * 0.02,
        ],
        profile,
      };
    }
  }
  return best;
}

function describe(pr: AxisProfile, i: number, colored: boolean): string {
  const bits: string[] = [];
  const maxCross = Math.max(...pr.crossArea, 1e-9);
  if (colored && pr.colorEdge[i] > 0.45) bits.push('colour boundary');
  if (pr.crossArea[i] < 0.35 * maxCross) bits.push('narrow neck');
  if (pr.flatness[i] > 0.25) bits.push('flat face');
  if (pr.feature[i] < 0.25) bits.push('low detail');
  const prev = pr.crossArea[Math.max(0, i - 3)];
  const next = pr.crossArea[Math.min(pr.crossArea.length - 1, i + 3)];
  if (next < prev) bits.push('no overhang');
  return bits.length ? bits.join(' · ') : `${AXIS_NAME[pr.axis]} seam`;
}

/* ------------------------------------------------------------------ */
/* Execution: apply a plan tree to a mesh                              */
/* ------------------------------------------------------------------ */

export interface LeafPiece {
  leafId: string;
  mesh: MeshData;
}

export interface ExecResult {
  pieces: LeafPiece[];
  /** Bounds of the mesh arriving at each node — drives plane quads + sliders. */
  nodeBounds: Map<string, Bounds>;
  warnings: string[];
  connectorPairs: number;
}

function connectorOptions(opts: PlannerOptions): ConnectorOptions {
  return {
    count: opts.connectorCount,
    diameter: opts.connectorDiameter,
    depth: opts.connectorDepth,
    clearance: opts.connectorClearance,
  };
}

export function executePlan(mesh: MeshData, root: PlanNode, eps: number, opts?: PlannerOptions): ExecResult {
  const nodeBounds = new Map<string, Bounds>();
  const warnings: string[] = [];
  let connectorPairs = 0;

  /** Record bounds for a whole subtree without slicing (muted cuts). */
  const recordBounds = (m: MeshData, node: PlanNode) => {
    nodeBounds.set(node.id, computeBounds(m));
    if (node.kind === 'split') { recordBounds(m, node.a); recordBounds(m, node.b); }
  };

  const walk = (m: MeshData, node: PlanNode): LeafPiece[] => {
    nodeBounds.set(node.id, computeBounds(m));
    if (node.kind === 'leaf') return [{ leafId: node.id, mesh: m }];
    if (!node.enabled) {
      // Muted: pass the geometry through untouched, but keep descendant bounds
      // so their gizmos stay correctly sized if the user re-enables this cut.
      recordBounds(m, node.a);
      recordBounds(m, node.b);
      return [{ leafId: node.id, mesh: m }];
    }

    const normal: [number, number, number] = [0, 0, 0];
    normal[node.axis] = 1;
    const plane: CutPlane = { normal, constant: node.offset };
    try {
      const requestedConnectors = node.connectors && opts ? connectorOptions(opts) : undefined;
      const r = slicePlane(m, plane, eps, requestedConnectors);
      // The user may have dragged the plane clear of the geometry — then the
      // cut is a no-op and everything continues down the surviving branch.
      if (!r.positive && !r.negative) return [{ leafId: node.id, mesh: m }];
      if (!r.positive) { recordBounds(m, node.b); return walk(r.negative!, node.a); }
      if (!r.negative) { recordBounds(m, node.a); return walk(r.positive, node.b); }

      if (!r.manifold) warnings.push(`Cut ${node.id}: open boundary — cap may be imperfect.`);
      if (requestedConnectors) {
        connectorPairs += r.connectorCount;
        if (r.connectorCount < requestedConnectors.count) {
          warnings.push(
            `Cut ${node.id}: placed ${r.connectorCount}/${requestedConnectors.count} connector(s); the cut face is too small for more.`,
          );
        }
      }
      return [...walk(r.negative, node.a), ...walk(r.positive, node.b)];
    } catch (e) {
      warnings.push(`Cut ${node.id} failed: ${(e as Error).message}`);
      return [{ leafId: node.id, mesh: m }];
    }
  };

  const pieces = walk(mesh, root);
  return { pieces, nodeBounds, warnings, connectorPairs };
}

/* ------------------------------------------------------------------ */
/* Colour-region segmentation                                          */
/* ------------------------------------------------------------------ */

/**
 * Groups triangles into perceptual colour clusters. For a colour-authored OBJ
 * this alone yields exactly the print-ready parts (skin / hair / eyes / teeth).
 */
export function segmentByColor(mesh: MeshData, maxRegions = 24): { mesh: MeshData; color: string }[] {
  const cols = mesh.colors;
  if (!cols) return [];
  const triCount = cols.length / 3;

  // Quantise into a coarse RGB lattice, then merge lattice cells by popularity.
  const Q = 6;
  const buckets = new Map<number, number[]>();
  for (let i = 0; i < triCount; i++) {
    const r = Math.min(Q - 1, Math.floor(cols[i * 3] * Q));
    const g = Math.min(Q - 1, Math.floor(cols[i * 3 + 1] * Q));
    const b = Math.min(Q - 1, Math.floor(cols[i * 3 + 2] * Q));
    const k = (r * Q + g) * Q + b;
    const list = buckets.get(k);
    if (list) list.push(i); else buckets.set(k, [i]);
  }

  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const keep = sorted.slice(0, maxRegions);
  const spill = sorted.slice(maxRegions);

  // Fold rare colours into their nearest kept centroid.
  const centroids = keep.map(([, tris]) => {
    let r = 0, g = 0, b = 0;
    for (const t of tris) { r += cols[t * 3]; g += cols[t * 3 + 1]; b += cols[t * 3 + 2]; }
    return [r / tris.length, g / tris.length, b / tris.length] as [number, number, number];
  });
  const groups = keep.map(([, tris]) => [...tris]);
  for (const [, tris] of spill) {
    for (const t of tris) {
      let bi = 0, bd = Infinity;
      for (let ci = 0; ci < centroids.length; ci++) {
        const d =
          (centroids[ci][0] - cols[t * 3]) ** 2 +
          (centroids[ci][1] - cols[t * 3 + 1]) ** 2 +
          (centroids[ci][2] - cols[t * 3 + 2]) ** 2;
        if (d < bd) { bd = d; bi = ci; }
      }
      groups[bi].push(t);
    }
  }

  return groups
    .map((tris, i) => ({ mesh: extractTriangles(mesh, tris), color: rgbToHex(centroids[i]) }))
    .filter((g) => g.mesh.positions.length >= 9);
}

/* ------------------------------------------------------------------ */
/* Segments                                                            */
/* ------------------------------------------------------------------ */

export const PALETTE = [
  '#e0524f', '#4f9ee0', '#8fc46b', '#e0a94f', '#9b6fd6',
  '#3fb8a8', '#d96fa8', '#7a86d9', '#c9d14f', '#5fbf7a',
  '#d97c4f', '#6fc2d9', '#b45fd6', '#d9b45f', '#4f7bd9',
  '#a8d95f', '#d95f7c', '#5fd9b4', '#9c8f7a', '#7ad95f',
];

export interface Segment {
  id: number;
  leafId: string;
  name: string;
  mesh: MeshData;
  /** Display / export colour. */
  color: string;
  /** Colour sampled from the source model, when available. */
  sourceColor?: string;
  volume: number;
  triangles: number;
  centroid: [number, number, number];
  visible: boolean;
}

export interface SegmentationResult {
  segments: Segment[];
  root: PlanNode;
  nodeBounds: Map<string, Bounds>;
  warnings: string[];
  notes: string[];
  elapsedMs: number;
}

const tick = () => new Promise<void>((r) => setTimeout(r, 0));

function buildSegments(
  pieces: LeafPiece[],
  useSourceColor: boolean,
  explicitColors?: string[],
): { segments: Segment[]; dropped: number } {
  const vols = pieces.map((p) => Math.abs(signedVolume(p.mesh)));
  const total = vols.reduce((a, b) => a + b, 0) || 1;

  const kept: { piece: LeafPiece; volume: number; idx: number }[] = [];
  let dropped = 0;
  pieces.forEach((piece, i) => {
    if (pieces.length > 2 && vols[i] / total < 0.0003) { dropped++; return; }
    kept.push({ piece, volume: vols[i], idx: i });
  });
  kept.sort((a, b) => b.volume - a.volume);

  const segments = kept.map((k, i) => {
    const src = rgbToHex(meanColor(k.piece.mesh));
    return {
      id: i,
      leafId: k.piece.leafId,
      name: `part_${String(i + 1).padStart(2, '0')}`,
      mesh: k.piece.mesh,
      color: explicitColors?.[k.idx] ?? (useSourceColor ? src : PALETTE[i % PALETTE.length]),
      sourceColor: k.piece.mesh.colors ? src : undefined,
      volume: k.volume,
      triangles: k.piece.mesh.positions.length / 9,
      centroid: centroid(k.piece.mesh),
      visible: true,
    } as Segment;
  });

  return { segments, dropped };
}

function appendSolidityWarnings(segments: Segment[], warnings: string[]) {
  const open = segments
    .map((segment) => ({ segment, topology: analyzeMeshTopology(segment.mesh) }))
    .filter(({ topology }) => !topology.isSolid);
  for (const { segment, topology } of open.slice(0, 4)) {
    warnings.push(
      `${segment.name} is not solid (${topology.boundaryEdges} boundary, ${topology.nonManifoldEdges} non-manifold edge(s)).`,
    );
  }
  if (open.length > 4) warnings.push(`${open.length - 4} additional non-solid part(s) detected.`);
}

/* ------------------------------------------------------------------ */
/* Main entry: plan + execute                                          */
/* ------------------------------------------------------------------ */

export async function runSegmentation(
  mesh: MeshData,
  opts: PlannerOptions,
  onProgress?: (pct: number, label: string) => void,
): Promise<SegmentationResult> {
  const start = performance.now();
  const prepared = prepareMeshForSlicing(mesh, opts);
  mesh = prepared.mesh;
  const warnings: string[] = [...prepared.warnings];
  const notes: string[] = [...prepared.notes];
  const bounds = computeBounds(mesh);
  const eps = (Math.hypot(...bounds.size) || 1) * 2e-6;

  /* ---- Colour-region mode: no geometry cutting required ---- */
  if (opts.mode === 'color') {
    onProgress?.(20, 'Clustering colour regions…');
    await tick();
    if (!mesh.colors) {
      throw new Error('This model has no colour data. Load a colour-authored 3MF or an OBJ with vertex colours/MTL.');
    }
    let regions = segmentByColor(mesh, Math.max(2, opts.parts));
    notes.push(`${regions.length} colour region(s) detected`);
    if (opts.separateLooseParts) {
      onProgress?.(60, 'Separating shells within regions…');
      await tick();
      const expanded: typeof regions = [];
      for (const r of regions) {
        const shells = splitConnectedComponents(r.mesh, 48);
        if (shells.length > 1) expanded.push(...shells.map((m) => ({ mesh: m, color: r.color })));
        else expanded.push(r);
      }
      regions = expanded;
      notes.push(`${regions.length} printable part(s) after shell separation`);
    }
    const pieces: LeafPiece[] = regions.map((r, i) => ({ leafId: `color${i}`, mesh: r.mesh }));
    const { segments, dropped } = buildSegments(pieces, true, regions.map((r) => r.color));
    if (dropped) warnings.push(`${dropped} negligible fragment(s) discarded.`);
    appendSolidityWarnings(segments, warnings);
    onProgress?.(100, 'Done');
    return {
      segments, root: { kind: 'leaf', id: 'root' }, nodeBounds: new Map(),
      warnings, notes, elapsedMs: performance.now() - start,
    };
  }

  /* ---- Topology mode ---- */
  if (opts.mode === 'components') {
    onProgress?.(30, 'Detecting disconnected shells…');
    await tick();
    const shells = splitConnectedComponents(mesh, 128);
    notes.push(`${shells.length} disconnected shell(s) found`);
    const pieces: LeafPiece[] = shells.map((m, i) => ({ leafId: `shell${i}`, mesh: m }));
    const { segments, dropped } = buildSegments(pieces, false);
    if (dropped) warnings.push(`${dropped} negligible shell(s) discarded.`);
    appendSolidityWarnings(segments, warnings);
    onProgress?.(100, 'Done');
    return {
      segments, root: { kind: 'leaf', id: 'root' }, nodeBounds: new Map(),
      warnings, notes, elapsedMs: performance.now() - start,
    };
  }

  /* ---- Recursive BSP planning ---- */
  onProgress?.(5, 'Analysing topology…');
  await tick();

  interface Entry {
    node: PlanLeaf;
    mesh: MeshData;
    depth: number;
    volume: number;
    cand?: Candidate | null;
    parentPatch: (n: PlanNode) => void;
  }

  let root: PlanNode = { kind: 'leaf', id: nextId('n') };
  const totalVolume = Math.abs(signedVolume(mesh)) || 1;

  const pool: Entry[] = [
    {
      node: root as PlanLeaf,
      mesh,
      depth: 0,
      volume: totalVolume,
      parentPatch: (n) => { root = n; },
    },
  ];

  const target = Math.max(2, Math.round(opts.parts));
  const maxDepth = 8;

  while (pool.length < target) {
    // Score every unsplit leaf for "how badly does this want dividing".
    let pick = -1;
    let pickScore = -Infinity;
    for (let i = 0; i < pool.length; i++) {
      const e = pool[i];
      if (e.cand === null) continue; // known unsplittable
      if (e.depth >= maxDepth) continue;
      if (e.cand === undefined) {
        if (opts.mode === 'uniform') {
          e.cand = uniformCut(e.mesh, opts);
        } else {
          e.cand = bestCut(e.mesh, opts, e.depth);
        }
      }
      if (!e.cand) continue;
      const volShare = e.volume / totalVolume;
      const b = computeBounds(e.mesh);
      const elong = Math.max(...b.size) / Math.max(Math.min(...b.size), 1e-9);
      // Big, elongated pieces with a cheap available seam go first.
      const score =
        Math.cbrt(volShare) * (1 + 0.35 * Math.min(elong, 6)) * (0.35 + e.cand.quality);
      if (score > pickScore) { pickScore = score; pick = i; }
    }
    if (pick < 0) { notes.push('Stopped early — no further high-quality seams available.'); break; }

    const entry = pool[pick];
    const cand = entry.cand!;
    const normal: [number, number, number] = [0, 0, 0];
    normal[cand.axis] = 1;

    let res;
    try {
      res = slicePlane(entry.mesh, { normal, constant: cand.offset }, eps);
    } catch (e) {
      warnings.push(`Slice failed: ${(e as Error).message}`);
      entry.cand = null;
      continue;
    }
    if (!res.positive || !res.negative) { entry.cand = null; continue; }

    const vA = Math.abs(signedVolume(res.negative));
    const vB = Math.abs(signedVolume(res.positive));
    // Reject useless slivers, but allow genuinely small features (nose/ear)
    // when isolation is turned up.
    const minShare = 0.004 * (1 - 0.8 * clamp01(opts.featureIsolation));
    if (Math.min(vA, vB) / totalVolume < minShare) { entry.cand = null; continue; }

    const leafA: PlanLeaf = { kind: 'leaf', id: nextId('n') };
    const leafB: PlanLeaf = { kind: 'leaf', id: nextId('n') };
    const split: PlanSplit = {
      kind: 'split',
      id: nextId('c'),
      axis: cand.axis,
      offset: cand.offset,
      enabled: true,
      connectors: false,
      quality: cand.quality,
      reason: cand.reason,
      range: cand.range,
      depth: entry.depth,
      a: leafA,
      b: leafB,
    };
    entry.parentPatch(split);

    pool.splice(pick, 1,
      {
        node: leafA, mesh: res.negative, depth: entry.depth + 1, volume: vA,
        parentPatch: (n) => { split.a = n; },
      },
      {
        node: leafB, mesh: res.positive, depth: entry.depth + 1, volume: vB,
        parentPatch: (n) => { split.b = n; },
      },
    );

    onProgress?.(10 + (pool.length / target) * 70, `Placing seam ${pool.length - 1}/${target - 1}…`);
    await tick();
  }

  /* ---- Collect ---- */
  onProgress?.(85, 'Separating & validating…');
  await tick();

  let pieces: LeafPiece[] = pool.map((e) => ({ leafId: e.node.id, mesh: e.mesh }));

  if (opts.separateLooseParts) {
    const expanded: LeafPiece[] = [];
    for (const p of pieces) {
      const shells = splitConnectedComponents(p.mesh, 32);
      if (shells.length > 1) {
        notes.push(`${shells.length} loose shells separated from one piece`);
        shells.forEach((m, i) => expanded.push({ leafId: `${p.leafId}_s${i}`, mesh: m }));
      } else expanded.push(p);
    }
    pieces = expanded;
  }

  const { segments, dropped } = buildSegments(pieces, false);
  if (dropped) warnings.push(`${dropped} negligible fragment(s) discarded (<0.03% volume).`);
  appendSolidityWarnings(segments, warnings);

  const splits = flattenSplits(root);
  const axes = new Set(splits.map((s) => s.axis));
  notes.unshift(
    `${splits.length} cut${splits.length === 1 ? '' : 's'} across ${axes.size} axis/axes (${[...axes].map((a) => AXIS_NAME[a]).join(', ') || '—'})`,
  );
  if (mesh.colors) notes.push('Colour boundaries factored into seam placement');

  const nodeBounds = executePlan(mesh, root, eps, opts).nodeBounds;

  onProgress?.(100, 'Done');
  return { segments, root, nodeBounds, warnings, notes, elapsedMs: performance.now() - start };
}

/** Even split of the current piece along its longest allowed axis. */
function uniformCut(mesh: MeshData, opts: PlannerOptions): Candidate | null {
  const b = computeBounds(mesh);
  const axes = allowedAxes(opts, 0);
  let axis = axes[0];
  for (const a of axes) if (b.size[a] > b.size[axis]) axis = a;
  if (b.size[axis] < 1e-6) return null;
  return {
    axis,
    offset: b.center[axis],
    cost: 0.5,
    quality: 0.5,
    reason: 'even split',
    range: [b.min[axis] + b.size[axis] * 0.02, b.max[axis] - b.size[axis] * 0.02],
    profile: profileAxis(mesh, axis, opts),
  };
}

/**
 * Re-run only the geometry for an edited plan tree (used when a cut is dragged,
 * disabled or deleted). Much cheaper than replanning.
 */
export function reapplyPlan(
  mesh: MeshData,
  root: PlanNode,
  opts: PlannerOptions,
): SegmentationResult {
  const start = performance.now();
  const prepared = prepareMeshForSlicing(mesh, opts);
  mesh = prepared.mesh;
  const bounds = computeBounds(mesh);
  const eps = (Math.hypot(...bounds.size) || 1) * 2e-6;
  const exec = executePlan(mesh, root, eps, opts);

  let pieces = exec.pieces;
  if (opts.separateLooseParts) {
    const expanded: LeafPiece[] = [];
    for (const p of pieces) {
      const shells = splitConnectedComponents(p.mesh, 32);
      if (shells.length > 1) shells.forEach((m, i) => expanded.push({ leafId: `${p.leafId}_s${i}`, mesh: m }));
      else expanded.push(p);
    }
    pieces = expanded;
  }

  const { segments, dropped } = buildSegments(pieces, false);
  const warnings = [...prepared.warnings, ...exec.warnings];
  if (dropped) warnings.push(`${dropped} negligible fragment(s) discarded.`);
  appendSolidityWarnings(segments, warnings);

  const splits = flattenSplits(root);
  const notes = [...prepared.notes, `${splits.filter((s) => s.enabled).length} active cut(s) applied`];
  if (exec.connectorPairs) notes.push(`${exec.connectorPairs} guide peg/socket pair(s) generated.`);
  return {
    segments,
    root,
    nodeBounds: exec.nodeBounds,
    warnings,
    notes,
    elapsedMs: performance.now() - start,
  };
}

/** Plan a single additional cut inside an existing leaf. */
export function planLeafSplit(leafMesh: MeshData, opts: PlannerOptions, depth: number): PlanSplit | null {
  const cand = bestCut(leafMesh, opts, depth);
  if (!cand) return null;
  return {
    kind: 'split',
    id: nextId('c'),
    axis: cand.axis,
    offset: cand.offset,
    enabled: true,
    connectors: false,
    quality: cand.quality,
    reason: cand.reason,
    range: cand.range,
    depth,
    a: { kind: 'leaf', id: nextId('n') },
    b: { kind: 'leaf', id: nextId('n') },
  };
}
