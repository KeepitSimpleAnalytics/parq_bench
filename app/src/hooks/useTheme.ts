import { useEffect, useState } from "react";
import type { ThemeMode, ResolvedTheme } from "../types";
import { UI_THEME_STORAGE_KEY } from "../constants";
import { readThemeMode, resolveThemeMode } from "../utils";

export function useTheme() {
  const [themeMode, setThemeMode] = useState<ThemeMode>(() => readThemeMode());
  const [resolvedTheme, setResolvedTheme] = useState<ResolvedTheme>(() => resolveThemeMode(readThemeMode()));

  useEffect(() => {
    window.localStorage.setItem(UI_THEME_STORAGE_KEY, themeMode);
    if (themeMode === "light" || themeMode === "dark") {
      setResolvedTheme(themeMode);
      return;
    }
    const mediaQuery = window.matchMedia("(prefers-color-scheme: dark)");
    const applySystemTheme = () => setResolvedTheme(mediaQuery.matches ? "dark" : "light");
    applySystemTheme();
    mediaQuery.addEventListener("change", applySystemTheme);
    return () => mediaQuery.removeEventListener("change", applySystemTheme);
  }, [themeMode]);

  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolvedTheme);
  }, [resolvedTheme]);

  return { themeMode, resolvedTheme, setThemeMode } as const;
}
