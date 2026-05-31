import { describe, it, expect } from "vitest";
import { extractYear, humanizeBackendError, displayPath } from "../utils/formatters";

describe("extractYear", () => {
  it("parses a bare four-digit year string", () => {
    expect(extractYear("1984")).toBe(1984);
  });

  it("parses an ISO date string and returns the year component", () => {
    expect(extractYear("2001-09-11")).toBe(2001);
  });

  it("returns null for null input", () => {
    expect(extractYear(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(extractYear(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(extractYear("")).toBeNull();
  });

  it("returns null for a string with no parseable year", () => {
    expect(extractYear("not a date at all")).toBeNull();
  });

  it("parses a negative year (BCE) correctly", () => {
    // The regex anchors on /^-?\d{4}/, so -0044 should yield -44.
    expect(extractYear("-0044")).toBe(-44);
  });
});

describe("humanizeBackendError", () => {
  it("returns 'Unknown error' for null", () => {
    expect(humanizeBackendError(null)).toBe("Unknown error");
  });

  it("returns 'Unknown error' for undefined", () => {
    expect(humanizeBackendError(undefined)).toBe("Unknown error");
  });

  it("humanizes a SqliteFailure error", () => {
    expect(humanizeBackendError("SqliteFailure: attempt to write a readonly database")).toBe(
      "Database error (technical detail in console)"
    );
  });

  it("humanizes a database-is-locked error", () => {
    expect(humanizeBackendError("rusqlite::Error: database is locked")).toBe(
      "Database is locked — close other apps using this library and try again"
    );
  });

  it("humanizes a network / connection-refused error", () => {
    const result = humanizeBackendError("connection refused: 127.0.0.1:3030");
    expect(result).toBe("Network error — check your connection");
  });

  it("humanizes a TLS certificate error", () => {
    expect(humanizeBackendError("certificate verify failed")).toBe(
      "Network error — check your connection"
    );
  });

  it("passes through a short non-matching error verbatim", () => {
    expect(humanizeBackendError("book not found")).toBe("book not found");
  });

  it("truncates a long non-matching error and appends a note", () => {
    const long = "x".repeat(300);
    const result = humanizeBackendError(long);
    expect(result.length).toBeLessThan(250);
    expect(result).toContain("(full detail in console)");
  });
});

describe("displayPath", () => {
  it("strips the Windows extended-length \\\\?\\ prefix", () => {
    expect(displayPath("\\\\?\\C:\\Users\\alice\\Library")).toBe(
      "C:\\Users\\alice\\Library"
    );
  });

  it("leaves a normal Windows path unchanged", () => {
    expect(displayPath("C:\\Users\\alice\\Library")).toBe(
      "C:\\Users\\alice\\Library"
    );
  });

  it("leaves a Unix path unchanged", () => {
    expect(displayPath("/home/alice/library")).toBe("/home/alice/library");
  });

  it("returns an empty string for empty input unchanged", () => {
    // The function has `if (!path) return path;` — preserves falsy passthrough.
    expect(displayPath("")).toBe("");
  });
});
