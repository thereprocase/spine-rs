// Thin wrapper over the in-process Tauri bridge. All frontends talk to the
// server through `invoke("call_api", ...)`; this module centralises the
// shape so the component files don't each reach into Tauri APIs.

import { invoke } from "@tauri-apps/api/core";

export interface ApiError {
  /** HTTP status code; 0 when the error did not come from an HTTP response. */
  status: number;
  /** Raw error body / message as surfaced by the bridge. */
  message: string;
}

/** `call_api` returns the body as a string on success, and an error string of
 *  the form `"<status>: <body>"` on failure. Parse that into a structured
 *  ApiError so callers can branch on HTTP code without regexing. */
function parseBridgeError(raw: unknown): ApiError {
  const text = String(raw ?? "");
  // The bridge formats errors as "<status>: <body>" (see lib.rs `call_api`).
  const match = text.match(/^(\d{3})(?:\s[^:]*)?:\s?([\s\S]*)$/);
  if (match) {
    return { status: parseInt(match[1], 10), message: match[2] };
  }
  return { status: 0, message: text };
}

/** Invoke the backend API and return the parsed JSON response. */
export async function callApiJson<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  try {
    const response = await invoke<string>("call_api", {
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    return JSON.parse(response) as T;
  } catch (err) {
    throw parseBridgeError(err);
  }
}

/** Invoke the backend API, discarding the response body. Used for endpoints
 *  that return 204 No Content (e.g. PUT /book/:id/metadata/fields). */
export async function callApi(method: string, path: string, body?: unknown): Promise<void> {
  try {
    await invoke<string>("call_api", {
      method,
      path,
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch (err) {
    throw parseBridgeError(err);
  }
}

export function isApiError(err: unknown): err is ApiError {
  return !!err && typeof err === "object" && "status" in err && "message" in err;
}
