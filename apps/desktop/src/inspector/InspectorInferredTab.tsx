import { useCallback, useEffect, useState } from "react";
import { callApi, callApiJson } from "../api/client";
import { humanizeBackendError } from "../utils/formatters";

export interface InferredCandidate {
  inferenceId: string;
  subject: string;
  predicate: string;
  object: string;
  objectLabel?: string;
  confidence: number;
  inferredBy: string;
  inferredAt: string;
  inferenceBasis?: string;
}

interface InferredQueueResponse {
  rows?: InferredCandidate[];
}

export interface InspectorInferredTabProps {
  bookId: string;
  onPromoted?: (inferenceId: string) => void;
  onRejected?: (inferenceId: string) => void;
  onCountChange?: (count: number) => void;
  /** Per ADR 016 §6 the tab is gated behind `spine.inference.enabled`
   *  (default false). The host (App.tsx) decides whether to mount; this
   *  prop is kept so the component can also be rendered standalone in
   *  tests without flag wiring. */
  featureFlagEnabled?: boolean;
}

function formatConfidence(c: number): string {
  return `${Math.round(Math.max(0, Math.min(1, c)) * 100)}%`;
}

function formatPredicate(uri: string): string {
  // Strip the BIBFRAME / LCSH prefixes for display; fall back to the
  // last path/fragment segment for unknown predicates.
  const knownPrefixes = [
    "http://id.loc.gov/ontologies/bibframe/",
    "http://id.loc.gov/vocabulary/relationships/",
  ];
  for (const prefix of knownPrefixes) {
    if (uri.startsWith(prefix)) return `bf:${uri.slice(prefix.length)}`;
  }
  const hash = uri.lastIndexOf("#");
  if (hash >= 0) return uri.slice(hash + 1);
  const slash = uri.lastIndexOf("/");
  return slash >= 0 ? uri.slice(slash + 1) : uri;
}

export default function InspectorInferredTab({
  bookId,
  onPromoted,
  onRejected,
  onCountChange,
  featureFlagEnabled = true,
}: InspectorInferredTabProps) {
  const [rows, setRows] = useState<InferredCandidate[]>([]);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [endpointMissing, setEndpointMissing] = useState(false);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const resp = await callApiJson<InferredQueueResponse | InferredCandidate[] | null>(
        "GET",
        `/api/v1/inference/book/${bookId}`,
      );
      const list = Array.isArray(resp) ? resp : resp?.rows ?? [];
      setRows(list);
      setEndpointMissing(false);
      setError(null);
      onCountChange?.(list.length);
      return list;
    } catch (err) {
      const apiErr = err as { status?: number; message?: string };
      if (apiErr?.status === 404) {
        setRows([]);
        setEndpointMissing(true);
        setError(null);
        onCountChange?.(0);
        return [] as InferredCandidate[];
      }
      setError(`Could not load inferred suggestions: ${humanizeBackendError(err)}`);
      return [] as InferredCandidate[];
    } finally {
      setLoaded(true);
    }
  }, [bookId, onCountChange]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const decide = async (row: InferredCandidate, action: "promote" | "reject") => {
    if (pending.has(row.inferenceId)) return;
    setPending((prev) => new Set(prev).add(row.inferenceId));
    try {
      await callApi(
        "POST",
        `/api/v1/inference/${row.inferenceId}/decide`,
        { action },
      );
      setRows((prev) => prev.filter((r) => r.inferenceId !== row.inferenceId));
      if (action === "promote") onPromoted?.(row.inferenceId);
      else onRejected?.(row.inferenceId);
      void refresh();
    } catch (err) {
      setError(`Decide failed: ${humanizeBackendError(err)}`);
    } finally {
      setPending((prev) => {
        const next = new Set(prev);
        next.delete(row.inferenceId);
        return next;
      });
    }
  };

  // ADR 016 §6: Ignore is a client-side filter — hides the row until
  // next page load, NO network call.
  const handleIgnore = (row: InferredCandidate) => {
    setHidden((prev) => new Set(prev).add(row.inferenceId));
  };

  if (!featureFlagEnabled) {
    return (
      <div className="inspector-body">
        <div className="data-section">
          <p className="empty-hint">
            Inferred suggestions are disabled. Enable
            <code> spine.inference.enabled</code> in settings to review LLM-suggested triples.
          </p>
        </div>
      </div>
    );
  }

  const visibleRows = rows.filter((r) => !hidden.has(r.inferenceId));

  return (
    <div className="inspector-body inspector-inferred">
      <div className="data-section">
        <label>Inferred suggestions</label>
        {error && (
          <p className="empty-hint" role="alert" style={{ color: "var(--alert, #c44)" }}>
            {error}
          </p>
        )}
        {loaded && visibleRows.length === 0 ? (
          <p className="empty-hint">
            {endpointMissing
              ? "No inferred suggestions yet — Sprint 11 inference engine not deployed against this library."
              : "No inferred triples for this book. (Inference engine not yet wired — this tab will populate when LLM inference lands in a future sprint.)"}
          </p>
        ) : (
          <ul className="inferred-list">
            {visibleRows.map((row) => {
              const isPending = pending.has(row.inferenceId);
              return (
                <li key={row.inferenceId} className="inferred-row">
                  <div className="inferred-row-head">
                    <span className="inferred-predicate">{formatPredicate(row.predicate)}</span>
                    <span className="inferred-object" title={row.object}>
                      {row.objectLabel ?? row.object}
                    </span>
                    <span className="inferred-confidence" title={`${row.confidence}`}>
                      {formatConfidence(row.confidence)}
                    </span>
                  </div>
                  <div className="inferred-row-prov">
                    <span className="inferred-by" title={row.inferredBy}>{row.inferredBy}</span>
                    <span className="inferred-at" title={row.inferredAt}>{row.inferredAt}</span>
                    {row.inferenceBasis && (
                      <span className="inferred-basis" title={row.inferenceBasis}>
                        — {row.inferenceBasis}
                      </span>
                    )}
                  </div>
                  <div className="inferred-row-actions">
                    <button
                      type="button"
                      className="btn-promote"
                      onClick={() => decide(row, "promote")}
                      disabled={isPending}
                    >
                      Promote
                    </button>
                    <button
                      type="button"
                      className="btn-reject"
                      onClick={() => decide(row, "reject")}
                      disabled={isPending}
                    >
                      Reject
                    </button>
                    <button
                      type="button"
                      className="btn-ignore"
                      onClick={() => handleIgnore(row)}
                      disabled={isPending}
                    >
                      Ignore
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
