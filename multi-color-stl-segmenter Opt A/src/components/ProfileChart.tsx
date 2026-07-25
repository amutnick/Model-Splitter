import { AXIS_NAME, type AxisProfile } from '../lib/autoSegment';

interface Props {
  profile: AxisProfile;
  /** Offsets of cuts that share this profile's axis. */
  offsets: number[];
  hasColor: boolean;
}

const W = 260;
const H = 88;

/** Visualises the planner's cross-section / cut-cost / colour-edge curves. */
export default function ProfileChart({ profile, offsets, hasColor }: Props) {
  const n = profile.cost.length;
  const t0 = profile.t[0];
  const t1 = profile.t[n - 1];
  const span = Math.max(t1 - t0, 1e-9);

  const maxCross = Math.max(...profile.crossArea, 1e-9);
  const minCost = Math.min(...profile.cost);
  const maxCost = Math.max(...profile.cost);
  const costSpan = Math.max(maxCost - minCost, 1e-9);

  const path = (vals: ArrayLike<number>, norm: (v: number) => number) => {
    let d = '';
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * W;
      const y = H - norm(vals[i]) * (H - 6) - 3;
      d += `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
    }
    return d;
  };

  return (
    <div className="rounded-lg border border-white/10 bg-black/30 p-2">
      <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>Profile along <b className="text-slate-300">{AXIS_NAME[profile.axis]}</b></span>
        <span className="font-mono">{t0.toFixed(1)} → {t1.toFixed(1)} mm</span>
      </div>
      <svg viewBox={`0 0 ${W} ${H}`} className="h-[88px] w-full">
        <defs>
          <linearGradient id="csGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.45" />
            <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        <path d={`${path(profile.crossArea, (v) => v / maxCross)} L${W},${H} L0,${H} Z`} fill="url(#csGrad)" />
        <path d={path(profile.crossArea, (v) => v / maxCross)} fill="none" stroke="#38bdf8" strokeWidth="1.2" />
        {hasColor && (
          <path d={path(profile.colorEdge, (v) => v)} fill="none" stroke="#c084fc" strokeWidth="1.1" opacity="0.9" />
        )}
        <path
          d={path(profile.cost, (v) => 1 - (v - minCost) / costSpan)}
          fill="none" stroke="#f59e0b" strokeWidth="1.2" strokeDasharray="3 2"
        />
        {offsets.map((o, i) => {
          const x = ((o - t0) / span) * W;
          if (x < -2 || x > W + 2) return null;
          return (
            <g key={i}>
              <line x1={x} y1={0} x2={x} y2={H} stroke="#ef4444" strokeWidth="1.2" opacity="0.85" />
              <circle cx={x} cy={5} r="2.4" fill="#ef4444" />
            </g>
          );
        })}
      </svg>
      <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[9px] text-slate-400">
        <span className="flex items-center gap-1"><i className="h-[2px] w-3 bg-sky-400" />section</span>
        <span className="flex items-center gap-1"><i className="h-[2px] w-3 bg-amber-500" />cut quality</span>
        {hasColor && <span className="flex items-center gap-1"><i className="h-[2px] w-3 bg-purple-400" />colour edge</span>}
        <span className="flex items-center gap-1"><i className="h-[2px] w-3 bg-red-500" />seams</span>
      </div>
    </div>
  );
}
