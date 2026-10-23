// Keeps a parsed copy of the project in sync with the daemon. Any change
// event (ours, an agent's, or an external edit) triggers one refetch; the
// project is small enough that this beats applying patches by hand.

import { useCallback, useEffect, useRef, useState } from "react";
import { Rpc, RpcError } from "./rpc";
import { parseProject, Project } from "./model";

export interface HistoryStep {
  actor: string;
  what: string;
  revs: number[];
  group?: string | null;
}

export interface Engine {
  project: Project | null;
  history: { undo: HistoryStep[]; redo: HistoryStep[] };
  lastChange: { actor: string; command: string; revision: number } | null;
  busy: string | null;
  error: string | null;
  clearError: () => void;
  /** Show a message in the error toast (for problems the UI catches before calling the engine). */
  report: (message: string) => void;
  query: <T = any>(method: string, params?: Record<string, unknown>, busy?: string) => Promise<T>;
  mutate: <T = any>(method: string, params?: Record<string, unknown>, busy?: string) => Promise<T | null>;
  /** Run several mutations as one undo step. */
  group: (label: string, fn: () => Promise<void>) => Promise<void>;
}

export function useEngine(rpc: Rpc): Engine {
  const [project, setProject] = useState<Project | null>(null);
  const [history, setHistory] = useState<Engine["history"]>({ undo: [], redo: [] });
  const [lastChange, setLastChange] = useState<Engine["lastChange"]>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rev = useRef(0);
  const fetching = useRef<Promise<void> | null>(null);
  const again = useRef(false);

  const refetch = useCallback(async () => {
    if (fetching.current) {
      again.current = true;
      return fetching.current;
    }
    const run = async () => {
      do {
        again.current = false;
        const [doc, hist] = await Promise.all([rpc.call("project.get"), rpc.call("history.list", { limit: 50 })]);
        rev.current = doc.revision;
        setProject(parseProject(doc));
        setHistory({ undo: hist.undo ?? [], redo: hist.redo ?? [] });
      } while (again.current);
    };
    fetching.current = run()
      .catch((e) => setError(String(e?.message ?? e)))
      .finally(() => (fetching.current = null));
    return fetching.current;
  }, [rpc]);

  useEffect(() => {
    const off = rpc.listen((method, params) => {
      if (method === "project.changed") {
        setLastChange({ actor: actorName(params.actor), command: params.command, revision: params.revision });
        if (params.revision !== rev.current) refetch();
      } else if (method === "project.reloaded" || method === "events.lagged") {
        refetch();
      }
    });
    rpc.call("events.subscribe").then(refetch, (e) => setError(String(e?.message ?? e)));
    return off;
  }, [rpc, refetch]);

  const query = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}, label?: string): Promise<T> => {
      if (label) setBusy(label);
      try {
        return await rpc.call<T>(method, params);
      } finally {
        if (label) setBusy(null);
      }
    },
    [rpc],
  );

  const mutate = useCallback(
    async <T,>(method: string, params: Record<string, unknown> = {}, label?: string): Promise<T | null> => {
      if (label) setBusy(label);
      try {
        const r: any = await rpc.call(method, { ...params, base_rev: rev.current });
        if (typeof r?.revision === "number" && r.revision !== rev.current) {
          rev.current = r.revision;
          await refetch();
        }
        return r as T;
      } catch (e) {
        if (e instanceof RpcError && /stale/i.test(e.message)) {
          await refetch();
          setError("The project changed under you (another client or the agent). Refreshed; try again.");
        } else {
          setError(String((e as any)?.message ?? e));
        }
        return null;
      } finally {
        if (label) setBusy(null);
      }
    },
    [rpc, refetch],
  );

  const group = useCallback(
    async (label: string, fn: () => Promise<void>) => {
      await rpc.call("history.begin_group", { label });
      try {
        await fn();
      } finally {
        await rpc.call("history.end_group").catch(() => {});
        await refetch();
      }
    },
    [rpc, refetch],
  );

  return { project, history, lastChange, busy, error, clearError: () => setError(null), report: setError, query, mutate, group };
}

/** `{kind: "agent", id: "claude"}` -> `agent:claude`; the local user is just `user`. */
export function actorName(a: unknown): string {
  if (typeof a === "string") return a;
  const o = a as { kind?: string; id?: string } | null;
  if (!o?.kind) return "unknown";
  return o.kind === "user" && (!o.id || o.id === "local") ? "user" : `${o.kind}:${o.id ?? ""}`;
}
