import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Viewport from './components/Viewport';
import Dropzone from './components/Dropzone';
import ProfileChart from './components/ProfileChart';
import CutList from './components/CutList';
import type { ViewportEngine, PlaneSpec } from './three/engine';
import type { MeshData } from './lib/stlIO';
import { computeBounds, signedVolume, type Bounds } from './lib/meshUtils';
import {
  runSegmentation, reapplyPlan, flattenSplits, removeSplit, updateSplit,
  replaceLeaf, planLeafSplit, executePlan, profileAxis, bestCut,
  DEFAULT_OPTIONS, AXIS_NAME,
  type PlanNode, type PlannerOptions, type Segment,
  type SegmentMode, type AxisOption, type AxisProfile,
} from './lib/autoSegment';
import { exportSegmentsZip, exportSinglePart } from './lib/exportZip';
import { saveBinaryFile } from './utils/tauriBridge';
import { loadModelFiles, type LoadedModel } from './lib/loadModel';
import { buildDemoCreature, buildDemoFigurine } from './lib/demoModel';
import {
  isTauri, openFileDialog, getNativeInfo, type NativeAppInfo,
} from './utils/tauriBridge';

/* ------------------------------------------------------------------ */
/* UI primitives                                                       */
/* ------------------------------------------------------------------ */

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-white/[0.07] px-4 py-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.14em] text-slate-400">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}

function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string; hint?: string; disabled?: boolean }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex rounded-lg bg-black/40 p-1 ring-1 ring-white/10">
      {options.map((o) => (
        <button
          key={o.value}
          title={o.hint}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={`flex-1 rounded-md px-1.5 py-1.5 text-[11px] font-medium transition ${
            value === o.value ? 'bg-sky-500 text-white shadow' : 'text-slate-400 hover:text-white'
          } disabled:cursor-not-allowed disabled:text-slate-600 disabled:hover:text-slate-600`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Toggle({ checked, onChange, label, hint }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; hint?: string;
}) {
  return (
    <label title={hint} className="flex cursor-pointer items-center justify-between gap-3 py-1">
      <span className="text-xs text-slate-300">{label}</span>
      <span
        onClick={() => onChange(!checked)}
        className={`relative h-5 w-9 shrink-0 rounded-full transition ${checked ? 'bg-emerald-500' : 'bg-slate-600'}`}
      >
        <span className={`absolute top-0.5 h-4 w-4 rounded-full bg-white transition-all ${checked ? 'left-[18px]' : 'left-0.5'}`} />
      </span>
    </label>
  );
}

function Slider({ label, value, min, max, step, onChange, format }: {
  label: string; value: number; min: number; max: number; step: number;
  onChange: (v: number) => void; format?: (v: number) => string;
}) {
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between">
        <p className="text-[11px] text-slate-500">{label}</p>
        <span className="font-mono text-xs text-sky-300">{format ? format(value) : value}</span>
      </div>
      <input
        type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(+e.target.value)}
        className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-500"
      />
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-black/30 px-2.5 py-2 ring-1 ring-white/[0.06]">
      <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-0.5 truncate text-[13px] font-semibold text-slate-100">{value}</div>
    </div>
  );
}

const fmt = (n: number) => n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/* ------------------------------------------------------------------ */
/* App                                                                 */
/* ------------------------------------------------------------------ */

export default function App() {
  const engineRef = useRef<ViewportEngine | null>(null);

  const [model, setModel] = useState<LoadedModel | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [root, setRoot] = useState<PlanNode | null>(null);
  const [nodeBounds, setNodeBounds] = useState<Map<string, Bounds>>(new Map());
  const [warnings, setWarnings] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<{ pct: number; label: string } | null>(null);
  const [exportPct, setExportPct] = useState<number | null>(null);
  const [elapsed, setElapsed] = useState<number | null>(null);

  const [opts, setOpts] = useState<PlannerOptions>(DEFAULT_OPTIONS);
  const [explode, setExplode] = useState(0);
  const [showPlanes, setShowPlanes] = useState(true);
  const [showGrid, setShowGrid] = useState(true);
  const [showSourceColors, setShowSourceColors] = useState(true);
  const [selectedPart, setSelectedPart] = useState<number | null>(null);
  const [selectedCut, setSelectedCut] = useState<string | null>(null);
  const [recenterExport, setRecenterExport] = useState(false);
  const [tab, setTab] = useState<'parts' | 'cuts'>('parts');
  const [previewProfile, setPreviewProfile] = useState<AxisProfile | null>(null);
  const [nativeInfo, setNativeInfo] = useState<NativeAppInfo | null>(null);

  // Ping the Rust backend once on mount so the header can show "Native" mode.
  useEffect(() => { getNativeInfo().then(setNativeInfo).catch(() => {}); }, []);

  const hasColor = !!model?.colors;
  const mesh: MeshData | null = model;

  const stats = useMemo(() => {
    if (!mesh) return null;
    const b = computeBounds(mesh);
    return {
      triangles: mesh.positions.length / 9,
      size: b.size,
      volume: Math.abs(signedVolume(mesh)),
      offset: [-b.center[0], -b.center[1], -b.min[2]] as [number, number, number],
    };
  }, [mesh]);

  const splits = useMemo(() => (root ? flattenSplits(root) : []), [root]);

  /**
   * Offsets of cuts currently being dragged. Kept OUT of `root` so that moving
   * a plane never re-creates the gizmo meshes mid-drag (which would drop the
   * drag target); the authoritative tree is only written on release.
   */
  const [liveOffsets, setLiveOffsets] = useState<Record<string, number>>({});
  const displaySplits = useMemo(
    () => splits.map((s) => (liveOffsets[s.id] !== undefined ? { ...s, offset: liveOffsets[s.id] } : s)),
    [splits, liveOffsets],
  );

  /* ---------------- plane specs for the viewport ---------------- */

  const planeSpecs = useMemo<PlaneSpec[]>(() => {
    return splits.map((s) => {
      const b = nodeBounds.get(s.id);
      const min = b ? b.min : ([-50, -50, -50] as [number, number, number]);
      const max = b ? b.max : ([50, 50, 50] as [number, number, number]);
      return {
        id: s.id, axis: s.axis, offset: s.offset,
        min, max, range: s.range, enabled: s.enabled,
        label: `Cut ${AXIS_NAME[s.axis]}`,
      };
    });
  }, [splits, nodeBounds]);

  useEffect(() => {
    engineRef.current?.setPlanes(planeSpecs, showPlanes && planeSpecs.length > 0);
  }, [planeSpecs, showPlanes]);

  useEffect(() => { engineRef.current?.setSelectedPlane(selectedCut); }, [selectedCut]);
  useEffect(() => { engineRef.current?.setExplode(explode); }, [explode]);
  useEffect(() => { engineRef.current?.setGridVisible(showGrid); }, [showGrid]);
  useEffect(() => { engineRef.current?.setSelected(selectedPart); }, [selectedPart]);

  /* ---------------- loading ---------------- */

  const applyModel = useCallback((m: LoadedModel) => {
    setModel(m);
    setSegments([]);
    setRoot(null);
    setNodeBounds(new Map());
    setSelectedPart(null);
    setSelectedCut(null);
    setWarnings([]);
    setNotes(m.notes);
    setError(null);
    setExplode(0);
    setElapsed(null);
    setTab('parts');
    if (m.colors) setOpts((o) => ({ ...o, mode: 'auto' }));
    const e = engineRef.current;
    if (e) {
      e.setPreview(m, true);
      e.setPlanes([], false);
      e.setSelected(null);
      e.frameModel();
    }
  }, []);

  const handleFiles = useCallback(async (files: File[]) => {
    setBusy({ pct: 15, label: `Reading ${files[0].name}…` });
    setError(null);
    try {
      await new Promise((r) => setTimeout(r, 0));
      const m = await loadModelFiles(files);
      applyModel(m);
      const tris = m.positions.length / 9;
      if (tris > 400_000) {
        setWarnings([`Heavy mesh (${fmt(tris)} triangles) — slicing may take several seconds.`]);
      }
    } catch (err) {
      console.error(err);
      setError(err instanceof Error ? err.message : 'Could not read that model.');
    } finally {
      setBusy(null);
    }
  }, [applyModel]);

  /**
   * Native "Open…" entry point. Uses the Tauri dialog + Rust file reader when
   * running as a desktop app, or the DOM file picker in a plain browser.
   * Either way we get back real `File` objects that the existing loader chain
   * already knows how to consume — so this is a drop-in replacement for the
   * dropzone that also captures a batch of files at once (OBJ + MTL).
   */
  const handleNativeOpen = useCallback(async () => {
    if (busy) return;
    try {
      const loaded = await openFileDialog({
        title: 'Open 3D model',
        multiple: true,
        filters: [
          { name: '3D Models', extensions: ['stl', 'obj', '3mf', 'mtl'] },
          { name: 'STL', extensions: ['stl'] },
          { name: 'OBJ (+ MTL)', extensions: ['obj', 'mtl'] },
        ],
      });
      if (!loaded.length) return;
      const files = loaded.map((lf) => new File([lf.bytes], lf.name));
      await handleFiles(files);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not open that file.');
    }
  }, [busy, handleFiles]);

  const loadDemo = useCallback((kind: 'creature' | 'figurine') => {
    try {
      const m = kind === 'creature' ? buildDemoCreature() : buildDemoFigurine();
      applyModel({
        ...m,
        name: kind === 'creature' ? 'demo_creature.obj' : 'demo_figurine.stl',
        format: kind === 'creature' ? 'obj' : 'stl',
        materials: [],
        hasVertexColors: kind === 'creature',
        usedMtl: false,
        notes: kind === 'creature'
          ? ['Colour-authored demo: skin / hair / eyes / teeth / cloth / base.']
          : ['Uncoloured demo — pure geometric feature analysis.'],
      });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [applyModel]);

  /* ---------------- preview profile (before slicing) ---------------- */

  useEffect(() => {
    if (!mesh || segments.length || opts.mode === 'components' || opts.mode === 'color') {
      setPreviewProfile(null);
      return;
    }
    const id = setTimeout(() => {
      try {
        const cand = bestCut(mesh, opts, 0);
        setPreviewProfile(cand ? cand.profile : profileAxis(mesh, 2, opts));
      } catch { setPreviewProfile(null); }
    }, 80);
    return () => clearTimeout(id);
  }, [mesh, opts, segments.length]);

  /* ---------------- segmentation ---------------- */

  const handleSegment = useCallback(async () => {
    if (!mesh || busy) return;
    setBusy({ pct: 0, label: 'Starting…' });
    setError(null);
    setWarnings([]);
    try {
      const r = await runSegmentation(mesh, opts, (pct, label) => setBusy({ pct, label }));
      setSegments(r.segments);
      setRoot(r.root);
      setNodeBounds(r.nodeBounds);
      setWarnings(r.warnings);
      setNotes(r.notes);
      setElapsed(r.elapsedMs);
      setSelectedPart(null);
      setSelectedCut(null);
      setTab(flattenSplits(r.root).length ? 'cuts' : 'parts');
      const e = engineRef.current;
      if (e) { e.setSegments(r.segments); e.setSelected(null); }
      setExplode(0.22);
    } catch (err) {
      console.error(err);
      setError(`Segmentation failed: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  }, [mesh, opts, busy]);

  /** Cheap geometry-only re-run after a cut is moved / muted / deleted. */
  const reapply = useCallback((nextRoot: PlanNode) => {
    if (!mesh) return;
    setRoot(nextRoot);
    try {
      const r = reapplyPlan(mesh, nextRoot, opts);
      setSegments(r.segments);
      setNodeBounds(r.nodeBounds);
      setWarnings(r.warnings);
      setElapsed(r.elapsedMs);
      const e = engineRef.current;
      if (e) { e.setSegments(r.segments); e.setSelected(null); }
      setSelectedPart(null);
    } catch (err) {
      setError(`Re-slice failed: ${(err as Error).message}`);
    }
  }, [mesh, opts]);

  /* ---------------- cut editing ---------------- */

  const handleCutMove = useCallback((id: string, offset: number, committed: boolean) => {
    if (!root) return;
    // While dragging: move only the gizmo + the overlay value (cheap, 60fps).
    engineRef.current?.movePlane(id, offset);
    if (!committed) {
      setLiveOffsets((prev) => ({ ...prev, [id]: offset }));
      return;
    }
    // On release: commit to the plan tree and re-run the CSG.
    setLiveOffsets((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    reapply(updateSplit(root, id, { offset }));
  }, [root, reapply]);

  const handleCutToggle = useCallback((id: string, enabled: boolean) => {
    if (!root) return;
    reapply(updateSplit(root, id, { enabled }));
  }, [root, reapply]);

  const handleCutDelete = useCallback((id: string) => {
    if (!root) return;
    if (selectedCut === id) setSelectedCut(null);
    reapply(removeSplit(root, id));
  }, [root, reapply, selectedCut]);

  /** "Split again" on a leaf part: plan one more cut inside just that piece. */
  const handleSplitPart = useCallback((seg: Segment) => {
    if (!mesh || !root) return;
    try {
      const bounds = computeBounds(mesh);
      const eps = (Math.hypot(...bounds.size) || 1) * 2e-6;
      const exec = executePlan(mesh, root, eps);
      // Loose-shell separation appends "_sN" to a leaf id — cut the parent leaf.
      const baseId = seg.leafId.replace(/_s\d+$/, '');
      const piece = exec.pieces.find((p) => p.leafId === baseId);
      if (!piece) { setError('Could not locate that part in the cut tree — re-slice first.'); return; }
      const split = planLeafSplit(piece.mesh, opts, 1);
      if (!split) { setError('No viable cut found inside that part.'); return; }
      const next = replaceLeaf(root, baseId, split);
      setSelectedCut(split.id);
      setTab('cuts');
      reapply(next);
    } catch (e) {
      setError(`Could not split that part: ${(e as Error).message}`);
    }
  }, [mesh, root, opts, reapply]);

  const handleReset = useCallback(() => {
    if (!mesh) return;
    setSegments([]);
    setRoot(null);
    setNodeBounds(new Map());
    setSelectedPart(null);
    setSelectedCut(null);
    setWarnings([]);
    setExplode(0);
    setElapsed(null);
    setTab('parts');
    const e = engineRef.current;
    if (e) { e.setPreview(mesh, showSourceColors); e.setPlanes([], false); }
  }, [mesh, showSourceColors]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      const k = e.key.toLowerCase();
      if (k === 's') handleSegment();
      if (k === 'f') engineRef.current?.frameModel();
      if (k === 'p') setShowPlanes((v) => !v);
      if (e.key === 'Escape') { setSelectedPart(null); setSelectedCut(null); }
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedCut) handleCutDelete(selectedCut);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [handleSegment, selectedCut, handleCutDelete]);

  /* ---------------- export ---------------- */

  const handleExportZip = useCallback(async () => {
    if (!segments.length) return;
    setExportPct(0);
    try {
      // In native mode we always want the bytes so the OS Save dialog can pick
      // the destination. In the browser we let JSZip's default "download" path
      // fire so `<a download>` works without a user gesture race condition.
      const bundle = await exportSegmentsZip(
        segments.map((s) => ({
          name: s.name, color: s.color, mesh: s.mesh, volume: s.volume, triangles: s.triangles,
        })),
        model?.name || 'model',
        { recenter: recenterExport ? stats?.offset : undefined, returnBlob: isTauri() },
        setExportPct,
      );
      if (bundle) {
        const result = await saveBinaryFile(bundle.blob, {
          title: 'Save segmented ZIP',
          fallbackFilename: bundle.filename,
          filters: [{ name: 'ZIP archive', extensions: ['zip'] }],
        });
        if (result.saved && result.path) setNotes((n) => [`Saved to ${result.path}`, ...n]);
      }
    } catch (e) {
      setError(`Export failed: ${(e as Error).message}`);
    } finally {
      setTimeout(() => setExportPct(null), 700);
    }
  }, [segments, model, recenterExport, stats]);

  const toggleVisible = (id: number) => {
    setSegments((prev) => prev.map((s) => {
      if (s.id !== id) return s;
      engineRef.current?.setPartVisible(id, !s.visible);
      return { ...s, visible: !s.visible };
    }));
  };

  const useSourceColorsForParts = useCallback(() => {
    setSegments((prev) => {
      const next = prev.map((s) => ({ ...s, color: s.sourceColor ?? s.color }));
      engineRef.current?.setPartColors(next);
      return next;
    });
  }, []);

  const totalTris = segments.reduce((a, s) => a + s.triangles, 0);
  const chartOffsets = previewProfile
    ? displaySplits.filter((s) => s.axis === previewProfile.axis).map((s) => s.offset)
    : [];

  /* ---------------- render ---------------- */

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-[#0b0f14] text-slate-200">
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-white/[0.07] bg-[#0e141b] px-4">
        <div className="flex items-center gap-3">
          <div className="grid h-8 w-8 place-items-center rounded-lg bg-gradient-to-br from-sky-500 to-indigo-600 text-sm font-black text-white">⬒</div>
          <div>
            <h1 className="text-sm font-semibold leading-tight text-white">STL / OBJ Model Segmenter</h1>
            <p className="text-[10px] leading-tight text-slate-500">Multi-axis, colour-aware splitting for multi-colour 3D printing</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {nativeInfo && (
            <span
              title={`${nativeInfo.name} ${nativeInfo.version} · ${nativeInfo.os}/${nativeInfo.arch}`}
              className="hidden items-center gap-1 rounded-md bg-emerald-500/15 px-2 py-1 text-[10px] font-semibold text-emerald-300 ring-1 ring-emerald-500/30 md:flex"
            >
              ● NATIVE
            </span>
          )}
          {model && (
            <span className="hidden max-w-[220px] items-center gap-2 truncate rounded-md bg-black/40 px-3 py-1.5 font-mono text-[11px] text-slate-400 ring-1 ring-white/10 lg:flex">
              {model.name}
              {hasColor && <b className="rounded bg-purple-500/25 px-1 text-[9px] text-purple-300">RGB</b>}
            </span>
          )}
          <button
            onClick={handleNativeOpen}
            disabled={!!busy}
            title={isTauri() ? 'Open a model via the macOS file picker' : 'Open a model'}
            className="rounded-lg bg-sky-500/90 px-3 py-1.5 text-[11px] font-semibold text-white shadow shadow-sky-950/40 transition hover:bg-sky-400 disabled:opacity-40"
          >
            📂 Open…
          </button>
          <div className="flex rounded-lg bg-black/40 p-1 ring-1 ring-white/10">
            {(['iso', 'front', 'top', 'right'] as const).map((v) => (
              <button key={v} onClick={() => engineRef.current?.setView(v)}
                className="rounded px-2.5 py-1 text-[11px] capitalize text-slate-400 transition hover:bg-white/10 hover:text-white">
                {v}
              </button>
            ))}
          </div>
          <button onClick={() => setShowGrid((g) => !g)}
            className={`rounded-lg px-3 py-1.5 text-[11px] ring-1 transition ${showGrid ? 'bg-white/10 text-white ring-white/15' : 'text-slate-400 ring-white/10 hover:text-white'}`}>
            Grid
          </button>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* ---------------- Left sidebar ---------------- */}
        <aside className="flex w-[326px] shrink-0 flex-col overflow-y-auto border-r border-white/[0.07] bg-[#0e141b]">
          <Section title="Model">
            <Dropzone onFiles={handleFiles} compact disabled={!!busy} />
            {!model && (
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button onClick={() => loadDemo('creature')} className="rounded-lg bg-white/5 px-2 py-2 text-[11px] text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white">
                  🎨 Colour demo
                </button>
                <button onClick={() => loadDemo('figurine')} className="rounded-lg bg-white/5 px-2 py-2 text-[11px] text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10 hover:text-white">
                  🗿 Grey demo
                </button>
              </div>
            )}
            {stats && (
              <div className="mt-3 grid grid-cols-2 gap-2">
                <Stat label="Triangles" value={fmt(stats.triangles)} />
                <Stat label="Volume" value={`${fmt(stats.volume / 1000)} cm³`} />
                <Stat label="Size X·Y" value={`${stats.size[0].toFixed(1)} × ${stats.size[1].toFixed(1)}`} />
                <Stat label="Height Z" value={stats.size[2].toFixed(1)} />
              </div>
            )}
            {model && model.materials.length > 1 && (
              <div className="mt-3">
                <p className="mb-1.5 text-[10px] uppercase tracking-wide text-slate-500">
                  Source materials ({model.materials.length})
                </p>
                <div className="flex flex-wrap gap-1">
                  {model.materials.slice(0, 14).map((m) => (
                    <span key={m.name} title={`${m.name} — ${fmt(m.triangles)} tris`}
                      className="flex items-center gap-1 rounded bg-black/40 px-1.5 py-0.5 text-[9px] text-slate-400 ring-1 ring-white/10">
                      <i className="h-2.5 w-2.5 rounded-sm" style={{ background: `rgb(${m.color.map((c) => Math.round(c * 255)).join(',')})` }} />
                      {m.name.slice(0, 12)}
                    </span>
                  ))}
                </div>
              </div>
            )}
            {model && hasColor && !segments.length && (
              <Toggle checked={showSourceColors} label="Show source colours"
                onChange={(v) => { setShowSourceColors(v); engineRef.current?.setPreview(mesh, v); }} />
            )}
          </Section>

          <Section title="Segmentation">
            <div className="space-y-3">
              <div>
                <p className="mb-1.5 text-[11px] text-slate-500">Strategy</p>
                <Segmented<SegmentMode>
                  value={opts.mode}
                  onChange={(mode) => setOpts((o) => ({ ...o, mode }))}
                  options={[
                    { value: 'auto', label: 'Auto', hint: 'Recursive multi-axis feature analysis' },
                    { value: 'color', label: 'Colour', hint: hasColor ? 'Split by colour regions (no cutting)' : 'Requires an OBJ with colours', disabled: !hasColor },
                    { value: 'uniform', label: 'Even', hint: 'Recursive even bisection' },
                    { value: 'components', label: 'Shells', hint: 'Split disconnected shells' },
                  ]}
                />
              </div>

              {(opts.mode === 'auto' || opts.mode === 'uniform') && (
                <>
                  <div>
                    <p className="mb-1.5 text-[11px] text-slate-500">Cut axis</p>
                    <Segmented<AxisOption>
                      value={opts.axis}
                      onChange={(axis) => setOpts((o) => ({ ...o, axis }))}
                      options={[
                        { value: 'auto', label: 'Auto', hint: 'Re-chosen at every recursion level' },
                        { value: 'x', label: 'X' }, { value: 'y', label: 'Y' }, { value: 'z', label: 'Z' },
                      ]}
                    />
                  </div>

                  <Slider label="Target parts" value={opts.parts} min={2} max={24} step={1}
                    onChange={(v) => setOpts((o) => ({ ...o, parts: v }))} />

                  {opts.mode === 'auto' && (
                    <>
                      <Slider label="Feature adherence" value={opts.featureBias} min={0} max={1} step={0.05}
                        onChange={(v) => setOpts((o) => ({ ...o, featureBias: v }))}
                        format={(v) => `${Math.round(v * 100)}%`} />
                      <Slider label="Feature isolation" value={opts.featureIsolation} min={0} max={1} step={0.05}
                        onChange={(v) => setOpts((o) => ({ ...o, featureIsolation: v }))}
                        format={(v) => `${Math.round(v * 100)}%`} />
                      <p className="-mt-1 text-[10px] leading-relaxed text-slate-500">
                        Isolation controls how aggressively small protruding features (nose, ears,
                        eyes, horns) get carved off into their own colour parts.
                      </p>
                      {hasColor && (
                        <Slider label="Colour boundary weight" value={opts.colorWeight} min={0} max={1} step={0.05}
                          onChange={(v) => setOpts((o) => ({ ...o, colorWeight: v }))}
                          format={(v) => `${Math.round(v * 100)}%`} />
                      )}
                      <Toggle checked={opts.multiAxis} label="Allow multi-axis cuts"
                        hint="Re-evaluate X / Y / Z at every recursion level"
                        onChange={(v) => setOpts((o) => ({ ...o, multiAxis: v }))} />
                    </>
                  )}
                </>
              )}

              <Toggle checked={opts.separateLooseParts} label="Separate loose shells"
                hint="Eyes, gems and props that aren't welded to the body"
                onChange={(v) => setOpts((o) => ({ ...o, separateLooseParts: v }))} />
              <Toggle checked={showPlanes} onChange={setShowPlanes} label="Show cut planes (P)" />
            </div>

            <button
              onClick={handleSegment}
              disabled={!mesh || !!busy}
              className="mt-4 flex w-full items-center justify-center gap-2 rounded-lg bg-sky-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-sky-950/50 transition hover:bg-sky-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none">
              ✂ SLICE MODEL <span className="text-[10px] opacity-70">(S)</span>
            </button>
            {segments.length > 0 && (
              <button onClick={handleReset} className="mt-2 w-full rounded-lg bg-white/5 px-3 py-2 text-xs text-slate-300 ring-1 ring-white/10 transition hover:bg-white/10">
                ↺ Reset cuts
              </button>
            )}
          </Section>

          {previewProfile && (
            <Section title="Cut analysis">
              <ProfileChart profile={previewProfile} offsets={chartOffsets} hasColor={hasColor} />
            </Section>
          )}

          {notes.length > 0 && (
            <Section title="Planner notes">
              <ul className="space-y-1.5">
                {notes.slice(0, 6).map((n, i) => (
                  <li key={i} className="flex gap-2 text-[11px] leading-relaxed text-slate-400">
                    <span className="text-emerald-400">▸</span>{n}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          <div className="mt-auto px-4 py-4 text-[10px] leading-relaxed text-slate-600">
            LMB rotate · RMB pan · scroll zoom · <b className="text-slate-500">drag a red/green/blue plane to move that cut</b> · click a part to isolate · F fit · Del removes selected cut
          </div>
        </aside>

        {/* ---------------- Viewport ---------------- */}
        <main className="relative min-w-0 flex-1">
          <Viewport
            className="absolute inset-0"
            onReady={(e) => { engineRef.current = e; e.setGridVisible(showGrid); }}
            onPick={(id) => setSelectedPart((cur) => (cur === id ? null : id))}
            onPlaneSelect={(id) => { setSelectedCut(id); if (id) setTab('cuts'); }}
            onPlaneDrag={handleCutMove}
          />

          {!model && (
            <div className="absolute inset-0 z-20 flex items-center justify-center bg-[#0b0f14]/85 p-10 backdrop-blur-sm">
              <div className="h-full max-h-[440px] w-full max-w-2xl">
                <Dropzone onFiles={handleFiles} disabled={!!busy} />
              </div>
            </div>
          )}

          {model && (
            <div className="pointer-events-none absolute inset-x-0 bottom-5 z-10 flex justify-center px-4">
              <div className="pointer-events-auto flex flex-wrap items-center justify-center gap-x-4 gap-y-2 rounded-xl border border-white/10 bg-[#11161d]/95 px-4 py-2.5 shadow-2xl backdrop-blur">
                <div className="flex items-center gap-2.5">
                  <span className="text-[11px] font-medium text-slate-300">Exploded View</span>
                  <input type="range" min={0} max={1} step={0.01} value={explode}
                    disabled={!segments.length}
                    onChange={(e) => setExplode(+e.target.value)}
                    className="h-1.5 w-36 cursor-pointer appearance-none rounded-full bg-slate-700 accent-sky-500 disabled:opacity-40" />
                </div>
                <div className="h-5 w-px bg-white/10" />
                <button onClick={handleReset} disabled={!segments.length}
                  className="rounded-md px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/10 disabled:opacity-40">↺ Reset Cuts</button>
                <button onClick={() => setShowPlanes((v) => !v)}
                  className={`rounded-md px-2.5 py-1 text-[11px] transition hover:bg-white/10 ${showPlanes ? 'text-sky-300' : 'text-slate-400'}`}>◫ Planes</button>
                <button onClick={() => engineRef.current?.frameModel()}
                  className="rounded-md px-2.5 py-1 text-[11px] text-slate-300 transition hover:bg-white/10">⤢ Fit</button>
                {segments.length > 0 && (
                  <span className="rounded-md bg-emerald-500/15 px-2.5 py-1 text-[11px] font-medium text-emerald-300">
                    {segments.length} parts · {splits.length} cuts
                  </span>
                )}
              </div>
            </div>
          )}

          {selectedCut && (
            <div className="pointer-events-none absolute right-4 top-4 z-10 rounded-lg border border-amber-500/40 bg-amber-950/70 px-3 py-2 text-[11px] text-amber-200 backdrop-blur">
              Drag the highlighted plane to slide this cut along its {AXIS_NAME[displaySplits.find((s) => s.id === selectedCut)?.axis ?? 0]} axis
            </div>
          )}

          {busy && (
            <div className="absolute inset-0 z-30 flex items-center justify-center bg-[#0b0f14]/75 backdrop-blur-sm">
              <div className="w-72 rounded-xl border border-white/10 bg-[#11161d] p-5 shadow-2xl">
                <div className="mb-3 flex items-center gap-3">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-sky-500 border-t-transparent" />
                  <span className="text-sm text-slate-200">{busy.label}</span>
                </div>
                <div className="h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
                  <div className="h-full rounded-full bg-sky-500 transition-all duration-200" style={{ width: `${busy.pct}%` }} />
                </div>
              </div>
            </div>
          )}

          <div className="pointer-events-none absolute left-4 top-4 z-20 w-[360px] space-y-2">
            {error && (
              <div className="pointer-events-auto flex items-start gap-2 rounded-lg border border-red-500/40 bg-red-950/85 p-3 text-xs text-red-200 backdrop-blur">
                <span>⚠</span><span className="flex-1">{error}</span>
                <button onClick={() => setError(null)} className="text-red-300 hover:text-white">✕</button>
              </div>
            )}
            {warnings.slice(0, 3).map((w, i) => (
              <div key={i} className="pointer-events-auto rounded-lg border border-amber-500/30 bg-amber-950/70 p-2.5 text-[11px] text-amber-200 backdrop-blur">{w}</div>
            ))}
          </div>
        </main>

        {/* ---------------- Right sidebar ---------------- */}
        <aside className="flex w-[310px] shrink-0 flex-col overflow-y-auto border-l border-white/[0.07] bg-[#0e141b]">
          <div className="flex shrink-0 gap-1 border-b border-white/[0.07] p-2">
            {(['parts', 'cuts'] as const).map((t) => (
              <button key={t} onClick={() => setTab(t)}
                className={`flex-1 rounded-md px-3 py-1.5 text-[11px] font-medium capitalize transition ${
                  tab === t ? 'bg-white/10 text-white' : 'text-slate-400 hover:text-white'}`}>
                {t} ({t === 'parts' ? segments.length : splits.length})
              </button>
            ))}
          </div>

          {tab === 'cuts' ? (
            <Section title="Cut planes" right={<span className="text-[10px] text-slate-500">drag in viewport</span>}>
              <CutList
                splits={displaySplits}
                selectedId={selectedCut}
                onSelect={setSelectedCut}
                onMove={handleCutMove}
                onToggle={handleCutToggle}
                onDelete={handleCutDelete}
              />
            </Section>
          ) : (
            <Section title="Parts" right={elapsed !== null ? <span className="font-mono text-[10px] text-slate-500">{elapsed.toFixed(0)} ms</span> : undefined}>
              {!segments.length ? (
                <p className="rounded-lg border border-dashed border-white/10 px-3 py-6 text-center text-[11px] leading-relaxed text-slate-500">
                  No segments yet.<br />Choose a strategy and press <b className="text-slate-300">Slice Model</b>.
                </p>
              ) : (
                <>
                  {segments.some((s) => s.sourceColor) && (
                    <button onClick={useSourceColorsForParts}
                      className="mb-2 w-full rounded-lg bg-purple-500/15 px-3 py-1.5 text-[11px] text-purple-200 ring-1 ring-purple-500/30 transition hover:bg-purple-500/25">
                      🎨 Use source model colours
                    </button>
                  )}
                  <ul className="space-y-1.5">
                    {segments.map((s) => (
                      <li key={s.id}
                        onClick={() => setSelectedPart(selectedPart === s.id ? null : s.id)}
                        className={`group flex cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-2 ring-1 transition ${
                          selectedPart === s.id ? 'bg-sky-500/15 ring-sky-500/50' : 'bg-black/25 ring-white/[0.06] hover:bg-white/[0.06]'}`}>
                        <span className="h-6 w-6 shrink-0 rounded-md ring-1 ring-white/20" style={{ background: s.color }} />
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-slate-100">{s.name}</div>
                          <div className="text-[10px] text-slate-500">{fmt(s.triangles)} tris · {(s.volume / 1000).toFixed(1)} cm³</div>
                        </div>
                        <button title="Split this part again"
                          onClick={(e) => { e.stopPropagation(); handleSplitPart(s); }}
                          className="rounded px-1 text-xs text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-amber-300">✂</button>
                        <button title={s.visible ? 'Hide' : 'Show'}
                          onClick={(e) => { e.stopPropagation(); toggleVisible(s.id); }}
                          className="rounded px-1 text-xs text-slate-400 transition hover:text-white">{s.visible ? '👁' : '🚫'}</button>
                        <button title="Download this part"
                          onClick={(e) => {
                            e.stopPropagation();
                            exportSinglePart(
                              { name: s.name, color: s.color, mesh: s.mesh, volume: s.volume, triangles: s.triangles },
                              model?.name || 'model',
                              recenterExport ? stats?.offset : undefined,
                            );
                          }}
                          className="rounded px-1 text-xs text-slate-400 opacity-0 transition group-hover:opacity-100 hover:text-white">⭳</button>
                      </li>
                    ))}
                  </ul>
                </>
              )}
            </Section>
          )}

          <Section title="Export">
            <Toggle checked={recenterExport} onChange={setRecenterExport} label="Re-centre assembly on origin" />
            <p className="mb-3 mt-1 text-[10px] leading-relaxed text-slate-500">
              Every part is written in the same coordinate frame, so importing them together into
              Bambu Studio / PrusaSlicer / Orca reassembles the model exactly.
            </p>
            <button onClick={handleExportZip} disabled={!segments.length || exportPct !== null}
              className="flex w-full items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-3 text-sm font-bold text-white shadow-lg shadow-emerald-950/50 transition hover:bg-emerald-400 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-500 disabled:shadow-none">
              ⭳ Download .ZIP
            </button>
            {exportPct !== null && (
              <div className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-slate-700">
                <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${exportPct}%` }} />
              </div>
            )}
            {segments.length > 0 && (
              <div className="mt-3 rounded-lg bg-black/30 p-2.5 font-mono text-[10px] leading-relaxed text-slate-500 ring-1 ring-white/[0.06]">
                {(model?.name || 'model').replace(/\.(stl|obj)$/i, '')}_segmented.zip
                <br />└ {segments.length} × .stl · {fmt(totalTris)} tris · MANIFEST.txt
              </div>
            )}
          </Section>

          <Section title="How the planner thinks">
            <ul className="space-y-2 text-[11px] leading-relaxed text-slate-400">
              <li><b className="text-slate-300">Recursive:</b> each sub-piece is re-analysed on X, Y and Z, so a head separates on Z and then a snout on Y.</li>
              <li><b className="text-slate-300">Colour-aware:</b> OBJ vertex/MTL colours pull seams onto hair, eye and skin boundaries.</li>
              <li><b className="text-slate-300">Print-ready:</b> seams prefer necks, flat faces and low-overhang regions; every cut is capped watertight.</li>
              <li><b className="text-slate-300">Editable:</b> drag any plane, mute it, delete it, or split a part again.</li>
            </ul>
          </Section>
        </aside>
      </div>
    </div>
  );
}
