import { useMemo, useRef, useEffect, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';

export default function GraphView({ books, onSelectBook }: { books: any[], onSelectBook: (id: string) => void }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [dimensions, setDimensions] = useState({ width: 800, height: 600 });

  useEffect(() => {
    if (!containerRef.current) return;
    const resizeObserver = new ResizeObserver(entries => {
      for (let entry of entries) {
        setDimensions({
          width: entry.contentRect.width,
          height: entry.contentRect.height
        });
      }
    });
    resizeObserver.observe(containerRef.current);
    return () => resizeObserver.disconnect();
  }, []);

  const graphData = useMemo(() => {
    const nodes: any[] = [];
    const links: any[] = [];

    const authorSet = new Set<string>();
    const subjectSet = new Set<string>();

    books.forEach(book => {
      // Book Node
      nodes.push({
        id: book.id,
        name: book.title,
        group: 'book',
        val: 5
      });

      // Authors
      book.authors.forEach((author: string) => {
        if (!authorSet.has(author)) {
          authorSet.add(author);
          nodes.push({ id: `author:${author}`, name: author, group: 'author', val: 3 });
        }
        links.push({ source: `author:${author}`, target: book.id });
      });

      // Subjects (from graph or legacy)
      const subjects = book.bibliographicGraph?.work?.subjects?.map((s: any) => s.label) || book.legacyMetadata.tags || [];
      subjects.forEach((subject: string) => {
        if (!subjectSet.has(subject)) {
          subjectSet.add(subject);
          nodes.push({ id: `subject:${subject}`, name: subject, group: 'subject', val: 2 });
        }
        links.push({ source: book.id, target: `subject:${subject}` });
      });
    });

    return { nodes, links };
  }, [books]);

  if (books.length === 0) {
    return (
      <div className="empty-surface-state">
        <strong>No graph data</strong>
        <span>Reconcile books with LoC metadata before using the graph view.</span>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={{ width: '100%', height: '100%', background: 'var(--bg-app)' }}>
      <ForceGraph2D
        width={dimensions.width}
        height={dimensions.height}
        graphData={graphData}
        nodeLabel="name"
        nodeColor={(node: any) => {
          if (node.group === 'book') return 'var(--accent)';
          if (node.group === 'author') return 'var(--yellow)';
          return 'var(--text-muted)';
        }}
        linkColor={() => 'rgba(255,255,255,0.1)'}
        nodeRelSize={4}
        onNodeClick={(node: any) => {
          if (node.group === 'book') onSelectBook(node.id);
        }}
        nodeCanvasObject={(node: any, ctx, globalScale) => {
          const label = node.name;
          const fontSize = node.group === 'book' ? 12 / globalScale : 10 / globalScale;
          ctx.font = `${fontSize}px Sans-Serif`;
          const textWidth = ctx.measureText(label).width;
          const bckgDimensions = [textWidth, fontSize].map(n => n + fontSize * 0.2); // some padding

          ctx.fillStyle = 'rgba(15, 23, 42, 0.8)';
          if (node.group === 'book') {
            ctx.beginPath();
            ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI, false);
            ctx.fillStyle = 'var(--accent)';
            ctx.fill();
          } else {
             ctx.fillRect(node.x - bckgDimensions[0] / 2, node.y - bckgDimensions[1] / 2, bckgDimensions[0], bckgDimensions[1]);
          }

          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillStyle = node.group === 'book' ? 'white' : node.group === 'author' ? 'var(--yellow)' : 'var(--text-muted)';
          
          if (node.group === 'book') {
            ctx.fillText(label, node.x, node.y + node.val + fontSize);
          } else {
            ctx.fillText(label, node.x, node.y);
          }

          node.__bckgDimensions = bckgDimensions; // to re-use in nodePointerAreaPaint
        }}
      />
    </div>
  );
}
