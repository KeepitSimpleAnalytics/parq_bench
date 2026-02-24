import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RuntimeHealth } from "../types";

export function useRuntimeHealth() {
  const [runtimeHealth, setRuntimeHealth] = useState<RuntimeHealth | null>(null);
  const memoryGuardRef = useRef(false);

  async function refreshRuntimeHealth() {
    const health = await invoke<RuntimeHealth>("runtime_health");
    setRuntimeHealth(health);
    memoryGuardRef.current = health.memory_guard_tripped;
  }

  // Polling effect
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

  const memoryGuardActive = runtimeHealth?.memory_guard_tripped ?? false;

  return { runtimeHealth, memoryGuardActive, memoryGuardRef, refreshRuntimeHealth } as const;
}
