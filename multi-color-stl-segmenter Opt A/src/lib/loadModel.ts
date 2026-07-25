/**
 * loadModel.ts — Unified STL / OBJ(+MTL) ingestion pipeline.
 * Accepts a multi-file drop so an OBJ can be paired with its material library.
 */
import { parseSTL, StlParseError, type MeshData } from './stlIO';
import { parseOBJ, parseMTL, ObjParseError, type MaterialMap, type Rgb } from './objIO';

export interface LoadedModel extends MeshData {
  name: string;
  format: 'stl' | 'obj';
  materials: { name: string; color: Rgb; triangles: number }[];
  hasVertexColors: boolean;
  usedMtl: boolean;
  notes: string[];
}

const MAX_BYTES = 300 * 1024 * 1024;

export async function loadModelFiles(files: File[]): Promise<LoadedModel> {
  const geoFile = files.find((f) => /\.(stl|obj)$/i.test(f.name));
  if (!geoFile) throw new Error('No .stl or .obj file found in the drop.');
  if (geoFile.size > MAX_BYTES) {
    throw new Error(`"${geoFile.name}" is ${(geoFile.size / 1048576).toFixed(0)} MB — over the 300 MB safety limit.`);
  }

  const notes: string[] = [];

  if (/\.stl$/i.test(geoFile.name)) {
    let buf: ArrayBuffer;
    try {
      buf = await geoFile.arrayBuffer();
    } catch {
      throw new StlParseError('Could not read the file from disk (it may have been moved).');
    }
    const mesh = parseSTL(buf);
    notes.push('STL has no colour data — using geometric analysis only.');
    return {
      ...mesh, name: geoFile.name, format: 'stl',
      materials: [], hasVertexColors: false, usedMtl: false, notes,
    };
  }

  // ---- OBJ (+ optional MTL) ----
  let mtl: MaterialMap | undefined;
  const mtlFile = files.find((f) => /\.mtl$/i.test(f.name));
  if (mtlFile) {
    try {
      mtl = parseMTL(await mtlFile.text());
      notes.push(`Loaded ${mtl.size} material(s) from ${mtlFile.name}.`);
    } catch {
      notes.push(`Could not read ${mtlFile.name} — falling back to group names.`);
    }
  }

  let text: string;
  try {
    text = await geoFile.text();
  } catch {
    throw new ObjParseError('Could not read the OBJ from disk.');
  }

  const parsed = parseOBJ(text, mtl);

  if (parsed.hasVertexColors) notes.push('Per-vertex colours detected — colour-region analysis enabled.');
  else if (parsed.usedMtl) notes.push('MTL diffuse colours applied per material group.');
  else if (parsed.materials.length > 1) {
    notes.push(`No .mtl supplied — ${parsed.materials.length} groups auto-coloured by name/hash.`);
  } else {
    notes.push('No colour information found in this OBJ.');
  }

  return {
    positions: parsed.positions,
    colors: parsed.colors,
    name: geoFile.name,
    format: 'obj',
    materials: parsed.materials,
    hasVertexColors: parsed.hasVertexColors,
    usedMtl: parsed.usedMtl,
    notes,
  };
}
