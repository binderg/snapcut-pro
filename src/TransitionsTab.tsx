import { useEffect, useMemo, useRef, useState } from "react";
import type { Engine } from "./engine";
import type { Actions } from "./Editor";
import { Clip, cutFor, Project } from "./model";
import { beginDrag, wasDrag } from "./dnd";
import { ENGINE_PREVIEWS, getRenderer, GlTransition, H, sceneImage, W } from "./gl/preview";

/**
 * GL Transitions come from the gl-transitions effect pack (ids `gl.transition/<id>`),
 * which the desktop shell installs on start. The engine copies one into the project
 * the first time it is used, so the project renders anywhere. This file only keeps
 * the original GLSL for the preview cards. Projects from before the pack may hold
 * `project.gl-<id>` copies made with `fx.define`; those still render.
 */
const GL_PACK = "gl.transition/";
const OLD_GL = "project.gl-";

interface FxEntry {
  id: string;
  reference: string;
  kind: string;
  name: string;
  description?: string;
  origin?: string;
}

interface Item {
  key: string;
  name: string;
  /** The engine's id when it can apply this transition, else null (preview only). */
  engineId: string | null;
  /** GL Transitions: the preview data. */
  gl: GlTransition | null;
  preview: GlTransition | null;
  detail: string;
  search: string;
}

const titleCase = (s: string) => s.replace(/(^|[ _-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

export function TransitionsTab({ engine, project, actions, playhead, selected }: { engine: Engine; project: Project; actions: Actions; playhead: number; selected: Clip | null }) {
  const [fx, setFx] = useState<FxEntry[] | null>(null);
  const [gl, setGl] = useState<GlTransition[]>([]);
  const [q, setQ] = useState("");
  const [duration, setDuration] = useState("0.5s");
  const [problem, setProblem] = useState<string | null>(null);

  const loadFx = () => engine.query<{ effects: FxEntry[] }>("fx.list").then((r) => setFx(r.effects ?? []), () => setFx([]));
  useEffect(() => {
    loadFx();
    import("./gl/transitions.json").then((m: any) => setGl((m.default ?? m).transitions as GlTransition[]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const video = selected?.kind === "video" ? selected : null;

  const { builtin, glItems } = useMemo(() => {
    const builtin: Item[] = (fx ?? [])
      .filter((e) => e.kind === "transition" && !e.id.startsWith(GL_PACK) && !e.id.startsWith(OLD_GL))
      .map((e) => ({
        key: e.id,
        name: e.name,
        engineId: e.id,
        gl: null,
        preview: ENGINE_PREVIEWS[e.id] ? { id: e.id, name: e.name, author: "", license: "", description: "", tags: [], params: [], glsl: ENGINE_PREVIEWS[e.id] } : null,
        detail: e.description ?? "",
        search: `${e.name} ${e.description ?? ""}`.toLowerCase(),
      }));
    // Usable when the engine lists it: from the installed pack, or already in this project.
    const known = new Set((fx ?? []).map((e) => e.id));
    const glItems: Item[] = gl.map((t) => ({
      key: `gl:${t.id}`,
      name: t.name || titleCase(t.id),
      engineId: t.engine_id && known.has(t.engine_id) ? t.engine_id : null,
      gl: t,
      preview: t,
      detail: [t.description, t.author && `by ${t.author}`, t.license && t.license !== "MIT" && `license: ${t.license}`].filter(Boolean).join(" · "),
      search: `${t.name} ${t.id} ${t.tags.join(" ")} ${t.author} ${t.description}`.toLowerCase(),
    }));
    return { builtin, glItems };
  }, [fx, gl]);

  const filter = (items: Item[]) => items.filter((i) => i.search.includes(q.toLowerCase()));
  /** Whether the engine can apply this transition. The engine copies a pack transition into the project itself on first use. */
  const ensure = async (i: Item): Promise<boolean> => {
    setProblem(null);
    return !!i.engineId && fx !== null;
  };
  const apply = async (i: Item) => {
    if (!i.engineId || engine.busy) return;
    const cut = cutFor(project, selected, playhead);
    if (!cut) { engine.report("There is no cut to put a transition on yet: place two clips next to each other on a video track."); return; }
    if (await ensure(i)) actions.addTransition(i.engineId, cut, duration);
  };

  const shownBuiltin = filter(builtin);
  const shownGl = filter(glItems);
  const hint = video ? `Click to put it on the cut at the end of ${video.name || video.id}, or drag it onto any cut.` : "Drag a card onto a cut in the timeline, or click to use the cut nearest the playhead.";

  return (
    <div className="single stack">
      <div className="search">
        <input className="input" placeholder="Search transitions" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input mono" style={{ width: 70 }} title="Duration" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </div>
      <p className="note" style={{ margin: 0 }}>{hint} Hover a card to play it.</p>
      {problem && <div className="err">{problem}</div>}
      {shownBuiltin.length > 0 && <div className="section-title">Built in</div>}
      <div className="tr-grid">{shownBuiltin.map((i) => <Card key={i.key} item={i} duration={duration} onApply={() => apply(i)} prepare={() => ensure(i)} />)}</div>
      {shownGl.length > 0 && <div className="section-title">GL Transitions ({shownGl.length})</div>}
      <div className="tr-grid">{shownGl.map((i) => <Card key={i.key} item={i} duration={duration} onApply={() => apply(i)} prepare={() => ensure(i)} />)}</div>
      {gl.length === 0 && <div className="spinner" />}
      {shownBuiltin.length + shownGl.length === 0 && gl.length > 0 && <p className="note">No transitions found.</p>}
      <p className="note">
        GL Transitions are by their authors (MIT unless a card says otherwise). The first use copies one into the project's effects folder.
        {fx !== null && gl.length > 0 && !glItems.some((i) => i.engineId) && " The GL Transitions pack is not installed: restart the editor, or run `ve plugin install plugins/gl-transitions`."}
        {glItems.some((i) => i.engineId) && glItems.some((i) => !i.engineId) && ' Cards marked "Preview" did not convert for the engine.'}
      </p>
    </div>
  );
}

function Card({ item, duration, onApply, prepare }: { item: Item; duration: string; onApply: () => void; prepare: () => Promise<boolean> }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [p, setP] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);

  // Resting picture is the outgoing image; hovering plays the shader.
  useEffect(() => {
    const ctx = ref.current?.getContext("2d");
    if (!ctx) return;
    if (p === null || !item.preview || broken) {
      ctx.drawImage(sceneImage(), 0, 0);
      return;
    }
    const r = getRenderer();
    const frame = r?.draw(item.preview, p);
    if (frame) ctx.drawImage(frame, 0, 0);
    else setBroken(true);
  }, [p, broken, item.preview]);

  // Hovering plays the transition on a loop: a beat on the first picture,
  // the transition, a beat on the second, again.
  const [hover, setHover] = useState(false);
  useEffect(() => {
    if (!hover) { setP(null); return; }
    const HOLD_A = 250, PLAY = 1100, HOLD_B = 450, LOOP = HOLD_A + PLAY + HOLD_B;
    const t0 = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const t = (now - t0) % LOOP;
      setP(t < HOLD_A ? 0 : t < HOLD_A + PLAY ? (t - HOLD_A) / PLAY : 1);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [hover]);
  const usable = !!item.engineId;

  return (
    <div
      className={`tr-card ${usable ? "" : "off"}`}
      onPointerDown={(e) => {
        if (!item.engineId) return;
        e.preventDefault();
        beginDrag(e, { kind: "transition", transition: item.engineId, duration, prepare }, item.name);
      }}
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      onClick={() => !wasDrag() && onApply()}
      title={`${item.name}${item.detail ? `\n${item.detail}` : ""}${usable ? "\nDrag onto a cut, or click to add it to the nearest cut" : `\nPreview only: ${item.gl?.engine_error?.split("\n")[0] ?? "the GL Transitions pack is not installed"}`}`}
    >
      <div className="tr-thumb">
        <canvas ref={ref} width={W} height={H} />
        {!usable && <span className="badge">Preview</span>}
        {broken && <span className="tr-broken">No preview</span>}
      </div>
      <div className="name">{item.name}</div>
    </div>
  );
}
