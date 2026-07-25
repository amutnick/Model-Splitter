/**
 * engine.ts — Encapsulated three.js viewport (Z-up, print-bed style grid).
 *
 * Owns: environment, part rendering, exploded view, picking, and the
 * interactive cut-plane gizmos (click to select, drag to slide along the
 * cut's own axis — never off it).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import type { MeshData } from '../lib/stlIO';
import type { Segment } from '../lib/autoSegment';

export interface PlaneSpec {
  id: string;
  axis: 0 | 1 | 2;
  offset: number;
  /** Model-space bounds of the sub-piece this cut applies to. */
  min: [number, number, number];
  max: [number, number, number];
  /** Allowed travel along the axis. */
  range: [number, number];
  enabled: boolean;
  label: string;
}

export interface EngineCallbacks {
  onPick?: (id: number | null) => void;
  onPlaneSelect?: (id: string | null) => void;
  onPlaneDrag?: (id: string, offset: number, committed: boolean) => void;
}

const AXIS_COLOR = [0xff5a5a, 0x5aff8a, 0x5aa8ff];

function toGeometry(mesh: MeshData, useSourceColors: boolean): THREE.BufferGeometry {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(mesh.positions), 3));
  if (useSourceColors && mesh.colors) {
    // Per-triangle colour → expand to per-vertex (flat shaded look).
    const tri = mesh.colors.length / 3;
    const vc = new Float32Array(tri * 9);
    for (let i = 0; i < tri; i++) {
      for (let v = 0; v < 3; v++) {
        vc[i * 9 + v * 3] = mesh.colors[i * 3];
        vc[i * 9 + v * 3 + 1] = mesh.colors[i * 3 + 1];
        vc[i * 9 + v * 3 + 2] = mesh.colors[i * 3 + 2];
      }
    }
    g.setAttribute('color', new THREE.BufferAttribute(vc, 3));
  }
  g.computeVertexNormals();
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export class ViewportEngine {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private root = new THREE.Group();
  private planeGroup = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private pointer = new THREE.Vector2();
  private frameId = 0;
  private ro: ResizeObserver;
  private disposed = false;

  private partMeshes: THREE.Mesh[] = [];
  private planeQuads: THREE.Mesh[] = [];
  private planeSpecs: PlaneSpec[] = [];
  private selectedPlane: string | null = null;
  private totalTriangles = 0;

  private explodeTarget = 0;
  private explodeCurrent = 0;
  private modelRadius = 50;
  private assemblyCenter = new THREE.Vector3();
  private hovered: number | null = null;
  private selected: number | null = null;
  private cb: EngineCallbacks;

  constructor(private container: HTMLElement, cb: EngineCallbacks = {}) {
    this.cb = cb;
    const w = container.clientWidth || 800;
    const h = container.clientHeight || 600;

    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.setClearColor(0x0d1117, 1);
    container.appendChild(this.renderer.domElement);

    this.scene.fog = new THREE.Fog(0x0d1117, 400, 1600);

    this.camera = new THREE.PerspectiveCamera(45, w / h, 0.1, 8000);
    this.camera.up.set(0, 0, 1);
    this.camera.position.set(140, -180, 120);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.maxPolarAngle = Math.PI * 0.98;
    this.controls.mouseButtons = {
      LEFT: THREE.MOUSE.ROTATE,
      MIDDLE: THREE.MOUSE.DOLLY,
      RIGHT: THREE.MOUSE.PAN,
    };

    this.buildEnvironment();
    this.scene.add(this.root);
    this.scene.add(this.planeGroup);

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(container);

    const el = this.renderer.domElement;
    el.addEventListener('pointermove', this.onPointerMove);
    el.addEventListener('pointerdown', this.onPointerDown);
    el.addEventListener('contextmenu', (e) => e.preventDefault());

    this.animate();
  }

  /* ---------------- environment ---------------- */
  private grid!: THREE.GridHelper;
  private gridFine!: THREE.GridHelper;
  private axisLines!: THREE.LineSegments;

  private buildEnvironment() {
    this.scene.add(new THREE.HemisphereLight(0xdfefff, 0x2a2f38, 1.05));
    this.scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const key = new THREE.DirectionalLight(0xffffff, 1.8);
    key.position.set(180, -220, 320);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 2000;
    const s = 400;
    key.shadow.camera.left = -s; key.shadow.camera.right = s;
    key.shadow.camera.top = s; key.shadow.camera.bottom = -s;
    key.shadow.bias = -0.0008;
    this.scene.add(key);

    const fill = new THREE.DirectionalLight(0x88aaff, 0.55);
    fill.position.set(-240, 160, 120);
    this.scene.add(fill);

    const rim = new THREE.DirectionalLight(0xffd9a0, 0.4);
    rim.position.set(0, 260, -160);
    this.scene.add(rim);

    this.gridFine = new THREE.GridHelper(1000, 200, 0x1b2430, 0x1b2430);
    this.gridFine.rotation.x = Math.PI / 2;
    (this.gridFine.material as THREE.Material).transparent = true;
    (this.gridFine.material as THREE.Material).opacity = 0.55;
    this.scene.add(this.gridFine);

    this.grid = new THREE.GridHelper(1000, 20, 0x2f3d4d, 0x2f3d4d);
    this.grid.rotation.x = Math.PI / 2;
    this.scene.add(this.grid);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(
      [-500, 0, 0, 500, 0, 0, 0, -500, 0, 0, 500, 0], 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(
      [0.75, 0.2, 0.2, 0.75, 0.2, 0.2, 0.2, 0.35, 0.8, 0.2, 0.35, 0.8], 3));
    this.axisLines = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true }));
    this.scene.add(this.axisLines);

    const shadowPlane = new THREE.Mesh(
      new THREE.PlaneGeometry(4000, 4000),
      new THREE.ShadowMaterial({ opacity: 0.32 }),
    );
    shadowPlane.receiveShadow = true;
    shadowPlane.position.z = -0.02;
    this.scene.add(shadowPlane);
  }

  /* ---------------- content ---------------- */

  private clearRoot() {
    for (const m of this.partMeshes) {
      m.geometry.dispose();
      (m.material as THREE.Material).dispose();
    }
    this.partMeshes = [];
    this.totalTriangles = 0;
    this.root.clear();
  }

  private tally() {
    this.totalTriangles = this.partMeshes.reduce(
      (s, m) => s + (m.geometry.getAttribute('position')?.count ?? 0) / 3, 0);
  }

  /** Single-body preview of the freshly loaded model. */
  setPreview(mesh: MeshData | null, useSourceColors = true) {
    this.clearRoot();
    if (!mesh) return;
    const hasColors = useSourceColors && !!mesh.colors;
    const geo = toGeometry(mesh, hasColors);
    const mat = new THREE.MeshStandardMaterial({
      color: hasColors ? 0xffffff : 0x9aa7b4,
      vertexColors: hasColors,
      roughness: 0.62,
      metalness: 0.06,
    });
    const m = new THREE.Mesh(geo, mat);
    m.castShadow = true;
    m.receiveShadow = true;
    m.userData.partId = -1;
    this.root.add(m);
    this.partMeshes = [m];
    this.tally();
    this.recenter();
  }

  setSegments(segments: Segment[]) {
    this.clearRoot();
    for (const seg of segments) {
      const geo = toGeometry(seg.mesh, false);
      const mat = new THREE.MeshStandardMaterial({
        color: new THREE.Color(seg.color),
        roughness: 0.5,
        metalness: 0.06,
      });
      const m = new THREE.Mesh(geo, mat);
      m.castShadow = true;
      m.receiveShadow = true;
      m.userData.partId = seg.id;
      m.userData.center = new THREE.Vector3(...seg.centroid);
      m.visible = seg.visible;
      this.root.add(m);
      this.partMeshes.push(m);
    }
    this.tally();
    this.recenter();
  }

  /** Update only the colours of the existing part meshes. */
  setPartColors(segments: Segment[]) {
    for (const seg of segments) {
      const m = this.partMeshes.find((x) => x.userData.partId === seg.id);
      if (m) (m.material as THREE.MeshStandardMaterial).color.set(seg.color);
    }
  }

  private recenter() {
    this.root.position.set(0, 0, 0);
    for (const m of this.partMeshes) m.position.set(0, 0, 0);
    this.root.updateMatrixWorld(true);
    const box = new THREE.Box3();
    for (const m of this.partMeshes) box.expandByObject(m);
    if (box.isEmpty()) return;
    const c = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    this.assemblyCenter.copy(c);
    this.modelRadius = Math.max(size.length() / 2, 1);
    this.root.position.set(-c.x, -c.y, -box.min.z);
    this.planeGroup.position.copy(this.root.position);
    this.updateGridScale(Math.max(size.x, size.y, size.z));
  }

  private updateGridScale(extent: number) {
    const target = Math.max(50, Math.pow(10, Math.ceil(Math.log10(extent || 50))));
    const scale = (target * 2) / 1000;
    for (const o of [this.grid, this.gridFine, this.axisLines]) o.scale.setScalar(scale);
    if (this.scene.fog instanceof THREE.Fog) {
      this.scene.fog.near = extent * 4;
      this.scene.fog.far = extent * 16;
    }
  }

  /* ---------------- cut plane gizmos ---------------- */

  setPlanes(specs: PlaneSpec[], visible: boolean) {
    for (const q of this.planeQuads) {
      q.geometry.dispose();
      (q.material as THREE.Material).dispose();
    }
    this.planeQuads = [];
    this.planeGroup.clear();
    this.planeSpecs = specs;
    this.planeGroup.visible = visible;
    if (!visible || !specs.length) return;
    this.planeGroup.position.copy(this.root.position);

    for (const spec of specs) {
      const size = [
        spec.max[0] - spec.min[0],
        spec.max[1] - spec.min[1],
        spec.max[2] - spec.min[2],
      ];
      const pad = 1.18;
      // Quad dimensions are the two axes that aren't the cut axis.
      const dims = [0, 1, 2].filter((a) => a !== spec.axis) as [number, number];
      const w = Math.max(size[dims[0]] * pad, 1e-3);
      const h = Math.max(size[dims[1]] * pad, 1e-3);

      const geo = new THREE.PlaneGeometry(w, h);
      const sel = this.selectedPlane === spec.id;
      const mat = new THREE.MeshBasicMaterial({
        color: spec.enabled ? (sel ? 0xffc247 : AXIS_COLOR[spec.axis]) : 0x556070,
        transparent: true,
        opacity: sel ? 0.3 : spec.enabled ? 0.17 : 0.08,
        side: THREE.DoubleSide,
        depthWrite: false,
      });
      const quad = new THREE.Mesh(geo, mat);
      quad.renderOrder = 5;

      const edge = new THREE.LineSegments(
        new THREE.EdgesGeometry(geo),
        new THREE.LineBasicMaterial({
          color: sel ? 0xffd97a : spec.enabled ? AXIS_COLOR[spec.axis] : 0x6a7686,
          transparent: true,
          opacity: sel ? 0.95 : 0.6,
        }),
      );
      quad.add(edge);

      // Orient: PlaneGeometry lies in XY; rotate so its normal is the cut axis.
      if (spec.axis === 0) quad.rotation.set(0, Math.PI / 2, Math.PI / 2);
      else if (spec.axis === 1) quad.rotation.set(Math.PI / 2, 0, 0);

      const center = new THREE.Vector3(
        (spec.min[0] + spec.max[0]) / 2,
        (spec.min[1] + spec.max[1]) / 2,
        (spec.min[2] + spec.max[2]) / 2,
      );
      center.setComponent(spec.axis, spec.offset);
      quad.position.copy(center);
      quad.userData.planeId = spec.id;
      quad.userData.axis = spec.axis;

      this.planeGroup.add(quad);
      this.planeQuads.push(quad);
    }
  }

  setSelectedPlane(id: string | null) {
    if (this.selectedPlane === id) return;
    this.selectedPlane = id;
    this.setPlanes(this.planeSpecs, this.planeGroup.visible);
  }

  /** Move one plane without rebuilding the whole gizmo set (drag / slider). */
  movePlane(id: string, offset: number) {
    const spec = this.planeSpecs.find((s) => s.id === id);
    const quad = this.planeQuads.find((q) => q.userData.planeId === id);
    if (!spec || !quad) return;
    spec.offset = offset;
    quad.position.setComponent(spec.axis, offset);
  }

  setExplode(amount: number) { this.explodeTarget = amount; }

  setPartVisible(id: number, visible: boolean) {
    const m = this.partMeshes.find((x) => x.userData.partId === id);
    if (m) m.visible = visible;
  }

  setSelected(id: number | null) {
    this.selected = id;
    this.applyHighlight();
  }

  private applyHighlight() {
    for (const m of this.partMeshes) {
      const mat = m.material as THREE.MeshStandardMaterial;
      const id = m.userData.partId as number;
      const isSel = this.selected !== null && this.selected === id;
      const isHov = this.hovered === id;
      mat.emissive.setHex(isSel ? 0x3a3a3a : isHov ? 0x1c1c1c : 0x000000);
      if (this.selected !== null && !isSel) {
        mat.transparent = true;
        mat.opacity = 0.25;
        mat.depthWrite = false;
      } else {
        mat.transparent = false;
        mat.opacity = 1;
        mat.depthWrite = true;
      }
      mat.needsUpdate = true;
    }
  }

  frameModel() {
    if (!this.partMeshes.length) return;
    const box = new THREE.Box3();
    for (const m of this.partMeshes) if (m.visible) box.expandByObject(m);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.25;
    const dir = new THREE.Vector3(0.62, -0.78, 0.42).normalize();
    this.camera.position.copy(center.clone().add(dir.multiplyScalar(dist)));
    this.camera.near = Math.max(dist / 500, 0.05);
    this.camera.far = dist * 60;
    this.camera.updateProjectionMatrix();
    this.controls.target.copy(center);
    this.controls.update();
  }

  setView(preset: 'iso' | 'front' | 'top' | 'right') {
    if (!this.partMeshes.length) return;
    const box = new THREE.Box3();
    for (const m of this.partMeshes) box.expandByObject(m);
    if (box.isEmpty()) return;
    const center = box.getCenter(new THREE.Vector3());
    const radius = Math.max(box.getSize(new THREE.Vector3()).length() / 2, 1);
    const dist = (radius / Math.sin((this.camera.fov * Math.PI) / 360)) * 1.25;
    const dirs: Record<string, THREE.Vector3> = {
      iso: new THREE.Vector3(0.62, -0.78, 0.42),
      front: new THREE.Vector3(0, -1, 0),
      top: new THREE.Vector3(0, -0.001, 1),
      right: new THREE.Vector3(1, 0, 0),
    };
    this.camera.position.copy(center.clone().add(dirs[preset].clone().normalize().multiplyScalar(dist)));
    this.controls.target.copy(center);
    this.controls.update();
  }

  setGridVisible(v: boolean) {
    this.grid.visible = v;
    this.gridFine.visible = v;
    this.axisLines.visible = v;
  }

  /* ---------------- interaction ---------------- */

  private updatePointer(e: { clientX: number; clientY: number }) {
    const r = this.renderer.domElement.getBoundingClientRect();
    this.pointer.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
  }

  private pickPart(): number | null {
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.partMeshes.filter((m) => m.visible), false);
    if (!hits.length) return null;
    const id = hits[0].object.userData.partId as number;
    return id >= 0 ? id : null;
  }

  private pickPlane(): THREE.Mesh | null {
    if (!this.planeGroup.visible || !this.planeQuads.length) return null;
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hits = this.raycaster.intersectObjects(this.planeQuads, false);
    return hits.length ? (hits[0].object as THREE.Mesh) : null;
  }

  private lastHoverTest = 0;
  private onPointerMove = (e: PointerEvent) => {
    if (this.drag) return;
    const now = performance.now();
    if (now - this.lastHoverTest < 60) return;
    this.lastHoverTest = now;
    this.updatePointer(e);

    if (this.pickPlane()) {
      this.renderer.domElement.style.cursor = 'grab';
      return;
    }
    if (this.totalTriangles > 500_000) {
      this.renderer.domElement.style.cursor = 'default';
      return;
    }
    const id = this.pickPart();
    if (id !== this.hovered) {
      this.hovered = id;
      this.applyHighlight();
      this.renderer.domElement.style.cursor = id !== null ? 'pointer' : 'default';
    }
  };

  /* --- plane dragging ------------------------------------------------ */

  private drag: {
    id: string;
    axis: 0 | 1 | 2;
    startOffset: number;
    startPx: { x: number; y: number };
    /** Screen-space direction + pixels-per-world-unit for the cut axis. */
    dir: THREE.Vector2;
    pxPerUnit: number;
    range: [number, number];
    moved: boolean;
  } | null = null;

  /**
   * Screen-space axis projection: robust for every camera orientation and
   * guarantees the plane can only ever slide along its own normal.
   */
  private axisScreenMetrics(worldPoint: THREE.Vector3, axis: 0 | 1 | 2) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const toPx = (v: THREE.Vector3) => {
      const p = v.clone().project(this.camera);
      return new THREE.Vector2((p.x * 0.5 + 0.5) * rect.width, (-p.y * 0.5 + 0.5) * rect.height);
    };
    const unit = new THREE.Vector3();
    unit.setComponent(axis, 1);
    const a = toPx(worldPoint);
    const b = toPx(worldPoint.clone().add(unit));
    const d = b.clone().sub(a);
    const len = d.length();
    if (len < 1e-4) return { dir: new THREE.Vector2(0, -1), pxPerUnit: 1 };
    return { dir: d.clone().divideScalar(len), pxPerUnit: len };
  }

  private onPointerDown = (e: PointerEvent) => {
    if (e.button !== 0) return;
    this.updatePointer(e);

    const quad = this.pickPlane();
    if (quad) {
      const id = quad.userData.planeId as string;
      const spec = this.planeSpecs.find((s) => s.id === id);
      if (spec) {
        this.cb.onPlaneSelect?.(id);
        this.setSelectedPlane(id);
        const worldPoint = quad.getWorldPosition(new THREE.Vector3());
        const { dir, pxPerUnit } = this.axisScreenMetrics(worldPoint, spec.axis);
        this.drag = {
          id, axis: spec.axis, startOffset: spec.offset,
          startPx: { x: e.clientX, y: e.clientY },
          dir, pxPerUnit, range: spec.range, moved: false,
        };
        this.controls.enabled = false;
        this.renderer.domElement.style.cursor = 'grabbing';
        window.addEventListener('pointermove', this.onDragMove);
        window.addEventListener('pointerup', this.onDragEnd);
        e.preventDefault();
        return;
      }
    }

    // Otherwise: part selection on a click (not a rotate-drag).
    const start = { x: e.clientX, y: e.clientY };
    const up = (ev: PointerEvent) => {
      window.removeEventListener('pointerup', up);
      if (ev.button !== 0) return;
      if (Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 4) return;
      this.updatePointer(ev);
      if (this.pickPlane()) return;
      const id = this.pickPart();
      this.cb.onPick?.(id);
      if (id === null) { this.cb.onPlaneSelect?.(null); this.setSelectedPlane(null); }
    };
    window.addEventListener('pointerup', up);
  };

  private onDragMove = (e: PointerEvent) => {
    const d = this.drag;
    if (!d) return;
    const dx = e.clientX - d.startPx.x;
    const dy = e.clientY - d.startPx.y;
    const along = (dx * d.dir.x + dy * d.dir.y) / d.pxPerUnit;
    let next = d.startOffset + along;
    next = Math.min(Math.max(next, d.range[0]), d.range[1]);
    if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
    this.movePlane(d.id, next);
    this.cb.onPlaneDrag?.(d.id, next, false);
  };

  private onDragEnd = () => {
    const d = this.drag;
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    this.drag = null;
    this.controls.enabled = true;
    this.renderer.domElement.style.cursor = 'grab';
    if (!d) return;
    const spec = this.planeSpecs.find((s) => s.id === d.id);
    if (spec && d.moved) this.cb.onPlaneDrag?.(d.id, spec.offset, true);
  };

  /* ---------------- loop ---------------- */

  private resize() {
    const w = this.container.clientWidth;
    const h = this.container.clientHeight;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
  }

  private animate = () => {
    if (this.disposed) return;
    this.frameId = requestAnimationFrame(this.animate);

    this.explodeCurrent += (this.explodeTarget - this.explodeCurrent) * 0.15;
    if (Math.abs(this.explodeTarget - this.explodeCurrent) < 1e-4) this.explodeCurrent = this.explodeTarget;

    const amt = this.explodeCurrent * this.modelRadius * 1.15;
    for (const m of this.partMeshes) {
      const c = m.userData.center as THREE.Vector3 | undefined;
      if (!c) continue;
      const dir = c.clone().sub(this.assemblyCenter);
      if (dir.lengthSq() < 1e-9) continue;
      m.position.copy(dir.normalize().multiplyScalar(amt));
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
  };

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.frameId);
    this.ro.disconnect();
    const el = this.renderer.domElement;
    el.removeEventListener('pointermove', this.onPointerMove);
    el.removeEventListener('pointerdown', this.onPointerDown);
    window.removeEventListener('pointermove', this.onDragMove);
    window.removeEventListener('pointerup', this.onDragEnd);
    this.clearRoot();
    this.controls.dispose();
    this.renderer.dispose();
    if (el.parentElement === this.container) this.container.removeChild(el);
  }
}
