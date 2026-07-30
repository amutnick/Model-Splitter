/** Unified STL / OBJ(+MTL) / 3MF ingestion pipeline. */
import { parseSTL, StlParseError, type MeshData } from './stlIO';
import { parseOBJ, parseMTL, ObjParseError, type MaterialMap, type Rgb } from './objIO';
import { parse3MF, ThreeMfParseError } from './threeMfIO';
import { analyzeMeshTopology, type MeshTopology } from './meshRepair';

export interface LoadedModel extends MeshData {
  name: string;
  format: 'stl' | 'obj' | '3mf';
  materials: { name: string; color: Rgb; triangles: number }[];
  hasVertexColors: boolean;
  usedMtl: boolean;
  notes: string[];
  topology: MeshTopology;
}

const MAX_BYTES = 300 * 1024 * 1024;

function finalize(model: Omit<LoadedModel, 'topology'>): LoadedModel {
  const topology = analyzeMeshTopology(model);
  const status = topology.isSolid
    ? 'Mesh topology check: solid and watertight.'
    : `Mesh topology check: open/non-solid (${topology.boundaryEdges} boundary, ${topology.nonManifoldEdges} non-manifold edge(s)).`;
  return { ...model, topology, notes: [status, ...model.notes] };
}

export async function loadModelFiles(files: File[]): Promise<LoadedModel> {
  const geometryFile = files.find((file) => /\.(stl|obj|3mf)$/i.test(file.name));
  if (!geometryFile) throw new Error('No .stl, .obj, or .3mf file found in the drop.');
  if (geometryFile.size > MAX_BYTES) {
    throw new Error(`"${geometryFile.name}" is ${(geometryFile.size / 1048576).toFixed(0)} MB — over the 300 MB safety limit.`);
  }

  const notes: string[] = [];

  if (/\.3mf$/i.test(geometryFile.name)) {
    try {
      const parsed = await parse3MF(await geometryFile.arrayBuffer());
      return finalize({
        positions: parsed.positions,
        ...(parsed.colors ? { colors: parsed.colors } : {}),
        name: geometryFile.name,
        format: '3mf',
        materials: parsed.materials,
        hasVertexColors: !!parsed.colors,
        usedMtl: false,
        notes: parsed.notes,
      });
    } catch (error) {
      if (error instanceof ThreeMfParseError) throw error;
      throw new ThreeMfParseError(`Could not read the 3MF file: ${(error as Error).message}`);
    }
  }

  if (/\.stl$/i.test(geometryFile.name)) {
    let buffer: ArrayBuffer;
    try {
      buffer = await geometryFile.arrayBuffer();
    } catch {
      throw new StlParseError('Could not read the file from disk (it may have been moved).');
    }
    const mesh = parseSTL(buffer);
    notes.push('STL has no colour data — using geometric analysis only.');
    return finalize({
      ...mesh,
      name: geometryFile.name,
      format: 'stl',
      materials: [],
      hasVertexColors: false,
      usedMtl: false,
      notes,
    });
  }

  let materialMap: MaterialMap | undefined;
  const materialFile = files.find((file) => /\.mtl$/i.test(file.name));
  if (materialFile) {
    try {
      materialMap = parseMTL(await materialFile.text());
      notes.push(`Loaded ${materialMap.size} material(s) from ${materialFile.name}.`);
    } catch {
      notes.push(`Could not read ${materialFile.name} — falling back to group names.`);
    }
  }

  let text: string;
  try {
    text = await geometryFile.text();
  } catch {
    throw new ObjParseError('Could not read the OBJ from disk.');
  }

  const parsed = parseOBJ(text, materialMap);
  if (parsed.hasVertexColors) notes.push('Per-vertex colours detected — colour-region analysis enabled.');
  else if (parsed.usedMtl) notes.push('MTL diffuse colours applied per material group.');
  else if (parsed.materials.length > 1) {
    notes.push(`No .mtl supplied — ${parsed.materials.length} groups auto-coloured by name/hash.`);
  } else {
    notes.push('No colour information found in this OBJ.');
  }

  return finalize({
    positions: parsed.positions,
    colors: parsed.colors,
    name: geometryFile.name,
    format: 'obj',
    materials: parsed.materials,
    hasVertexColors: parsed.hasVertexColors,
    usedMtl: parsed.usedMtl,
    notes,
  });
}
