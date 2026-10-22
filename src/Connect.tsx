import { useState } from "react";
import { daemonUrl, initProject, isTauri, pickFolder } from "./host";
import { load, save } from "./prefs";

export interface Target {
  url: string;
  project: string | null; // folder, when known
}

interface Recent {
  path: string;
  opened: number;
}

const SIZES: Record<string, string> = {
  "Landscape 1920x1080": "1920x1080",
  "Vertical 1080x1920": "1080x1920",
  "Square 1080x1080": "1080x1080",
  "4K 3840x2160": "3840x2160",
};

export function Connect({ onConnect }: { onConnect: (t: Target) => void }) {
  const [veBin, setVeBin] = useState(() => load("veBin", ""));
  const [recent, setRecent] = useState<Recent[]>(() => load("recent", []));
  const [url, setUrl] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("my-edit");
  const [size, setSize] = useState("Landscape 1920x1080");
  const [fps, setFps] = useState("30");

  const remember = (path: string) => {
    const next = [{ path, opened: Date.now() }, ...recent.filter((r) => r.path !== path)].slice(0, 8);
    setRecent(next);
    save("recent", next);
  };

  const open = async (path: string) => {
    setErr(null);
    setWorking(true);
    try {
      save("veBin", veBin);
      const ws = await daemonUrl(veBin, path);
      remember(path);
      onConnect({ url: ws, project: path });
    } catch (e) {
      setErr(String(e));
    } finally {
      setWorking(false);
    }
  };

  const browse = async () => {
    const p = await pickFolder("Open a ve project folder");
    if (p) open(p);
  };

  const create = async () => {
    const parent = await pickFolder("Where should the project folder go?");
    if (!parent) return;
    const path = `${parent.replace(/[\\/]+$/, "")}${parent.includes("\\") ? "\\" : "/"}${name.trim() || "my-edit"}`;
    setErr(null);
    setWorking(true);
    try {
      await initProject(veBin, path, fps, SIZES[size]);
      await open(path);
    } catch (e) {
      setErr(String(e));
      setWorking(false);
    }
  };

  return (
    <div className="connect">
      <div className="connect-card">
        <div className="brand"><span className="brand-mark" /> ve editor</div>
        {isTauri ? (
          <>
            <div>
              <h1>Open a project</h1>
              <p className="muted">A project is a folder with a <code>project.otio</code>. The editor starts its engine daemon if it isn't running.</p>
            </div>
            {!creating ? (
              <div className="hstack">
                <button className="btn primary" onClick={browse} disabled={working}>Open folder…</button>
                <button className="btn" onClick={() => setCreating(true)} disabled={working}>New project</button>
                {working && <span className="spinner" />}
              </div>
            ) : (
              <div className="card stack">
                <div className="field"><label>Name</label><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></div>
                <div className="hstack">
                  <div className="field" style={{ flex: 1 }}>
                    <label>Canvas</label>
                    <select className="input" value={size} onChange={(e) => setSize(e.target.value)}>
                      {Object.keys(SIZES).map((s) => <option key={s}>{s}</option>)}
                    </select>
                  </div>
                  <div className="field" style={{ width: 120 }}>
                    <label>Frame rate</label>
                    <select className="input" value={fps} onChange={(e) => setFps(e.target.value)}>
                      {["23.976", "24", "25", "29.97", "30", "50", "59.94", "60"].map((f) => <option key={f}>{f}</option>)}
                    </select>
                  </div>
                </div>
                <div className="hstack">
                  <button className="btn primary" onClick={create} disabled={working}>Choose location and create</button>
                  <button className="btn ghost" onClick={() => setCreating(false)}>Cancel</button>
                  {working && <span className="spinner" />}
                </div>
              </div>
            )}
            {recent.length > 0 && (
              <div>
                <div className="section-title">Recent</div>
                <div className="recent">
                  {recent.map((r) => (
                    <div key={r.path} className="row" onClick={() => !working && open(r.path)}>
                      <span className="grow">
                        {r.path.split(/[\\/]/).pop()}
                        <div className="path">{r.path}</div>
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
            <details>
              <summary>Engine binary</summary>
              <div className="field" style={{ marginTop: 10 }}>
                <label>Path to <code>ve</code> (empty: use the one on PATH)</label>
                <input className="input mono" value={veBin} placeholder="ve" onChange={(e) => setVeBin(e.target.value)} />
              </div>
            </details>
          </>
        ) : (
          <>
            <div>
              <h1>Connect to a project</h1>
              <p className="muted">
                In a browser the editor can't start the engine. Run <code>ve daemon start --json</code> in the project folder and paste its <code>websocket</code> URL.
              </p>
            </div>
            <div className="field">
              <label>WebSocket URL</label>
              <input className="input mono" value={url} placeholder="ws://127.0.0.1:52011/rpc?token=…" onChange={(e) => setUrl(e.target.value)} />
            </div>
            <div className="hstack">
              <button className="btn primary" disabled={!url.startsWith("ws")} onClick={() => onConnect({ url: url.trim(), project: null })}>Connect</button>
            </div>
            <p className="note">Playback of rendered previews and file pickers need the desktop app. Scrubbing and editing work here.</p>
          </>
        )}
        {err && <div className="err">{err}</div>}
      </div>
    </div>
  );
}
