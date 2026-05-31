import { useEffect, useRef, useState } from "react";
import { Activity, X } from "lucide-react";
import { callApiJson } from "./api/client";
import type { JobEntry, JobStatus } from "./types";

export interface JobsIndicatorProps {
  /** Parent signals that in-flight jobs exist by bumping this token.
   *  When no jobs are active (token === lastSeen AND list is empty), the
   *  indicator polls nothing and shows "Idle". Keeps idle libraries
   *  quiet — no /api/v1/jobs spam every two seconds when nothing's
   *  happening. */
  activityToken: number;
}

export function describeStatus(status: JobStatus): string {
  switch (status.status) {
    case "pending": return "Pending";
    case "running": return "Running";
    case "completed": return "Completed";
    case "failed": return "Failed";
    default: return "Unknown";
  }
}

function isTerminal(status: JobStatus): boolean {
  return status.status === "completed" || status.status === "failed";
}

export function JobsIndicator({ activityToken }: JobsIndicatorProps) {
  const [jobs, setJobs] = useState<JobEntry[]>([]);
  const [open, setOpen] = useState(false);
  const intervalRef = useRef<number | null>(null);

  const activeCount = jobs.filter(j => !isTerminal(j.status)).length;

  // Single-shot fetch. Called once when `activityToken` changes and then
  // on the 2-second tick only while there are active jobs.
  const refresh = async () => {
    try {
      const list = await callApiJson<JobEntry[]>("GET", "/api/v1/jobs");
      setJobs(list);
      return list;
    } catch {
      // Silent — jobs endpoint flakiness shouldn't yell at the user.
      return [] as JobEntry[];
    }
  };

  // Re-run whenever the parent nudges us (e.g. a new ingest job dispatched).
  useEffect(() => {
    void refresh();
  }, [activityToken]);

  // Poll every 2s only while active jobs exist. When the last active job
  // turns terminal, the next poll sees activeCount === 0 and clears the
  // interval — no busy loop.
  useEffect(() => {
    if (activeCount === 0) {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }
    if (intervalRef.current !== null) return;
    const handle = window.setInterval(() => {
      void refresh();
    }, 2000);
    intervalRef.current = handle;
    return () => {
      clearInterval(handle);
      if (intervalRef.current === handle) intervalRef.current = null;
    };
  }, [activeCount]);

  const label = activeCount === 0
    ? "Idle"
    : `${activeCount} job${activeCount === 1 ? "" : "s"} running`;

  return (
    <div className="jobs-indicator-root">
      <button
        type="button"
        className={`jobs-indicator-btn ${activeCount > 0 ? "has-activity" : ""}`}
        onClick={() => setOpen(o => !o)}
        aria-label={`Jobs: ${label}. Click to ${open ? "close" : "open"} jobs panel.`}
        aria-expanded={open}
      >
        <Activity size={14} aria-hidden="true" />
        <span>{label}</span>
        {jobs.length > 0 && <span className="jobs-indicator-count">{jobs.length}</span>}
      </button>
      {open && (
        <div className="jobs-panel" role="dialog" aria-label="Background jobs">
          <header className="jobs-panel-header">
            <h3>Background jobs</h3>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="Close jobs panel"
              className="jobs-panel-close"
            >
              <X size={14} />
            </button>
          </header>
          {jobs.length === 0 ? (
            <p className="jobs-panel-empty">No jobs to show.</p>
          ) : (
            <ul className="jobs-panel-list">
              {jobs.map(job => {
                const ts = job.finishedAt ?? job.createdAt;
                return (
                  <li key={job.id} className={`jobs-panel-item status-${job.status.status}`}>
                    <div className="jobs-panel-row">
                      <span className="jobs-panel-status">{describeStatus(job.status)}</span>
                      <code className="jobs-panel-id" title={job.id}>{job.id.slice(0, 8)}</code>
                      <span className="jobs-panel-time" title={ts ?? undefined}>
                        {ts ? new Date(ts).toLocaleTimeString() : "—"}
                      </span>
                    </div>
                    {(job.status.status === "completed" || job.status.status === "failed") && (
                      <p className={`jobs-panel-result ${job.status.status === "failed" ? "is-error" : ""}`}>
                        {job.status.result}
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
