/**
 * Half-space partition of a triangle soup with watertight cap generation.
 * Optional cylindrical alignment pegs are built into the negative half and
 * matching clearance sockets are cut into the positive half.
 */
import { ShapeUtils, Vector2 } from 'three';
import type { MeshData } from './stlIO';

export interface CutPlane {
  /** Unit normal. */
  normal: [number, number, number];
  /** Plane satisfies dot(normal, p) = constant. */
  constant: number;
}

export interface ConnectorOptions {
  count: number;
  diameter: number;
  depth: number;
  /** Radial clearance added to the matching socket. */
  clearance: number;
}

export interface SliceResult {
  positive: MeshData | null;
  negative: MeshData | null;
  /** Area of the generated cap before connector holes. */
  capArea: number;
  /** True when the cut produced properly closed boundary loops. */
  manifold: boolean;
  /** Number of peg/socket pairs placed on this cut. */
  connectorCount: number;
}

type V3 = [number, number, number];

interface CapGroup {
  contour2: Vector2[];
  contour3: V3[];
  holes2: Vector2[][];
  holes3: V3[][];
}

interface ConnectorPlacement {
  group: number;
  center2: Vector2;
  center3: V3;
  pegRadius: number;
  socketRadius: number;
  depth: number;
}

interface CapResult {
  positiveTris: number[];
  negativeTris: number[];
  area: number;
  closed: boolean;
  placements: ConnectorPlacement[];
  u: V3;
  v: V3;
}

const dot = (n: V3, x: number, y: number, z: number) => n[0] * x + n[1] * y + n[2] * z;

/** Build an orthonormal basis (u, v) such that u × v = n. */
function planeBasis(n: V3): { u: V3; v: V3 } {
  const helper: V3 = Math.abs(n[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0];
  let ux = n[1] * helper[2] - n[2] * helper[1];
  let uy = n[2] * helper[0] - n[0] * helper[2];
  let uz = n[0] * helper[1] - n[1] * helper[0];
  const length = Math.hypot(ux, uy, uz) || 1;
  ux /= length; uy /= length; uz /= length;
  return {
    u: [ux, uy, uz],
    v: [n[1] * uz - n[2] * uy, n[2] * ux - n[0] * uz, n[0] * uy - n[1] * ux],
  };
}

function polygonArea2(points: Vector2[]): number {
  let area = 0;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    area += (points[j].x + points[i].x) * (points[j].y - points[i].y);
  }
  return area / 2;
}

function pointInPolygon(point: Vector2, polygon: Vector2[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const xi = polygon[i].x, yi = polygon[i].y;
    const xj = polygon[j].x, yj = polygon[j].y;
    if ((yi > point.y) !== (yj > point.y) && point.x < ((xj - xi) * (point.y - yi)) / (yj - yi || 1e-12) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/** Partition `mesh` by `plane`. `eps` is an absolute tolerance in model units. */
export function slicePlane(
  mesh: MeshData,
  plane: CutPlane,
  eps = 1e-5,
  connectors?: ConnectorOptions,
): SliceResult {
  const positions = mesh.positions;
  const sourceColors = mesh.colors;
  const normal = plane.normal;
  const constant = plane.constant;
  const triCount = positions.length / 9;

  const positive: number[] = [];
  const negative: number[] = [];
  const positiveColors: number[] = [];
  const negativeColors: number[] = [];
  const segments: number[] = [];

  const triangle: number[][] = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const color: V3 = [0.7, 0.7, 0.72];
  let availablePositiveDepth = 0;

  for (let triangleIndex = 0; triangleIndex < triCount; triangleIndex++) {
    const base = triangleIndex * 9;
    let positiveVertices = 0, negativeVertices = 0;
    for (let vertex = 0; vertex < 3; vertex++) {
      const x = positions[base + vertex * 3];
      const y = positions[base + vertex * 3 + 1];
      const z = positions[base + vertex * 3 + 2];
      let distance = dot(normal, x, y, z) - constant;
      availablePositiveDepth = Math.max(availablePositiveDepth, distance);
      if (distance > -eps && distance < eps) distance = 0;
      else if (distance > 0) positiveVertices++;
      else negativeVertices++;
      triangle[vertex][0] = x;
      triangle[vertex][1] = y;
      triangle[vertex][2] = z;
      triangle[vertex][3] = distance;
    }
    if (sourceColors) {
      color[0] = sourceColors[triangleIndex * 3];
      color[1] = sourceColors[triangleIndex * 3 + 1];
      color[2] = sourceColors[triangleIndex * 3 + 2];
    }

    if (negativeVertices === 0) {
      pushTri(positive, triangle);
      if (sourceColors) positiveColors.push(...color);
      continue;
    }
    if (positiveVertices === 0) {
      pushTri(negative, triangle);
      if (sourceColors) negativeColors.push(...color);
      continue;
    }

    const above = clip(triangle, 1);
    const below = clip(triangle, -1);
    fanTriangulate(positive, above, sourceColors ? positiveColors : null, color);
    fanTriangulate(negative, below, sourceColors ? negativeColors : null, color);
    collectSegment(segments, above);
  }

  let capArea = 0;
  let manifold = true;
  let connectorCount = 0;
  if (segments.length >= 6 && positive.length && negative.length) {
    try {
      const usableConnectors = normalizeConnectorOptions(connectors, availablePositiveDepth, eps);
      const cap = buildCap(segments, normal, constant, eps, usableConnectors);
      capArea = cap.area;
      manifold = cap.closed;
      connectorCount = cap.placements.length;
      const positiveMean = meanColor(positiveColors);
      const negativeMean = meanColor(negativeColors);

      appendTriangles(positive, cap.positiveTris, true, sourceColors ? positiveColors : null, positiveMean);
      appendTriangles(negative, cap.negativeTris, false, sourceColors ? negativeColors : null, negativeMean);

      if (cap.placements.length) {
        const male = buildConnectorGeometry(cap.placements, normal, cap.u, cap.v, false);
        const sockets = buildConnectorGeometry(cap.placements, normal, cap.u, cap.v, true);
        appendTriangles(negative, male, false, sourceColors ? negativeColors : null, negativeMean);
        appendTriangles(positive, sockets, false, sourceColors ? positiveColors : null, positiveMean);
      }
    } catch {
      manifold = false;
    }
  }

  const build = (vertices: number[], colorsOut: number[]): MeshData | null =>
    vertices.length >= 9
      ? { positions: new Float32Array(vertices), ...(sourceColors ? { colors: new Float32Array(colorsOut) } : {}) }
      : null;

  return {
    positive: build(positive, positiveColors),
    negative: build(negative, negativeColors),
    capArea,
    manifold,
    connectorCount,
  };
}

function normalizeConnectorOptions(
  options: ConnectorOptions | undefined,
  availableDepth: number,
  eps: number,
): ConnectorOptions | undefined {
  if (!options) return undefined;
  const count = Math.max(0, Math.min(8, Math.round(options.count)));
  const diameter = Number.isFinite(options.diameter) ? Math.max(0, options.diameter) : 0;
  const clearance = Number.isFinite(options.clearance) ? Math.max(0, options.clearance) : 0;
  const requestedDepth = Number.isFinite(options.depth) ? Math.max(0, options.depth) : 0;
  const depth = Math.min(requestedDepth, Math.max(0, availableDepth * 0.45));
  if (!count || diameter <= eps * 8 || depth <= eps * 8) return undefined;
  return { count, diameter, clearance, depth };
}

function meanColor(colorsIn: number[]): V3 {
  if (!colorsIn.length) return [0.7, 0.7, 0.72];
  let red = 0, green = 0, blue = 0;
  for (let i = 0; i < colorsIn.length; i += 3) {
    red += colorsIn[i]; green += colorsIn[i + 1]; blue += colorsIn[i + 2];
  }
  const count = colorsIn.length / 3;
  return [red / count, green / count, blue / count];
}

function pushTri(out: number[], triangle: number[][]) {
  for (let i = 0; i < 3; i++) out.push(triangle[i][0], triangle[i][1], triangle[i][2]);
}

function appendTriangles(
  out: number[],
  triangles: number[],
  reverse: boolean,
  colorOut: number[] | null,
  color: V3,
) {
  for (let i = 0; i < triangles.length; i += 9) {
    if (reverse) {
      out.push(
        triangles[i], triangles[i + 1], triangles[i + 2],
        triangles[i + 6], triangles[i + 7], triangles[i + 8],
        triangles[i + 3], triangles[i + 4], triangles[i + 5],
      );
    } else {
      for (let offset = 0; offset < 9; offset++) out.push(triangles[i + offset]);
    }
    if (colorOut) colorOut.push(...color);
  }
}

/** Sutherland–Hodgman half-space clip. side = +1 keeps d >= 0. */
function clip(polygon: number[][], side: 1 | -1): number[][] {
  const out: number[][] = [];
  for (let i = 0; i < polygon.length; i++) {
    const current = polygon[i];
    const next = polygon[(i + 1) % polygon.length];
    const currentDistance = current[3] * side;
    const nextDistance = next[3] * side;
    if (currentDistance >= 0) out.push(current);
    if ((currentDistance > 0 && nextDistance < 0) || (currentDistance < 0 && nextDistance > 0)) {
      const amount = currentDistance / (currentDistance - nextDistance);
      out.push([
        current[0] + (next[0] - current[0]) * amount,
        current[1] + (next[1] - current[1]) * amount,
        current[2] + (next[2] - current[2]) * amount,
        0,
      ]);
    }
  }
  return out;
}

function fanTriangulate(out: number[], polygon: number[][], colorOut: number[] | null, color: V3) {
  for (let i = 2; i < polygon.length; i++) {
    out.push(
      polygon[0][0], polygon[0][1], polygon[0][2],
      polygon[i - 1][0], polygon[i - 1][1], polygon[i - 1][2],
      polygon[i][0], polygon[i][1], polygon[i][2],
    );
    if (colorOut) colorOut.push(...color);
  }
}

/** The two on-plane vertices of a clipped polygon form the cut chord. */
function collectSegment(segments: number[], polygon: number[][]) {
  const onPlane = polygon.filter((vertex) => vertex[3] === 0);
  if (onPlane.length !== 2) return;
  const [a, b] = onPlane;
  if (Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]) === 0) return;
  segments.push(a[0], a[1], a[2], b[0], b[1], b[2]);
}

function buildCap(
  segments: number[],
  normal: V3,
  constant: number,
  eps: number,
  connectors?: ConnectorOptions,
): CapResult {
  const tolerance = Math.max(eps * 4, 1e-9);
  const cell = tolerance * 2;
  const buckets = new Map<string, number[]>();
  const nodes: { point: V3; edges: number[] }[] = [];

  const weld = (x: number, y: number, z: number): number => {
    const cx = Math.floor(x / cell), cy = Math.floor(y / cell), cz = Math.floor(z / cell);
    const toleranceSquared = tolerance * tolerance;
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (let dz = -1; dz <= 1; dz++) {
          const list = buckets.get(`${cx + dx},${cy + dy},${cz + dz}`);
          if (!list) continue;
          for (const nodeIndex of list) {
            const point = nodes[nodeIndex].point;
            const xDistance = point[0] - x, yDistance = point[1] - y, zDistance = point[2] - z;
            if (xDistance * xDistance + yDistance * yDistance + zDistance * zDistance <= toleranceSquared) return nodeIndex;
          }
        }
      }
    }
    const index = nodes.length;
    nodes.push({ point: [x, y, z], edges: [] });
    const key = `${cx},${cy},${cz}`;
    const list = buckets.get(key);
    if (list) list.push(index); else buckets.set(key, [index]);
    return index;
  };

  const edges: { a: number; b: number; used: boolean }[] = [];
  for (let i = 0; i < segments.length; i += 6) {
    const a = weld(segments[i], segments[i + 1], segments[i + 2]);
    const b = weld(segments[i + 3], segments[i + 4], segments[i + 5]);
    if (a === b) continue;
    const index = edges.length;
    edges.push({ a, b, used: false });
    nodes[a].edges.push(index);
    nodes[b].edges.push(index);
  }

  const loops3: V3[][] = [];
  let closed = nodes.every((node) => node.edges.length === 2);
  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex++) {
    if (edges[edgeIndex].used) continue;
    const start = edges[edgeIndex].a;
    let current = edges[edgeIndex].b;
    edges[edgeIndex].used = true;
    const loop: V3[] = [nodes[start].point, nodes[current].point];
    let guard = 0;
    let wrapped = false;
    while (guard++ < 1_000_000) {
      const candidate = nodes[current].edges.find((index) => !edges[index].used);
      if (candidate === undefined) break;
      edges[candidate].used = true;
      current = edges[candidate].a === current ? edges[candidate].b : edges[candidate].a;
      if (current === start) { wrapped = true; break; }
      loop.push(nodes[current].point);
    }
    if (!wrapped) closed = false;
    if (loop.length >= 3) loops3.push(loop);
  }

  const { u, v } = planeBasis(normal);
  const loops2 = loops3.map((loop) => loop.map((point) => new Vector2(dot(u, ...point), dot(v, ...point))));
  const metadata = loops2.map((loop, index) => ({ index, area: Math.abs(polygonArea2(loop)) }));
  metadata.sort((a, b) => b.area - a.area);
  const isHole = new Array(loops2.length).fill(false);
  const holeOf = new Array<number>(loops2.length).fill(-1);
  for (let metaIndex = 0; metaIndex < metadata.length; metaIndex++) {
    const index = metadata[metaIndex].index;
    let depth = 0;
    let parent = -1;
    for (let larger = 0; larger < metaIndex; larger++) {
      const candidate = metadata[larger].index;
      if (pointInPolygon(loops2[index][0], loops2[candidate])) { depth++; parent = candidate; }
    }
    if (depth % 2 === 1) { isHole[index] = true; holeOf[index] = parent; }
  }

  const groups: CapGroup[] = [];
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
      let hole2 = loops2[j], hole3 = loops3[j];
      if (polygonArea2(hole2) > 0) {
        hole2 = [...hole2].reverse();
        hole3 = [...hole3].reverse();
      }
      holes2.push(hole2);
      holes3.push(hole3);
    }
    groups.push({ contour2, contour3, holes2, holes3 });
  }

  const base = triangulateGroups(groups, [], normal, u, v, constant);
  if (!base.triangles.length) closed = false;
  const placements = closed && connectors
    ? placeConnectors(groups, connectors, normal, u, v, constant, eps)
    : [];
  const negativeTris = placements.length
    ? triangulateGroups(groups, placements.map((placement) => ({ ...placement, radius: placement.pegRadius })), normal, u, v, constant).triangles
    : base.triangles;
  const positiveTris = placements.length
    ? triangulateGroups(groups, placements.map((placement) => ({ ...placement, radius: placement.socketRadius })), normal, u, v, constant).triangles
    : base.triangles;

  return { positiveTris, negativeTris, area: base.area, closed, placements, u, v };
}

function triangulateGroups(
  groups: CapGroup[],
  connectorHoles: (ConnectorPlacement & { radius: number })[],
  normal: V3,
  u: V3,
  v: V3,
  constant: number,
): { triangles: number[]; area: number } {
  const triangles: number[] = [];
  let area = 0;
  groups.forEach((group, groupIndex) => {
    const holes2 = [...group.holes2];
    const holes3 = [...group.holes3];
    for (const connector of connectorHoles) {
      if (connector.group !== groupIndex) continue;
      const circle = circleLoop(connector.center2, connector.radius, normal, u, v, constant);
      holes2.push(circle.points2);
      holes3.push(circle.points3);
    }
    const all3 = [...group.contour3, ...holes3.flat()];
    const faces = ShapeUtils.triangulateShape(group.contour2, holes2);
    for (const face of faces) {
      const a = all3[face[0]], b = all3[face[1]], c = all3[face[2]];
      if (!a || !b || !c) continue;
      triangles.push(...a, ...b, ...c);
      const first: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      const second: V3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
      area += 0.5 * Math.hypot(
        first[1] * second[2] - first[2] * second[1],
        first[2] * second[0] - first[0] * second[2],
        first[0] * second[1] - first[1] * second[0],
      );
    }
  });
  return { triangles, area };
}

function circleLoop(center: Vector2, radius: number, normal: V3, u: V3, v: V3, constant: number) {
  const points2: Vector2[] = [];
  const points3: V3[] = [];
  const sides = 24;
  for (let i = 0; i < sides; i++) {
    const angle = (i / sides) * Math.PI * 2;
    const x = center.x + Math.cos(angle) * radius;
    const y = center.y + Math.sin(angle) * radius;
    points2.push(new Vector2(x, y));
    points3.push([
      u[0] * x + v[0] * y + normal[0] * constant,
      u[1] * x + v[1] * y + normal[1] * constant,
      u[2] * x + v[2] * y + normal[2] * constant,
    ]);
  }
  return { points2, points3 };
}

function distanceToSegment(point: Vector2, a: Vector2, b: Vector2): number {
  const dx = b.x - a.x, dy = b.y - a.y;
  const lengthSquared = dx * dx + dy * dy;
  const amount = lengthSquared > 0
    ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSquared))
    : 0;
  return Math.hypot(point.x - (a.x + dx * amount), point.y - (a.y + dy * amount));
}

function boundaryClearance(point: Vector2, group: CapGroup): number {
  let clearance = Infinity;
  for (const loop of [group.contour2, ...group.holes2]) {
    for (let i = 0; i < loop.length; i++) {
      clearance = Math.min(clearance, distanceToSegment(point, loop[i], loop[(i + 1) % loop.length]));
    }
  }
  return clearance;
}

function placeConnectors(
  groups: CapGroup[],
  options: ConnectorOptions,
  normal: V3,
  u: V3,
  v: V3,
  constant: number,
  eps: number,
): ConnectorPlacement[] {
  if (!groups.length) return [];
  let groupIndex = 0;
  let bestArea = -Infinity;
  groups.forEach((group, index) => {
    const area = Math.abs(polygonArea2(group.contour2)) - group.holes2.reduce((sum, hole) => sum + Math.abs(polygonArea2(hole)), 0);
    if (area > bestArea) { bestArea = area; groupIndex = index; }
  });
  const group = groups[groupIndex];
  const pegRadius = options.diameter / 2;
  const socketRadius = pegRadius + options.clearance;
  const edgeMargin = socketRadius + Math.max(pegRadius * 0.3, eps * 12);
  const xs = group.contour2.map((point) => point.x);
  const ys = group.contour2.map((point) => point.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  if (maxX - minX < edgeMargin * 2 || maxY - minY < edgeMargin * 2) return [];

  const candidates: { point: Vector2; clearance: number }[] = [];
  const grid = 19;
  for (let yIndex = 1; yIndex < grid; yIndex++) {
    for (let xIndex = 1; xIndex < grid; xIndex++) {
      const point = new Vector2(
        minX + ((maxX - minX) * xIndex) / grid,
        minY + ((maxY - minY) * yIndex) / grid,
      );
      if (!pointInPolygon(point, group.contour2)) continue;
      if (group.holes2.some((hole) => pointInPolygon(point, hole))) continue;
      const clearance = boundaryClearance(point, group);
      if (clearance >= edgeMargin) candidates.push({ point, clearance });
    }
  }

  const selected: { point: Vector2; clearance: number }[] = [];
  const minimumSpacing = socketRadius * 2 + Math.max(pegRadius, options.clearance * 2);
  while (selected.length < options.count && candidates.length) {
    let bestIndex = -1, bestScore = -Infinity;
    candidates.forEach((candidate, index) => {
      const spacing = selected.length
        ? Math.min(...selected.map((other) => candidate.point.distanceTo(other.point)))
        : candidate.clearance;
      if (selected.length && spacing < minimumSpacing) return;
      const score = spacing + candidate.clearance * 0.25;
      if (score > bestScore) { bestScore = score; bestIndex = index; }
    });
    if (bestIndex < 0) break;
    selected.push(candidates.splice(bestIndex, 1)[0]);
  }

  return selected.map(({ point }) => ({
    group: groupIndex,
    center2: point,
    center3: [
      u[0] * point.x + v[0] * point.y + normal[0] * constant,
      u[1] * point.x + v[1] * point.y + normal[1] * constant,
      u[2] * point.x + v[2] * point.y + normal[2] * constant,
    ],
    pegRadius,
    socketRadius,
    depth: options.depth,
  }));
}

/** Build male peg surfaces or inward-facing female socket surfaces. */
function buildConnectorGeometry(
  placements: ConnectorPlacement[],
  normal: V3,
  u: V3,
  v: V3,
  socket: boolean,
): number[] {
  const triangles: number[] = [];
  const sides = 24;
  for (const placement of placements) {
    const radius = socket ? placement.socketRadius : placement.pegRadius;
    const base: V3[] = [];
    const end: V3[] = [];
    for (let i = 0; i < sides; i++) {
      const angle = (i / sides) * Math.PI * 2;
      const radial: V3 = [
        u[0] * Math.cos(angle) + v[0] * Math.sin(angle),
        u[1] * Math.cos(angle) + v[1] * Math.sin(angle),
        u[2] * Math.cos(angle) + v[2] * Math.sin(angle),
      ];
      const point: V3 = [
        placement.center3[0] + radial[0] * radius,
        placement.center3[1] + radial[1] * radius,
        placement.center3[2] + radial[2] * radius,
      ];
      base.push(point);
      end.push([
        point[0] + normal[0] * placement.depth,
        point[1] + normal[1] * placement.depth,
        point[2] + normal[2] * placement.depth,
      ]);
    }
    const endCenter: V3 = [
      placement.center3[0] + normal[0] * placement.depth,
      placement.center3[1] + normal[1] * placement.depth,
      placement.center3[2] + normal[2] * placement.depth,
    ];
    for (let i = 0; i < sides; i++) {
      const next = (i + 1) % sides;
      if (socket) {
        triangles.push(...base[i], ...end[next], ...base[next]);
        triangles.push(...base[i], ...end[i], ...end[next]);
        triangles.push(...endCenter, ...end[next], ...end[i]);
      } else {
        triangles.push(...base[i], ...base[next], ...end[next]);
        triangles.push(...base[i], ...end[next], ...end[i]);
        triangles.push(...endCenter, ...end[i], ...end[next]);
      }
    }
  }
  return triangles;
}
