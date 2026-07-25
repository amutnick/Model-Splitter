/**
 * exportZip.ts — Bundles every segment as an individual binary STL inside a
 * single archive. All parts keep the ORIGINAL model coordinate frame, so
 * importing them together into Bambu Studio / PrusaSlicer / Cura reassembles
 * the model perfectly ("Load as assembly" / "Keep position").
 */
import JSZip from 'jszip';
import { saveAs } from 'file-saver';
import { writeBinarySTL, type MeshData } from './stlIO';
import { computeBounds } from './meshUtils';

export interface ExportPart {
  name: string;
  color: string;
  mesh: MeshData;
  volume: number;
  triangles: number;
}

export interface ExportOptions {
  /** Translate every part by the same vector so the assembly sits on origin. */
  recenter?: [number, number, number];
  includeManifest?: boolean;
  includeAssembly?: boolean;
  /**
   * When true, `exportSegmentsZip` returns the ZIP as `{ blob, filename }` and
   * DOES NOT trigger a browser download — used by the Tauri bridge which
   * needs the bytes so it can call the native Save dialog itself.
   */
  returnBlob?: boolean;
}

export interface ExportBundle {
  blob: Blob;
  filename: string;
}

function applyOffset(mesh: MeshData, o?: [number, number, number]): MeshData {
  if (!o || (o[0] === 0 && o[1] === 0 && o[2] === 0)) return mesh;
  const p = new Float32Array(mesh.positions);
  for (let i = 0; i < p.length; i += 3) { p[i] += o[0]; p[i + 1] += o[1]; p[i + 2] += o[2]; }
  return { positions: p };
}

const sanitize = (s: string) =>
  s.replace(/\.(stl|obj)$/i, '').replace(/[^a-z0-9_\-]+/gi, '_').slice(0, 60) || 'model';

export async function exportSegmentsZip(
  parts: ExportPart[],
  originalName: string,
  options: ExportOptions = {},
  onProgress?: (pct: number) => void,
): Promise<ExportBundle | void> {
  if (!parts.length) throw new Error('Nothing to export — segment a model first.');

  const base = sanitize(originalName);
  const zip = new JSZip();
  const folder = zip.folder(`${base}_segmented`) ?? zip;

  const manifest: string[] = [
    `# ${base} — segmented for multi-colour 3D printing`,
    `# generated ${new Date().toISOString()}`,
    '',
    'file\tcolor\ttriangles\tvolume_mm3\tbbox_min\tbbox_max',
  ];

  for (let i = 0; i < parts.length; i++) {
    const part = parts[i];
    const mesh = applyOffset(part.mesh, options.recenter);
    const fileName = `${base}_${part.name}.stl`;
    const buf = writeBinarySTL(mesh, `${base} ${part.name} ${part.color}`);
    folder.file(fileName, buf);

    const b = computeBounds(mesh);
    manifest.push(
      [
        fileName,
        part.color,
        part.triangles,
        part.volume.toFixed(3),
        b.min.map((v) => v.toFixed(2)).join(','),
        b.max.map((v) => v.toFixed(2)).join(','),
      ].join('\t'),
    );
    onProgress?.(Math.round(((i + 1) / parts.length) * 70));
  }

  if (options.includeManifest !== false) {
    manifest.push(
      '',
      'HOW TO PRINT IN COLOUR',
      '----------------------',
      'All parts share ONE coordinate system, so they reassemble automatically.',
      '',
      'With an AMS / multi-material unit:',
      '  1. Select every .stl and import them together.',
      '  2. Choose "Load as a single object" / "Keep original position" when asked.',
      '  3. Assign one filament slot per part using the colours listed above.',
      '',
      'Without an AMS:',
      '  1. Import parts one at a time and lay each new flat cap face on the bed',
      '     (every cut face is planar, so "Place on face" gives zero-support prints).',
      '  2. Print each part in its own filament, then glue the assembly together.',
    );
    folder.file('MANIFEST.txt', manifest.join('\n'));
  }

  onProgress?.(80);
  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'DEFLATE', compressionOptions: { level: 6 } },
    (meta) => onProgress?.(80 + Math.round(meta.percent * 0.2)),
  );
  const filename = `${base}_segmented.zip`;
  if (options.returnBlob) {
    onProgress?.(100);
    return { blob, filename };
  }
  saveAs(blob, filename);
  onProgress?.(100);
}

/** Single-part download helper. */
export function exportSinglePart(part: ExportPart, originalName: string, recenter?: [number, number, number]) {
  const base = sanitize(originalName);
  const mesh = applyOffset(part.mesh, recenter);
  const blob = new Blob([writeBinarySTL(mesh, `${base} ${part.name}`)], { type: 'model/stl' });
  saveAs(blob, `${base}_${part.name}.stl`);
}
