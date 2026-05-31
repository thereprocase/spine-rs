import { useEffect, useRef, useState } from "react";
import { AlertCircle } from "lucide-react";
import { callApiJson, isApiError } from "./api/client";
import type { DeletedBook } from "./types";

export interface RemoveBookDialogProps {
  bookId: string;
  bookTitle: string;
  onClose: () => void;
  onRemoved: (result: DeletedBook) => void;
  onError: (message: string) => void;
}

export function RemoveBookDialog({
  bookId,
  bookTitle,
  onClose,
  onRemoved,
  onError
}: RemoveBookDialogProps) {
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [isRemoving, setIsRemoving] = useState(false);
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  // Focus Cancel on open — destructive-action hygiene, so pressing Enter
  // immediately does NOT remove a book. User has to deliberately Tab to
  // "Remove" or click it.
  useEffect(() => {
    cancelRef.current?.focus();
  }, []);

  // Escape closes the dialog.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !isRemoving) onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isRemoving, onClose]);

  const handleRemove = async () => {
    setIsRemoving(true);
    try {
      const path = `/api/v1/book/${bookId}?delete_files=${deleteFiles}`;
      const result = await callApiJson<DeletedBook>("DELETE", path);
      onRemoved(result);
      onClose();
    } catch (err) {
      if (isApiError(err)) {
        if (err.status === 404) {
          // Stale UI — the book was already gone. Treat as success so the
          // list refreshes; parent clears selection.
          onRemoved({ uuid: bookId, path: "", deletedFiles: [] });
          onClose();
          return;
        }
        if (err.status === 503) {
          onError("Library not loaded — open a library first.");
        } else if (err.status === 400) {
          onError(`Cannot remove this book: ${err.message}`);
        } else {
          onError(`Remove failed (${err.status || "network"}): ${err.message}`);
        }
      } else {
        onError(`Remove failed: ${String(err)}`);
      }
      setIsRemoving(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="remove-dialog-title"
      className="remove-dialog-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget && !isRemoving) onClose();
      }}
    >
      <div className="remove-dialog">
        <header className="remove-dialog-header">
          <div className="remove-dialog-icon" aria-hidden="true">
            <AlertCircle size={24} />
          </div>
          <h2 id="remove-dialog-title">Remove book</h2>
        </header>
        <p className="remove-dialog-body">
          Remove <strong>{bookTitle}</strong> from the library?
        </p>
        <label className="remove-dialog-checkbox">
          <input
            type="checkbox"
            checked={deleteFiles}
            onChange={(e) => setDeleteFiles(e.target.checked)}
            disabled={isRemoving}
          />
          <span>Also delete files from disk</span>
        </label>
        <p className="remove-dialog-hint">
          {deleteFiles
            ? "Format files (EPUB, cover, etc.) will be permanently deleted."
            : "Files on disk will be left in place; only the library entry is removed."}
        </p>
        <footer className="remove-dialog-actions">
          <button
            ref={cancelRef}
            type="button"
            onClick={onClose}
            disabled={isRemoving}
            className="btn-secondary"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => void handleRemove()}
            disabled={isRemoving}
            className="btn-danger"
            aria-label={`Remove ${bookTitle} from library`}
          >
            {isRemoving ? "Removing..." : "Remove"}
          </button>
        </footer>
      </div>
    </div>
  );
}
