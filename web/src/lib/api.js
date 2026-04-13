export const API_BASE = import.meta.env.VITE_API_BASE ?? (window.location.port === "5197" ? "http://localhost:3001" : window.location.origin);

export async function fetchJson(url, options) {
  const response = await fetch(url, { cache: "no-store", ...options });
  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const errorMessage = payload.error
      || payload.reason
      || (Array.isArray(payload.errors) && payload.errors.length ? payload.errors.join(" ") : null)
      || `Request failed with status ${response.status}`;
    const error = new Error(errorMessage);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}
