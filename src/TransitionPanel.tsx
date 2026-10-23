// Right-hand panel for a selected transition: kind, length, alignment and the
// params its manifest declares (JSON Schema from fx.list), plus Remove and
// Apply to all. Every change is one transition.set; the timeline redraws
// from the engine's answer.

import { useEffect, useState } from "react";
import type { Engine } from "./engine";
import type { Actions } from "./Editor";
import { Align, alignOf, cutsOf, findClip, fitTransition, maxTransition, Project, Transition } from "./model";
import { Icon } from "./icons";

interface FxEntry {
  id: string;
  reference: string;
  kind: string;
  name: string;
  description?: string;
  params?: { properties?: Record<string, ParamSchema> };
}

interface ParamSchema {
  type?: string;
  format?: string;
  minimum?: number;
  maximum?: number;
  default?: unknown;
  enum?: unknown[];
  description?: string;
  title?: string;
}

/** `core.transition/wipe@1` -> `core.transition/wipe`. */
const baseId = (ref: string) => ref.replace(/@\d+$/, "");

export function TransitionPanel({ project, engine, tr, actions }: { project: Project; engine: Engine; tr: Transition; actions: Actions }) {
  const [fx, setFx] = useState<FxEntry[]>([]);
  useEffect(() => {
    engine.query<{ effects: FxEntry[] }>("fx.list").then((r) => setFx((r.effects ?? []).filter((e) => e.kind === "transition")), () => setFx([]));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const fps = project.fps;
  const entry = fx.find((e) => e.id === baseId(tr.kind) || e.reference === tr.kind);
  const align = alignOf(tr);
  const frames = tr.inOffset + tr.outOffset;
  const a = findClip(project, tr.outgoing), b = findClip(project, tr.incoming);
  const max = a && b ? Math.max(frames, maxTransition(project, { outgoing: a, incoming: b }, align)) : frames;
  const minF = align === "center" ? 2 : 1;
  // The slider tops out at the handles or 5 s, whichever is shorter (CapCut's range).
  const sliderMax = Math.max(minF, Math.min(max, Math.round(fps * 5)));

  const [dur, setDur] = useState(frames);
  const [text, setText] = useState(secs(frames, fps));
  useEffect(() => { setDur(frames); setText(secs(frames, fps)); }, [tr.id, frames, fps]);

  const commitDur = (f: number) => {
    const v = Math.max(minF, Math.min(max, Math.round(f)));
    setDur(v);
    setText(secs(v, fps));
    if (v !== frames) actions.setTransition(tr.id, { duration: v });
  };
  const stepDur = (by: number) => commitDur(dur + by);

  const props = Object.entries(entry?.params?.properties ?? {});
  const setParam = (k: string, v: unknown) => actions.setTransition(tr.id, { params: { [k]: v } });
  const resetParams = () => {
    const nulls = Object.fromEntries(Object.keys(tr.params).map((k) => [k, null]));
    if (Object.keys(nulls).length) actions.setTransition(tr.id, { params: nulls });
  };

  const applyToAll = async () => {
    const track = project.tracks.find((t) => t.id === tr.trackId);
    if (!track) return;
    await engine.group("Apply transition to all", async () => {
      for (const cut of cutsOf(track)) {
        if (cut.transition?.id === tr.id) continue;
        const fit = fitTransition(project, cut, frames, align);
        const common = { transition: tr.kind, params: tr.params, duration: `f${fit.duration}`, align: fit.align };
        if (cut.transition) await engine.mutate("transition.set", { id: cut.transition.id, ...common });
        else await engine.mutate("transition.add", { clip: cut.outgoing.id, ...common });
      }
    });
  };

  const kinds = fx.length ? fx : [{ id: baseId(tr.kind), reference: tr.kind, kind: "transition", name: baseId(tr.kind) }];

  return (
    <section className="panel">
      <div className="panel-head">Transition</div>
      <div className="single stack" style={{ flex: 1 }}>
        <div className="section-title hstack" style={{ justifyContent: "space-between" }}>
          <span>Transition parameters</span>
          <button className="icon-btn" style={{ width: 24, height: 24 }} onClick={resetParams} disabled={!Object.keys(tr.params).length} data-tip="Reset parameters">
            <Icon.undo />
          </button>
        </div>
        <div className="props">
          <span className="k">Name</span>
          <select className="input" value={entry?.id ?? baseId(tr.kind)} onChange={(e) => actions.setTransition(tr.id, { transition: e.target.value })}>
            {kinds.map((k) => <option key={k.id} value={k.id}>{k.name}</option>)}
          </select>
          <span className="k">Duration</span>
          <div className="slider-row" style={{ gridTemplateColumns: "1fr 64px 22px" }}>
            <input
              type="range" min={minF} max={sliderMax} step={1} value={Math.min(dur, sliderMax)}
              onChange={(e) => { const v = Number(e.target.value); setDur(v); setText(secs(v, fps)); }}
              onPointerUp={() => commitDur(dur)} onKeyUp={() => commitDur(dur)}
            />
            <input
              className="input mono" value={text}
              onChange={(e) => setText(e.target.value)}
              onBlur={() => commitDur(parseSecs(text, fps) ?? frames)}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitDur(parseSecs(text, fps) ?? frames);
                else if (e.key === "ArrowUp") { e.preventDefault(); stepDur(1); }
                else if (e.key === "ArrowDown") { e.preventDefault(); stepDur(-1); }
              }}
            />
            <div className="stepper">
              <button onClick={() => stepDur(1)} title="One frame longer">▲</button>
              <button onClick={() => stepDur(-1)} title="One frame shorter">▼</button>
            </div>
          </div>
          <span className="k">Align</span>
          <div className="seg">
            {(["center", "start", "end"] as Align[]).map((v) => (
              <button key={v} className={align === v ? "on" : ""} onClick={() => v !== align && actions.setTransition(tr.id, { align: v })}
                title={v === "center" ? "Centered on the cut" : v === "start" ? "Starts at the cut" : "Ends at the cut"}>
                {v === "center" ? "Center" : v === "start" ? "Start" : "End"}
              </button>
            ))}
          </div>
          {props.map(([k, sc]) => (
            <Param key={k} name={k} schema={sc} value={tr.params[k] ?? sc.default} onChange={(v) => setParam(k, v)} trId={tr.id} />
          ))}
        </div>
        <p className="note">
          {Math.round(frames)} frames, {secs(tr.inOffset, fps)} before the cut and {secs(tr.outOffset, fps)} after.
          {max < Infinity && ` The clips' spare media allows up to ${secs(max, fps)}.`} Drag the edges on the timeline to change the length, or the block to move it to another cut.
        </p>
        <div style={{ flex: 1 }} />
        <div className="hstack" style={{ justifyContent: "space-between" }}>
          <button className="btn ghost danger" onClick={() => actions.removeTransition(tr.id)}><Icon.trash /> Remove</button>
          <button className="btn" onClick={applyToAll} disabled={!!engine.busy} title={`Put this transition on every cut on ${tr.trackName}`}>Apply to all</button>
        </div>
      </div>
    </section>
  );
}

function Param({ name, schema, value, onChange, trId }: { name: string; schema: ParamSchema; value: unknown; onChange: (v: unknown) => void; trId: string }) {
  const label = schema.title ?? name.replace(/_/g, " ").replace(/^./, (c) => c.toUpperCase());
  const [local, setLocal] = useState<unknown>(value);
  useEffect(() => setLocal(value), [trId, JSON.stringify(value)]); // eslint-disable-line react-hooks/exhaustive-deps

  // Colors fire on every mouse move in the picker; send the last one after a pause.
  useEffect(() => {
    if (schema.format !== "color" || JSON.stringify(local) === JSON.stringify(value)) return;
    const t = setTimeout(() => onChange(local), 350);
    return () => clearTimeout(t);
  }, [local]); // eslint-disable-line react-hooks/exhaustive-deps

  let control: JSX.Element;
  if (schema.format === "color" && Array.isArray(local)) {
    control = <input type="color" value={toHex(local as number[])} onChange={(e) => setLocal(fromHex(e.target.value, (local as number[]).length))} style={{ width: 48, height: 26, padding: 0, border: "none", background: "none" }} />;
  } else if (schema.type === "number" || schema.type === "integer") {
    const lo = schema.minimum ?? 0, hi = schema.maximum ?? Math.max(1, Number(local) * 2);
    const step = schema.type === "integer" ? 1 : (hi - lo) / 200;
    const n = Number(local ?? 0);
    const commit = () => n !== value && onChange(schema.type === "integer" ? Math.round(n) : n);
    control = (
      <div className="slider-row">
        <input type="range" min={lo} max={hi} step={step} value={n} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} />
        <input className="input mono" value={+n.toFixed(3)} onChange={(e) => setLocal(Number(e.target.value) || 0)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />
      </div>
    );
  } else if (schema.type === "boolean") {
    control = <input type="checkbox" checked={!!local} onChange={(e) => { setLocal(e.target.checked); onChange(e.target.checked); }} />;
  } else if (schema.enum) {
    control = (
      <select className="input" value={String(local)} onChange={(e) => { const v = schema.enum!.find((x) => String(x) === e.target.value); setLocal(v); onChange(v); }}>
        {schema.enum.map((x) => <option key={String(x)} value={String(x)}>{String(x)}</option>)}
      </select>
    );
  } else {
    control = <span className="v mono faint">{JSON.stringify(local)}</span>;
  }
  return (
    <>
      <span className="k" title={schema.description}>{label}</span>
      {control}
    </>
  );
}

function secs(frames: number, fps: number) {
  return `${+(frames / fps).toFixed(2)}s`;
}

/** `0.9`, `0.9s` or `27f` to frames. */
function parseSecs(s: string, fps: number): number | null {
  const t = s.trim();
  const f = /^(\d+)f$/.exec(t);
  if (f) return Number(f[1]);
  const m = /^(\d*\.?\d+)\s*s?$/.exec(t);
  return m ? Math.round(Number(m[1]) * fps) : null;
}

/** sRGB [r,g,b] in 0..1 <-> `#rrggbb`. */
function toHex(c: number[]) {
  return "#" + c.slice(0, 3).map((v) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0")).join("");
}
function fromHex(h: string, n: number) {
  const v = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return n === 4 ? [...v, 1] : v;
}
