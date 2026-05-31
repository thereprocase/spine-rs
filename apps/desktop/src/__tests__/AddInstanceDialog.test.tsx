// Happy-path render + submit tests for AddInstanceDialog. Mounts the
// component with react-dom/client directly into a happy-dom-backed
// container and drives the form via native DOM events — no
// @testing-library/react dependency, matches the existing pure-vitest
// pattern in this directory.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import AddInstanceDialog, { type InstanceDraft } from "../AddInstanceDialog";

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

function setInputValue(input: HTMLInputElement, value: string) {
  // React tracks the previous value via a setter on the prototype to
  // de-bounce no-op events; assign through the descriptor so React's
  // synthetic onChange actually fires.
  const proto = Object.getPrototypeOf(input);
  const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

function findInputByPlaceholder(placeholder: string): HTMLInputElement {
  const input = container.querySelector<HTMLInputElement>(
    `input[placeholder*="${placeholder}"]`,
  );
  if (!input) throw new Error(`no input with placeholder containing "${placeholder}"`);
  return input;
}

describe("AddInstanceDialog", () => {
  it("submits the canonical InstanceDraft shape on Add-instance click", () => {
    const onSave = vi.fn<(draft: InstanceDraft) => void>();
    const onClose = vi.fn();

    act(() => {
      root.render(
        <AddInstanceDialog
          bookTitle="The Test Book"
          onSave={onSave}
          onClose={onClose}
        />,
      );
    });

    // Default format is "EPUB"; tweak each optional field then submit.
    setInputValue(findInputByPlaceholder("EPUB, PDF, MOBI"), "Hardcover");
    setInputValue(findInputByPlaceholder("2026 or 2026-04-25"), "2024-04");
    setInputValue(findInputByPlaceholder("978…"), "9780000000001");

    // Two "optional" inputs share the same placeholder; pick the first
    // (Publisher) and the second (Edition title) by querying the labels.
    const inputs = Array.from(
      container.querySelectorAll<HTMLInputElement>('input[placeholder="optional"]'),
    );
    expect(inputs.length).toBe(2);
    setInputValue(inputs[0], "Test House");
    setInputValue(inputs[1], "Annotated edition");

    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add instance",
    );
    expect(submit, "Add instance button must render").toBeTruthy();

    act(() => {
      submit!.click();
    });

    expect(onSave).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledWith({
      format: "Hardcover",
      publicationDate: "2024-04",
      publisher: "Test House",
      isbn: "9780000000001",
      title: "Annotated edition",
      reconcileAgainstLoc: true,
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it("omits optional fields when blank and defaults reconcileAgainstLoc to true", () => {
    const onSave = vi.fn<(draft: InstanceDraft) => void>();
    const onClose = vi.fn();

    act(() => {
      root.render(
        <AddInstanceDialog
          bookTitle="Bare Book"
          onSave={onSave}
          onClose={onClose}
        />,
      );
    });

    // Submit with only the default format ("EPUB") — every other field empty.
    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add instance",
    );
    act(() => {
      submit!.click();
    });

    expect(onSave).toHaveBeenCalledWith({
      format: "EPUB",
      publicationDate: undefined,
      publisher: undefined,
      isbn: undefined,
      title: undefined,
      reconcileAgainstLoc: true,
    });
  });

  it("disables submit when format is empty after trim", () => {
    const onSave = vi.fn<(draft: InstanceDraft) => void>();

    act(() => {
      root.render(
        <AddInstanceDialog bookTitle="Book" onSave={onSave} onClose={() => {}} />,
      );
    });

    setInputValue(findInputByPlaceholder("EPUB, PDF, MOBI"), "   ");

    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add instance",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);

    // Clicking the disabled button must not fire onSave.
    act(() => {
      submit.click();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("disables submit when publication date fails EDTF validation", () => {
    const onSave = vi.fn<(draft: InstanceDraft) => void>();

    act(() => {
      root.render(
        <AddInstanceDialog bookTitle="Book" onSave={onSave} onClose={() => {}} />,
      );
    });

    // Garbage non-EDTF text (not even a 4-digit year prefix) must block submit.
    setInputValue(findInputByPlaceholder("2026 or 2026-04-25"), "next-tuesday");

    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add instance",
    ) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("toggling the reconcile checkbox flips reconcileAgainstLoc on submit", () => {
    const onSave = vi.fn<(draft: InstanceDraft) => void>();

    act(() => {
      root.render(
        <AddInstanceDialog bookTitle="Book" onSave={onSave} onClose={() => {}} />,
      );
    });

    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    );
    expect(checkbox?.checked).toBe(true);

    act(() => {
      checkbox!.click();
    });
    expect(checkbox?.checked).toBe(false);

    const submit = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent === "Add instance",
    );
    act(() => {
      submit!.click();
    });

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ reconcileAgainstLoc: false }),
    );
  });
});
