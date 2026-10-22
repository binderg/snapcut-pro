import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Rpc } from "./rpc";
import { useEngine } from "./engine";
import { at, Clip, delta, findClip, linkedIds, Project } from "./model";
import { onFileDrop } from "./host";
import { Icon } from "./icons";
import { LeftPanel } from "./LeftPanel";
import { Player } from "./Player";
import { Inspector } from "./Inspector";
import { Timeline } from "./Timeline";
import { load, save } from "./prefs";

export interface Actions {
  seek: (frame: number) => void;
  select: (clipId: string | null) => void;
  split: () => void;
  deleteLeft: () => void;
  deleteRight: () => void;
  rippleDelete: () => void;
  lift: () => void;
  deleteClip: (clip: string, ripple: boolean) => void;
  unlink: (clip: string) => void;
  undo: () => void;
  redo: () => void;
  addMarker: () => void;
  removeMarker: (id: string) => void;
  insert: (asset: string, frame?: number, track?: string) => void;
  /** `push`: move what is in the way right instead of overwriting it. `reorder`: swap places. */
  move: (clip: string, frame: number, track?: string, mode?: "push" | "reorder") => void;
  trim: (clip: string, side: "in" | "out", frames: number) => void;
  setSpeed: (clip: string, speed: string) => void;
  setVolume: (clip: string, db: number) => void;
  importPaths: (paths: string[]) => void;
}

export function Editor({ rpc, projectPath, onClose }: { rpc: Rpc; projectPath: string | null; onClose: () => void }) {
  const engine = useEngine(rpc);
  const { project, mutate } = engine;
  const [playhead, setPlayhead] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const [timelineH, setTimelineH] = useState<number>(() => load("timelineH", 340));
  const [leftW, setLeftW] = useState<number>(() => load("leftW", 360));
  const [rightW, setRightW] = useState<number>(() => load("rightW", 340));
  const projRef = useRef<Project | null>(null);
  projRef.current = project;
  const playheadRef = useRef(0);
  playheadRef.current = playhead;

  // Keep the playhead and selection valid after edits (ours or an agent's).
  useEffect(() => {
    if (!project) return;
    if (playhead > project.duration) setPlayhead(project.duration);
    if (selected && !findClip(project, selected)) setSelected(null);
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  // Tell the user when someone else edits.
  useEffect(() => {
    const c = engine.lastChange;
    if (c && c.actor && !c.actor.startsWith("user")) {
      setInfo(`${c.actor} ran ${c.command} (rev ${c.revision})`);
      const t = setTimeout(() => setInfo(null), 4000);
      return () => clearTimeout(t);
    }
  }, [engine.lastChange]);

  const selectedClip = findClip(project, selected);

  /** The clip that playhead tools act on: the selection if it spans the playhead, else the top clip there. */
  const targetClip = useCallback((): Clip | null => {
    const p = projRef.current;
    if (!p) return null;
    const ph = playheadRef.current;
    const sel = findClip(p, selected);
    if (sel && sel.start < ph && ph < sel.end) return sel;
    for (const kind of ["video", "audio"] as const) {
      for (const t of p.tracks.filter((t) => t.kind === kind)) {
        const c = t.clips.find((c) => c.start < ph && ph < c.end);
        if (c) return c;
      }
    }
    return null;
  }, [selected]);

  const tracksOf = (p: Project, c: Clip) => {
    const ids = linkedIds(p, c);
    return [...new Set(p.tracks.filter((t) => t.clips.some((x) => ids.has(x.id))).map((t) => t.name))];
  };

  const actions: Actions = useMemo(
    () => ({
      seek: (f) => {
        const p = projRef.current;
        setPlayhead(Math.max(0, Math.min(Math.round(f), p?.duration ?? 0)));
      },
      select: setSelected,
      split: () => {
        const c = targetClip();
        if (!c) return;
        // Cut the selection (and its linked clips) if it is under the playhead, else everything there.
        const sel = findClip(projRef.current, selected);
        mutate("edit.split", { at: at(playheadRef.current), clips: sel && sel.id === c.id ? [c.id] : [] });
      },
      deleteLeft: () => {
        const p = projRef.current, c = targetClip();
        if (!p || !c) return;
        mutate("edit.ripple_delete", { ranges: [{ from: at(c.start), to: at(playheadRef.current) }], tracks: tracksOf(p, c) });
        setPlayhead(c.start);
      },
      deleteRight: () => {
        const p = projRef.current, c = targetClip();
        if (!p || !c) return;
        mutate("edit.ripple_delete", { ranges: [{ from: at(playheadRef.current), to: at(c.end) }], tracks: tracksOf(p, c) });
      },
      rippleDelete: () => selected && mutate("edit.ripple_delete", { clips: [selected] }),
      lift: () => selected && mutate("edit.delete", { clips: [selected] }),
      deleteClip: (clip, ripple) => mutate(ripple ? "edit.ripple_delete" : "edit.delete", { clips: [clip] }),
      unlink: (clip) => mutate("edit.unlink", { clip }),
      undo: () => mutate("history.undo"),
      redo: () => mutate("history.redo"),
      addMarker: () => mutate("marker.add", { at: at(playheadRef.current), name: "marker", color: "CYAN" }),
      removeMarker: (id) => mutate("marker.remove", { ids: [id] }),
      insert: (asset, frame, track) =>
        mutate("edit.insert", { asset, at: at(frame ?? playheadRef.current), ...(track ? { track } : {}) }),
      move: (clip, frame, track, mode) => mutate("edit.move", { clip, to: at(frame), ...(track ? { track } : {}), ...(mode ? { [mode]: true } : {}) }),
      trim: (clip, side, frames) => frames !== 0 && mutate("edit.trim", { clip, [side]: delta(frames) }),
      setSpeed: (clip, speed) => mutate("edit.set_speed", { clip, speed, ripple: true }),
      setVolume: (clip, db) => mutate("edit.set_volume", { clip, db }),
      importPaths: (paths) => paths.length > 0 && mutate("media.import", { paths }, `Importing ${paths.length} file${paths.length > 1 ? "s" : ""}…`),
    }),
    [mutate, targetClip, selected],
  );

  // Files dropped from the OS (desktop app only).
  useEffect(() => {
    let off = () => {};
    onFileDrop((paths) => actions.importPaths(paths)).then((f) => (off = f));
    return () => off();
  }, [actions]);

  // Keyboard shortcuts, CapCut-style.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.tagName === "INPUT" || t.tagName === "SELECT" || t.tagName === "TEXTAREA") return;
      const p = projRef.current;
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();
      if (k === " ") { e.preventDefault(); setPlaying((x) => !x); }
      else if (mod && k === "z" && !e.shiftKey) { e.preventDefault(); actions.undo(); }
      else if ((mod && k === "y") || (mod && e.shiftKey && k === "z")) { e.preventDefault(); actions.redo(); }
      else if ((mod && k === "b") || (!mod && k === "s")) { e.preventDefault(); actions.split(); }
      else if (k === "q") actions.deleteLeft();
      else if (k === "w") actions.deleteRight();
      else if (k === "delete" || k === "backspace") { e.shiftKey ? actions.lift() : actions.rippleDelete(); }
      else if (k === "m") actions.addMarker();
      else if (k === "arrowleft") { e.preventDefault(); actions.seek(playheadRef.current - (e.shiftKey ? Math.round(p?.fps ?? 30) : 1)); }
      else if (k === "arrowright") { e.preventDefault(); actions.seek(playheadRef.current + (e.shiftKey ? Math.round(p?.fps ?? 30) : 1)); }
      else if (k === "home") actions.seek(0);
      else if (k === "end") actions.seek(p?.duration ?? 0);
      else if (k === "escape") setSelected(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [actions]);

  const startResize = (e: React.PointerEvent) => {
    const y0 = e.clientY, h0 = timelineH;
    const moveH = (ev: PointerEvent) => setTimelineH(Math.max(220, Math.min(window.innerHeight - 320, h0 - (ev.clientY - y0))));
    const up = () => {
      window.removeEventListener("pointermove", moveH);
      window.removeEventListener("pointerup", up);
      setTimelineH((h) => (save("timelineH", h), h));
    };
    window.addEventListener("pointermove", moveH);
    window.addEventListener("pointerup", up);
  };

  /** Drag a column edge. `dir` is +1 when moving right grows the panel (left panel), -1 for the right one. */
  const startResizeCol = (which: "leftW" | "rightW") => (e: React.PointerEvent) => {
    e.preventDefault();
    const x0 = e.clientX;
    const w0 = which === "leftW" ? leftW : rightW;
    const set = which === "leftW" ? setLeftW : setRightW;
    const dir = which === "leftW" ? 1 : -1;
    // Keep at least 320 px for the player.
    const other = which === "leftW" ? rightW : leftW;
    const max = Math.max(240, window.innerWidth - other - 320 - 24);
    const move = (ev: PointerEvent) => set(Math.max(240, Math.min(max, w0 + dir * (ev.clientX - x0))));
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      set((w) => (save(which, w), w));
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  if (!project) {
    return <div className="connect"><div className="spinner" /></div>;
  }

  return (
    <div className="app" style={{ ["--timeline-h" as any]: `${timelineH}px`, gridTemplateRows: `40px minmax(280px, 1fr) 6px ${timelineH}px` }}>
      <header className="topbar">
        <div className="brand"><span className="brand-mark" /> ve</div>
        <button className="btn ghost small" onClick={onClose} title="Close project">Projects</button>
        <div className="title">
          {project.name}
          <small className="mono">rev {project.revision} · {project.width}x{project.height} · {+project.fps.toFixed(3)} fps</small>
        </div>
        {engine.busy && <span className="hstack muted"><span className="spinner" />{engine.busy}</span>}
        <ExportButton engine={engine} />
      </header>

      <div className="upper" style={{ gridTemplateColumns: `${leftW}px 6px minmax(320px, 1fr) 6px ${rightW}px` }}>
        <LeftPanel project={project} engine={engine} actions={actions} playhead={playhead} selected={selectedClip} />
        <div className="vsplitter" onPointerDown={startResizeCol("leftW")} onDoubleClick={() => { setLeftW(360); save("leftW", 360); }} title="Drag to resize, double-click to reset" />
        <Player
          project={project}
          engine={engine}
          playhead={playhead}
          playing={playing}
          setPlaying={setPlaying}
          seek={actions.seek}
        />
        <div className="vsplitter" onPointerDown={startResizeCol("rightW")} onDoubleClick={() => { setRightW(340); save("rightW", 340); }} title="Drag to resize, double-click to reset" />
        <Inspector project={project} clip={selectedClip} actions={actions} projectPath={projectPath} />
      </div>

      <div className="splitter" onPointerDown={startResize} onDoubleClick={() => { setTimelineH(340); save("timelineH", 340); }} title="Drag to resize, double-click to reset" />

      <Timeline
        project={project}
        engine={engine}
        playhead={playhead}
        selected={selected}
        actions={actions}
        playing={playing}
      />

      {engine.error && (
        <div className="toast">
          <pre>{engine.error}</pre>
          <button className="icon-btn" style={{ width: 22, height: 22 }} onClick={engine.clearError}><Icon.close /></button>
        </div>
      )}
      {!engine.error && info && <div className="toast info"><pre>{info}</pre></div>}
    </div>
  );
}

function ExportButton({ engine }: { engine: ReturnType<typeof useEngine> }) {
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<{ name: string; description?: string }[]>([]);
  const [preset, setPreset] = useState("youtube-1080p");
  const [result, setResult] = useState<string | null>(null);

  useEffect(() => {
    if (!open || presets.length) return;
    engine.query("render.presets").then((r: any) => {
      const list = (r.presets ?? r ?? []).map((p: any) => (typeof p === "string" ? { name: p } : p));
      setPresets(list);
    });
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const run = async () => {
    setResult(null);
    try {
      const r: any = await engine.query("render.export", { preset }, "Exporting…");
      setResult(r.path ?? JSON.stringify(r));
    } catch (e: any) {
      setResult(`Export failed: ${e?.message ?? e}`);
    }
  };

  return (
    <div style={{ position: "relative" }}>
      <button className="btn primary" onClick={() => setOpen((x) => !x)}><Icon.export /> Export</button>
      {open && (
        <div className="card stack" style={{ position: "absolute", right: 0, top: 36, width: 360, zIndex: 40, border: "1px solid var(--line)", boxShadow: "0 12px 40px rgba(0,0,0,.5)" }}>
          <div className="field">
            <label>Preset</label>
            <select className="input" value={preset} onChange={(e) => setPreset(e.target.value)}>
              {(presets.length ? presets : [{ name: preset }]).map((p) => (
                <option key={p.name} value={p.name}>{p.name}{p.description ? `  ${p.description}` : ""}</option>
              ))}
            </select>
          </div>
          <div className="hstack">
            <button className="btn primary" onClick={run} disabled={!!engine.busy}>Export</button>
            <button className="btn ghost" onClick={() => setOpen(false)}>Close</button>
          </div>
          {result && (
            <div className="note" style={{ userSelect: "text", wordBreak: "break-all" }}>
              {result.startsWith("Export failed") ? result : <>Written to the engine cache (kept for a day):<br /><code>{result}</code></>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
