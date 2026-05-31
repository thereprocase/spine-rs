import { describe, it, expect } from "vitest";
import { describeStatus } from "../JobsIndicator";
import type { JobStatus } from "../types";

describe("describeStatus", () => {
  it("returns 'Pending' for pending status", () => {
    const status: JobStatus = { status: "pending" };
    expect(describeStatus(status)).toBe("Pending");
  });

  it("returns 'Running' for running status", () => {
    const status: JobStatus = { status: "running" };
    expect(describeStatus(status)).toBe("Running");
  });

  it("returns 'Completed' for completed status", () => {
    const status: JobStatus = { status: "completed", result: "some-uuid" };
    expect(describeStatus(status)).toBe("Completed");
  });

  it("returns 'Failed' for failed status", () => {
    const status: JobStatus = { status: "failed", result: "some error" };
    expect(describeStatus(status)).toBe("Failed");
  });

  it("returns 'Unknown' for an unrecognised status string", () => {
    // Cast to bypass TypeScript's exhaustiveness check so we can test the
    // runtime default branch that guards against future API additions.
    const status = { status: "totally_new_status" } as unknown as JobStatus;
    expect(describeStatus(status)).toBe("Unknown");
  });
});
