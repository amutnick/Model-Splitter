/**
 * demoModel.ts — Procedural samples so the tool can be evaluated without a file.
 *
 * The creature bust deliberately contains the exact structures multi-colour
 * printing cares about: a narrow neck (Z seam), a protruding snout (Y seam),
 * separate eye shells (topology), and distinct colour zones for hair/eyes/
 * teeth/skin (colour-region seams) — plus a base for bed contact.
 */
import * as THREE from 'three';
import type { MeshData } from './stlIO';

type Rgb = [number, number, number];

interface Piece {
  geo: THREE.BufferGeometry;
  color: Rgb;
}

function bake(pieces: Piece[], withColor: boolean): MeshData {
  const posChunks: Float32Array[] = [];
  const colChunks: Float32Array[] = [];
  let totalPos = 0;

  for (const { geo, color } of pieces) {
    const ng = geo.index ? geo.toNonIndexed() : geo;
    const arr = ng.getAttribute('position').array as Float32Array;
    const copy = new Float32Array(arr);
    posChunks.push(copy);
    totalPos += copy.length;
    if (withColor) {
      const tris = copy.length / 9;
      const c = new Float32Array(tris * 3);
      for (let i = 0; i < tris; i++) { c[i * 3] = color[0]; c[i * 3 + 1] = color[1]; c[i * 3 + 2] = color[2]; }
      colChunks.push(c);
    }
    if (ng !== geo) ng.dispose();
    geo.dispose();
  }

  const positions = new Float32Array(totalPos);
  let o = 0;
  for (const c of posChunks) { positions.set(c, o); o += c.length; }

  if (!withColor) return { positions };

  const colors = new Float32Array(totalPos / 3);
  let oc = 0;
  for (const c of colChunks) { colors.set(c, oc); oc += c.length; }
  return { positions, colors };
}

const P = (geo: THREE.BufferGeometry, color: Rgb): Piece => ({ geo, color });

const SKIN: Rgb = [0.86, 0.68, 0.55];
const HAIR: Rgb = [0.30, 0.18, 0.12];
const EYE: Rgb = [0.12, 0.32, 0.78];
const TOOTH: Rgb = [0.95, 0.94, 0.90];
const CLOTH: Rgb = [0.24, 0.40, 0.68];
const BASE: Rgb = [0.42, 0.47, 0.55];

/** A colour-authored creature bust — best showcase for multi-axis + colour. */
export function buildDemoCreature(): MeshData {
  const p: Piece[] = [];
  const rx = Math.PI / 2;

  // Base plinth (flat bed contact)
  p.push(P(new THREE.CylinderGeometry(30, 34, 7, 56).rotateX(rx).translate(0, 0, 3.5), BASE));
  p.push(P(new THREE.CylinderGeometry(26, 30, 3, 56).rotateX(rx).translate(0, 0, 8.5), BASE));

  // Shoulders / chest — clothed
  p.push(P(new THREE.SphereGeometry(24, 44, 32).scale(1.25, 0.85, 0.72).translate(0, 0, 26), CLOTH));
  p.push(P(new THREE.CylinderGeometry(19, 24, 18, 40).rotateX(rx).translate(0, 0, 20), CLOTH));

  // Neck — the classic narrow waist the planner should find on Z
  p.push(P(new THREE.CylinderGeometry(8.2, 10.5, 12, 32).rotateX(rx).translate(0, 0, 40), SKIN));

  // Head
  p.push(P(new THREE.SphereGeometry(17, 48, 36).scale(1, 1.06, 1.14).translate(0, 0, 58), SKIN));
  // Jaw / chin
  p.push(P(new THREE.SphereGeometry(11, 32, 24).scale(1, 0.95, 0.8).translate(0, -6, 50), SKIN));

  // Snout / muzzle — protrudes on −Y, should isolate on the Y axis
  p.push(P(new THREE.CylinderGeometry(5.2, 8.5, 14, 28).rotateX(0).translate(0, -19, 55), SKIN));
  p.push(P(new THREE.SphereGeometry(5.4, 24, 18).translate(0, -25, 56), SKIN));

  // Teeth — separate colour + tiny shells
  for (let i = -1; i <= 1; i += 2) {
    p.push(P(new THREE.ConeGeometry(1.5, 5, 12).rotateX(Math.PI).translate(i * 3, -23, 50), TOOTH));
  }

  // Eyes — disconnected shells AND a distinct colour
  for (let i = -1; i <= 1; i += 2) {
    p.push(P(new THREE.SphereGeometry(3.6, 24, 18).translate(i * 7, -13.5, 62), EYE));
  }

  // Ears — protrude on ±X, should isolate on the X axis
  for (let i = -1; i <= 1; i += 2) {
    p.push(P(
      new THREE.ConeGeometry(5, 14, 20).rotateZ(i * -0.35).rotateX(-0.15).translate(i * 14, 2, 72),
      SKIN,
    ));
  }

  // Hair / mane — top-back mass in its own colour
  p.push(P(new THREE.SphereGeometry(17.6, 40, 30).scale(1.02, 1.0, 0.72).translate(0, 4, 66), HAIR));
  for (let i = 0; i < 7; i++) {
    const a = (i / 6 - 0.5) * 2.1;
    p.push(P(
      new THREE.CapsuleGeometry(2.6, 16, 6, 14)
        .rotateX(rx + 0.55).rotateZ(a)
        .translate(Math.sin(a) * 11, 12 + Math.cos(a) * 3, 64),
      HAIR,
    ));
  }

  return bake(p, true);
}

/** Uncoloured figurine — exercises the purely geometric planner. */
export function buildDemoFigurine(): MeshData {
  const p: Piece[] = [];
  const rx = Math.PI / 2;
  const g: Rgb = [0.7, 0.7, 0.72];

  p.push(P(new THREE.CylinderGeometry(26, 30, 6, 48).rotateX(rx).translate(0, 0, 3), g));
  p.push(P(new THREE.CapsuleGeometry(6.5, 26, 8, 20).rotateX(rx).translate(-8, 0, 22), g));
  p.push(P(new THREE.CapsuleGeometry(6.5, 26, 8, 20).rotateX(rx).translate(8, 0, 22), g));
  p.push(P(new THREE.SphereGeometry(13, 32, 24).translate(0, 0, 42), g));
  p.push(P(new THREE.CylinderGeometry(8.5, 12, 12, 32).rotateX(rx).translate(0, 0, 50), g));
  p.push(P(new THREE.SphereGeometry(15, 36, 28).scale(1, 0.8, 1.1).translate(0, 0, 64), g));
  p.push(P(new THREE.CapsuleGeometry(4.6, 22, 8, 18).rotateX(rx).rotateY(0.35).translate(-16, 0, 62), g));
  p.push(P(new THREE.CapsuleGeometry(4.6, 22, 8, 18).rotateX(rx).rotateY(-0.35).translate(16, 0, 62), g));
  p.push(P(new THREE.CylinderGeometry(5, 5.6, 8, 24).rotateX(rx).translate(0, 0, 80), g));
  p.push(P(new THREE.SphereGeometry(12, 40, 32).scale(1, 1.05, 1.12).translate(0, 0, 94), g));
  p.push(P(new THREE.ConeGeometry(2.4, 7, 16).rotateX(-rx).translate(0, -12.5, 94), g));
  p.push(P(new THREE.SphereGeometry(3.2, 16, 12).translate(-11.5, 0, 96), g));
  p.push(P(new THREE.SphereGeometry(3.2, 16, 12).translate(11.5, 0, 96), g));

  return bake(p, false);
}
