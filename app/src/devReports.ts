import type { ExportPayload } from "./types";
import { FIRST_VIEWPORT_TARGET_MS, PERSPECTIVE_READY_TARGET_MS } from "./constants";
import { escapeCsvCell } from "./utils";

/** CSV form of the internal acceptance-gate / benchmark report (dev builds only). */
export function buildExportCsv(payload: ExportPayload): string {
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

  if (payload.perf_sweep) {
    rows.push(
      [
        "perf_sweep_summary",
        payload.perf_sweep.evaluatedAt,
        payload.perf_sweep.filePath,
        "",
        "",
        "",
        "",
        "",
        payload.perf_sweep.firstViewportP95 === null
          ? ""
          : payload.perf_sweep.firstViewportP95.toFixed(3),
        String(FIRST_VIEWPORT_TARGET_MS),
        String(payload.perf_sweep.passCount === payload.perf_sweep.completedRuns),
        payload.perf_sweep.perspectiveReadyP95 === null
          ? ""
          : payload.perf_sweep.perspectiveReadyP95.toFixed(3),
        String(PERSPECTIVE_READY_TARGET_MS),
        payload.perf_sweep.failCount === 0 ? "ready" : "error",
        String(payload.perf_sweep.failCount === 0),
        String(payload.perf_sweep.failCount === 0),
        `runs=${payload.perf_sweep.completedRuns}/${payload.perf_sweep.runCount}; pass=${payload.perf_sweep.passCount}; fail=${payload.perf_sweep.failCount}; first_p50=${payload.perf_sweep.firstViewportP50?.toFixed(1) ?? "n/a"}; perspective_p50=${payload.perf_sweep.perspectiveReadyP50?.toFixed(1) ?? "n/a"}`,
      ]
        .map((cell) => escapeCsvCell(String(cell)))
        .join(","),
    );

    payload.perf_sweep.runs.forEach((run) => {
      rows.push(
        [
          "perf_sweep_run",
          run.evaluatedAt,
          run.filePath,
          "",
          "",
          "",
          "",
          "",
          run.firstViewportMs === null ? "" : run.firstViewportMs.toFixed(3),
          String(FIRST_VIEWPORT_TARGET_MS),
          String(run.firstViewportPass),
          run.perspectiveReadyMs === null ? "" : run.perspectiveReadyMs.toFixed(3),
          String(PERSPECTIVE_READY_TARGET_MS),
          run.perspectiveStatus,
          String(run.perspectivePass),
          String(run.passed),
          run.details,
        ]
          .map((cell) => escapeCsvCell(String(cell)))
          .join(","),
      );
    });
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
