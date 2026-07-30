import { AXIS_NAME, type PlanSplit } from '../lib/autoSegment';

interface Props {
  splits: PlanSplit[];
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onMove: (id: string, offset: number, committed: boolean) => void;
  onToggle: (id: string, enabled: boolean) => void;
  onToggleConnectors: (id: string, enabled: boolean) => void;
  onDelete: (id: string) => void;
}

const AXIS_STYLE = [
  'bg-red-500/20 text-red-300 ring-red-500/40',
  'bg-emerald-500/20 text-emerald-300 ring-emerald-500/40',
  'bg-sky-500/20 text-sky-300 ring-sky-500/40',
];

/**
 * Editable list of every plane in the BSP tree. Each cut can be selected,
 * slid along its own axis (slider or numeric field), muted, or deleted —
 * deleting a cut collapses its whole subtree back into one part.
 */
export default function CutList({
  splits, selectedId, onSelect, onMove, onToggle, onToggleConnectors, onDelete,
}: Props) {
  if (!splits.length) {
    return (
      <p className="rounded-lg border border-dashed border-white/10 px-3 py-5 text-center text-[11px] leading-relaxed text-slate-500">
        No cuts yet. Run <b className="text-slate-300">Slice Model</b> to generate them,
        then drag any plane in the viewport.
      </p>
    );
  }

  return (
    <ul className="space-y-1.5">
      {splits.map((s, i) => {
        const sel = selectedId === s.id;
        const span = Math.max(s.range[1] - s.range[0], 1e-6);
        const step = span / 400;
        return (
          <li
            key={s.id}
            onClick={() => onSelect(sel ? null : s.id)}
            className={`cursor-pointer rounded-lg px-2.5 py-2 ring-1 transition ${
              sel ? 'bg-amber-500/10 ring-amber-500/50' : 'bg-black/25 ring-white/[0.06] hover:bg-white/[0.05]'
            } ${s.enabled ? '' : 'opacity-50'}`}
          >
            <div className="flex items-center gap-2">
              <span
                className={`grid h-6 w-6 shrink-0 place-items-center rounded-md text-[11px] font-bold ring-1 ${AXIS_STYLE[s.axis]}`}
                title={`Cut normal: ${AXIS_NAME[s.axis]} axis`}
              >
                {AXIS_NAME[s.axis]}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[11px] font-medium text-slate-200">
                  Cut {i + 1}
                  <span className="ml-1.5 font-normal text-slate-500">· {s.reason}</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-slate-700">
                    <div
                      className="h-full rounded-full bg-emerald-500"
                      style={{ width: `${Math.round(s.quality * 100)}%` }}
                    />
                  </div>
                  <span className="text-[9px] text-slate-500">
                    quality {Math.round(s.quality * 100)}% · depth {s.depth}
                  </span>
                </div>
              </div>
              <button
                title={s.connectors ? 'Remove guide pegs from this cut' : 'Add guide pegs and matching sockets to this cut'}
                onClick={(e) => { e.stopPropagation(); onToggleConnectors(s.id, !s.connectors); }}
                className={`rounded px-1.5 py-0.5 text-[9px] font-bold transition ${
                  s.connectors ? 'bg-emerald-500/20 text-emerald-300 ring-1 ring-emerald-500/40' : 'text-slate-500 hover:text-emerald-300'
                }`}
              >PEG</button>
              <button
                title={s.enabled ? 'Mute this cut' : 'Enable this cut'}
                onClick={(e) => { e.stopPropagation(); onToggle(s.id, !s.enabled); }}
                className="rounded px-1 text-[11px] text-slate-400 transition hover:text-white"
              >{s.enabled ? '◉' : '○'}</button>
              <button
                title="Delete this cut (merges its parts)"
                onClick={(e) => { e.stopPropagation(); onDelete(s.id); }}
                className="rounded px-1 text-[11px] text-slate-500 transition hover:text-red-400"
              >✕</button>
            </div>

            {/* Position editor — constrained to the cut's own axis */}
            <div className="mt-2 flex items-center gap-2">
              <input
                type="range"
                min={s.range[0]}
                max={s.range[1]}
                step={step}
                value={s.offset}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => onMove(s.id, +e.target.value, false)}
                onPointerUp={(e) => onMove(s.id, +(e.target as HTMLInputElement).value, true)}
                onKeyUp={(e) => onMove(s.id, +(e.target as HTMLInputElement).value, true)}
                className="h-1.5 flex-1 cursor-pointer appearance-none rounded-full bg-slate-700 accent-amber-500"
              />
              <input
                type="number"
                value={Number(s.offset.toFixed(2))}
                step={Number((span / 100).toFixed(3))}
                onClick={(e) => e.stopPropagation()}
                onChange={(e) => {
                  const v = Number(e.target.value);
                  if (Number.isFinite(v)) onMove(s.id, Math.min(Math.max(v, s.range[0]), s.range[1]), false);
                }}
                onBlur={(e) => onMove(s.id, Math.min(Math.max(+e.target.value, s.range[0]), s.range[1]), true)}
                className="w-[62px] rounded-md bg-black/50 px-1.5 py-1 text-right font-mono text-[10px] text-slate-200 ring-1 ring-white/10 outline-none focus:ring-amber-500/60"
              />
              <span className="w-4 text-[9px] text-slate-500">mm</span>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
