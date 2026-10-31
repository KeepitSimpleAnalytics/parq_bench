import type { AppSettings } from "./types";

export const PAGE_SIZE = 256;
export const ROW_HEIGHT = 30;
export const MIN_VIEWPORT_HEIGHT = 320;
export const OVERSCAN = 8;
export const COLUMN_WIDTH = 180;
export const FIRST_VIEWPORT_TARGET_MS = 500;
export const PERSPECTIVE_READY_TARGET_MS = 3000;
export const ACCEPTANCE_GATE_TIMEOUT_MS = 15000;
export const PERSPECTIVE_RESTORE_TIMEOUT_DEFAULT_MS = 8000;
export const PERSPECTIVE_RESTORE_TIMEOUT_CHART_MS = 20000;

export const PARQUET_EXTENSIONS = ["parquet"];
export const DELIMITED_EXTENSIONS = ["csv", "tsv", "psv", "txt", "data"];
/** Every extension that can be mounted as a workspace table. Single source of truth for
 *  file pickers, drag-and-drop filtering and source-kind detection. */
export const WORKSPACE_EXTENSIONS = [...PARQUET_EXTENSIONS, ...DELIMITED_EXTENSIONS];
/** File types offered when mounting a folder of files (glob). */
export const WORKSPACE_FOLDER_FILE_TYPES: Array<{ ext: string; label: string }> = [
  { ext: "parquet", label: "Parquet (*.parquet)" },
  { ext: "csv", label: "CSV (*.csv)" },
  { ext: "tsv", label: "TSV (*.tsv)" },
  { ext: "psv", label: "Pipe-delimited (*.psv)" },
  { ext: "txt", label: "Text (*.txt)" },
  { ext: "data", label: "Data (*.data)" },
];

export const UI_THEME_STORAGE_KEY = "parqbench.ui.theme_mode";
export const UI_WORKSPACE_SLOW_MODE_STORAGE_KEY = "parqbench.ui.workspace_slow_mode_enabled";
export const UI_ACTIVE_TAB_STORAGE_KEY = "parqbench.ui.active_tab";
export const UI_RECENT_FILES_STORAGE_KEY = "parqbench.ui.recent_files";
export const UI_QUERY_HISTORY_STORAGE_KEY = "parqbench.ui.query_history";
export const UI_SETTINGS_STORAGE_KEY = "parqbench.ui.settings";
export const RECENT_FILES_MAX = 15;
export const QUERY_HISTORY_MAX = 50;

export const DEFAULT_SETTINGS: AppSettings = {
  sqlRowLimit: 200,
  perspectiveMaxRows: 5000,
  editorFontSize: 13,
  expandMode: "fullscreen",
  showPerspectiveConfigure: true,
  showVisualization: true,
  deepStats: false,
};

export const INTERNAL_TOOLS_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_PARQBENCH_INTERNAL_TOOLS === "1";
export const APP_VERSION: string = __APP_VERSION__;
export const PRODUCT_STAGE_LABEL = "Beta";
