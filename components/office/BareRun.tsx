"use client";
import { useEffect, useState } from "react";

const POLL_MS = 2000;
const DONE_STATUSES = new Set(["complete", "failed"]);

/** Bare tracer-bullet run view: fetches /api/runs/[id], polls until done, dumps raw JSON. No styling — TKT-12/13 build the real UI. */
export default function BareRun({ id }: { id: string }) {
  const [state, setState] = useState<unknown>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      const res = await fetch(`/api/runs/${id}`);
      if (cancelled) return;
      if (!res.ok) {
        setState({ error: res.status });
        return;
      }
      const data: unknown = await res.json();
      if (cancelled) return;
      setState(data);
      const status = (data as { run?: { status?: string } })?.run?.status;
      if (!status || !DONE_STATUSES.has(status)) timer = setTimeout(poll, POLL_MS);
    }

    void poll();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [id]);

  return <pre>{JSON.stringify(state, null, 2)}</pre>;
}
