import { Component, ReactNode, StrictMode, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { Connect, Target } from "./Connect";
import { Editor } from "./Editor";
import { Rpc } from "./rpc";
import "./styles.css";

function Root() {
  const [target, setTarget] = useState<Target | null>(() => {
    // `?ws=<url>` connects straight away (handy in a browser).
    const ws = new URLSearchParams(location.search).get("ws");
    return ws ? { url: ws, project: null } : null;
  });
  const [rpc, setRpc] = useState<Rpc | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!target) return;
    const r = new Rpc(target.url);
    let live = true;
    r.ready.then(
      () => live && setRpc(r),
      (e) => {
        if (!live) return;
        setErr(String(e.message ?? e));
        setTarget(null);
      },
    );
    r.onClose = () => {
      if (!live) return;
      setErr("Lost the connection to the engine.");
      setRpc(null);
      setTarget(null);
    };
    return () => {
      live = false;
      r.close();
      setRpc(null);
    };
  }, [target]);

  if (!target) {
    return (
      <>
        <Connect onConnect={(t) => { setErr(null); setTarget(t); }} />
        {err && <div className="toast"><pre>{err}</pre></div>}
      </>
    );
  }
  if (!rpc) {
    return <div className="connect"><div className="spinner" /></div>;
  }
  return <Editor rpc={rpc} projectPath={target.project} onClose={() => setTarget(null)} />;
}

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) {
    return { err };
  }
  render() {
    if (!this.state.err) return this.props.children;
    return (
      <div className="connect">
        <div className="connect-card">
          <h1>The editor hit a bug</h1>
          <pre className="err">{String(this.state.err.stack ?? this.state.err)}</pre>
          <div className="hstack"><button className="btn primary" onClick={() => location.reload()}>Reload</button></div>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Boundary>
      <Root />
    </Boundary>
  </StrictMode>,
);
