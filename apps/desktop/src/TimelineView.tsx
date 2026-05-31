import { useMemo } from 'react';
import { Book as BookIcon } from 'lucide-react';
import { extractYear } from './utils/formatters';

export default function TimelineView({ books, onSelectBook, selectedBookId }: { books: any[], onSelectBook: (id: string) => void, selectedBookId: string | null }) {

  const timelineData = useMemo(() => {
    const data: { year: number, books: any[] }[] = [];
    const map = new Map<number, any[]>();

    books.forEach(book => {
      let year: number | null = null;
      if (book.bibliographicGraph?.work?.originDate) {
        year = extractYear(book.bibliographicGraph.work.originDate);
      }
      if (year === null && book.legacyMetadata?.pubDate) {
        year = extractYear(book.legacyMetadata.pubDate);
      }

      if (year === null || year === 0) year = 9999; // Unknown

      if (!map.has(year)) map.set(year, []);
      map.get(year)!.push(book);
    });

    const years = Array.from(map.keys()).sort((a, b) => a - b);
    years.forEach(year => {
      data.push({ year, books: map.get(year)! });
    });

    return data;
  }, [books]);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '40px' }}>
      <div style={{ maxWidth: '800px', margin: '0 auto', position: 'relative' }}>
        {/* The center line */}
        <div style={{ position: 'absolute', left: '120px', top: 0, bottom: 0, width: '2px', background: 'var(--border)' }}></div>

        {timelineData.map(({ year, books }) => (
          <div key={year} style={{ display: 'flex', marginBottom: '40px', position: 'relative' }}>
            {/* Year Label */}
            <div style={{ width: '100px', textAlign: 'right', paddingRight: '20px', fontWeight: 800, fontSize: '1.2rem', color: year === 9999 ? 'var(--text-dim)' : 'var(--accent)', paddingTop: '8px' }}>
              {year === 9999 ? "Unknown" : year}
            </div>
            
            {/* Dot */}
            <div style={{ position: 'absolute', left: '116px', top: '14px', width: '10px', height: '10px', borderRadius: '50%', background: 'var(--bg-app)', border: '2px solid var(--accent)' }}></div>

            {/* Books */}
            <div style={{ flex: 1, paddingLeft: '40px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
              {books.map(book => (
                <div 
                  key={book.id}
                  onClick={() => onSelectBook(book.id)}
                  style={{ 
                    background: selectedBookId === book.id ? 'var(--bg-active)' : 'var(--bg-sidebar)', 
                    border: `1px solid ${selectedBookId === book.id ? 'var(--accent)' : 'var(--border)'}`,
                    padding: '16px', 
                    borderRadius: '8px', 
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '16px',
                    transition: 'transform 0.2s, box-shadow 0.2s',
                    boxShadow: selectedBookId === book.id ? '0 4px 12px rgba(0,0,0,0.2)' : 'none'
                  }}
                  onMouseOver={e => e.currentTarget.style.transform = 'translateY(-2px)'}
                  onMouseOut={e => e.currentTarget.style.transform = 'translateY(0)'}
                >
                  <BookIcon size={24} color={book.bibliographicGraph ? 'var(--accent)' : 'var(--yellow)'} />
                  <div>
                    <h4 style={{ margin: '0 0 4px 0', fontSize: '1rem', color: 'var(--text-main)' }}>{book.title}</h4>
                    <p style={{ margin: 0, fontSize: '0.8rem', color: 'var(--text-muted)' }}>{book.authors.join(", ")}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ))}
        {timelineData.length === 0 && (
          <div className="empty-surface-state">
            <strong>No timeline data</strong>
            <span>Books need an origin date or Calibre publication date before they appear here.</span>
          </div>
        )}
      </div>
    </div>
  );
}
