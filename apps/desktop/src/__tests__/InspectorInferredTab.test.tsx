// Vitest scaffold for the Sprint 11 Inspector "Inferred Suggestions" tab
// per ADR 016 §6. Pre-pins the row + action contract before the component
// lands, mirroring the pre-test pattern that worked for
// Settings drawer, the backup endpoint, and the S10
// reconcile endpoints.
//
// EXPECTED RED until `apps/desktop/src/inspector/InspectorInferredTab.tsx` lands.
//
// Wire shape per ADR 016 §5 (initial
// dispatch listed book-rooted paths, ADR §5 won as authoritative):
//   GET  /api/v1/inference/book/{book_uuid}      → 200 [InferredCandidate]
//   POST /api/v1/inference/{inference_id}/decide → 204
//     body: { "action": "promote" | "reject", "reason"?: string }
//
// Sprint 11 ships **read + decide**. The third ADR §5 endpoint
// `POST /api/v1/inference/run` belongs to the Sprint 12+ first-inferrer
// ship per ADR's "Implementation Notes": *"No inferrer is shipped by
// this ADR."*
//
// Component prop proposal (subject to adjustment, same way
// the S10 ReconcileDrawer scaffold flexed):
//   - bookId: string  (which book's inferred graph to fetch)
//   - onPromoted?: (inferenceId: string) => void
//   - onRejected?: (inferenceId: string) => void
//   - onCountChange?: (count: number) => void
//
// Each row carries the four ADR §2 lock-required provenance predicates;
// loose-match on field names because the backend serde shape (camelCase
// typeshare vs snake_case raw vs flattened-vs-nested) is his call.
//
// Per ADR §6 the Inspector tab is gated behind a feature flag
// `spine.inference.enabled` (default false). Tests assume the flag is
// ON or absent — the component should render without a flag-check
// in test mode, OR accept a `featureFlagEnabled?: boolean` prop with
// default true.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import InspectorInferredTab from "../inspector/InspectorInferredTab";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  invokeMock.mockReset();
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function textContent(): string {
  return container.textContent ?? "";
}

function findButtonByLabel(label: string | RegExp): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll<HTMLButtonElement>("button")).find(
    (b) => {
      const t = (b.textContent ?? "").trim();
      return label instanceof RegExp ? label.test(t) : t === label;
    },
  );
}

async function flushPolls() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const sampleRow = {
  inferenceId: "urn:spine:inference:abc-123",
  subject: "urn:spine:work:test-work-uuid",
  predicate: "http://id.loc.gov/ontologies/bibframe/subject",
  object: "http://id.loc.gov/authorities/subjects/sh85076671",
  objectLabel: "Library science",
  confidence: 0.87,
  inferredBy: "spine-inferrer-lcsh-suggest@0.1.0",
  inferredAt: "2026-05-12T14:30:00Z",
  inferenceBasis: "title+publisher exact match in LCSH-tagged corpus",
};

const secondRow = {
  inferenceId: "urn:spine:inference:def-456",
  subject: "urn:spine:work:test-work-uuid",
  predicate: "http://id.loc.gov/ontologies/bibframe/subject",
  object: "http://id.loc.gov/authorities/subjects/sh85088762",
  objectLabel: "Mathematics",
  confidence: 0.62,
  inferredBy: "spine-inferrer-lcsh-suggest@0.1.0",
  inferredAt: "2026-05-12T14:30:01Z",
};

function mockInferredList(rows: Array<typeof sampleRow | typeof secondRow>) {
  invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string }) => {
    if (args.method === "GET" && args.path.startsWith("/api/v1/inference/book/")) {
      return JSON.stringify({ rows });
    }
    if (args.method === "GET" && args.path.endsWith("/cover")) {
      throw "404 Not Found: no cover";
    }
    throw "404 Not Found";
  });
}

function renderTab(
  overrides: Partial<React.ComponentProps<typeof InspectorInferredTab>> = {},
) {
  const baseProps: React.ComponentProps<typeof InspectorInferredTab> = {
    bookId: "test-book-uuid",
    onPromoted: vi.fn(),
    onRejected: vi.fn(),
    onCountChange: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(<InspectorInferredTab {...baseProps} />);
  });
  return baseProps;
}

describe("InspectorInferredTab", () => {
  it("polls GET /api/v1/inference/book/:book_id on mount", async () => {
    mockInferredList([]);
    renderTab({ bookId: "test-book-uuid" });
    await flushPolls();
    const calls = invokeMock.mock.calls.filter(
      ([_cmd, args]) =>
        args?.method === "GET" && args?.path === "/api/v1/inference/book/test-book-uuid",
    );
    expect(calls.length, "tab must hit /api/v1/inference/book/:book_id (ADR §5)").toBeGreaterThanOrEqual(1);
  });

  it("renders empty state when no inferred candidates exist", async () => {
    mockInferredList([]);
    renderTab();
    await flushPolls();
    // ADR §6: empty state explains the surface + offers a "Run inferrer"
    // affordance. Loose-match against likely copy variants.
    expect(
      /no inferred|no suggestions|run inferrer|nothing to review/i.test(textContent()),
      "empty state must render some explanation copy",
    ).toBe(true);
  });

  it("renders one row per inferred candidate", async () => {
    mockInferredList([sampleRow, secondRow]);
    renderTab();
    await flushPolls();
    expect(textContent()).toContain("Library science");
    expect(textContent()).toContain("Mathematics");
  });

  it("renders confidence as percent (0.87 → 87%)", async () => {
    mockInferredList([sampleRow]);
    renderTab();
    await flushPolls();
    expect(textContent()).toContain("87%");
  });

  it("surfaces inferrer id+version per ADR §6", async () => {
    mockInferredList([sampleRow]);
    renderTab();
    await flushPolls();
    expect(textContent()).toContain("spine-inferrer-lcsh-suggest");
  });

  it("Promote POSTs /api/v1/inference/:inference_id/decide with { action: \"promote\" }", async () => {
    let getCount = 0;
    invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string; body?: string }) => {
      if (args.method === "GET" && args.path.startsWith("/api/v1/inference/book/")) {
        getCount += 1;
        return JSON.stringify({ rows: getCount === 1 ? [sampleRow] : [] });
      }
      if (args.method === "POST" && args.path.endsWith("/decide")) {
        return JSON.stringify({ ok: true });
      }
      throw "404 Not Found";
    });
    const props = renderTab();
    await flushPolls();
    const promoteBtn = findButtonByLabel(/promote/i);
    expect(promoteBtn, "Promote button").toBeTruthy();
    await act(async () => {
      promoteBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const decideCall = invokeMock.mock.calls.find(
      ([_cmd, args]) =>
        args?.method === "POST" && args?.path?.endsWith("/decide"),
    );
    expect(decideCall, "expected POST .../decide").toBeTruthy();
    expect(decideCall![1].path).toBe(
      "/api/v1/inference/urn:spine:inference:abc-123/decide",
    );
    const body = JSON.parse(decideCall![1].body as string);
    expect(body.action).toBe("promote");
    await flushPolls();
    expect(props.onPromoted).toHaveBeenCalledWith("urn:spine:inference:abc-123");
  });

  it("Reject POSTs /api/v1/inference/:inference_id/decide with { action: \"reject\" }", async () => {
    let getCount = 0;
    invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string; body?: string }) => {
      if (args.method === "GET" && args.path.startsWith("/api/v1/inference/book/")) {
        getCount += 1;
        return JSON.stringify({ rows: getCount === 1 ? [sampleRow] : [] });
      }
      if (args.method === "POST" && args.path.endsWith("/decide")) {
        return JSON.stringify({ ok: true });
      }
      throw "404 Not Found";
    });
    const props = renderTab();
    await flushPolls();
    const rejectBtn = findButtonByLabel(/reject/i);
    expect(rejectBtn, "Reject button").toBeTruthy();
    await act(async () => {
      rejectBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const decideCall = invokeMock.mock.calls.find(
      ([_cmd, args]) =>
        args?.method === "POST" && args?.path?.endsWith("/decide"),
    );
    expect(decideCall, "expected POST .../decide").toBeTruthy();
    expect(decideCall![1].path).toBe(
      "/api/v1/inference/urn:spine:inference:abc-123/decide",
    );
    const body = JSON.parse(decideCall![1].body as string);
    expect(body.action).toBe("reject");
    // `reason` is optional per ADR §5; the component MAY surface a freeform
    // reason input (loose pin), or omit the field entirely.
    await flushPolls();
    expect(props.onRejected).toHaveBeenCalledWith("urn:spine:inference:abc-123");
  });

  it("Ignore button is client-side filter; hides row WITHOUT a network call", async () => {
    // ADR §6: Ignore is a client-side filter that hides the row until
    // next page load. Critical assertion: no POST or DELETE must fire.
    mockInferredList([sampleRow]);
    renderTab();
    await flushPolls();
    const ignoreBtn = findButtonByLabel(/ignore|defer|hide/i);
    if (!ignoreBtn) {
      // The component MAY choose to omit the Ignore affordance and only ship
      // Promote/Reject in v0; not a hard contract per ADR §6 ("Promote
      // and Reject both call POST /decide; Ignore is a client-side
      // filter") — Ignore is described but not load-bearing for v0.
      // Note as expected behavior; don't hard-fail.
      return;
    }
    const beforeCount = invokeMock.mock.calls.filter(
      ([_cmd, args]) => args?.method === "POST" || args?.method === "DELETE",
    ).length;
    await act(async () => {
      ignoreBtn!.click();
      await Promise.resolve();
    });
    const afterCount = invokeMock.mock.calls.filter(
      ([_cmd, args]) => args?.method === "POST" || args?.method === "DELETE",
    ).length;
    expect(afterCount, "Ignore must not POST or DELETE — client-side filter only").toBe(
      beforeCount,
    );
  });

  it("fires onCountChange with the row count on each poll", async () => {
    mockInferredList([sampleRow, secondRow]);
    const props = renderTab();
    await flushPolls();
    expect(props.onCountChange).toHaveBeenCalledWith(2);
  });

  it("renders graceful 404 empty-state if endpoint not deployed", async () => {
    invokeMock.mockImplementation(async () => {
      throw "404 Not Found: endpoint missing";
    });
    renderTab();
    await flushPolls();
    // Either an explicit "feature not yet shipped" message OR the
    // generic empty-state copy is acceptable.
    expect(
      /sprint 11|not yet|coming|not deployed|no inferred|no suggestions/i.test(textContent()),
      "404 from inferred endpoint must render some explanatory copy",
    ).toBe(true);
  });
});
