import { useEffect, useState } from "react";
import type { Engine } from "./engine";
import type { Actions } from "./Editor";
import { Asset, at, Clip, Project, shortTime, timecode } from "./model";
import { isTauri, pickMedia } from "./host";
import { Icon } from "./icons";

type Tab = "media" | "effects" | "transitions" | "markers" | "analyze" | "history";

const TABS: { id: Tab; label: string; icon: () => JSX.Element }[] = [
  { id: "media", label: "Media", icon: Icon.media },
  { id: "effects", label: "Effects", icon: Icon.effects },
  { id: "transitions", label: "Transitions", icon: Icon.transitions },
  { id: "markers", label: "Markers", icon: Icon.markers },
  { id: "analyze", label: "Analyze", icon: Icon.analyze },
  { id: "history", label: "History", icon: Icon.history },
];

export function LeftPanel(props: { project: Project; engine: Engine; actions: Actions; playhead: number; selected: Clip | null }) {
  const [tab, setTab] = useState<Tab>("media");
  return (
    <section className="panel">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t.id} className={`tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            <t.icon />
            {t.label}
          </button>
        ))}
      </div>
      {tab === "media" && <MediaTab {...props} />}
      {tab === "effects" && <FxTab {...props} kind="effect" />}
      {tab === "transitions" && <FxTab {...props} kind="transition" />}
      {tab === "markers" && <MarkersTab {...props} />}
      {tab === "analyze" && <AnalyzeTab {...props} />}
      {tab === "history" && <HistoryTab {...props} />}
    </section>
  );
}

function MediaTab({ project, actions, engine }: { project: Project; actions: Actions; engine: Engine }) {
  const [filter, setFilter] = useState<"all" | "video" | "audio">("all");
  const [q, setQ] = useState("");
  const [sel, setSel] = useState<string | null>(null);
  const used = new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.url)));
  const assets = project.assets.filter(
    (a) =>
      a.kind === "source" &&
      (filter === "all" || (filter === "video" ? !!a.video : !a.video)) &&
      a.name.toLowerCase().includes(q.toLowerCase()),
  );

  const importFiles = async () => actions.importPaths(await pickMedia());

  return (
    <div className="side-body">
      <nav className="side-nav">
        {(["all", "video", "audio"] as const).map((f) => (
          <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>
            {f === "all" ? "All" : f === "video" ? "Video" : "Audio"}
          </button>
        ))}
      </nav>
      <div className="side-content">
        <div className="search">
          <input className="input" placeholder="Search media" value={q} onChange={(e) => setQ(e.target.value)} />
          {isTauri && <button className="btn" onClick={importFiles}><Icon.plus /> Import</button>}
        </div>
        {project.assets.length === 0 ? (
          <div className="dropzone" style={{ marginTop: 12 }}>
            {isTauri ? "Drop video or audio files anywhere, or click Import." : <>Import with <code>ve import &lt;files&gt;</code>; it shows up here.</>}
          </div>
        ) : (
          <div className="media-grid">
            {assets.map((a) => (
              <MediaCard key={a.id} engine={engine} a={a} fps={project.fps} used={used.has(a.url)} sel={sel === a.id} onSelect={() => setSel(a.id)} onAdd={() => actions.insert(a.id)} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function MediaCard({ a, fps, used, sel, onSelect, onAdd, engine }: { engine: Engine; a: Asset; fps: number; used: boolean; sel: boolean; onSelect: () => void; onAdd: () => void }) {
  const v = a.video;
  const thumb = useThumbnail(engine, a);
  const detail = [v ? `${v.width}x${v.height}` : null, v?.vfr ? "VFR" : null, a.audio ? `${Math.round(a.audio.sample_rate / 1000)}k` : null].filter(Boolean).join(" · ");
  return (
    <div
      className={`media-card ${sel ? "sel" : ""}`}
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData("application/x-ve-asset", a.id);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={onSelect}
      onDoubleClick={onAdd}
      title={`${a.name}\n${detail}\nDrag to the timeline, or double-click to insert at the playhead`}
    >
      <div className={`thumb ${v ? "" : "audio"}`}>
        {thumb ? <img src={thumb} alt="" draggable={false} style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }} /> : v ? <Icon.video /> : <Icon.audio />}
        {used && <span className="badge">Added</span>}
        <span className="dur mono">{shortTime(a.frames, fps)}</span>
        <button className="add" onClick={(e) => { e.stopPropagation(); onAdd(); }} title="Insert at playhead">+</button>
      </div>
      <div className="name">{a.name}</div>
    </div>
  );
}

const COLORS: Record<string, string> = {
  red: "#ff6b6b", pink: "#f472b6", orange: "#fb923c", yellow: "#facc15", green: "#4ade80",
  cyan: "#22d3ee", blue: "#60a5fa", purple: "#a78bfa", magenta: "#e879f9", black: "#71717a", white: "#e5e5e5",
};
export const markerColor = (c: string) => COLORS[c] ?? COLORS.red;

function MarkersTab({ project, actions }: { project: Project; actions: Actions }) {
  const ms = [...project.markers].sort((a, b) => a.start - b.start);
  return (
    <div className="single">
      <div className="hstack" style={{ marginBottom: 10 }}>
        <button className="btn" onClick={actions.addMarker}><Icon.plus /> Marker at playhead</button>
        <span className="faint">M</span>
      </div>
      {ms.length === 0 && <p className="note">No markers. Analyzers (silence, scenes) write markers here too.</p>}
      <div className="list">
        {ms.map((m) => (
          <div key={m.id} className="row" onClick={() => actions.seek(m.start)}>
            <span className="dot" style={{ background: markerColor(m.color) }} />
            <span className="mono muted">{timecode(m.start, project.fps)}</span>
            <span className="grow">{m.name || "(unnamed)"}{m.duration > 0 && <span className="faint"> · {(m.duration / project.fps).toFixed(2)}s</span>}</span>
            {m.source !== "user" && <span className="chip plugin">{m.source}</span>}
            <button className="icon-btn" style={{ width: 24, height: 24 }} title="Remove" onClick={(e) => { e.stopPropagation(); actions.removeMarker(m.id); }}><Icon.close /></button>
          </div>
        ))}
      </div>
    </div>
  );
}

function AnalyzeTab({ project, engine }: { project: Project; engine: Engine }) {
  const [threshold, setThreshold] = useState("-35dB");
  const [minDur, setMinDur] = useState("0.5s");
  const [pad, setPad] = useState("0.1s");
  const [sceneT, setSceneT] = useState("10");
  const silences = project.markers.filter((m) => m.name === "silence" && m.duration > 0);
  const total = silences.reduce((s, m) => s + m.duration, 0);

  return (
    <div className="single stack">
      <div className="card stack">
        <b>Silence</b>
        <p className="note" style={{ margin: 0 }}>Marks quiet stretches on the timeline mix as <code>silence</code> markers. Review them on the timeline, then cut them in one step.</p>
        <div className="hstack">
          <div className="field" style={{ flex: 1 }}><label>Threshold</label><input className="input mono" value={threshold} onChange={(e) => setThreshold(e.target.value)} /></div>
          <div className="field" style={{ flex: 1 }}><label>Min length</label><input className="input mono" value={minDur} onChange={(e) => setMinDur(e.target.value)} /></div>
          <div className="field" style={{ flex: 1 }}><label>Keep breath</label><input className="input mono" value={pad} onChange={(e) => setPad(e.target.value)} /></div>
        </div>
        <div className="hstack">
          <button className="btn" disabled={!!engine.busy || project.duration === 0} onClick={() => engine.mutate("analyze.silence", { threshold, min_duration: minDur, pad }, "Finding silences…")}>Find silences</button>
          <button className="btn primary" disabled={!!engine.busy || silences.length === 0} onClick={() => engine.mutate("edit.ripple_delete", { markers: "silence" }, "Cutting silences…")}>
            Cut {silences.length || ""} silence{silences.length === 1 ? "" : "s"}
          </button>
        </div>
        {silences.length > 0 && <span className="note">{silences.length} found, {(total / project.fps).toFixed(1)}s in total.</span>}
      </div>
      <div className="card stack">
        <b>Scene changes</b>
        <p className="note" style={{ margin: 0 }}>Adds a marker at each shot change.</p>
        <div className="hstack">
          <div className="field" style={{ width: 110 }}><label>Threshold</label><input className="input mono" value={sceneT} onChange={(e) => setSceneT(e.target.value)} /></div>
          <button className="btn" style={{ alignSelf: "flex-end" }} disabled={!!engine.busy || project.duration === 0} onClick={() => engine.mutate("analyze.scenes", { threshold: Number(sceneT) || undefined }, "Finding scene changes…")}>Find scenes</button>
        </div>
      </div>
    </div>
  );
}

function HistoryTab({ engine, actions }: { engine: Engine; actions: Actions }) {
  const { undo, redo } = engine.history;
  const chip = (actor: string) => (
    <span className={`chip ${actor.startsWith("agent") ? "agent" : actor.startsWith("plugin") ? "plugin" : ""}`}>{actor.startsWith("user") ? "you" : actor}</span>
  );
  return (
    <div className="single">
      <div className="hstack" style={{ marginBottom: 10 }}>
        <button className="btn" disabled={!undo.length} onClick={actions.undo}><Icon.undo /> Undo</button>
        <button className="btn" disabled={!redo.length} onClick={actions.redo}><Icon.redo /> Redo</button>
      </div>
      {redo.length > 0 && (
        <>
          <div className="section-title">Undone</div>
          <div className="list">
            {[...redo].reverse().map((s, i) => (
              <div key={`r${i}`} className="row faint"><span className="grow">{s.what}</span>{chip(s.actor)}</div>
            ))}
          </div>
        </>
      )}
      <div className="section-title">Steps</div>
      {undo.length === 0 && <p className="note">Nothing yet. Edits from you and from agents show up here with who made them.</p>}
      <div className="list">
        {undo.map((s, i) => (
          <div key={`u${i}`} className="row">
            <span className="grow">{s.what}</span>
            <span className="mono faint">r{s.revs[s.revs.length - 1]}</span>
            {chip(s.actor)}
          </div>
        ))}
      </div>
    </div>
  );
}

interface FxEntry {
  id: string;
  reference: string;
  kind: "effect" | "transition";
  name: string;
  description?: string;
  origin?: string;
}

/** Effects and transitions come from `fx.list`, so plugins and project effects show up on their own. */
function FxTab({ engine, playhead, selected, kind }: { engine: Engine; playhead: number; selected: Clip | null; kind: "effect" | "transition" }) {
  const [list, setList] = useState<FxEntry[] | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [q, setQ] = useState("");
  const [duration, setDuration] = useState("0.5s");
  const noun = kind === "effect" ? "effect" : "transition";

  useEffect(() => {
    engine.query<{ effects: FxEntry[]; problems?: string[] }>("fx.list").then(
      (r) => { setList(r.effects ?? []); setProblems(r.problems ?? []); },
      () => setList([]),
    );
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const shown = (list ?? []).filter((e) => e.kind === kind && e.name.toLowerCase().includes(q.toLowerCase()));
  const video = selected?.kind === "video" ? selected : null;

  const apply = (e: FxEntry) => {
    if (kind === "effect") {
      if (video) engine.mutate("effect.add", { clip: video.id, effect: e.id });
    } else {
      engine.mutate("transition.add", {
        transition: e.id,
        duration,
        ...(video ? { clip: video.id } : { at: at(playhead) }),
      });
    }
  };

  const hint =
    kind === "effect"
      ? video ? `Adds to ${video.name || video.id}.` : "Select a video clip on the timeline, then click an effect."
      : video ? `Goes on the cut at the end of ${video.name || video.id}.` : "Goes on the cut at the playhead, or select the clip before the cut.";
  const canApply = kind === "effect" ? !!video : true;

  return (
    <div className="single stack">
      <div className="search">
        <input className="input" placeholder={`Search ${noun}s`} value={q} onChange={(e) => setQ(e.target.value)} />
        {kind === "transition" && (
          <input className="input mono" style={{ width: 70 }} title="Duration" value={duration} onChange={(e) => setDuration(e.target.value)} />
        )}
      </div>
      <p className="note" style={{ margin: 0 }}>{hint}</p>
      {list === null && <div className="spinner" />}
      <div className="list">
        {shown.map((e) => (
          <div key={e.reference} className="row" title={e.description} onClick={() => canApply && !engine.busy && apply(e)} style={canApply ? undefined : { opacity: 0.5 }}>
            <span className="grow">{e.name}{e.description && <span className="faint"> · {e.description}</span>}</span>
            {e.origin && e.origin !== "builtin" && <span className="chip plugin">{e.origin}</span>}
            <span className="icon-btn" style={{ width: 24, height: 24 }}><Icon.plus /></span>
          </div>
        ))}
      </div>
      {list && shown.length === 0 && <p className="note">No {noun}s found.</p>}
      {problems.length > 0 && <p className="note" style={{ color: "var(--warn)" }}>{problems.join(" | ")}</p>}
      <p className="note">Only the GPU preview shows these for now. Exports and contact sheets still render plain clips.</p>
    </div>
  );
}

// Poster frames come from the engine (the UI can't read the media files). Kept for the session.
const thumbs = new Map<string, string>();

function useThumbnail(engine: Engine, a: Asset): string | null {
  const [src, setSrc] = useState<string | null>(thumbs.get(a.id) ?? null);
  useEffect(() => {
    if (!a.video || thumbs.has(a.id)) return;
    let live = true;
    engine.query<{ mime: string; data: string }>("ui.thumbnail", { asset: a.id, width: 240 }).then(
      (r) => {
        const url = `data:${r.mime};base64,${r.data}`;
        thumbs.set(a.id, url);
        if (live) setSrc(url);
      },
      () => {}, // no picture is fine; the icon stays
    );
    return () => { live = false; };
  }, [a.id]); // eslint-disable-line react-hooks/exhaustive-deps
  return src;
}
