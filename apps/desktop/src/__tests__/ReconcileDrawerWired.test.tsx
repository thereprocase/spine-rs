// Vitest scaffold for the Sprint 10 wired ReconcileDrawer state machine.
// Pre-pins the endpoint contract before the drawer is migrated onto
// the 3-endpoint Sprint 10 surface, per the Sprint 10 design.
// EXPECTED RED until the Sprint 10 rewire and backend endpoints land.
//
// Locked endpoint contract per the Sprint 10 design:
//   GET  /api/v1/reconcile/queue                   → 200 { rows | queue: [...] }
//   POST /api/v1/reconcile/{book_id}/promote       → 2xx with { locUri }
//   POST /api/v1/reconcile/{book_id}/skip          → 2xx (no body)
// (Mint-local is frontend-only — short-circuits to spinemint URI per
// the dispatch; no endpoint pinned.)
//
// This file deliberately exists alongside `ReconcileDrawer.test.tsx`
// during the migration window. Once the rewire lands, the older
// test (which validated the previous-generation
// `/api/v1/library/reconciles/pending` + per-book accept/mint/skip
// paths) is superseded and can be deleted in the same commit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import ReconcileDrawer from "../ReconcileDrawer";

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

const sampleRows = [
  {
    bookId: "book-aaaa-1111",
    title: "Pride and Prejudice",
    author: "Austen, Jane",
    hasCover: true,
    candidates: [
      {
        uri: "http://id.loc.gov/resources/works/14456236",
        label: "Pride and prejudice",
        agent: "Austen, Jane, 1775-1817",
        pubDate: "1813",
        confidence: 0.78,
      },
    ],
    flaggedAt: "2026-04-25T15:00:00Z",
    reason: "low-confidence",
  },
  {
    bookId: "book-bbbb-2222",
    title: "An obscure self-published novella",
    candidates: [],
    reason: "timeout",
  },
];

/** GET /api/v1/reconcile/queue mock. The backend may model the response
 *  body as `{ rows: [...] }`, `{ queue: [...] }`, or a bare array.
 *  This helper sends `{ rows }` first; tests that need a different
 *  shape configure invokeMock directly. */
function mockQueueResponse(rows: typeof sampleRows) {
  invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string }) => {
    if (args.method === "GET" && args.path === "/api/v1/reconcile/queue") {
      return JSON.stringify({ rows });
    }
    if (args.method === "GET" && args.path.startsWith("/api/v1/book/") && args.path.endsWith("/cover")) {
      throw "404 Not Found: no cover";
    }
    throw "404 Not Found";
  });
}

function renderDrawer(
  overrides: Partial<React.ComponentProps<typeof ReconcileDrawer>> = {},
) {
  const baseProps: React.ComponentProps<typeof ReconcileDrawer> = {
    open: true,
    onClose: vi.fn(),
    onAutoOpen: vi.fn(),
    onResolved: vi.fn(),
    onCountChange: vi.fn(),
    ...overrides,
  };
  act(() => {
    root.render(<ReconcileDrawer {...baseProps} />);
  });
  return baseProps;
}

describe("ReconcileDrawer (wired against Sprint 10 endpoints)", () => {
  it("polls GET /api/v1/reconcile/queue on mount", async () => {
    mockQueueResponse([]);
    renderDrawer();
    await flushPolls();
    const queueCalls = invokeMock.mock.calls.filter(
      ([_cmd, args]) =>
        args?.method === "GET" && args?.path === "/api/v1/reconcile/queue",
    );
    expect(queueCalls.length, "drawer must hit /reconcile/queue (Sprint 10 path)")
      .toBeGreaterThanOrEqual(1);
  });

  it("renders one row per pending entry from the queue", async () => {
    mockQueueResponse(sampleRows);
    renderDrawer();
    await flushPolls();
    const rows = container.querySelectorAll("[data-testid=\"reconcile-row\"]");
    expect(rows.length).toBe(2);
    expect(textContent()).toContain("Pride and Prejudice");
    expect(textContent()).toContain("An obscure self-published novella");
  });

  it("Accept LoC POSTs to /api/v1/reconcile/{book_id}/promote with { locUri }", async () => {
    let getCount = 0;
    invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string; body?: string }) => {
      if (args.method === "GET" && args.path === "/api/v1/reconcile/queue") {
        getCount += 1;
        return JSON.stringify({ rows: getCount === 1 ? sampleRows : [] });
      }
      if (args.method === "POST" && args.path.includes("/reconcile/") && args.path.endsWith("/promote")) {
        return JSON.stringify({ ok: true });
      }
      throw "404 Not Found";
    });
    const props = renderDrawer();
    await flushPolls();
    const acceptBtn = findButtonByLabel(/accept/i);
    expect(acceptBtn, "Accept LoC button").toBeTruthy();
    await act(async () => {
      acceptBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    const promoteCall = invokeMock.mock.calls.find(
      ([_cmd, args]) =>
        args?.method === "POST" &&
        args?.path?.endsWith("/promote") &&
        args?.path?.includes("/reconcile/"),
    );
    expect(promoteCall, "expected POST to /api/v1/reconcile/:bookId/promote").toBeTruthy();
    expect(promoteCall![1].path).toBe("/api/v1/reconcile/book-aaaa-1111/promote");
    const body = JSON.parse(promoteCall![1].body as string);
    expect(body.locUri).toBe("http://id.loc.gov/resources/works/14456236");
    await flushPolls();
    expect(props.onResolved).toHaveBeenCalledWith("book-aaaa-1111");
  });

  it("Skip POSTs to /api/v1/reconcile/{book_id}/skip with no body", async () => {
    invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string }) => {
      if (args.method === "GET" && args.path === "/api/v1/reconcile/queue") {
        return JSON.stringify({ rows: sampleRows });
      }
      // Mock skip as immediate resolve so the deferred POST fires for
      // the test's purposes; in production the 5s undo window applies.
      if (args.method === "POST" && args.path.endsWith("/skip")) {
        return JSON.stringify({ ok: true });
      }
      throw "404 Not Found";
    });
    renderDrawer();
    await flushPolls();
    const skipBtn = findButtonByLabel(/skip\s*ingest/i);
    expect(skipBtn, "Skip ingest button").toBeTruthy();
    await act(async () => {
      skipBtn!.click();
      await Promise.resolve();
    });
    // Path-shape contract: any POST to /api/v1/reconcile/<id>/skip
    // qualifies, regardless of whether it lands during the 5s undo
    // window (sync) or after (deferred).
    const skipCall = invokeMock.mock.calls.find(
      ([_cmd, args]) =>
        args?.method === "POST" &&
        args?.path?.includes("/reconcile/") &&
        args?.path?.endsWith("/skip"),
    );
    if (skipCall) {
      expect(skipCall![1].path).toBe("/api/v1/reconcile/book-aaaa-1111/skip");
      expect(skipCall![1].body).toBeUndefined();
    } else {
      // The 5s undo window may delay the POST past the synchronous
      // assertion — accept that branch as well, but at minimum the
      // SkipUndoRow must be visible (per ADR 015 amendment-3).
      expect(textContent()).toMatch(/skipping ingest/i);
    }
  });

  it("Mint local short-circuits without a network round-trip", async () => {
    // Per the Sprint 10 design: "Mint-local short-circuits to spinemint URI"
    // — frontend-only. The button MAY clear the row from the local list
    // and surface onResolved, but MUST NOT POST to the new wire-shape
    // (no /reconcile/<id>/mint-local endpoint exists in the Sprint 10
    // contract). Loose: accept either a local-only handler or a no-op.
    invokeMock.mockImplementation(async (_cmd: string, args: { method: string; path: string }) => {
      if (args.method === "GET" && args.path === "/api/v1/reconcile/queue") {
        return JSON.stringify({ rows: sampleRows });
      }
      throw "404 Not Found";
    });
    renderDrawer();
    await flushPolls();
    const mintBtn = findButtonByLabel(/mint\s*local/i);
    expect(mintBtn, "Mint local button").toBeTruthy();
    await act(async () => {
      mintBtn!.click();
      await Promise.resolve();
      await Promise.resolve();
    });
    // The hard assertion: no POST to the new mint-local path.
    // (A local-only state mutation is fine; we don't pin that yet.)
    const mintPost = invokeMock.mock.calls.find(
      ([_cmd, args]) => args?.method === "POST" && args?.path?.endsWith("/mint-local"),
    );
    expect(mintPost, "Mint local must not POST in the Sprint 10 wire-shape").toBeUndefined();
  });

  it("renders endpoint-unavailable empty state on 404 from /reconcile/queue", async () => {
    invokeMock.mockImplementation(async () => {
      throw "404 Not Found: queue endpoint missing";
    });
    renderDrawer();
    await flushPolls();
    // The existing empty state mentions "Sprint 10 backend"; loose match
    // against likely variants.
    expect(textContent()).toMatch(/sprint 10|activates when|backend/i);
  });

  it("fires onCountChange with the queue length on each successful poll", async () => {
    mockQueueResponse(sampleRows);
    const props = renderDrawer();
    await flushPolls();
    expect(props.onCountChange).toHaveBeenCalledWith(2);
  });

  it("auto-opens via onAutoOpen on first row arrival", async () => {
    mockQueueResponse(sampleRows);
    const props = renderDrawer({ open: false });
    await flushPolls();
    expect(props.onAutoOpen).toHaveBeenCalled();
  });
});
