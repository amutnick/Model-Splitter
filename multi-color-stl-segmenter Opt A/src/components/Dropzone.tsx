import { useCallback, useRef, useState } from 'react';

interface Props {
  onFiles: (files: File[]) => void;
  compact?: boolean;
  disabled?: boolean;
}

const ACCEPT = /\.(stl|obj|mtl)$/i;

export default function Dropzone({ onFiles, compact, disabled }: Props) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const handle = useCallback(
    (list: FileList | null) => {
      setErr(null);
      if (!list || !list.length) return;
      const files = Array.from(list).filter((f) => ACCEPT.test(f.name));
      if (!files.length) {
        setErr('Only .stl and .obj (plus an optional .mtl) files are supported.');
        return;
      }
      if (!files.some((f) => /\.(stl|obj)$/i.test(f.name))) {
        setErr('Drop the .obj together with its .mtl — an .mtl alone has no geometry.');
        return;
      }
      if (files.every((f) => f.size === 0)) {
        setErr('That file is empty.');
        return;
      }
      onFiles(files);
    },
    [onFiles],
  );

  const dnd = {
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); if (!disabled) setOver(true); },
    onDragLeave: () => setOver(false),
    onDrop: (e: React.DragEvent) => {
      e.preventDefault();
      setOver(false);
      if (!disabled) handle(e.dataTransfer.files);
    },
  };

  const input = (
    <input
      ref={inputRef}
      type="file"
      multiple
      accept=".stl,.obj,.mtl,model/stl,model/obj"
      className="hidden"
      onChange={(e) => handle(e.target.files)}
    />
  );

  if (compact) {
    return (
      <div {...dnd} className="space-y-2">
        <button
          disabled={disabled}
          onClick={() => inputRef.current?.click()}
          className={`w-full rounded-lg border border-dashed px-3 py-3 text-xs font-medium transition ${
            over ? 'border-sky-400 bg-sky-400/10 text-sky-200'
                 : 'border-white/15 text-slate-300 hover:border-sky-400/60 hover:text-white'
          } disabled:opacity-40`}
        >
          ⤒ Drop .stl / .obj (+ .mtl) or click to browse
        </button>
        {input}
        {err && <p className="text-[11px] text-red-400">{err}</p>}
      </div>
    );
  }

  return (
    <div
      {...dnd}
      className={`relative flex h-full w-full flex-col items-center justify-center rounded-2xl border-2 border-dashed transition ${
        over ? 'border-sky-400 bg-sky-500/10' : 'border-white/15 bg-white/[0.02]'
      }`}
    >
      <div className={`pointer-events-none flex flex-col items-center gap-4 px-8 text-center transition ${over ? 'scale-105' : ''}`}>
        <div className="grid h-20 w-20 place-items-center rounded-2xl bg-gradient-to-br from-sky-500/25 to-indigo-500/20 text-4xl shadow-lg shadow-sky-900/40">
          🧊
        </div>
        <div>
          <h2 className="text-xl font-semibold text-white">Drop your model here</h2>
          <p className="mt-1 max-w-md text-sm text-slate-400">
            <span className="font-mono text-slate-300">.stl</span> (ASCII or Binary) or{' '}
            <span className="font-mono text-slate-300">.obj</span> — drop the{' '}
            <span className="font-mono text-slate-300">.mtl</span> alongside it to unlock
            colour-region analysis.
          </p>
        </div>
      </div>
      <button
        onClick={() => inputRef.current?.click()}
        disabled={disabled}
        className="mt-6 rounded-lg bg-sky-500 px-6 py-2.5 text-sm font-semibold text-white shadow-lg shadow-sky-900/40 transition hover:bg-sky-400 disabled:opacity-40"
      >
        Browse Files
      </button>
      {input}
      {err && <p className="mt-3 text-xs text-red-400">{err}</p>}
      <p className="absolute bottom-4 text-[11px] text-slate-500">Nothing is uploaded — all geometry stays on your machine.</p>
    </div>
  );
}
