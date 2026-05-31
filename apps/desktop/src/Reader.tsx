import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import 'foliate-js/view.js'; 
import { packagedReaderFrontend } from './readerFrontends';

type BookResourceResponse = {
  contentType: string;
  // Raw byte count of the decoded resource — what foliate's `getSize` wants.
  decodedLength: number;
  // Byte count of the base64 envelope; exposed for buffer budgeting.
  encodedLength: number;
  dataBase64: string;
};

type ReadingProgress = {
  bookId: string;
  locator: string;
  progressFraction?: number;
  chapterLabel?: string;
  updatedAt: string;
};

type ReaderProps = {
  bookId: string;
  bookTitle?: string;
  initialProgress?: ReadingProgress | null;
  onProgressSaved?: (progress: ReadingProgress) => void;
  onClose: () => void;
};

function decodeBase64(data: string): Uint8Array {
  const binary = atob(data);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export default function Reader({ bookId, bookTitle, initialProgress, onProgressSaved, onClose }: ReaderProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  // Capture the initial locator on first mount so we don't tear down + re-init the
  // reader every time the parent replaces the `initialProgress` object reference
  // (which happens on every progress save).
  const initialLocatorRef = useRef<string | null>(initialProgress?.locator ?? null);
  const mountedBookIdRef = useRef<string>(bookId);
  if (mountedBookIdRef.current !== bookId) {
    mountedBookIdRef.current = bookId;
    initialLocatorRef.current = initialProgress?.locator ?? null;
  }
  const emitProgressSaved = useEffectEvent((progress: ReadingProgress) => {
    onProgressSaved?.(progress);
  });

  useEffect(() => {
    if (!containerRef.current) return;

    let isCancelled = false;
    let persistTimer: ReturnType<typeof setTimeout> | null = null;
    // Most recent relocate payload — captured so that if the reader unmounts
    // while a 400ms debounce is in flight we can fire the save synchronously
    // instead of losing the last ~half-second of reading.
    let latestDetail: any = null;
    const container = containerRef.current;
    const initialLocator = initialLocatorRef.current;
    setError(null);

    // Create the foliate view web component
    const view = document.createElement('foliate-view') as any;
    container.innerHTML = ''; // Clear previous
    container.appendChild(view);

    const sendProgress = async (detail: any) => {
      try {
        const response = await invoke<string>("call_api", {
          method: "POST",
          path: `/api/v1/book/${bookId}/progress`,
          body: JSON.stringify({
            locator: detail.cfi,
            progressFraction: typeof detail.fraction === "number" ? detail.fraction : null,
            chapterLabel: detail.tocItem?.label ?? null
          })
        });
        emitProgressSaved(JSON.parse(response));
      } catch (saveError) {
        console.error("Failed to save reader progress:", saveError);
      }
    };

    const persistProgress = (detail: any) => {
      if (!detail?.cfi) return;
      latestDetail = detail;
      if (persistTimer) {
        clearTimeout(persistTimer);
      }
      persistTimer = setTimeout(() => {
        persistTimer = null;
        void sendProgress(detail);
      }, 400);
    };

    const handleRelocate = (event: Event) => {
      persistProgress((event as CustomEvent).detail);
    };
    view.addEventListener('relocate', handleRelocate);

    // Tab hide / window close also flushes the pending save. Best-effort:
    // the browser may kill the request in flight, but firing it is strictly
    // better than dropping the last position.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden" && persistTimer && latestDetail) {
        clearTimeout(persistTimer);
        persistTimer = null;
        void sendProgress(latestDetail);
      }
    };
    document.addEventListener("visibilitychange", handleVisibilityChange);

    const initReader = async () => {
      try {
        const { EPUB } = await import('foliate-js/epub.js');
        const resourceCache = new Map<string, Promise<BookResourceResponse>>();

        const loadResource = (path: string) => {
          if (!resourceCache.has(path)) {
            // If the invoke rejects, drop the cached promise so a subsequent
            // call retries instead of re-awaiting the poisoned rejection.
            const pending = invoke<BookResourceResponse>('read_book_resource', { bookId, path })
              .catch((err) => {
                resourceCache.delete(path);
                throw err;
              });
            resourceCache.set(path, pending);
          }
          return resourceCache.get(path)!;
        };

        const book = new EPUB({
          loadText: async (path: string) => {
            const resource = await loadResource(path);
            return new TextDecoder().decode(decodeBase64(resource.dataBase64));
          },
          loadBlob: async (path: string) => {
            const resource = await loadResource(path);
            const bytes = decodeBase64(resource.dataBase64);
            return new Blob([asArrayBuffer(bytes)], {
              type: resource.contentType || 'application/octet-stream'
            });
          },
          getSize: async (path: string) => {
            const resource = await loadResource(path);
            return resource.decodedLength;
          }
        });

        await book.init();
        if (isCancelled) return;

        await view.open(book);
        await view.init({
          lastLocation: initialLocator,
          showTextStart: !initialLocator
        });
        
      } catch (err: any) {
        if (!isCancelled) {
          console.error("Reader init error:", err);
          setError(err.message || "Failed to load book");
        }
      }
    };

    initReader();

    return () => {
      isCancelled = true;
      // Flush any pending debounced save before tearing down. Fire-and-forget
      // the POST — we can't await in a cleanup, but starting the invoke is
      // enough to stop losing the last 400ms of reading position.
      if (persistTimer && latestDetail) {
        clearTimeout(persistTimer);
        persistTimer = null;
        void sendProgress(latestDetail);
      } else if (persistTimer) {
        clearTimeout(persistTimer);
      }
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      view.removeEventListener('relocate', handleRelocate);
      if (view && typeof view.close === 'function') {
        view.close();
      }
      container.innerHTML = '';
    };
  }, [bookId, emitProgressSaved]);

  const nextChapter = () => {
    if (containerRef.current?.firstChild) {
      (containerRef.current.firstChild as any).next();
    }
  };

  const prevChapter = () => {
    if (containerRef.current?.firstChild) {
      (containerRef.current.firstChild as any).prev();
    }
  };

  return (
    <div className="reader-overlay" style={{ 
      position: 'fixed', inset: 0, zIndex: 1000, 
      background: 'var(--bg-app)', display: 'flex', flexDirection: 'column' 
    }}>
      <header className="reader-header" style={{ 
        padding: '12px 24px', 
        borderBottom: '1px solid var(--border)', 
        display: 'flex', 
        justifyContent: 'space-between',
        alignItems: 'center',
        background: 'var(--bg-sidebar)',
        color: 'var(--text-main)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0, flex: 1 }}>
          <h3 style={{ margin: 0, fontSize: '1rem', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {bookTitle ? bookTitle : packagedReaderFrontend.name}
            {bookTitle && (
              <span style={{ marginLeft: '10px', fontSize: '0.75rem', fontWeight: 400, color: 'var(--text-muted)' }}>
                {packagedReaderFrontend.name}
              </span>
            )}
          </h3>
          <div className="reader-controls" style={{ display: 'flex', gap: '8px', background: 'var(--bg-app)', padding: '4px', borderRadius: '6px' }}>
            <button onClick={prevChapter} style={{ background: 'transparent', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '4px 12px', borderRadius: '4px' }} onMouseOver={e => e.currentTarget.style.background = 'var(--bg-sidebar)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>&larr; Prev</button>
            <button onClick={nextChapter} style={{ background: 'transparent', border: 'none', color: 'var(--text-main)', cursor: 'pointer', padding: '4px 12px', borderRadius: '4px' }} onMouseOver={e => e.currentTarget.style.background = 'var(--bg-sidebar)'} onMouseOut={e => e.currentTarget.style.background = 'transparent'}>Next &rarr;</button>
          </div>
        </div>
        <button 
          onClick={onClose}
          style={{
            background: 'rgba(255, 255, 255, 0.05)',
            border: '1px solid var(--border)',
            color: 'var(--text-muted)',
            padding: '6px 16px',
            borderRadius: '6px',
            cursor: 'pointer',
            transition: 'all 0.2s'
          }}
          onMouseOver={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.1)'; e.currentTarget.style.color = 'var(--text-main)'; }}
          onMouseOut={e => { e.currentTarget.style.background = 'rgba(255, 255, 255, 0.05)'; e.currentTarget.style.color = 'var(--text-muted)'; }}
        >
          Close
        </button>
      </header>

      {error ? (
        <div style={{ padding: '40px', color: '#ef4444', textAlign: 'center' }}>
          <h4>Error Loading Reader</h4>
          <p>{error}</p>
        </div>
      ) : (
        <div ref={containerRef} style={{ flex: 1, position: 'relative', overflow: 'hidden' }}>
          {/* Foliate view will mount here */}
        </div>
      )}
    </div>
  );
}
