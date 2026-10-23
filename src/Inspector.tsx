import { useEffect, useState } from "react";
import type { Actions } from "./Editor";
import type { Engine } from "./engine";
import { Clip, ClipTransform, DEFAULT_TRANSFORM, fileName, Project, timecode, TransformField, Transition } from "./model";
import { Icon } from "./icons";
import { TransitionPanel } from "./TransitionPanel";

type Tab = "basic" | "audio" | "speed";

export function Inspector({ project, engine, clip, transition, actions, projectPath }: { project: Project; engine: Engine; clip: Clip | null; transition: Transition | null; actions: Actions; projectPath: string | null }) {
  const [tab, setTab] = useState<Tab>("basic");
  if (transition) return <TransitionPanel key={transition.id} project={project} engine={engine} tr={transition} actions={actions} />;
  if (!clip) return <ProjectInfo project={project} projectPath={projectPath} />;
  const tabs: { id: Tab; label: string }[] = [
    { id: "basic", label: clip.kind === "video" ? "Video" : "Clip" },
    { id: "audio", label: "Audio" },
    { id: "speed", label: "Speed" },
  ];
  return (
    <section className="panel">
      <div className="subtabs" style={{ borderBottom: "1px solid var(--line)" }}>
        {tabs.map((t) => (
          <button key={t.id} className={`subtab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>
      <div className="single stack">
        {tab === "basic" && clip.kind === "video" && <TransformPanel project={project} clip={clip} actions={actions} />}
        {tab === "basic" && <Basic project={project} clip={clip} />}
        {tab === "audio" && <Audio project={project} clip={clip} actions={actions} />}
        {tab === "speed" && <Speed project={project} clip={clip} actions={actions} />}
      </div>
    </section>
  );
}

function Basic({ project, clip }: { project: Project; clip: Clip }) {
  const fps = project.fps;
  const linked = clip.link ? project.tracks.flatMap((t) => t.clips).filter((c) => c.link === clip.link && c.id !== clip.id) : [];
  return (
    <>
      <div className="section-title">Clip</div>
      <div className="props">
        <span className="k">Name</span><span className="v" title={clip.name}>{clip.name}</span>
        <span className="k">ID</span><span className="v mono" style={{ userSelect: "text" }}>{clip.id}</span>
        <span className="k">Track</span><span className="v">{clip.trackName}</span>
        <span className="k">Start</span><span className="v mono">{timecode(clip.start, fps)}</span>
        <span className="k">End</span><span className="v mono">{timecode(clip.end, fps)}</span>
        <span className="k">Duration</span><span className="v mono">{timecode(clip.end - clip.start, fps)} <span className="faint">({clip.end - clip.start}f)</span></span>
        <span className="k">Source in</span><span className="v mono">{timecode(clip.sourceIn, fps)}</span>
        <span className="k">Speed</span><span className="v mono">{fmtSpeed(clip.speed)}</span>
        <span className="k">Linked</span><span className="v">{linked.length ? linked.map((c) => `${c.trackName} ${c.id}`).join(", ") : "none"}</span>
        {clip.url && (<><span className="k">File</span><span className="v" title={clip.url}>{fileName(clip.url)}</span></>)}
      </div>
    </>
  );
}

/**
 * One slider per transform field. Values show in the units people think in
 * (percent, degrees) and go to the engine raw. A change is sent when the
 * slider is let go (or Enter / leaving the box), so a drag is one undo step.
 */
interface FieldSpec {
  field: TransformField;
  label: string;
  min: number;
  max: number;
  step: number;
  /** Engine value -> shown value, and back. */
  show: (v: number) => number;
  read: (v: number) => number;
  unit: string;
}

const pct = (v: number) => Math.round(v * 1000) / 10;
const fromPct = (v: number) => v / 100;
const same = (v: number) => Math.round(v * 10) / 10;

const POSITION: FieldSpec[] = [
  { field: "x", label: "X", min: -100, max: 100, step: 0.5, show: pct, read: fromPct, unit: "%" },
  { field: "y", label: "Y", min: -100, max: 100, step: 0.5, show: pct, read: fromPct, unit: "%" },
  { field: "scale", label: "Scale", min: 5, max: 400, step: 1, show: pct, read: fromPct, unit: "%" },
  { field: "rotation", label: "Rotation", min: -180, max: 180, step: 1, show: same, read: (v) => v, unit: "°" },
  { field: "opacity", label: "Opacity", min: 0, max: 100, step: 1, show: pct, read: fromPct, unit: "%" },
];
const CROP: FieldSpec[] = [
  { field: "crop_left", label: "Left", min: 0, max: 90, step: 0.5, show: pct, read: fromPct, unit: "%" },
  { field: "crop_right", label: "Right", min: 0, max: 90, step: 0.5, show: pct, read: fromPct, unit: "%" },
  { field: "crop_top", label: "Top", min: 0, max: 90, step: 0.5, show: pct, read: fromPct, unit: "%" },
  { field: "crop_bottom", label: "Bottom", min: 0, max: 90, step: 0.5, show: pct, read: fromPct, unit: "%" },
];

/** Quick placements: name, values. */
const PRESETS: [string, Partial<Record<TransformField, number>>][] = [
  ["Full", { x: 0, y: 0, scale: 1, rotation: 0 }],
  ["PiP ↘", { x: 0.3, y: 0.3, scale: 0.35, rotation: 0 }],
  ["PiP ↗", { x: 0.3, y: -0.3, scale: 0.35, rotation: 0 }],
  ["PiP ↙", { x: -0.3, y: 0.3, scale: 0.35, rotation: 0 }],
  ["PiP ↖", { x: -0.3, y: -0.3, scale: 0.35, rotation: 0 }],
  ["Left half", { x: -0.25, y: 0, scale: 0.5, rotation: 0 }],
  ["Right half", { x: 0.25, y: 0, scale: 0.5, rotation: 0 }],
];

function TransformPanel({ project, clip, actions }: { project: Project; clip: Clip; actions: Actions }) {
  const t: ClipTransform = clip.transform ?? DEFAULT_TRANSFORM;
  const set = (field: TransformField, v: number | null) => actions.setTransform(clip.id, { [field]: v });
  const changed = clip.transform != null;
  const below = project.tracks.filter((x) => x.kind === "video").findIndex((x) => x.id === clip.trackId) > 0;
  return (
    <>
      <div className="section-title" style={{ display: "flex", alignItems: "center" }}>
        <span style={{ flex: 1 }}>Transform</span>
        <button className="btn ghost" style={{ height: 24, padding: "0 8px" }} disabled={!changed} onClick={() => actions.setTransform(clip.id, {}, true)}>Reset all</button>
      </div>
      <div className="seg">
        {PRESETS.map(([name, v]) => (
          <button key={name} className={Object.entries(v).every(([k, x]) => t[k as TransformField] === x) ? "on" : ""} onClick={() => actions.setTransform(clip.id, v)}>{name}</button>
        ))}
      </div>
      <div className="stack" style={{ gap: 6 }}>
        {POSITION.map((f) => <FieldRow key={`${clip.id}:${f.field}`} spec={f} value={t[f.field]} keyed={t.keyframed.includes(f.field)} set={set} />)}
      </div>
      <div className="section-title">Crop</div>
      <div className="stack" style={{ gap: 6 }}>
        {CROP.map((f) => <FieldRow key={`${clip.id}:${f.field}`} spec={f} value={t[f.field]} keyed={t.keyframed.includes(f.field)} set={set} />)}
      </div>
      {t.keyframed.length > 0 && (
        <p className="note">Animated by keyframes: {t.keyframed.join(", ")}. The sliders set the value used outside the keyframes; keyframes are set from the CLI (<code>ve transform --key</code>) for now.</p>
      )}
      <p className="note">
        Position moves the picture's center, in percent of the canvas ({project.width}x{project.height}). Scale is relative to the picture fitted to the canvas.
        {!below && " This is the bottom video track, so nothing shows behind it; put clips on a higher track to layer them."}
      </p>
    </>
  );
}

function FieldRow({ spec, value, keyed, set }: { spec: FieldSpec; value: number; keyed: boolean; set: (f: TransformField, v: number | null) => void }) {
  const shown = spec.show(value);
  const [v, setV] = useState(shown);
  const [text, setText] = useState(String(shown));
  useEffect(() => { setV(shown); setText(String(shown)); }, [shown]);
  const isDefault = value === (DEFAULT_TRANSFORM[spec.field] as number);
  const commit = (n: number) => {
    if (!Number.isFinite(n)) { setText(String(shown)); return; }
    const raw = spec.read(n);
    if (Math.abs(raw - value) > 1e-9) set(spec.field, raw);
  };
  return (
    <div className="xf-row">
      <span className={`k ${keyed ? "keyed" : ""}`} title={keyed ? "Animated by keyframes" : undefined}>{spec.label}{keyed ? " ◆" : ""}</span>
      <input
        type="range"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={Math.max(spec.min, Math.min(spec.max, v))}
        onChange={(e) => { const n = Number(e.target.value); setV(n); setText(String(n)); }}
        onPointerUp={() => commit(v)}
        onKeyUp={(e) => (e.key.startsWith("Arrow") || e.key === "Home" || e.key === "End") && commit(v)}
      />
      <input
        className="input mono"
        value={text}
        title={spec.unit}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => commit(parseFloat(text))}
        onKeyDown={(e) => { if (e.key === "Enter") commit(parseFloat(text)); e.stopPropagation(); }}
      />
      <button className="icon-btn" title="Reset" disabled={isDefault} onClick={() => set(spec.field, null)}><Icon.undo /></button>
    </div>
  );
}

function Audio({ project, clip, actions }: { project: Project; clip: Clip; actions: Actions }) {
  // A video clip's sound lives on its linked audio clip.
  const target = clip.kind === "audio" ? clip : project.tracks.flatMap((t) => t.clips).find((c) => c.kind === "audio" && c.link && c.link === clip.link) ?? null;
  const [db, setDb] = useState(target?.volumeDb ?? 0);
  useEffect(() => setDb(target?.volumeDb ?? 0), [target?.id, target?.volumeDb]);
  if (!target) return <p className="note">This clip has no sound.</p>;
  const commit = (v: number) => v !== target.volumeDb && actions.setVolume(target.id, Math.round(v * 10) / 10);
  return (
    <>
      <div className="section-title">Volume</div>
      <div className="slider-row">
        <input type="range" min={-60} max={20} step={0.5} value={db} onChange={(e) => setDb(Number(e.target.value))} onPointerUp={() => commit(db)} onKeyUp={() => commit(db)} />
        <input className="input mono" value={db} onChange={(e) => setDb(Number(e.target.value) || 0)} onBlur={() => commit(db)} onKeyDown={(e) => e.key === "Enter" && commit(db)} />
      </div>
      <div className="seg">
        {[-12, -6, -3, 0, 3, 6].map((v) => (
          <button key={v} className={target.volumeDb === v ? "on" : ""} onClick={() => { setDb(v); commit(v); }}>{v > 0 ? `+${v}` : v} dB</button>
        ))}
      </div>
      <p className="note">Gain in dB on {target.trackName}. Cuts get a short crossfade automatically.</p>
    </>
  );
}

function Speed({ clip, actions }: { project: Project; clip: Clip; actions: Actions }) {
  const current = fmtSpeed(clip.speed);
  const [custom, setCustom] = useState(`${clip.speed[0]}/${clip.speed[1]}`);
  useEffect(() => setCustom(`${clip.speed[0]}/${clip.speed[1]}`), [clip.id, clip.speed[0], clip.speed[1]]); // eslint-disable-line react-hooks/exhaustive-deps
  const presets: [string, string][] = [["1/2", "0.5x"], ["3/4", "0.75x"], ["1/1", "1x"], ["5/4", "1.25x"], ["3/2", "1.5x"], ["2/1", "2x"], ["3/1", "3x"]];
  return (
    <>
      <div className="section-title">Speed <span className="mono" style={{ textTransform: "none", color: "var(--accent)" }}>{current}</span></div>
      <div className="seg">
        {presets.map(([v, l]) => (
          <button key={v} className={`${clip.speed[0]}/${clip.speed[1]}` === v ? "on" : ""} onClick={() => actions.setSpeed(clip.id, v)}>{l}</button>
        ))}
      </div>
      <div className="field">
        <label>Exact ratio (e.g. 3/2) or decimal</label>
        <div className="hstack">
          <input className="input mono" style={{ flex: 1 }} value={custom} onChange={(e) => setCustom(e.target.value)} onKeyDown={(e) => e.key === "Enter" && actions.setSpeed(clip.id, custom)} />
          <button className="btn" onClick={() => actions.setSpeed(clip.id, custom)}>Apply</button>
        </div>
      </div>
      <p className="note">Linked clips change together and later clips ripple. Speed is also written as an OTIO <code>LinearTimeWarp</code>, so it survives the hand-off to Resolve or Premiere.</p>
    </>
  );
}

function ProjectInfo({ project, projectPath }: { project: Project; projectPath: string | null }) {
  const clips = project.tracks.reduce((n, t) => n + t.clips.length, 0);
  return (
    <section className="panel">
      <div className="panel-head">Project</div>
      <div className="single stack">
        <div className="props">
          <span className="k">Name</span><span className="v">{project.name}</span>
          <span className="k">Canvas</span><span className="v">{project.width}x{project.height}</span>
          <span className="k">Frame rate</span><span className="v mono">{project.rate[1] === 1 ? project.rate[0] : `${project.rate[0]}/${project.rate[1]}`} ({+project.fps.toFixed(3)})</span>
          <span className="k">Audio</span><span className="v">{project.sampleRate} Hz</span>
          <span className="k">Duration</span><span className="v mono">{timecode(project.duration, project.fps)}</span>
          <span className="k">Tracks</span><span className="v">{project.tracks.map((t) => t.name).join(", ")}</span>
          <span className="k">Clips</span><span className="v">{clips}</span>
          <span className="k">Revision</span><span className="v mono">{project.revision}</span>
          {projectPath && (<><span className="k">Folder</span><span className="v" title={projectPath} style={{ userSelect: "text" }}>{projectPath}</span></>)}
        </div>
        <p className="note">Select a clip on the timeline to edit it. Agents editing this project through the CLI show up live.</p>
      </div>
    </section>
  );
}

function fmtSpeed([n, d]: [number, number]) {
  const v = n / d;
  return `${+v.toFixed(3)}x`;
}
