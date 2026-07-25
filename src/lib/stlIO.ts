/**
 * stlIO.ts — Robust ASCII + Binary STL parsing and Binary STL writing.
 *
 * The parser is intentionally defensive: STL files in the wild are frequently
 * truncated, mis-headered ("solid " prefix on a binary file), or contain NaN
 * vertices produced by broken exporters. Every failure mode throws a typed
 * StlParseError so the UI can present something actionable.
 */

export class StlParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StlParseError';
  }
}

/** A non-indexed triangle soup — the canonical internal mesh representation. */
export interface MeshData {
  /** Flat XYZ triples, 9 floats per triangle. */
  positions: Float32Array;
  /**
   * Optional PER-TRIANGLE linear RGB in 0..1 (3 floats per triangle, i.e.
   * length === positions.length / 3). Populated from OBJ vertex colours or
   * MTL diffuse values and used by the planner as a colour-boundary signal.
   */
  colors?: Float32Array;
}

export const triangleCount = (m: MeshData) => m.positions.length / 9;

const MAX_TRIANGLES = 6_000_000; // ~200MB STL — hard ceiling to avoid OOM.

/* ------------------------------------------------------------------ */
/* Detection                                                           */
/* ------------------------------------------------------------------ */

function looksBinary(buffer: ArrayBuffer): boolean {
  if (buffer.byteLength < 84) return false;
  const view = new DataView(buffer);
  const declared = view.getUint32(80, true);
  const expected = 84 + declared * 50;
  // The single most reliable signal: the declared facet count matches size.
  if (expected === buffer.byteLength) return true;

  // Otherwise sniff the first 512 bytes for non-ASCII / binary garbage.
  const head = new Uint8Array(buffer, 0, Math.min(512, buffer.byteLength));
  let text = '';
  for (let i = 0; i < head.length; i++) text += String.fromCharCode(head[i]);
  if (!/^\s*solid/i.test(text)) return true;
  // "solid" present but no "facet"/"vertex" keyword nearby → binary in disguise.
  return !/facet|vertex|endsolid/i.test(text);
}

/* ------------------------------------------------------------------ */
/* Binary                                                              */
/* ------------------------------------------------------------------ */

function parseBinary(buffer: ArrayBuffer): MeshData {
  if (buffer.byteLength < 84) throw new StlParseError('Binary STL is truncated (< 84 bytes).');
  const view = new DataView(buffer);
  let faces = view.getUint32(80, true);
  const available = Math.floor((buffer.byteLength - 84) / 50);

  if (faces === 0) throw new StlParseError('Binary STL declares 0 triangles.');
  if (faces > available) faces = available; // tolerate truncated tails
  if (faces > MAX_TRIANGLES)
    throw new StlParseError(`Model too large: ${faces.toLocaleString()} triangles (limit ${MAX_TRIANGLES.toLocaleString()}).`);

  const positions = new Float32Array(faces * 9);
  let o = 84;
  let w = 0;
  for (let i = 0; i < faces; i++) {
    o += 12; // skip facet normal — recomputed from winding later
    for (let v = 0; v < 3; v++) {
      positions[w++] = view.getFloat32(o, true);
      positions[w++] = view.getFloat32(o + 4, true);
      positions[w++] = view.getFloat32(o + 8, true);
      o += 12;
    }
    o += 2; // attribute byte count
  }
  return { positions };
}

/* ------------------------------------------------------------------ */
/* ASCII                                                               */
/* ------------------------------------------------------------------ */

function parseAscii(buffer: ArrayBuffer): MeshData {
  const text = new TextDecoder().decode(buffer);
  const out: number[] = [];
  // Tolerant of arbitrary whitespace / exponent notation / missing normals.
  const vertexRe = /vertex\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)\s+(-?[\d.eE+-]+)/g;
  let m: RegExpExecArray | null;
  while ((m = vertexRe.exec(text)) !== null) {
    out.push(parseFloat(m[1]), parseFloat(m[2]), parseFloat(m[3]));
    if (out.length / 9 > MAX_TRIANGLES)
      throw new StlParseError('ASCII STL exceeds the supported triangle limit.');
  }
  if (out.length < 9) throw new StlParseError('No triangles found — file is not a valid ASCII STL.');
  const usable = Math.floor(out.length / 9) * 9;
  return { positions: new Float32Array(out.slice(0, usable)) };
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

/** Parse an STL ArrayBuffer, auto-detecting encoding and scrubbing bad data. */
export function parseSTL(buffer: ArrayBuffer): MeshData {
  if (!buffer || buffer.byteLength === 0) throw new StlParseError('File is empty.');
  const mesh = looksBinary(buffer) ? parseBinary(buffer) : parseAscii(buffer);
  return scrub(mesh);
}

/** Drop NaN/Infinite and zero-area (degenerate) triangles. */
function scrub(mesh: MeshData): MeshData {
  const p = mesh.positions;
  const n = p.length / 9;
  const keep = new Float32Array(p.length);
  let w = 0;
  for (let i = 0; i < n; i++) {
    const b = i * 9;
    let ok = true;
    for (let k = 0; k < 9; k++) {
      if (!Number.isFinite(p[b + k])) { ok = false; break; }
    }
    if (!ok) continue;
    // Cross product magnitude test for degeneracy.
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    const cx = ay * bz - az * by, cy = az * bx - ax * bz, cz = ax * by - ay * bx;
    if (cx * cx + cy * cy + cz * cz <= 1e-24) continue;
    keep.set(p.subarray(b, b + 9), w);
    w += 9;
  }
  if (w === 0) throw new StlParseError('Mesh contains no valid triangles after cleanup.');
  return { positions: keep.slice(0, w) };
}

/** Serialize a triangle soup to a binary STL ArrayBuffer. */
export function writeBinarySTL(mesh: MeshData, header = 'Generated by Model Splitter'): ArrayBuffer {
  const p = mesh.positions;
  const faces = p.length / 9;
  const buffer = new ArrayBuffer(84 + faces * 50);
  const view = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < Math.min(79, header.length); i++) bytes[i] = header.charCodeAt(i) & 0x7f;
  view.setUint32(80, faces, true);

  let o = 84;
  for (let i = 0; i < faces; i++) {
    const b = i * 9;
    const ax = p[b + 3] - p[b], ay = p[b + 4] - p[b + 1], az = p[b + 5] - p[b + 2];
    const bx = p[b + 6] - p[b], by = p[b + 7] - p[b + 1], bz = p[b + 8] - p[b + 2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    view.setFloat32(o, nx, true);
    view.setFloat32(o + 4, ny, true);
    view.setFloat32(o + 8, nz, true);
    o += 12;
    for (let k = 0; k < 9; k++) {
      view.setFloat32(o, p[b + k], true);
      o += 4;
    }
    view.setUint16(o, 0, true);
    o += 2;
  }
  return buffer;
}
