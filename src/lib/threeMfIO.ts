/**
 * Minimal 3MF Core reader.
 *
 * Supports zipped .3mf packages containing mesh objects, component assemblies,
 * build-item/object transforms, model units, base materials and colour groups.
 * Texture extensions are intentionally ignored because Model Splitter's
 * canonical mesh carries one RGB value per triangle rather than UV textures.
 */
import JSZip from 'jszip';
import { DOMParser, type Document, type Element, type Node } from '@xmldom/xmldom';
import type { MeshData } from './stlIO';
import type { Rgb } from './objIO';

export class ThreeMfParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ThreeMfParseError';
  }
}

export interface ThreeMfMaterial {
  name: string;
  color: Rgb;
  triangles: number;
}

export interface ThreeMfResult extends MeshData {
  materials: ThreeMfMaterial[];
  objectCount: number;
  unit: string;
  notes: string[];
}

type Transform = [number, number, number, number, number, number, number, number, number, number, number, number];

interface PropertyEntry {
  name: string;
  color: Rgb;
}

interface PropertyResource {
  entries: PropertyEntry[];
}

interface RawTriangle {
  v: [number, number, number];
  pid?: string;
  p: [number | undefined, number | undefined, number | undefined];
}

interface RawMesh {
  vertices: [number, number, number][];
  triangles: RawTriangle[];
}

interface RawComponent {
  objectId: string;
  transform: Transform;
}

interface RawObject {
  id: string;
  name: string;
  pid?: string;
  pindex?: number;
  mesh?: RawMesh;
  components: RawComponent[];
}

const IDENTITY: Transform = [1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0];
const MAX_TRIANGLES = 6_000_000;
const MAX_MODEL_XML_BYTES = 128 * 1024 * 1024;

const UNIT_TO_MM: Record<string, number> = {
  micron: 0.001,
  millimeter: 1,
  centimeter: 10,
  inch: 25.4,
  foot: 304.8,
  meter: 1000,
};

const localName = (element: Element): string =>
  (element.localName || element.tagName.split(':').pop() || element.tagName).toLowerCase();

function childElements(parent: Element | Document, name?: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < parent.childNodes.length; i++) {
    const node = parent.childNodes.item(i) as Node | null;
    if (!node || node.nodeType !== 1) continue;
    const element = node as Element;
    if (!name || localName(element) === name) out.push(element);
  }
  return out;
}

function descendants(parent: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    const element = all.item(i);
    if (element && localName(element) === name) out.push(element);
  }
  return out;
}

function requiredNumber(element: Element, attribute: string): number {
  const value = Number(element.getAttribute(attribute));
  if (!Number.isFinite(value)) {
    throw new ThreeMfParseError(`3MF ${localName(element)} has an invalid ${attribute} value.`);
  }
  return value;
}

function optionalIndex(element: Element, attribute: string): number | undefined {
  const raw = element.getAttribute(attribute);
  if (raw === null || raw === '') return undefined;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function parseTransform(raw: string | null): Transform {
  if (!raw) return [...IDENTITY];
  const values = raw.trim().split(/\s+/).map(Number);
  if (values.length !== 12 || values.some((value) => !Number.isFinite(value))) {
    throw new ThreeMfParseError('3MF contains an invalid 3×4 transform matrix.');
  }
  return values as Transform;
}

/** Compose transforms so the returned matrix applies `local` and then `parent`. */
function compose(parent: Transform, local: Transform): Transform {
  return [
    parent[0] * local[0] + parent[3] * local[1] + parent[6] * local[2],
    parent[1] * local[0] + parent[4] * local[1] + parent[7] * local[2],
    parent[2] * local[0] + parent[5] * local[1] + parent[8] * local[2],
    parent[0] * local[3] + parent[3] * local[4] + parent[6] * local[5],
    parent[1] * local[3] + parent[4] * local[4] + parent[7] * local[5],
    parent[2] * local[3] + parent[5] * local[4] + parent[8] * local[5],
    parent[0] * local[6] + parent[3] * local[7] + parent[6] * local[8],
    parent[1] * local[6] + parent[4] * local[7] + parent[7] * local[8],
    parent[2] * local[6] + parent[5] * local[7] + parent[8] * local[8],
    parent[0] * local[9] + parent[3] * local[10] + parent[6] * local[11] + parent[9],
    parent[1] * local[9] + parent[4] * local[10] + parent[7] * local[11] + parent[10],
    parent[2] * local[9] + parent[5] * local[10] + parent[8] * local[11] + parent[11],
  ];
}

function applyTransform(transform: Transform, point: [number, number, number], scale: number): [number, number, number] {
  const [x, y, z] = point;
  return [
    (transform[0] * x + transform[3] * y + transform[6] * z + transform[9]) * scale,
    (transform[1] * x + transform[4] * y + transform[7] * z + transform[10]) * scale,
    (transform[2] * x + transform[5] * y + transform[8] * z + transform[11]) * scale,
  ];
}

function determinant(transform: Transform): number {
  return (
    transform[0] * (transform[4] * transform[8] - transform[7] * transform[5]) -
    transform[3] * (transform[1] * transform[8] - transform[7] * transform[2]) +
    transform[6] * (transform[1] * transform[5] - transform[4] * transform[2])
  );
}

function parseColor(raw: string | null): Rgb | null {
  if (!raw) return null;
  const value = raw.trim();
  const match = /^#([0-9a-f]{6})(?:[0-9a-f]{2})?$/i.exec(value);
  if (!match) return null;
  return [
    parseInt(match[1].slice(0, 2), 16) / 255,
    parseInt(match[1].slice(2, 4), 16) / 255,
    parseInt(match[1].slice(4, 6), 16) / 255,
  ];
}

function parseProperties(document: Document): Map<string, PropertyResource> {
  const resources = new Map<string, PropertyResource>();
  for (const element of descendants(document, 'basematerials')) {
    const id = element.getAttribute('id');
    if (!id) continue;
    const entries = childElements(element, 'base').flatMap((base, index) => {
      const color = parseColor(base.getAttribute('displaycolor'));
      return color ? [{ name: base.getAttribute('name') || `material_${index + 1}`, color }] : [];
    });
    if (entries.length) resources.set(id, { entries });
  }
  for (const element of descendants(document, 'colorgroup')) {
    const id = element.getAttribute('id');
    if (!id) continue;
    const entries = childElements(element, 'color').flatMap((entry, index) => {
      const color = parseColor(entry.getAttribute('color'));
      return color ? [{ name: `color_${index + 1}`, color }] : [];
    });
    if (entries.length) resources.set(id, { entries });
  }
  return resources;
}

function parseMesh(element: Element): RawMesh {
  const verticesElement = childElements(element, 'vertices')[0];
  const trianglesElement = childElements(element, 'triangles')[0];
  if (!verticesElement || !trianglesElement) throw new ThreeMfParseError('3MF mesh is missing vertices or triangles.');

  const vertices = childElements(verticesElement, 'vertex').map((vertex) => [
    requiredNumber(vertex, 'x'), requiredNumber(vertex, 'y'), requiredNumber(vertex, 'z'),
  ] as [number, number, number]);

  const triangles = childElements(trianglesElement, 'triangle').map((triangle) => {
    const v: [number, number, number] = [
      requiredNumber(triangle, 'v1'), requiredNumber(triangle, 'v2'), requiredNumber(triangle, 'v3'),
    ];
    if (v.some((index) => !Number.isInteger(index) || index < 0 || index >= vertices.length)) {
      throw new ThreeMfParseError('3MF triangle references a vertex outside its mesh.');
    }
    return {
      v,
      pid: triangle.getAttribute('pid') || undefined,
      p: [
        optionalIndex(triangle, 'p1'), optionalIndex(triangle, 'p2'), optionalIndex(triangle, 'p3'),
      ] as RawTriangle['p'],
    };
  });
  return { vertices, triangles };
}

function parseObjects(document: Document): Map<string, RawObject> {
  const objects = new Map<string, RawObject>();
  for (const element of descendants(document, 'object')) {
    const id = element.getAttribute('id');
    if (!id) continue;
    const meshElement = childElements(element, 'mesh')[0];
    const componentsElement = childElements(element, 'components')[0];
    const components = componentsElement
      ? childElements(componentsElement, 'component').map((component) => {
        const objectId = component.getAttribute('objectid');
        if (!objectId) throw new ThreeMfParseError('3MF component is missing objectid.');
        return { objectId, transform: parseTransform(component.getAttribute('transform')) };
      })
      : [];
    objects.set(id, {
      id,
      name: element.getAttribute('name') || `object_${id}`,
      pid: element.getAttribute('pid') || undefined,
      pindex: optionalIndex(element, 'pindex'),
      mesh: meshElement ? parseMesh(meshElement) : undefined,
      components,
    });
  }
  return objects;
}

function propertyForTriangle(
  triangle: RawTriangle,
  object: RawObject,
  properties: Map<string, PropertyResource>,
): PropertyEntry | null {
  const pid = triangle.pid ?? object.pid;
  if (!pid) return null;
  const resource = properties.get(pid);
  if (!resource) return null;
  const indices = triangle.p.map((index) => index ?? object.pindex).filter((index): index is number => index !== undefined);
  if (!indices.length) return null;
  const selected = indices.map((index) => resource.entries[index]).filter((entry): entry is PropertyEntry => !!entry);
  if (!selected.length) return null;
  const color: Rgb = [0, 0, 0];
  for (const entry of selected) {
    color[0] += entry.color[0]; color[1] += entry.color[1]; color[2] += entry.color[2];
  }
  color[0] /= selected.length; color[1] /= selected.length; color[2] /= selected.length;
  return { name: [...new Set(selected.map((entry) => entry.name))].join('+'), color };
}

function parseXml(xml: string): Document {
  const errors: string[] = [];
  try {
    const document = new DOMParser({
      onError: (level, message) => { if (level !== 'warning') errors.push(message); },
    }).parseFromString(xml, 'application/xml');
    if (errors.length || !document.documentElement) {
      throw new ThreeMfParseError(`3MF model XML is invalid${errors[0] ? `: ${errors[0]}` : '.'}`);
    }
    return document;
  } catch (error) {
    if (error instanceof ThreeMfParseError) throw error;
    throw new ThreeMfParseError(`Could not parse the 3MF model XML: ${(error as Error).message}`);
  }
}

/** Parse a complete zipped .3mf package into Model Splitter's triangle soup. */
export async function parse3MF(buffer: ArrayBuffer): Promise<ThreeMfResult> {
  if (!buffer.byteLength) throw new ThreeMfParseError('3MF file is empty.');
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer, { checkCRC32: true });
  } catch (error) {
    throw new ThreeMfParseError(`Could not open the 3MF package: ${(error as Error).message}`);
  }

  const modelPath = Object.keys(zip.files).find((name) => /^3d\/3dmodel\.model$/i.test(name))
    ?? Object.keys(zip.files).find((name) => /(^|\/)3dmodel\.model$/i.test(name));
  if (!modelPath) throw new ThreeMfParseError('3MF package does not contain a 3D model part.');

  const xml = await zip.file(modelPath)!.async('string');
  if (new TextEncoder().encode(xml).byteLength > MAX_MODEL_XML_BYTES) {
    throw new ThreeMfParseError('3MF model XML exceeds the 128 MB safety limit.');
  }
  const document = parseXml(xml);
  const modelElement = document.documentElement;
  if (!modelElement) throw new ThreeMfParseError('3MF model XML has no root element.');
  const unit = (modelElement.getAttribute('unit') || 'millimeter').toLowerCase();
  const unitScale = UNIT_TO_MM[unit];
  if (!unitScale) throw new ThreeMfParseError(`Unsupported 3MF model unit: ${unit}.`);

  const properties = parseProperties(document);
  const objects = parseObjects(document);
  if (!objects.size) throw new ThreeMfParseError('3MF model contains no objects.');

  const positions: number[] = [];
  const triangleProperties: (PropertyEntry | null)[] = [];
  let instantiatedObjects = 0;

  const renderObject = (objectId: string, transform: Transform, stack: Set<string>) => {
    if (stack.has(objectId)) throw new ThreeMfParseError(`3MF component cycle detected at object ${objectId}.`);
    const object = objects.get(objectId);
    if (!object) throw new ThreeMfParseError(`3MF references missing object ${objectId}.`);
    stack.add(objectId);
    instantiatedObjects++;

    if (object.mesh) {
      const mirrored = determinant(transform) < 0;
      for (const triangle of object.mesh.triangles) {
        const order = mirrored ? [triangle.v[0], triangle.v[2], triangle.v[1]] : triangle.v;
        for (const vertexIndex of order) {
          const point = applyTransform(transform, object.mesh.vertices[vertexIndex], unitScale);
          positions.push(point[0], point[1], point[2]);
        }
        triangleProperties.push(propertyForTriangle(triangle, object, properties));
        if (triangleProperties.length > MAX_TRIANGLES) {
          throw new ThreeMfParseError(`3MF exceeds the ${MAX_TRIANGLES.toLocaleString()} triangle limit.`);
        }
      }
    }

    for (const component of object.components) {
      renderObject(component.objectId, compose(transform, component.transform), stack);
    }
    stack.delete(objectId);
  };

  const buildElement = descendants(document, 'build')[0];
  const buildItems = buildElement ? childElements(buildElement, 'item') : [];
  if (buildItems.length) {
    for (const item of buildItems) {
      const objectId = item.getAttribute('objectid');
      if (!objectId) throw new ThreeMfParseError('3MF build item is missing objectid.');
      renderObject(objectId, parseTransform(item.getAttribute('transform')), new Set());
    }
  } else {
    for (const object of objects.values()) {
      if (object.mesh) renderObject(object.id, IDENTITY, new Set());
    }
  }

  if (!positions.length) throw new ThreeMfParseError('3MF build contains no mesh triangles.');

  const colored = triangleProperties.some(Boolean);
  const colorsOut = colored ? new Float32Array(triangleProperties.length * 3) : undefined;
  const materialMap = new Map<string, ThreeMfMaterial>();
  if (colorsOut) {
    triangleProperties.forEach((property, index) => {
      const color = property?.color ?? [0.7, 0.7, 0.72];
      colorsOut.set(color, index * 3);
      if (!property) return;
      const key = `${property.name}:${property.color.map((value) => value.toFixed(5)).join(',')}`;
      const existing = materialMap.get(key);
      if (existing) existing.triangles++;
      else materialMap.set(key, { name: property.name, color: property.color, triangles: 1 });
    });
  }

  const notes = [
    `3MF ${unit} units converted to millimetres.`,
    `${instantiatedObjects} object instance(s) loaded from the build assembly.`,
  ];
  if (colored) notes.push(`${materialMap.size} 3MF material/colour assignment(s) loaded.`);
  if (descendants(document, 'texture2d').length) notes.push('3MF texture maps are not imported; geometry and material colours were retained.');

  return {
    positions: new Float32Array(positions),
    ...(colorsOut ? { colors: colorsOut } : {}),
    materials: [...materialMap.values()].sort((a, b) => b.triangles - a.triangles),
    objectCount: instantiatedObjects,
    unit,
    notes,
  };
}
