// Hand-written TypeScript types that mirror backend Rust structs.
//
// Wave 2 added FacetCount, DeletedBook, BookUpdate, JobEntry, and
// UpdateMetadataFieldsRequest without #[typeshare] annotations. A proper
// typeshare pipeline is tracked as a Wave 4 follow-up; until then these
// types must stay in sync with `core/calibre-db/src/lib.rs` and
// `core/spine-srv/src/api_v1.rs` by hand.

export interface FacetCount {
  name: string;
  bookCount: number;
}

export interface DeletedBook {
  uuid: string;
  path: string;
  deletedFiles: string[];
  /** Files that could not be removed from disk. Each entry is [path, errorMessage].
   * The DB commit already happened when these are present; treat as warnings. */
  failedFileDeletes?: Array<[string, string]>;
}

// Nullable-field convention matches the Rust Option<Option<String>> pattern
// that `calibre-db::BookUpdate` uses: `undefined` / absent key means
// "leave unchanged"; `null` means "explicitly clear the field".
export interface BookUpdate {
  title?: string;
  authors?: string[];
  tags?: string[];
  series?: string | null;
  seriesIndex?: number;
  pubdate?: string | null;
  publisher?: string | null;
  languages?: string[];
}

export type JobStatus =
  | { status: "pending" }
  | { status: "running" }
  | { status: "completed"; result: string }
  | { status: "failed"; result: string };

export interface JobEntry {
  id: string;
  status: JobStatus;
  /** ISO8601 timestamp when the job was queued. Optional: older
   *  backends omit this field; the jobs panel renders "—" when absent. */
  createdAt?: string;
  /** ISO8601 timestamp when the job finished (status completed|failed). */
  finishedAt?: string;
}
