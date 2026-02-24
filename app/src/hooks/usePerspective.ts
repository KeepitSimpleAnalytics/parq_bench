import { useState, useRef, useEffect } from "react";
import type {
  PerspectiveStatus,
  PerspectiveContext,
  GatePerspectiveStatus,
  PreviewResponse,
  AppSettings,
  ViewMode,
} from "../types";
import {
  withTimeout,
  waitForNextPaint,
  sleepMs,
  perspectiveRestoreTimeoutMs,
} from "../utils";

interface UsePerspectiveParams {
  preview: PreviewResponse | null;
  loadedRows: Map<number, Array<string | null>>;
  firstViewportMs: number | null;
  openStartRef: React.MutableRefObject<number | null>;
  settings: AppSettings;
  onError: (error: string) => void;
  onViewModeChange: (mode: ViewMode) => void;
}

export function usePerspective({
  preview,
  loadedRows,
  firstViewportMs,
  openStartRef,
  settings,
  onError,
  onViewModeChange,
}: UsePerspectiveParams) {
  const [perspectiveStatus, setPerspectiveStatus] = useState<PerspectiveStatus>("idle");
  const [perspectiveStage, setPerspectiveStage] = useState("idle");
  const [perspectiveError, setPerspectiveError] = useState<string | null>(null);
  const [perspectiveContext, setPerspectiveContext] = useState<PerspectiveContext>("preview");
  const [perspectiveLoadedForFile, setPerspectiveLoadedForFile] = useState<string | null>(null);
  const [perspectiveReadyMs, setPerspectiveReadyMs] = useState<number | null>(null);

  const perspectiveViewerRef = useRef<HTMLElement | null>(null);
  const perspectiveTableRef = useRef<{ delete?: () => Promise<void> | void } | null>(null);
  const perspectiveStatusRef = useRef<PerspectiveStatus>("idle");
  const perspectiveErrorRef = useRef<string | null>(null);
  const perspectiveReadyMsRef = useRef<number | null>(null);
  const perspectiveRuntimeInitRef = useRef<Promise<void> | null>(null);
  // Perspective module doesn't ship comprehensive TS types; typed as unknown
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const perspectiveCoreRef = useRef<any>(null);

  // Ref sync effects
  useEffect(() => { perspectiveStatusRef.current = perspectiveStatus; }, [perspectiveStatus]);
  useEffect(() => { perspectiveErrorRef.current = perspectiveError; }, [perspectiveError]);
  useEffect(() => { perspectiveReadyMsRef.current = perspectiveReadyMs; }, [perspectiveReadyMs]);

  function resolvePerspectiveContext(preferred?: PerspectiveContext): PerspectiveContext | null {
    if (preferred === "preview" || preferred === "workspace") {
      return preferred;
    }
    return "preview";
  }

  function resetPerspective() {
    perspectiveStatusRef.current = "idle";
    perspectiveReadyMsRef.current = null;
    perspectiveErrorRef.current = null;
    setPerspectiveStatus("idle");
    setPerspectiveStage("idle");
    setPerspectiveError(null);
    setPerspectiveLoadedForFile(null);
    setPerspectiveReadyMs(null);
    setPerspectiveContext("preview");
  }

  async function waitForPerspectiveViewerReady(timeoutMs = 3000): Promise<
    HTMLElement & {
      load: (table: unknown) => Promise<void>;
      restore: (config: unknown) => Promise<void>;
    }
  > {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const viewer = perspectiveViewerRef.current as
        | (HTMLElement & {
            load?: (table: unknown) => Promise<void>;
            restore?: (config: unknown) => Promise<void>;
          })
        | null;
      if (viewer && typeof viewer.load === "function" && typeof viewer.restore === "function") {
        return viewer as HTMLElement & {
          load: (table: unknown) => Promise<void>;
          restore: (config: unknown) => Promise<void>;
        };
      }
      await waitForNextPaint();
    }
    throw new Error("Perspective viewer did not initialize.");
  }

  async function ensurePerspectiveRuntime(setStage: (stage: string) => void) {
    if (!perspectiveRuntimeInitRef.current) {
      perspectiveRuntimeInitRef.current = (async () => {
        // Stage 1: parallel import of all independent modules + WASM URLs
        const [perspective, perspectiveViewer, serverWasmMod, viewerWasmMod] = await withTimeout(
          "perspective parallel imports",
          Promise.all([
            import("@finos/perspective"),
            import("@finos/perspective-viewer"),
            import("@finos/perspective/dist/wasm/perspective-server.wasm?url"),
            import("@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url"),
          ]),
        );
        // Stage 2: init server + init client in parallel (independent of each other)
        setStage("core.init");
        await withTimeout(
          "perspective init_server + init_client",
          Promise.all([
            Promise.resolve(perspective.init_server(fetch(serverWasmMod.default))),
            perspectiveViewer.init_client(fetch(viewerWasmMod.default)),
          ]),
        );
        // Stage 3: register plugins in parallel
        setStage("plugins.import");
        await withTimeout(
          "perspective plugins import",
          Promise.all([
            import("@finos/perspective-viewer-datagrid"),
            import("@finos/perspective-viewer-d3fc"),
          ]),
        );
        setStage("custom-element");
        await withTimeout(
          "perspective-viewer define",
          customElements.whenDefined("perspective-viewer"),
        );
        perspectiveCoreRef.current = perspective;
      })().catch((err) => {
        perspectiveRuntimeInitRef.current = null;
        throw err;
      });
    }
    await withTimeout("perspective runtime init", perspectiveRuntimeInitRef.current);
  }

  async function loadPerspectiveDataset(
    dataset: Array<Record<string, unknown>>,
    restoreConfig: Record<string, unknown>,
    options?: { loadedForFile?: string; trackOpenTiming?: boolean; context?: PerspectiveContext },
  ) {
    let stage = "runtime";
    setPerspectiveStatus("loading");
    setPerspectiveStage(stage);
    setPerspectiveError(null);

    try {
      if (dataset.length === 0) {
        throw new Error("No rows available to visualize.");
      }
      const targetContext = resolvePerspectiveContext(options?.context);
      if (!targetContext) {
        throw new Error("Perspective viewer unavailable in current layout. Add Preview or Workspace tab.");
      }
      if (perspectiveContext !== targetContext) {
        setPerspectiveContext(targetContext);
        await waitForNextPaint();
      }

      await ensurePerspectiveRuntime((next) => {
        stage = next;
        setPerspectiveStage(next);
      });

      const perspective = perspectiveCoreRef.current;
      if (!perspective) {
        throw new Error("Perspective runtime is unavailable after initialization.");
      }

      stage = "viewer.ready";
      setPerspectiveStage(stage);
      const viewer = await withTimeout("viewer.ready()", waitForPerspectiveViewerReady(), 5000);

      const previousTable = perspectiveTableRef.current;

      stage = "worker";
      setPerspectiveStage(stage);
      // Perspective worker API is untyped; see https://perspective.finos.org/docs/js/
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const worker: any = await withTimeout("perspective worker()", perspective.worker());
      stage = "table";
      setPerspectiveStage(stage);
      const table = await withTimeout("worker.table()", worker.table(dataset));
      perspectiveTableRef.current = table as { delete?: () => Promise<void> | void };
      stage = "viewer.load";
      setPerspectiveStage(stage);
      await withTimeout("viewer.load()", viewer.load(table));
      stage = "viewer.restore";
      setPerspectiveStage(stage);
      const restoreTimeoutMs = perspectiveRestoreTimeoutMs(restoreConfig);
      try {
        await withTimeout("viewer.restore()", viewer.restore(restoreConfig), restoreTimeoutMs);
      } catch (restoreErr) {
        const restoreMessage = String(restoreErr);
        if (!restoreMessage.includes("View not found")) {
          throw restoreErr;
        }
        stage = "viewer.restore.retry";
        setPerspectiveStage(stage);
        await waitForNextPaint();
        await withTimeout("viewer.restore(retry)", viewer.restore(restoreConfig), restoreTimeoutMs);
      }
      if (previousTable?.delete) {
        try {
          await previousTable.delete();
        } catch (cleanupErr) {
          const message = String(cleanupErr);
          if (!message.includes("Cannot delete table with views")) {
            throw cleanupErr;
          }
        }
      }

      setPerspectiveStatus("ready");
      setPerspectiveStage("ready");
      if (options?.loadedForFile) {
        setPerspectiveLoadedForFile(options.loadedForFile);
      }
      if (options?.trackOpenTiming && openStartRef.current !== null) {
        setPerspectiveReadyMs(performance.now() - openStartRef.current);
      }
      onViewModeChange("perspective");
    } catch (err) {
      const plugin = String(restoreConfig.plugin ?? "");
      const timeoutHint =
        stage === "viewer.restore" && String(err).includes("timed out")
          ? ` Try a lower-cardinality X column or reduce row count before using ${plugin}.`
          : "";
      setPerspectiveStatus("error");
      setPerspectiveStage("error");
      setPerspectiveError(`stage=${stage} ${String(err)}${timeoutHint}`);
      onError(`Perspective error: stage=${stage} ${String(err)}${timeoutHint}`);
      onViewModeChange("virtual");
    }
  }

  async function waitForPerspectiveResult(timeoutMs: number): Promise<{
    status: GatePerspectiveStatus;
    readyMs: number | null;
    error: string | null;
  }> {
    const started = performance.now();
    while (performance.now() - started < timeoutMs) {
      const status = perspectiveStatusRef.current;
      if (status === "ready") {
        const readyMs = perspectiveReadyMsRef.current;
        if (readyMs !== null) {
          return { status: "ready", readyMs, error: null };
        }
      }
      if (status === "error") {
        return {
          status: "error",
          readyMs: perspectiveReadyMsRef.current,
          error: perspectiveErrorRef.current,
        };
      }
      await sleepMs(100);
    }
    return { status: "timeout", readyMs: perspectiveReadyMsRef.current, error: "Perspective timeout" };
  }

  // Auto-load Perspective from preview data
  useEffect(() => {
    if (
      !preview ||
      firstViewportMs === null ||
      perspectiveLoadedForFile === preview.file_path ||
      perspectiveStatus !== "idle"
    ) {
      return;
    }

    const rowIndexes = Array.from(loadedRows.keys())
      .sort((a, b) => a - b)
      .slice(0, settings.perspectiveMaxRows);

    if (rowIndexes.length === 0) {
      return;
    }

    const dataset = rowIndexes.map((rowIndex) => {
      const row = loadedRows.get(rowIndex) ?? [];
      const item: Record<string, string | null> = {};
      preview.schema.forEach((col, colIndex) => {
        item[col.name] = row[colIndex] ?? null;
      });
      return item;
    });

    void loadPerspectiveDataset(dataset, { plugin: "Datagrid" }, {
      loadedForFile: preview.file_path,
      trackOpenTiming: true,
      context: "preview",
    });
  }, [firstViewportMs, loadedRows, perspectiveLoadedForFile, perspectiveStatus, preview]);

  // Hide/show Perspective's built-in configure (settings) button via shadow DOM style injection
  // Only runs after Perspective has fully loaded to avoid layout interference
  useEffect(() => {
    if (perspectiveStatus !== "ready") return;
    const viewer = perspectiveViewerRef.current;
    if (!viewer) return;
    const shadow = viewer.shadowRoot;
    if (!shadow) return;
    const styleId = "parqbench-hide-configure";
    let styleEl = shadow.getElementById(styleId) as HTMLStyleElement | null;
    if (!settings.showPerspectiveConfigure) {
      if (!styleEl) {
        styleEl = document.createElement("style");
        styleEl.id = styleId;
        styleEl.textContent = "#settings_button { display: none !important; }";
        shadow.appendChild(styleEl);
      }
    } else {
      if (styleEl) styleEl.remove();
    }
  }, [settings.showPerspectiveConfigure, perspectiveStatus]);

  return {
    perspectiveStatus,
    perspectiveStage,
    perspectiveError,
    perspectiveContext,
    perspectiveReadyMs,
    perspectiveLoadedForFile,
    perspectiveViewerRef,
    loadPerspectiveDataset,
    waitForPerspectiveResult,
    resetPerspective,
  };
}
