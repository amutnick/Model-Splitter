import { describe, expect, it } from 'vitest';
import type { MeshData } from './stlIO';
import { analyzeMeshTopology, repairBoundaryHoles } from './meshRepair';
import { computeBounds } from './meshUtils';
import { DEFAULT_OPTIONS, prepareMeshForSlicing, reapplyPlan, type PlanNode } from './autoSegment';
import { slicePlane } from './slicePlane';

const cubeTriangles = [
  // bottom (-Z)
  0, 0, 0, 0, 1, 0, 1, 1, 0,
  0, 0, 0, 1, 1, 0, 1, 0, 0,
  // top (+Z)
  0, 0, 1, 1, 0, 1, 1, 1, 1,
  0, 0, 1, 1, 1, 1, 0, 1, 1,
  // left (-X)
  0, 0, 0, 0, 0, 1, 0, 1, 1,
  0, 0, 0, 0, 1, 1, 0, 1, 0,
  // right (+X)
  1, 0, 0, 1, 1, 0, 1, 1, 1,
  1, 0, 0, 1, 1, 1, 1, 0, 1,
  // front (-Y)
  0, 0, 0, 1, 0, 0, 1, 0, 1,
  0, 0, 0, 1, 0, 1, 0, 0, 1,
  // back (+Y)
  0, 1, 0, 0, 1, 1, 1, 1, 1,
  0, 1, 0, 1, 1, 1, 1, 1, 0,
];

const cube = (): MeshData => ({ positions: new Float32Array(cubeTriangles) });

// Remove the two top triangles while retaining a consistently wound boundary.
const openCube = (): MeshData => ({
  positions: new Float32Array([...cubeTriangles.slice(0, 18), ...cubeTriangles.slice(36)]),
});

describe('mesh topology repair', () => {
  it('detects and closes a simple boundary loop', () => {
    const before = analyzeMeshTopology(openCube());
    expect(before.isSolid).toBe(false);
    expect(before.boundaryEdges).toBe(4);

    const repair = repairBoundaryHoles(openCube());
    expect(repair.repairedLoops).toBe(1);
    expect(repair.addedTriangles).toBe(2);
    expect(repair.after.boundaryEdges).toBe(0);
    expect(repair.after.nonManifoldEdges).toBe(0);
    expect(repair.after.isSolid).toBe(true);
  });

  it('repairs open input only when the option is enabled', () => {
    const untouched = prepareMeshForSlicing(openCube(), { ...DEFAULT_OPTIONS, repairOpenMeshes: false });
    expect(untouched.topology.isSolid).toBe(false);
    expect(untouched.warnings.join(' ')).toContain('Enable “Repair open mesh”');

    const prepared = prepareMeshForSlicing(openCube(), { ...DEFAULT_OPTIONS, repairOpenMeshes: true });
    expect(prepared.topology.isSolid).toBe(true);
    expect(prepared.notes.join(' ')).toContain('validated as watertight');
  });

  it('keeps both halves solid when adding guide pegs and sockets', () => {
    expect(analyzeMeshTopology(cube()).isSolid).toBe(true);
    const result = slicePlane(
      cube(),
      { normal: [0, 0, 1], constant: 0.5 },
      1e-6,
      { count: 2, diameter: 0.2, depth: 0.2, clearance: 0.02 },
    );

    expect(result.manifold).toBe(true);
    expect(result.connectorCount).toBe(2);
    expect(result.positive).not.toBeNull();
    expect(result.negative).not.toBeNull();
    expect(analyzeMeshTopology(result.positive!).isSolid).toBe(true);
    expect(analyzeMeshTopology(result.negative!).isSolid).toBe(true);
    expect(computeBounds(result.negative!).max[2]).toBeCloseTo(0.7, 5);
  });

  it('adds connectors only to cuts that opt in', () => {
    const root: PlanNode = {
      kind: 'split',
      id: 'cut1',
      axis: 2,
      offset: 0.5,
      enabled: true,
      connectors: true,
      quality: 1,
      reason: 'test',
      range: [0.1, 0.9],
      depth: 0,
      a: { kind: 'leaf', id: 'a' },
      b: { kind: 'leaf', id: 'b' },
    };
    const options = {
      ...DEFAULT_OPTIONS,
      separateLooseParts: false,
      connectorCount: 1,
      connectorDiameter: 0.2,
      connectorDepth: 0.2,
      connectorClearance: 0.02,
    };
    const result = reapplyPlan(cube(), root, options);
    const withoutConnectors = reapplyPlan(cube(), { ...root, connectors: false }, options);
    expect(result.segments).toHaveLength(2);
    expect(result.notes.join(' ')).toContain('1 guide peg/socket pair');
    expect(withoutConnectors.notes.join(' ')).not.toContain('guide peg/socket');
    expect(result.segments.reduce((sum, segment) => sum + segment.triangles, 0)).toBeGreaterThan(
      withoutConnectors.segments.reduce((sum, segment) => sum + segment.triangles, 0),
    );
    expect(result.segments.every((segment) => analyzeMeshTopology(segment.mesh).isSolid)).toBe(true);
  });
});
