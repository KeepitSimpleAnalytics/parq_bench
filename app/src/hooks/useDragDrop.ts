import { useState, useEffect, useRef } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { ActiveTab } from "../types";

interface UseDragDropParams {
  activeTab: ActiveTab;
  previewPaneRef: React.RefObject<HTMLDivElement | null>;
  sqlPaneRef: React.RefObject<HTMLDivElement | null>;
  onPreviewDrop: (paths: string[]) => void;
  onSqlDrop: (paths: string[]) => void;
}

export function useDragDrop({
  activeTab,
  previewPaneRef,
  sqlPaneRef,
  onPreviewDrop,
  onSqlDrop,
}: UseDragDropParams) {
  const [dragOverZone, setDragOverZone] = useState<"preview" | "sql" | null>(null);

  // Use refs for callbacks to avoid stale closures in the effect
  const onPreviewDropRef = useRef(onPreviewDrop);
  onPreviewDropRef.current = onPreviewDrop;
  const onSqlDropRef = useRef(onSqlDrop);
  onSqlDropRef.current = onSqlDrop;

  useEffect(() => {
    let cancelled = false;
    const unlisten = getCurrentWebview().onDragDropEvent((event) => {
      if (cancelled) return;
      const payload = event.payload;
      if (payload.type === "over") {
        const pos = payload.position;
        const previewRect = previewPaneRef.current?.getBoundingClientRect();
        const sqlRect = sqlPaneRef.current?.getBoundingClientRect();
        if (
          previewRect &&
          activeTab === "preview" &&
          pos.x >= previewRect.left &&
          pos.x <= previewRect.right &&
          pos.y >= previewRect.top &&
          pos.y <= previewRect.bottom
        ) {
          setDragOverZone("preview");
        } else if (
          sqlRect &&
          activeTab === "sql" &&
          pos.x >= sqlRect.left &&
          pos.x <= sqlRect.right &&
          pos.y >= sqlRect.top &&
          pos.y <= sqlRect.bottom
        ) {
          setDragOverZone("sql");
        } else {
          setDragOverZone(activeTab);
        }
      } else if (payload.type === "leave") {
        setDragOverZone(null);
      } else if (payload.type === "drop") {
        const zone = dragOverZone ?? activeTab;
        setDragOverZone(null);
        const paths = payload.paths;
        if (!paths || paths.length === 0) return;
        if (zone === "preview") {
          onPreviewDropRef.current(paths);
        } else {
          onSqlDropRef.current(paths);
        }
      }
    });

    return () => {
      cancelled = true;
      unlisten.then((fn) => fn());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, dragOverZone]);

  return { dragOverZone };
}
