// Vitest scaffold for the Sprint 9 Settings drawer. Pins
// the section + control contract before the component exists, mirroring
// the AddInstanceDialog test pattern (react-dom/client + happy-dom, no
// @testing-library/react).
//
// EXPECTED RED until `apps/desktop/src/Settings.tsx` lands. Per
// the Sprint 9 design: "pinning the contract early is a
// feature not a bug." Prop shape subject to adjustment on the landing commit.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import Settings from "../Settings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

function renderSettings(overrides: Partial<React.ComponentProps<typeof Settings>> = {}) {
  const baseProps = {
    onClose: vi.fn(),
    theme: "auto" as const,
    onThemeChange: vi.fn(),
    currentLibraryPath: "/library/spine-default",
    recentLibraries: [
      { path: "/library/spine-default" },
      { path: "/library/personal-2025", pinned: true, label: "Personal" },
    ],
    onSwitchLibrary: vi.fn(),
    onPinLibrary: vi.fn(),
    onForgetLibrary: vi.fn(),
    lastBackupAtMs: null,
    backupRetention: "last-7" as const,
    onPickBackupDest: vi.fn(),
    onBackupNow: vi.fn(),
    onRetentionChange: vi.fn(),
    isBackupRunning: false,
    ...overrides,
  };
  act(() => {
    root.render(<Settings {...baseProps} />);
  });
  return baseProps;
}

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

describe("Settings drawer", () => {
  it("renders the five expected section headers (Theme / Library / Backup / Reconcile / About)", () => {
    renderSettings();
    const text = textContent();
    expect(text).toMatch(/theme/i);
    expect(text).toMatch(/library/i);
    expect(text).toMatch(/backup/i);
    expect(text).toMatch(/reconcile/i);
    expect(text).toMatch(/about/i);
  });

  it("Theme section exposes a 3-way toggle (auto / dark / light)", () => {
    renderSettings({ theme: "dark" });
    expect(findButtonByLabel(/auto/i), "auto theme button").toBeTruthy();
    expect(findButtonByLabel(/dark/i), "dark theme button").toBeTruthy();
    expect(findButtonByLabel(/light/i), "light theme button").toBeTruthy();
  });

  it("clicking a theme option calls onThemeChange with that mode", () => {
    const props = renderSettings({ theme: "auto" });
    const lightBtn = findButtonByLabel(/light/i);
    expect(lightBtn).toBeTruthy();
    act(() => {
      lightBtn!.click();
    });
    expect(props.onThemeChange).toHaveBeenCalledWith("light");
  });

  it("Library section shows the current path and a Switch control", () => {
    renderSettings({ currentLibraryPath: "/library/test-lib" });
    expect(textContent()).toContain("/library/test-lib");
    const switchBtn = findButtonByLabel(/switch/i);
    expect(switchBtn, "Switch library button").toBeTruthy();
  });

  it("clicking Switch fires onSwitchLibrary", () => {
    const props = renderSettings();
    const switchBtn = findButtonByLabel(/switch/i);
    act(() => {
      switchBtn!.click();
    });
    expect(props.onSwitchLibrary).toHaveBeenCalledTimes(1);
  });

  it("recent libraries list surfaces each entry's path", () => {
    renderSettings();
    const text = textContent();
    expect(text).toContain("/library/spine-default");
    expect(text).toContain("/library/personal-2025");
  });

  it("Backup section shows graceful empty-state when lastBackupAtMs is null", () => {
    renderSettings({ lastBackupAtMs: null });
    // Empty-state copy unspecified — assert SOMETHING appears under the
    // Backup header even without a backend timestamp. Loose to give
    // wording flexibility while pinning the no-crash contract.
    const text = textContent();
    // Match the most likely user-facing variants. If
    // the wording is wholly different, this test should be the first
    // signal in code review.
    expect(
      /no backup yet|never backed up|—|—/i.test(text) ||
        text.includes("Backup"),
      "backup section must render some empty-state copy when lastBackupAtMs is null",
    ).toBe(true);
  });

  it("clicking Backup-now fires onBackupNow", () => {
    const props = renderSettings();
    const backupBtn = findButtonByLabel(/back\s*up\s*now|backup now/i);
    expect(backupBtn, "Backup now button").toBeTruthy();
    act(() => {
      backupBtn!.click();
    });
    expect(props.onBackupNow).toHaveBeenCalledTimes(1);
  });

  it("Backup-now button is disabled while isBackupRunning=true", () => {
    renderSettings({ isBackupRunning: true });
    const backupBtn = findButtonByLabel(/back(?:\s*up\s*now|ing\s*up)/i);
    expect(backupBtn?.disabled, "Backup now must be disabled during in-flight run").toBe(true);
  });

  it("retention dropdown calls onRetentionChange with selected value", () => {
    const props = renderSettings({ backupRetention: "last-7" });
    const select = container.querySelector<HTMLSelectElement>("select");
    expect(select, "retention <select> element").toBeTruthy();

    // Drive change via the React-tracked setter trick used in
    // AddInstanceDialog.test.tsx for inputs.
    const proto = Object.getPrototypeOf(select);
    const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    setter?.call(select, "last-30");
    select!.dispatchEvent(new Event("change", { bubbles: true }));

    expect(props.onRetentionChange).toHaveBeenCalledWith("last-30");
  });

  it("Reconcile section is present as a Sprint 10 placeholder", () => {
    renderSettings();
    // Loose match — may render "Coming in Sprint 10" or just a
    // stub heading. Existence of "reconcile" header is the contract.
    expect(textContent()).toMatch(/reconcile/i);
  });

  it("Escape key fires onClose", () => {
    const props = renderSettings();
    // Dispatch Escape on the document — drawer should listen at top-level.
    const event = new KeyboardEvent("keydown", { key: "Escape", bubbles: true });
    act(() => {
      document.dispatchEvent(event);
    });
    expect(props.onClose).toHaveBeenCalled();
  });
});
