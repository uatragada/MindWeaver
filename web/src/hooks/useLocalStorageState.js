import { useEffect, useState } from "react";

function readStoredJson(key, fallbackValue) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallbackValue;
  } catch {
    return fallbackValue;
  }
}

export function useLocalStorageState(key, initialValue) {
  const [state, setState] = useState(() => {
    const fallbackValue = typeof initialValue === "function" ? initialValue() : initialValue;
    return readStoredJson(key, fallbackValue);
  });

  useEffect(() => {
    window.localStorage.setItem(key, JSON.stringify(state));
  }, [key, state]);

  return [state, setState];
}
