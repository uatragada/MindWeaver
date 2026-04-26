function extractProtocolUrl(argv = []) {
  return argv.find((value) => /^mindweaver:\/\//i.test(String(value ?? ""))) ?? null;
}

function buildProtocolWindowParams(url) {
  const parsed = url ? new URL(url) : null;
  const params = {};
  if (parsed?.searchParams.get("panel")) params.rightPanel = parsed.searchParams.get("panel");
  if (parsed?.searchParams.get("sourceType")) params.sourceType = parsed.searchParams.get("sourceType");
  if (parsed?.searchParams.get("sessionId")) params.sessionId = parsed.searchParams.get("sessionId");
  return params;
}

export {
  buildProtocolWindowParams,
  extractProtocolUrl
};
