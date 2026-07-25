import { useEffect, useRef } from 'react';
import { ViewportEngine } from '../three/engine';

interface Props {
  onReady: (engine: ViewportEngine) => void;
  onPick?: (id: number | null) => void;
  onPlaneSelect?: (id: string | null) => void;
  onPlaneDrag?: (id: string, offset: number, committed: boolean) => void;
  className?: string;
}

/** Thin React lifecycle wrapper around the imperative three.js engine. */
export default function Viewport({ onReady, onPick, onPlaneSelect, onPlaneDrag, className }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);

  // Refs keep the engine callbacks current without re-creating the renderer.
  const readyRef = useRef(onReady);
  const pickRef = useRef(onPick);
  const planeSelRef = useRef(onPlaneSelect);
  const planeDragRef = useRef(onPlaneDrag);
  readyRef.current = onReady;
  pickRef.current = onPick;
  planeSelRef.current = onPlaneSelect;
  planeDragRef.current = onPlaneDrag;

  useEffect(() => {
    if (!hostRef.current) return;
    let engine: ViewportEngine | null = null;
    try {
      engine = new ViewportEngine(hostRef.current, {
        onPick: (id) => pickRef.current?.(id),
        onPlaneSelect: (id) => planeSelRef.current?.(id),
        onPlaneDrag: (id, offset, committed) => planeDragRef.current?.(id, offset, committed),
      });
      readyRef.current(engine);
    } catch (err) {
      console.error('WebGL init failed', err);
      if (hostRef.current) {
        hostRef.current.innerHTML =
          '<div class="flex h-full items-center justify-center text-sm text-red-300">WebGL is unavailable in this browser.</div>';
      }
    }
    return () => engine?.dispose();
  }, []);

  return <div ref={hostRef} className={className} />;
}
