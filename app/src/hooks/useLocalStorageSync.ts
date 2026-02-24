import { useEffect } from "react";

export function useLocalStorageSync(key: string, value: string) {
  useEffect(() => {
    window.localStorage.setItem(key, value);
  }, [key, value]);
}
