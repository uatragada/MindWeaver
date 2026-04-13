import { useCallback, useEffect, useState } from "react";

function getSessionIdFromLocation() {
  return new URLSearchParams(window.location.search).get("sessionId");
}

function buildSessionUrl(sessionId) {
  const url = new URL(window.location.href);
  if (sessionId) {
    url.searchParams.set("sessionId", sessionId);
  } else {
    url.searchParams.delete("sessionId");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}

export function useSessionRoute() {
  const [sessionId, setSessionId] = useState(() => getSessionIdFromLocation());

  useEffect(() => {
    const handlePopState = () => {
      setSessionId(getSessionIdFromLocation());
    };

    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  const navigateToSession = useCallback((nextSessionId, { replace = false } = {}) => {
    const targetSessionId = nextSessionId || null;
    const nextUrl = buildSessionUrl(targetSessionId);
    const method = replace ? "replaceState" : "pushState";
    window.history[method]({}, "", nextUrl);
    setSessionId(targetSessionId);
  }, []);

  return [sessionId, navigateToSession];
}
