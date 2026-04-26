function makeQuickNoteSubmitter({ getRuntimeUrl, fetchImpl = fetch, now = () => new Date() }) {
  return async function submitQuickNote(payload = {}) {
    const runtimeUrl = getRuntimeUrl?.();
    if (!runtimeUrl) throw new Error("MindWeaver is not ready yet.");
    const sessionId = String(payload.sessionId ?? "").trim();
    const label = String(payload.label ?? "").trim();
    const type = String(payload.type ?? "concept").trim() || "concept";
    const title = String(payload.title ?? "").trim() || label || `Tray note - ${now().toLocaleString()}`;
    const content = String(payload.content ?? "").trim();

    if (!sessionId) throw new Error("Choose a destination map.");
    if (!content && !label) throw new Error("Add note text or a node label.");

    if (label) {
      const response = await fetchImpl(`${runtimeUrl}/api/nodes`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sessionId,
          type,
          label,
          description: String(payload.description ?? "").trim(),
          note: content
        })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.error || `Could not create note node (${response.status}).`);
      if (content && body.node?.id) {
        const patchResponse = await fetchImpl(`${runtimeUrl}/api/nodes/${encodeURIComponent(body.node.id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sessionId,
            note: content
          })
        });
        const patchBody = await patchResponse.json().catch(() => ({}));
        if (!patchResponse.ok) throw new Error(patchBody.error || `Created the node, but could not attach the note (${patchResponse.status}).`);
      }
      return { ok: true, message: `Created ${type} node: ${body.node?.label || label}` };
    }

    const response = await fetchImpl(`${runtimeUrl}/api/import`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sessionId,
        sourceType: "note",
        title,
        content
      })
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(body.error || `Could not import note (${response.status}).`);
    return { ok: true, message: `Imported note: ${title}` };
  };
}

export {
  makeQuickNoteSubmitter
};
