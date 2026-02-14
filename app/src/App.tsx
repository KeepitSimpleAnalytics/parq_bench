import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open, save } from "@tauri-apps/plugin-dialog";
import { tableFromIPC } from "apache-arrow";
import "./App.css";

const PAGE_SIZE = 256;
const ROW_HEIGHT = 30;
const MIN_VIEWPORT_HEIGHT = 320;
const OVERSCAN = 8;
const PERSPECTIVE_MAX_ROWS = 5000;
const COLUMN_WIDTH = 180;
const FIRST_VIEWPORT_TARGET_MS = 500;
const PERSPECTIVE_READY_TARGET_MS = 3000;
const ACCEPTANCE_GATE_TIMEOUT_MS = 15000;

type SmokeRow = {
  id: number;
  label: string;
};

type SmokeQueryResponse = {
  duckdb_version: string;
  rows: SmokeRow[];
};

type ArrowRow = {
  id: number;
  label: string;
};

type SocketServerInfo = {
  url: string;
  payload_bytes: number;
};

type BenchmarkResult = {
  mode: "ipc" | "socket";
  sizeMb: number;
  bytes: number;
  elapsedMs: number;
  throughputMbps: number;
};

type RuntimeHealth = {
  memory_guard_tripped: boolean;
  process_rss_bytes: number;
  total_memory_bytes: number;
  usage_ratio: number;
  message: string | null;
};

type PreviewColumn = {
  name: string;
  duckdb_type: string;
};

type PreviewResponse = {
  file_path: string;
  file_size_bytes: number;
  total_rows: number;
  row_offset: number;
  row_limit: number;
  schema: PreviewColumn[];
  rows: Array<Array<string | null>>;
};

type ParquetRowsTransport = {
  mode: "ipc" | "socket";
  payload_bytes: number;
  ipc_payload: number[] | null;
  socket_url: string | null;
  row_offset: number;
  row_limit: number;
  row_count: number;
};

type ViewMode = "virtual" | "perspective";
type PerspectiveStatus = "idle" | "loading" | "ready" | "error";
type GatePerspectiveStatus = "ready" | "error" | "timeout";

type AcceptanceGateReport = {
  filePath: string;
  evaluatedAt: string;
  firstViewportMs: number | null;
  perspectiveReadyMs: number | null;
  firstViewportPass: boolean;
  perspectivePass: boolean;
  perspectiveStatus: GatePerspectiveStatus;
  passed: boolean;
  details: string;
};

type ExportPayload = {
  exported_at: string;
  targets: {
    first_viewport_ms: number;
    perspective_ready_ms: number;
  };
  acceptance_gate: AcceptanceGateReport | null;
  benchmarks: BenchmarkResult[];
  latest_view: {
    file_path: string | null;
    first_viewport_ms: number | null;
    perspective_ready_ms: number | null;
    perspective_status: PerspectiveStatus;
    perspective_stage: string;
  };
};

function App() {
  const [result, setResult] = useState<SmokeQueryResponse | null>(null);
  const [arrowRows, setArrowRows] = useState<ArrowRow[]>([]);
  const [arrowBytes, setArrowBytes] = useState(0);
  const [benchmarks, setBenchmarks] = useState<BenchmarkResult[]>([]);
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [loadedRows, setLoadedRows] = useState<Map<number, Array<string | null>>>(new Map());
  const [loadedPages, setLoadedPages] = useState<Set<number>>(new Set());
  const [inFlightPages, setInFlightPages] = useState<Set<number>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>("virtual");
  const [perspectiveStatus, setPerspectiveStatus] = useState<PerspectiveStatus>("idle");
  const [perspectiveStage, setPerspectiveStage] = useState("idle");
  const [perspectiveError, setPerspectiveError] = useState<string | null>(null);
  const [perspectiveLoadedForFile, setPerspectiveLoadedForFile] = useState<string | null>(null);
  const [firstViewportMs, setFirstViewportMs] = useState<number | null>(null);
  const [perspectiveReadyMs, setPerspectiveReadyMs] = useState<number | null>(null);
  const [acceptanceGate, setAcceptanceGate] = useState<AcceptanceGateReport | null>(null);
  const [lastExportPath, setLastExportPath] = useState<string | null>(null);
  const perspectiveViewerRef = useRef<HTMLElement | null>(null);
  const perspectiveTableRef = useRef<{ delete?: () => Promise<void> | void } | null>(null);
  const memoryGuardRef = useRef(false);
  const openStartRef = useRef<number | null>(null);
  const perspectiveStatusRef = useRef<PerspectiveStatus>("idle");
  const perspectiveErrorRef = useRef<string | null>(null);
  const perspectiveReadyMsRef = useRef<number | null>(null);
  const perspectiveRuntimeInitRef = useRef<Promise<void> | null>(null);
  const perspectiveCoreRef = useRef<any>(null);

  async function withTimeout<T>(label: string, promise: Promise<T>, ms = 8000): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async function waitForNextPaint() {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  }

  async function sleepMs(ms: number) {
    await new Promise<void>((resolve) => setTimeout(resolve, ms));
  }

  async function pickParquetFile(): Promise<string | null> {
    const selected = await open({
      title: "Open Parquet File",
      multiple: false,
      filters: [{ name: "Parquet", extensions: ["parquet"] }],
    });

    if (!selected || Array.isArray(selected)) {
      return null;
    }
    return selected;
  }

  async function loadPreviewFromPath(filePath: string): Promise<number> {
    openStartRef.current = performance.now();
    setFirstViewportMs(null);
    setPerspectiveReadyMs(null);

    const data = await invoke<PreviewResponse>("preview_parquet", {
      filePath,
      rowLimit: PAGE_SIZE,
    });
    setPreview(data);
    setViewMode("virtual");
    setPerspectiveStatus("idle");
    setPerspectiveStage("idle");
    setPerspectiveError(null);
    setPerspectiveLoadedForFile(null);
    setScrollTop(0);
    setScrollLeft(0);
    setLoadedPages(new Set([0]));
    setInFlightPages(new Set());
    setLoadedRows(() => {
      const next = new Map<number, Array<string | null>>();
      data.rows.forEach((row, idx) => next.set(data.row_offset + idx, row));
      return next;
    });

    await waitForNextPaint();
    await waitForNextPaint();
    const elapsed = openStartRef.current === null ? 0 : performance.now() - openStartRef.current;
    setFirstViewportMs(elapsed);
    return elapsed;
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
        return { status: "ready", readyMs: perspectiveReadyMsRef.current, error: null };
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

  async function refreshRuntimeHealth() {
    const health = await invoke<RuntimeHealth>("runtime_health");
    setRuntimeHealth(health);
    memoryGuardRef.current = health.memory_guard_tripped;
  }

  function buildExportPayload(exportedAt: string): ExportPayload {
    return {
      exported_at: exportedAt,
      targets: {
        first_viewport_ms: FIRST_VIEWPORT_TARGET_MS,
        perspective_ready_ms: PERSPECTIVE_READY_TARGET_MS,
      },
      acceptance_gate: acceptanceGate,
      benchmarks,
      latest_view: {
        file_path: preview?.file_path ?? null,
        first_viewport_ms: firstViewportMs,
        perspective_ready_ms: perspectiveReadyMs,
        perspective_status: perspectiveStatus,
        perspective_stage: perspectiveStage,
      },
    };
  }

  function escapeCsvCell(value: string): string {
    if (value.includes(",") || value.includes("\"") || value.includes("\n")) {
      return `"${value.replace(/"/g, "\"\"")}"`;
    }
    return value;
  }

  function buildExportCsv(payload: ExportPayload): string {
    const rows: string[] = [];
    rows.push(
      [
        "category",
        "timestamp",
        "file_path",
        "mode",
        "size_mb",
        "bytes",
        "elapsed_ms",
        "throughput_mb_s",
        "first_viewport_ms",
        "first_viewport_target_ms",
        "first_viewport_pass",
        "perspective_ready_ms",
        "perspective_target_ms",
        "perspective_status",
        "perspective_pass",
        "gate_pass",
        "details",
      ].join(","),
    );

    if (payload.acceptance_gate) {
      rows.push(
        [
          "gate",
          payload.acceptance_gate.evaluatedAt,
          payload.acceptance_gate.filePath,
          "",
          "",
          "",
          "",
          "",
          payload.acceptance_gate.firstViewportMs === null
            ? ""
            : payload.acceptance_gate.firstViewportMs.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          String(payload.acceptance_gate.firstViewportPass),
          payload.acceptance_gate.perspectiveReadyMs === null
            ? ""
            : payload.acceptance_gate.perspectiveReadyMs.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          payload.acceptance_gate.perspectiveStatus,
          String(payload.acceptance_gate.perspectivePass),
          String(payload.acceptance_gate.passed),
          payload.acceptance_gate.details,
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );
    }

    for (const entry of payload.benchmarks) {
      rows.push(
        [
          "benchmark",
          payload.exported_at,
          payload.latest_view.file_path ?? "",
          entry.mode,
          String(entry.sizeMb),
          String(entry.bytes),
          entry.elapsedMs.toFixed(3),
          entry.throughputMbps.toFixed(3),
          payload.latest_view.first_viewport_ms === null
            ? ""
            : payload.latest_view.first_viewport_ms.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          "",
          payload.latest_view.perspective_ready_ms === null
            ? ""
            : payload.latest_view.perspective_ready_ms.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          payload.latest_view.perspective_status,
          "",
          "",
          "",
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );
    }

    return rows.join("\n");
  }

  async function exportResults(format: "json" | "csv") {
    setLoading(true);
    setError(null);

    try {
      const exportedAt = new Date().toISOString();
      const payload = buildExportPayload(exportedAt);
      const stamp = exportedAt.replace(/[:.]/g, "-");
      const selected = await save({
        title: `Export Results (${format.toUpperCase()})`,
        defaultPath: `parq_bench_results_${stamp}.${format}`,
        filters: [
          {
            name: format.toUpperCase(),
            extensions: [format],
          },
        ],
      });

      if (!selected) {
        return;
      }

      const contents = format === "json" ? JSON.stringify(payload, null, 2) : buildExportCsv(payload);
      await invoke("write_text_report", { path: selected, contents });
      setLastExportPath(selected);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    const updateViewportHeight = () => {
      setViewportHeight(Math.max(MIN_VIEWPORT_HEIGHT, Math.floor(window.innerHeight * 0.62)));
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    return () => window.removeEventListener("resize", updateViewportHeight);
  }, []);

  useEffect(() => {
    let cancelled = false;

    const poll = async () => {
      try {
        const health = await invoke<RuntimeHealth>("runtime_health");
        if (!cancelled) {
          setRuntimeHealth(health);
          memoryGuardRef.current = health.memory_guard_tripped;
        }
      } catch {
        // runtime health polling is best-effort
      }
    };

    void poll();
    const id = window.setInterval(() => {
      void poll();
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  useEffect(() => {
    perspectiveStatusRef.current = perspectiveStatus;
  }, [perspectiveStatus]);

  useEffect(() => {
    perspectiveErrorRef.current = perspectiveError;
  }, [perspectiveError]);

  useEffect(() => {
    perspectiveReadyMsRef.current = perspectiveReadyMs;
  }, [perspectiveReadyMs]);

  async function runSmokeQuery() {
    const response = await invoke<SmokeQueryResponse>("duckdb_smoke_query");
    setResult(response);
  }

  async function runArrowIpcSmoke() {
    const payload = await invoke<number[]>("arrow_ipc_smoke_batch");
    const bytes = Uint8Array.from(payload);
    const table = tableFromIPC(bytes);
    const rows = Array.from(table).map((row) => ({
      id: Number(row.id),
      label: String(row.label),
    }));

    setArrowBytes(bytes.byteLength);
    setArrowRows(rows);
  }

  async function runIpcBenchmark(sizeMb: number): Promise<BenchmarkResult> {
    const start = performance.now();
    const payload = await invoke<number[]>("arrow_ipc_payload", { sizeMb });
    const elapsedMs = performance.now() - start;
    const bytes = payload.length;
    const throughputMbps = bytes / (1024 * 1024) / (elapsedMs / 1000);

    return { mode: "ipc", sizeMb, bytes, elapsedMs, throughputMbps };
  }

  async function runSocketBenchmark(sizeMb: number): Promise<BenchmarkResult> {
    const server = await invoke<SocketServerInfo>("start_arrow_socket_server", {
      sizeMb,
    });

    const start = performance.now();
    const bytes = await new Promise<number>((resolve, reject) => {
      let received = 0;
      const ws = new WebSocket(server.url);
      ws.binaryType = "arraybuffer";

      ws.onmessage = (event) => {
        if (typeof event.data === "string") {
          return;
        }

        if (event.data instanceof ArrayBuffer) {
          received += event.data.byteLength;
        }
      };

      ws.onerror = () => reject(new Error("Socket benchmark connection failed"));
      ws.onclose = () => resolve(received);
    });

    const elapsedMs = performance.now() - start;
    const throughputMbps = bytes / (1024 * 1024) / (elapsedMs / 1000);

    return { mode: "socket", sizeMb, bytes, elapsedMs, throughputMbps };
  }

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

  async function runTransportBenchmarks() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; transport benchmark is blocked.");
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const ipc = await runIpcBenchmark(16);
      const socket = await runSocketBenchmark(64);
      setBenchmarks([ipc, socket]);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

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
        setError(String(err));
      } finally {
        setInFlightPages((prev) => {
          const next = new Set(prev);
          next.delete(pageIndex);
          return next;
        });
      }
    },
    [inFlightPages, loadedPages, preview, setRowsAtOffset],
  );

  async function openParquetPreview() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError(
        "Memory panic circuit is active. Close other memory-heavy apps or reduce workload before opening more data.",
      );
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const selected = await pickParquetFile();
      if (!selected) {
        return;
      }
      await loadPreviewFromPath(selected);
    } catch (err) {
      setError(String(err));
    } finally {
      setLoading(false);
    }
  }

  async function runAcceptanceGate() {
    await refreshRuntimeHealth();
    if (memoryGuardRef.current) {
      setError("Memory panic circuit is active; acceptance gate is blocked.");
      return;
    }

    setLoading(true);
    setError(null);
    setAcceptanceGate(null);

    try {
      let targetFile = preview?.file_path ?? null;
      if (!targetFile) {
        targetFile = await pickParquetFile();
      }
      if (!targetFile) {
        return;
      }

      const firstMs = await loadPreviewFromPath(targetFile);
      const perspectiveResult = await waitForPerspectiveResult(ACCEPTANCE_GATE_TIMEOUT_MS);
      const firstViewportPass = firstMs <= FIRST_VIEWPORT_TARGET_MS;
      const perspectivePass =
        perspectiveResult.status === "ready" &&
        perspectiveResult.readyMs !== null &&
        perspectiveResult.readyMs <= PERSPECTIVE_READY_TARGET_MS;
      const passed = firstViewportPass && perspectivePass;

      setAcceptanceGate({
        filePath: targetFile,
        evaluatedAt: new Date().toISOString(),
        firstViewportMs: firstMs,
        perspectiveReadyMs: perspectiveResult.readyMs,
        firstViewportPass,
        perspectivePass,
        perspectiveStatus: perspectiveResult.status,
        passed,
        details: perspectiveResult.error ?? "",
      });
    } catch (err) {
      const message = String(err);
      setError(message);
      setAcceptanceGate({
        filePath: preview?.file_path ?? "unknown",
        evaluatedAt: new Date().toISOString(),
        firstViewportMs: firstViewportMs,
        perspectiveReadyMs: perspectiveReadyMs,
        firstViewportPass: firstViewportMs !== null && firstViewportMs <= FIRST_VIEWPORT_TARGET_MS,
        perspectivePass: false,
        perspectiveStatus: "error",
        passed: false,
        details: message,
      });
    } finally {
      setLoading(false);
    }
  }

  const totalRows = preview?.total_rows ?? 0;
  const canExportResults = true;
  const memoryGuardActive = runtimeHealth?.memory_guard_tripped ?? false;
  const memoryUsagePct = runtimeHealth ? runtimeHealth.usage_ratio * 100 : null;
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

  useEffect(() => {
    if (runtimeHealth?.memory_guard_tripped) {
      setInFlightPages(new Set());
      if (runtimeHealth.message) {
        setError(runtimeHealth.message);
      }
    }
  }, [runtimeHealth]);

  useEffect(() => {
    if (!preview || perspectiveLoadedForFile === preview.file_path || perspectiveStatus !== "idle") {
      return;
    }

    const rowIndexes = Array.from(loadedRows.keys())
      .sort((a, b) => a - b)
      .slice(0, PERSPECTIVE_MAX_ROWS);

    if (rowIndexes.length === 0) {
      return;
    }

    const initPerspective = async () => {
      let stage = "imports";
      setPerspectiveStatus("loading");
      setPerspectiveStage(stage);
      setPerspectiveError(null);

      try {
        if (!perspectiveRuntimeInitRef.current) {
          perspectiveRuntimeInitRef.current = (async () => {
            const perspective = await withTimeout("perspective core import", import("@finos/perspective"));
            const perspectiveViewer = await withTimeout(
              "perspective-viewer import",
              import("@finos/perspective-viewer"),
            );
            const perspectiveServerWasmUrl = (
              await withTimeout(
                "perspective-server wasm url",
                import("@finos/perspective/dist/wasm/perspective-server.wasm?url"),
              )
            ).default;
            stage = "core.init_server";
            setPerspectiveStage(stage);
            await withTimeout(
              "perspective init_server()",
              Promise.resolve(perspective.init_server(fetch(perspectiveServerWasmUrl))),
            );
            const viewerWasmUrl = (
              await withTimeout(
                "perspective-viewer wasm url",
                import("@finos/perspective-viewer/dist/wasm/perspective-viewer.wasm?url"),
              )
            ).default;
            stage = "viewer.init_client";
            setPerspectiveStage(stage);
            await withTimeout(
              "perspective-viewer init_client()",
              perspectiveViewer.init_client(fetch(viewerWasmUrl)),
            );
            stage = "datagrid.import";
            setPerspectiveStage(stage);
            await withTimeout(
              "perspective-viewer-datagrid import",
              import("@finos/perspective-viewer-datagrid"),
            );
            stage = "custom-element";
            setPerspectiveStage(stage);
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
        const perspective = perspectiveCoreRef.current;
        if (!perspective) {
          throw new Error("Perspective runtime is unavailable after initialization.");
        }

        const viewer = perspectiveViewerRef.current as
          | (HTMLElement & {
              load?: (table: unknown) => Promise<void>;
              restore?: (config: unknown) => Promise<void>;
            })
          | null;

        if (!viewer || !viewer.load || !viewer.restore) {
          throw new Error("Perspective viewer did not initialize.");
        }

        if (perspectiveTableRef.current?.delete) {
          await perspectiveTableRef.current.delete();
          perspectiveTableRef.current = null;
        }

        const dataset = rowIndexes.map((rowIndex) => {
          const row = loadedRows.get(rowIndex) ?? [];
          const item: Record<string, string | null> = {};
          preview.schema.forEach((col, colIndex) => {
            item[col.name] = row[colIndex] ?? null;
          });
          return item;
        });

        stage = "worker";
        setPerspectiveStage(stage);
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
        await withTimeout("viewer.restore()", viewer.restore({ plugin: "Datagrid" }));

        setPerspectiveStatus("ready");
        setPerspectiveStage("ready");
        setPerspectiveLoadedForFile(preview.file_path);
        if (openStartRef.current !== null) {
          setPerspectiveReadyMs(performance.now() - openStartRef.current);
        }
        setViewMode("perspective");
      } catch (err) {
        setPerspectiveStatus("error");
        setPerspectiveStage("error");
        setPerspectiveError(`stage=${stage} ${String(err)}`);
        setViewMode("virtual");
      }
    };

    void initPerspective();
  }, [loadedRows, perspectiveLoadedForFile, perspectiveStatus, preview]);

  useEffect(() => {
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        await runSmokeQuery();
        await runArrowIpcSmoke();
      } catch (err) {
        setError(String(err));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <main className="app-shell">
      <header className="topbar">
        <h1>Parq-Bench</h1>
        <span className="phase">Phase 1 Viewer</span>
      </header>

      <section className="card">
        <div className="actions">
          <button type="button" onClick={() => void openParquetPreview()} disabled={loading || memoryGuardActive}>
            Open Parquet
          </button>
          <button type="button" onClick={() => void runAcceptanceGate()} disabled={loading || memoryGuardActive}>
            {loading ? "Running..." : "Run Acceptance Gate"}
          </button>
          <button
            type="button"
            onClick={() =>
              void (async () => {
                setLoading(true);
                setError(null);
                try {
                  await runSmokeQuery();
                  await runArrowIpcSmoke();
                  await runTransportBenchmarks();
                } catch (err) {
                  setError(String(err));
                } finally {
                  setLoading(false);
                }
              })()
            }
            disabled={loading || memoryGuardActive}
          >
            {loading ? "Running..." : "Run Smoke Checks"}
          </button>
          <button type="button" onClick={() => void exportResults("json")} disabled={loading || !canExportResults}>
            Export JSON
          </button>
          <button type="button" onClick={() => void exportResults("csv")} disabled={loading || !canExportResults}>
            Export CSV
          </button>
          {preview ? (
            <>
              <button
                type="button"
                onClick={() => setViewMode("virtual")}
                disabled={viewMode === "virtual"}
              >
                Virtual View
              </button>
              <button
                type="button"
                onClick={() => setViewMode("perspective")}
                disabled={perspectiveStatus !== "ready" || viewMode === "perspective"}
              >
                Perspective View
              </button>
            </>
          ) : null}
          {result ? <span>DuckDB {result.duckdb_version}</span> : null}
          {arrowBytes > 0 ? <span>Arrow IPC {arrowBytes} bytes</span> : null}
          {lastExportPath ? (
            <span className="path-text" title={lastExportPath}>
              Exported: {lastExportPath}
            </span>
          ) : null}
        </div>

        {runtimeHealth ? (
          <div className={memoryGuardActive ? "health-banner health-bad" : "health-banner"}>
            Memory usage: {memoryUsagePct?.toFixed(1)}%
            {runtimeHealth.message ? ` | ${runtimeHealth.message}` : ""}
          </div>
        ) : null}

        {acceptanceGate ? (
          <div className={acceptanceGate.passed ? "gate-report gate-pass" : "gate-report gate-fail"}>
            Gate {acceptanceGate.passed ? "PASS" : "FAIL"} | First viewport:{" "}
            {acceptanceGate.firstViewportMs === null ? "n/a" : `${acceptanceGate.firstViewportMs.toFixed(0)}ms`} |{" "}
            Perspective:{" "}
            {acceptanceGate.perspectiveReadyMs === null
              ? acceptanceGate.perspectiveStatus
              : `${acceptanceGate.perspectiveReadyMs.toFixed(0)}ms (${acceptanceGate.perspectiveStatus})`}{" "}
            | File: {acceptanceGate.filePath}
            {acceptanceGate.details ? ` | Detail: ${acceptanceGate.details}` : ""}
          </div>
        ) : null}

        {error ? <p className="error">{error}</p> : null}

        {preview ? (
          <>
            <h3>Parquet Preview</h3>
            <p className="meta-line">
              <span className="path-text" title={preview.file_path}>
                <strong>Path:</strong> {preview.file_path}
              </span>
              <span>
                <strong>Size:</strong> {(preview.file_size_bytes / (1024 * 1024)).toFixed(2)} MB
              </span>
              <span>
                <strong>Rows:</strong> {preview.total_rows.toLocaleString()}
              </span>
              <span>
                <strong>Columns:</strong> {preview.schema.length}
              </span>
              <span>
                <strong>Renderer:</strong> {viewMode}
              </span>
              <span>
                <strong>Perspective:</strong> {perspectiveStatus}
              </span>
              <span>
                <strong>Stage:</strong> {perspectiveStage}
              </span>
            </p>
            <div className="metrics-line">
              <span
                className={
                  firstViewportMs === null
                    ? "metric-chip"
                    : firstViewportMs <= FIRST_VIEWPORT_TARGET_MS
                      ? "metric-chip metric-good"
                      : "metric-chip metric-bad"
                }
              >
                First viewport:{" "}
                {firstViewportMs === null
                  ? "pending"
                  : `${firstViewportMs.toFixed(0)}ms / target ${FIRST_VIEWPORT_TARGET_MS}ms`}
              </span>
              <span
                className={
                  perspectiveReadyMs === null
                    ? "metric-chip"
                    : perspectiveReadyMs <= PERSPECTIVE_READY_TARGET_MS
                      ? "metric-chip metric-good"
                      : "metric-chip metric-bad"
                }
              >
                Perspective ready:{" "}
                {perspectiveReadyMs === null
                  ? "pending"
                  : `${perspectiveReadyMs.toFixed(0)}ms / target ${PERSPECTIVE_READY_TARGET_MS}ms`}
              </span>
            </div>
            {perspectiveError ? <p className="error">Perspective error: {perspectiveError}</p> : null}

            {viewMode === "virtual" ? (
              <>
                <div className="virtual-header-track">
                  <div
                    className="virtual-header-row"
                    style={{
                      gridTemplateColumns: columnGridTemplate,
                      width: `${gridContentWidth}px`,
                      transform: `translateX(-${scrollLeft}px)`,
                    }}
                  >
                    {preview.schema.map((col) => (
                      <div
                        key={col.name}
                        className="virtual-cell virtual-cell-head"
                        title={col.duckdb_type}
                      >
                        {col.name}
                      </div>
                    ))}
                  </div>
                </div>
                <div
                  className="virtual-grid"
                  style={{ height: `${viewportHeight}px` }}
                  onScroll={(event) => {
                    setScrollTop(event.currentTarget.scrollTop);
                    setScrollLeft(event.currentTarget.scrollLeft);
                  }}
                >
                  <div
                    className="virtual-spacer"
                    style={{ height: `${totalRows * ROW_HEIGHT}px`, width: `${gridContentWidth}px` }}
                  >
                    {visibleIndices.map((index) => {
                      const row = loadedRows.get(index);
                      return (
                        <div
                          key={`virtual-row-${index}`}
                          className="virtual-row"
                          style={{
                            top: `${index * ROW_HEIGHT}px`,
                            height: `${ROW_HEIGHT}px`,
                            width: `${gridContentWidth}px`,
                            gridTemplateColumns: columnGridTemplate,
                          }}
                        >
                          {preview.schema.map((col, colIndex) => (
                            <div
                              key={`virtual-cell-${index}-${col.name}`}
                              className="virtual-cell"
                              title={row?.[colIndex] ?? "NULL"}
                            >
                              {row ? (row[colIndex] ?? "NULL") : "..."}
                            </div>
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
              </>
            ) : null}
            <div
              className={viewMode === "perspective" ? "perspective-wrap" : "perspective-wrap hidden"}
              style={{ height: `${viewportHeight}px` }}
            >
              <perspective-viewer ref={perspectiveViewerRef} className="perspective-viewer" />
            </div>
          </>
        ) : null}

        <details className="diagnostics">
          <summary>Diagnostics</summary>
          <h3>Arrow IPC Decode</h3>
          <table>
            <thead>
              <tr>
                <th>ID</th>
                <th>Label</th>
              </tr>
            </thead>
            <tbody>
              {arrowRows.map((row) => (
                <tr key={`arrow-${row.id}`}>
                  <td>{row.id}</td>
                  <td>{row.label}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <h3>Transport Benchmarks</h3>
          <table>
            <thead>
              <tr>
                <th>Mode</th>
                <th>Payload</th>
                <th>Bytes</th>
                <th>Time (ms)</th>
                <th>Throughput (MB/s)</th>
              </tr>
            </thead>
            <tbody>
              {benchmarks.map((entry) => (
                <tr key={entry.mode}>
                  <td>{entry.mode}</td>
                  <td>{entry.sizeMb} MB</td>
                  <td>{entry.bytes.toLocaleString()}</td>
                  <td>{entry.elapsedMs.toFixed(1)}</td>
                  <td>{entry.throughputMbps.toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      </section>
    </main>
  );
}

export default App;
