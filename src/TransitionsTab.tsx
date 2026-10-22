import { useEffect, useMemo, useRef, useState } from "react";
import type { Engine } from "./engine";
import { at, Clip } from "./model";
import { ENGINE_PREVIEWS, getRenderer, GlTransition, H, sceneImage, W } from "./gl/preview";

/** Engine ids of the GL Transitions, once the engine ships them (see the importer script). */
export const glEngineId = (id: string) => `gl.transitions/${id}`;

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
  preview: GlTransition | null;
  detail: string;
  search: string;
}

const titleCase = (s: string) => s.replace(/(^|[ _-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

export function TransitionsTab({ engine, playhead, selected }: { engine: Engine; playhead: number; selected: Clip | null }) {
  const [fx, setFx] = useState<FxEntry[] | null>(null);
  const [gl, setGl] = useState<GlTransition[]>([]);
  const [q, setQ] = useState("");
  const [duration, setDuration] = useState("0.5s");

  useEffect(() => {
    engine.query<{ effects: FxEntry[] }>("fx.list").then((r) => setFx(r.effects ?? []), () => setFx([]));
    import("./gl/transitions.json").then((m: any) => setGl((m.default ?? m).transitions as GlTransition[]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const video = selected?.kind === "video" ? selected : null;

  const { builtin, glItems } = useMemo(() => {
    const engineIds = new Set((fx ?? []).filter((e) => e.kind === "transition").map((e) => e.id));
    const builtin: Item[] = (fx ?? [])
      .filter((e) => e.kind === "transition" && !e.id.startsWith("gl.transitions/"))
      .map((e) => ({
        key: e.id,
        name: e.name,
        engineId: e.id,
        preview: ENGINE_PREVIEWS[e.id] ? { id: e.id, name: e.name, author: "", license: "", description: "", tags: [], params: [], glsl: ENGINE_PREVIEWS[e.id] } : null,
        detail: e.description ?? "",
        search: `${e.name} ${e.description ?? ""}`.toLowerCase(),
      }));
    const glItems: Item[] = gl.map((t) => ({
      key: `gl:${t.id}`,
      name: t.name || titleCase(t.id),
      engineId: engineIds.has(glEngineId(t.id)) ? glEngineId(t.id) : null,
      preview: t,
      detail: [t.description, t.author && `by ${t.author}`, t.license && t.license !== "MIT" && `license: ${t.license}`].filter(Boolean).join(" · "),
      search: `${t.name} ${t.id} ${t.tags.join(" ")} ${t.author} ${t.description}`.toLowerCase(),
    }));
    return { builtin, glItems };
  }, [fx, gl]);

  const filter = (items: Item[]) => items.filter((i) => i.search.includes(q.toLowerCase()));
  const apply = (i: Item) => {
    if (!i.engineId || engine.busy) return;
    engine.mutate("transition.add", { transition: i.engineId, duration, ...(video ? { clip: video.id } : { at: at(playhead) }) });
  };

  const shownBuiltin = filter(builtin);
  const shownGl = filter(glItems);
  const hint = video ? `Goes on the cut at the end of ${video.name || video.id}.` : "Goes on the cut at the playhead, or select the clip before the cut.";

  return (
    <div className="single stack">
      <div className="search">
        <input className="input" placeholder="Search transitions" value={q} onChange={(e) => setQ(e.target.value)} />
        <input className="input mono" style={{ width: 70 }} title="Duration" value={duration} onChange={(e) => setDuration(e.target.value)} />
      </div>
      <p className="note" style={{ margin: 0 }}>{hint} Move the mouse over a card to scrub the transition.</p>
      {shownBuiltin.length > 0 && <div className="section-title">Built in</div>}
      <div className="tr-grid">{shownBuiltin.map((i) => <Card key={i.key} item={i} onApply={() => apply(i)} />)}</div>
      {shownGl.length > 0 && <div className="section-title">GL Transitions ({shownGl.length})</div>}
      <div className="tr-grid">{shownGl.map((i) => <Card key={i.key} item={i} onApply={() => apply(i)} />)}</div>
      {gl.length === 0 && <div className="spinner" />}
      {shownBuiltin.length + shownGl.length === 0 && gl.length > 0 && <p className="note">No transitions found.</p>}
      <p className="note">GL Transitions are by their authors (MIT unless a card says otherwise). Cards marked "preview only" are not in the engine yet.</p>
    </div>
  );
}

function Card({ item, onApply }: { item: Item; onApply: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [p, setP] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);

  // Resting picture is the outgoing image; hovering draws the shader at the mouse position.
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

  const move = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    setP(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };
  const usable = !!item.engineId;

  return (
    <div
      className={`tr-card ${usable ? "" : "off"}`}
      onMouseMove={move}
      onMouseLeave={() => setP(null)}
      onClick={onApply}
      title={`${item.name}${item.detail ? `\n${item.detail}` : ""}${usable ? "\nClick to add at the cut" : "\nPreview only: not in the engine yet"}`}
    >
      <div className="tr-thumb">
        <canvas ref={ref} width={W} height={H} />
        {p !== null && <div className="tr-sweep" style={{ left: `${p * 100}%` }} />}
        {!usable && <span className="badge">Preview</span>}
        {broken && <span className="tr-broken">No preview</span>}
      </div>
      <div className="name">{item.name}</div>
    </div>
  );
}
