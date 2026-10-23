import { useEffect, useState } from "react";
import type { Actions } from "./Editor";
import type { Engine } from "./engine";
import { Clip, fileName, Project, timecode, Transition } from "./model";
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
      <p className="note">Transform, crop and effects arrive with the Phase 2 compositor; the engine can't express them yet.</p>
    </>
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
