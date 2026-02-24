import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { tableFromIPC } from "apache-arrow";
import type { PreviewResponse, ParquetRowsTransport } from "../types";
import { PAGE_SIZE, ROW_HEIGHT, MIN_VIEWPORT_HEIGHT, OVERSCAN, COLUMN_WIDTH } from "../constants";

async function readSocketPayload(url: string): Promise<Uint8Array> {
  return new Promise<Uint8Array>((resolve, reject) => {
    const chunks: Uint8Array[] = [];
    let totalBytes = 0;
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";

    ws.onmessage = (event) => {
      if (typeof event.data === "string") {
        return;
      }

      if (event.data instanceof ArrayBuffer) {
        const chunk = new Uint8Array(event.data);
        chunks.push(chunk);
        totalBytes += chunk.byteLength;
      }
    };

    ws.onerror = () => reject(new Error("Socket page stream failed"));
    ws.onclose = () => {
      const merged = new Uint8Array(totalBytes);
      let offset = 0;
      for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.byteLength;
      }
      resolve(merged);
    };
  });
}

export interface UseVirtualScrollParams {
  preview: PreviewResponse | null;
  memoryGuardRef: React.RefObject<boolean>;
  onError: (msg: string) => void;
}

export function useVirtualScroll({ preview, memoryGuardRef, onError }: UseVirtualScrollParams) {
  const [loadedRows, setLoadedRows] = useState<Map<number, Array<string | null>>>(new Map());
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [inFlightPages, setInFlightPages] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);

  // Viewport resize
  useEffect(() => {
    const updateViewportHeight = () => {
      setViewportHeight(Math.max(MIN_VIEWPORT_HEIGHT, Math.floor(window.innerHeight * 0.62)));
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  const totalRows = preview?.total_rows ?? 0;
  const gridContentWidth = preview ? preview.schema.length * COLUMN_WIDTH : 0;
  const columnGridTemplate = preview ? `repeat(${preview.schema.length}, ${COLUMN_WIDTH}px)` : "";
  const visibleStart = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const visibleCount = Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2;
  const visibleEnd = Math.max(
    visibleStart,
    Math.min(totalRows - 1, visibleStart + visibleCount - 1),
  );

  const visibleIndices = useMemo(() => {
    const rows: number[] = [];
    for (let idx = visibleStart; idx <= visibleEnd; idx += 1) {
      rows.push(idx);
    }
    return rows;
  }, [visibleEnd, visibleStart]);

  const setRowsAtOffset = useCallback((rowOffset: number, rows: Array<Array<string | null>>) => {
    setLoadedRows((prev) => {
      const next = new Map(prev);
      rows.forEach((row, idx) => next.set(rowOffset + idx, row));
      return next;
    });
  }, []);

  const fetchPage = useCallback(
    async (pageIndex: number) => {
      if (memoryGuardRef.current) {
        return;
      }
      if (!preview || loadedPages.has(pageIndex) || inFlightPages.has(pageIndex)) {
        return;
      }

      setInFlightPages((prev) => new Set(prev).add(pageIndex));
      try {
        const rowOffset = pageIndex * PAGE_SIZE;
        const page = await invoke<ParquetRowsTransport>("fetch_parquet_rows_transport", {
          filePath: preview.file_path,
          rowOffset,
          rowLimit: PAGE_SIZE,
        });

        let payloadBytes: Uint8Array;
        if (page.mode === "ipc") {
          if (!page.ipc_payload) {
            throw new Error("Missing IPC payload for parquet page transport.");
          }
          payloadBytes = Uint8Array.from(page.ipc_payload);
        } else {
          if (!page.socket_url) {
            throw new Error("Missing socket URL for parquet page transport.");
          }
          payloadBytes = await readSocketPayload(page.socket_url);
        }

        const table = tableFromIPC(payloadBytes);
        const rows = Array.from(table).map((record) =>
          preview.schema.map((col) => {
            const value = (record as Record<string, unknown>)[col.name];
            return value === null || value === undefined ? null : String(value);
          }),
        );

        if (memoryGuardRef.current) {
          return;
        }
        setRowsAtOffset(page.row_offset, rows);
        setLoadedPages((prev) => new Set(prev).add(pageIndex));
      } catch (err) {
        onError(String(err));
      } finally {
        setInFlightPages((prev) => {
          const next = new Set(prev);
          next.delete(pageIndex);
          return next;
        });
      }
    },
    [inFlightPages, loadedPages, preview, setRowsAtOffset, memoryGuardRef, onError],
  );

  // Page fetch on visible range change
  useEffect(() => {
    if (!preview || totalRows === 0) {
      return;
    }

    const firstPage = Math.floor(visibleStart / PAGE_SIZE);
    const lastPage = Math.floor(visibleEnd / PAGE_SIZE);

    for (let page = firstPage; page <= lastPage; page += 1) {
      if (!loadedPages.has(page) && !inFlightPages.has(page)) {
        void fetchPage(page);
      }
    }
  }, [fetchPage, inFlightPages, loadedPages, preview, totalRows, visibleEnd, visibleStart]);

  function resetScroll() {
    setScrollTop(0);
    setScrollLeft(0);
    setLoadedPages(new Set());
    setInFlightPages(new Set());
    setLoadedRows(new Map());
  }

  function setInitialPage(data: PreviewResponse) {
    setScrollTop(0);
    setScrollLeft(0);
    setLoadedPages(new Set([0]));
    setInFlightPages(new Set());
    setLoadedRows(() => {
      const next = new Map<number, Array<string | null>>();
      data.rows.forEach((row, idx) => next.set(data.row_offset + idx, row));
      return next;
    });
  }

  return {
    loadedRows,
    scrollTop,
    scrollLeft,
    setScrollTop,
    setScrollLeft,
    viewportHeight,
    visibleIndices,
    totalRows,
    gridContentWidth,
    columnGridTemplate,
    resetScroll,
    setInitialPage,
    setInFlightPages,
    loadedPages,
    inFlightPages,
  } as const;
}
