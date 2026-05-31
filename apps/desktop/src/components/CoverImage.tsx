import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";

export default function CoverImage({ bookId, hasCover, className }: { bookId: string, hasCover?: boolean, className?: string }) {
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    if (hasCover) {
      invoke<string>("call_api", { method: "GET", path: `/api/v1/book/${bookId}/cover` })
        .then(base64Uri => {
          if (base64Uri) setSrc(base64Uri);
        })
        .catch(console.error);
    }
  }, [bookId, hasCover]);

  if (src) {
    return <img src={src} className={className} alt="Cover" />;
  }
  return <div className={className}></div>;
}
