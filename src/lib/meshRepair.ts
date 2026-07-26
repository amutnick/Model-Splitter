/** Mesh topology diagnostics and conservative boundary-hole repair. */
import { ShapeUtils, Vector2 } from 'three';
import type { MeshData } from './stlIO';
import { computeBounds, meanColor, signedVolume } from './meshUtils';

export interface MeshTopology {
  triangles: number;
  weldedVertices: number;
  edges: number;
  boundaryEdges: number;
  nonManifoldEdges: number;
  inconsistentEdges: number;
  isWatertight: boolean;
  hasVolume: boolean;
  isSolid: boolean;
}

export interface MeshRepairResult {
  mesh: MeshData;
  before: MeshTopology;
  after: MeshTopology;
  repairedLoops: number;
  skippedLoops: number;
  addedTriangles: number;
}

type V3 = [number, number, number];

interface WeldVertex {
  point: V3;
  count: number;
}

interface EdgeInfo {
  a: number;
  b: number;
  count: number;
  orientation: number;
  from: number;
  to: number;
}

interface EdgeData {
  vertices: WeldVertex[];
  edges: EdgeInfo[];
  tolerance: number;
}

function buildEdgeData(mesh: MeshData): EdgeData {
  const bounds = computeBounds(mesh);
  const diagonal = Math.hypot(...bounds.size) || 1;
  const tolerance = Math.max(diagonal * 1e-6, 1e-8);
  const scale = 1 / tolerance;
  const vertexMap = new Map<string, number>();
  const vertices: WeldVertex[] = [];
  const vertexIds = new Int32Array(mesh.positions.length / 3);

  for (let i = 0; i < mesh.positions.length; i += 3) {
    const x = mesh.positions[i], y = mesh.positions[i + 1], z = mesh.positions[i + 2];
    const key = `${Math.round(x * scale)},${Math.round(y * scale)},${Math.round(z * scale)}`;
    let id = vertexMap.get(key);
    if (id === undefined) {
      id = vertices.length;
      vertexMap.set(key, id);
      vertices.push({ point: [x, y, z], count: 1 });
    } else {
      const vertex = vertices[id];
      const count = vertex.count + 1;
      vertex.point = [
        vertex.point[0] + (x - vertex.point[0]) / count,
        vertex.point[1] + (y - vertex.point[1]) / count,
        vertex.point[2] + (z - vertex.point[2]) / count,
      ];
      vertex.count = count;
    }
    vertexIds[i / 3] = id;
  }

  const edgeMap = new Map<string, EdgeInfo>();
  const triCount = mesh.positions.length / 9;
  for (let triangle = 0; triangle < triCount; triangle++) {
    const base = triangle * 3;
    const ids = [vertexIds[base], vertexIds[base + 1], vertexIds[base + 2]];
    for (let edge = 0; edge < 3; edge++) {
      const from = ids[edge];
      const to = ids[(edge + 1) % 3];
      if (from === to) continue;
      const a = Math.min(from, to), b = Math.max(from, to);
      const key = `${a},${b}`;
      const orientation = from === a ? 1 : -1;
      const existing = edgeMap.get(key);
      if (existing) {
        existing.count++;
        existing.orientation += orientation;
      } else {
        edgeMap.set(key, { a, b, count: 1, orientation, from, to });
      }
    }
  }

  return { vertices, edges: [...edgeMap.values()], tolerance };
}

function topologyFromData(mesh: MeshData, data: EdgeData): MeshTopology {
  let boundaryEdges = 0;
  let nonManifoldEdges = 0;
  let inconsistentEdges = 0;
  for (const edge of data.edges) {
    if (edge.count === 1) boundaryEdges++;
    else if (edge.count > 2) nonManifoldEdges++;
    else if (edge.count === 2 && Math.abs(edge.orientation) === 2) inconsistentEdges++;
  }
  const volume = Math.abs(signedVolume(mesh));
  const bounds = computeBounds(mesh);
  const scaleVolume = Math.max(bounds.size[0] * bounds.size[1] * bounds.size[2], 1e-12);
  const hasVolume = volume > scaleVolume * 1e-10;
  const isWatertight = boundaryEdges === 0 && nonManifoldEdges === 0;
  return {
    triangles: mesh.positions.length / 9,
    weldedVertices: data.vertices.length,
    edges: data.edges.length,
    boundaryEdges,
    nonManifoldEdges,
    inconsistentEdges,
    isWatertight,
    hasVolume,
    isSolid: isWatertight && inconsistentEdges === 0 && hasVolume,
  };
}

export function analyzeMeshTopology(mesh: MeshData): MeshTopology {
  return topologyFromData(mesh, buildEdgeData(mesh));
}

function normalize(v: V3): V3 | null {
  const length = Math.hypot(...v);
  return length > 1e-12 ? [v[0] / length, v[1] / length, v[2] / length] : null;
}

function newell(points: V3[]): V3 | null {
  let x = 0, y = 0, z = 0;
  for (let i = 0; i < points.length; i++) {
    const current = points[i];
    const next = points[(i + 1) % points.length];
    x += (current[1] - next[1]) * (current[2] + next[2]);
    y += (current[2] - next[2]) * (current[0] + next[0]);
    z += (current[0] - next[0]) * (current[1] + next[1]);
  }
  return normalize([x, y, z]);
}

function basis(normal: V3): { u: V3; v: V3 } {
  const helper: V3 = Math.abs(normal[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  const u = normalize([
    normal[1] * helper[2] - normal[2] * helper[1],
    normal[2] * helper[0] - normal[0] * helper[2],
    normal[0] * helper[1] - normal[1] * helper[0],
  ]) ?? [1, 0, 0];
  return {
    u,
    v: [
      normal[1] * u[2] - normal[2] * u[1],
      normal[2] * u[0] - normal[0] * u[2],
      normal[0] * u[1] - normal[1] * u[0],
    ],
  };
}

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

function triangleNormal(a: V3, b: V3, c: V3): V3 {
  return [
    (b[1] - a[1]) * (c[2] - a[2]) - (b[2] - a[2]) * (c[1] - a[1]),
    (b[2] - a[2]) * (c[0] - a[0]) - (b[0] - a[0]) * (c[2] - a[2]),
    (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]),
  ];
}

/**
 * Fill simple boundary loops. Non-manifold edges and self-intersecting or
 * branched boundaries are left untouched and reported by the returned stats.
 */
export function repairBoundaryHoles(mesh: MeshData, maxLoops = 256): MeshRepairResult {
  const data = buildEdgeData(mesh);
  const before = topologyFromData(mesh, data);
  if (before.boundaryEdges === 0) {
    return { mesh, before, after: before, repairedLoops: 0, skippedLoops: 0, addedTriangles: 0 };
  }

  const boundary = data.edges.filter((edge) => edge.count === 1);
  const adjacency = new Map<number, number[]>();
  boundary.forEach((edge, index) => {
    const a = adjacency.get(edge.a); if (a) a.push(index); else adjacency.set(edge.a, [index]);
    const b = adjacency.get(edge.b); if (b) b.push(index); else adjacency.set(edge.b, [index]);
  });

  const used = new Uint8Array(boundary.length);
  const loops: number[][] = [];
  let skippedLoops = 0;

  for (let startEdge = 0; startEdge < boundary.length && loops.length < maxLoops; startEdge++) {
    if (used[startEdge]) continue;
    const first = boundary[startEdge];
    const loop = [first.from, first.to];
    used[startEdge] = 1;
    let current = first.to;
    const start = first.from;
    let closed = false;
    let guard = 0;

    while (guard++ <= boundary.length) {
      if (current === start) { closed = true; break; }
      const incident = adjacency.get(current) ?? [];
      if (incident.length !== 2) break;
      const nextEdge = incident.find((index) => !used[index]);
      if (nextEdge === undefined) break;
      used[nextEdge] = 1;
      const edge = boundary[nextEdge];
      current = edge.a === current ? edge.b : edge.a;
      if (current !== start) loop.push(current);
    }

    if (closed && loop.length >= 3) loops.push(loop);
    else skippedLoops++;
  }
  skippedLoops += boundary.some((_, index) => !used[index]) ? 1 : 0;

  const additions: number[] = [];
  let repairedLoops = 0;
  for (const loop of loops) {
    const points = loop.map((id) => data.vertices[id].point);
    const boundaryNormal = newell(points);
    if (!boundaryNormal) { skippedLoops++; continue; }
    const capNormal: V3 = [-boundaryNormal[0], -boundaryNormal[1], -boundaryNormal[2]];
    const { u, v } = basis(capNormal);
    const projected = points.map((point) => new Vector2(dot(point, u), dot(point, v)));
    const faces = ShapeUtils.triangulateShape(projected, []);
    if (!faces.length) { skippedLoops++; continue; }

    let added = 0;
    for (const face of faces) {
      let a = points[face[0]], b = points[face[1]], c = points[face[2]];
      if (!a || !b || !c) continue;
      if (dot(triangleNormal(a, b, c), capNormal) < 0) [b, c] = [c, b];
      additions.push(...a, ...b, ...c);
      added++;
    }
    if (added) repairedLoops++;
  }

  if (!additions.length) {
    return { mesh, before, after: before, repairedLoops: 0, skippedLoops, addedTriangles: 0 };
  }

  const positions = new Float32Array(mesh.positions.length + additions.length);
  positions.set(mesh.positions);
  positions.set(additions, mesh.positions.length);

  let colors: Float32Array | undefined;
  if (mesh.colors) {
    const addedTriangles = additions.length / 9;
    colors = new Float32Array(mesh.colors.length + addedTriangles * 3);
    colors.set(mesh.colors);
    const capColor = meanColor(mesh);
    for (let i = mesh.colors.length; i < colors.length; i += 3) colors.set(capColor, i);
  }

  const repaired = colors ? { positions, colors } : { positions };
  const after = analyzeMeshTopology(repaired);
  return {
    mesh: repaired,
    before,
    after,
    repairedLoops,
    skippedLoops,
    addedTriangles: additions.length / 9,
  };
}
