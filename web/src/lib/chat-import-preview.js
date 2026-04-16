function extractJsonObjectString(rawValue) {
  const value = String(rawValue ?? "").trim();
  if (!value) return "";

  if (value.startsWith("```")) {
    return value
      .replace(/^```(?:json)?\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();
  }

  const firstBrace = value.indexOf("{");
  const lastBrace = value.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return value.slice(firstBrace, lastBrace + 1).trim();
  }

  return value;
}

function normalizeImportLabel(value) {
  return String(value ?? "")
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\w\s-]/g, " ")
    .replace(/[_-]+/g, " ")
    .replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b(\w+?)ies\b/g, "$1y")
    .replace(/\b([a-z0-9]{4,})s\b/g, (word, stem) => (/(ss|us|is|ous)$/.test(word) ? word : stem));
}

export function getChatHistoryImportPreview(rawValue) {
  const jsonText = extractJsonObjectString(rawValue);
  if (!jsonText) return { state: "idle" };

  try {
    const parsed = JSON.parse(jsonText);
    const nodes = Array.isArray(parsed?.nodes) ? parsed.nodes : [];
    const relationships = Array.isArray(parsed?.relationships) ? parsed.relationships : [];
    const highlights = Array.isArray(parsed?.conversation_highlights) ? parsed.conversation_highlights : [];
    const issues = [];
    const warningCounts = {
      invalidNodes: 0,
      duplicateNodes: 0,
      invalidRelationships: 0,
      relationshipsMissingNodes: 0,
      selfRelationships: 0,
      invalidHighlights: 0
    };
    const warnings = [];
    const allowedProviders = new Set(["chatgpt", "claude", "other"]);
    const allowedNodeTypes = new Set(["area", "domain", "topic", "skill", "concept"]);
    const allowedRelationshipTypes = new Set(["contains", "builds_on", "prerequisite", "related", "contrasts", "supports", "needs", "focuses_on"]);
    const labelSet = new Set();
    let validNodeCount = 0;

    if (String(parsed?.schema_version ?? "").trim() !== "mindweaver.chat_import.v1") {
      issues.push('schema_version must be "mindweaver.chat_import.v1".');
    }
    if (!allowedProviders.has(String(parsed?.provider ?? "").trim().toLowerCase())) {
      issues.push("provider must be chatgpt, claude, or other.");
    }
    if (!String(parsed?.title ?? "").trim()) {
      issues.push("title is required.");
    }
    if (!String(parsed?.summary ?? "").trim()) {
      issues.push("summary is required.");
    }
    if (!nodes.length) {
      issues.push("nodes must contain at least one item.");
    }

    nodes.forEach((node) => {
      const type = String(node?.type ?? "").trim().toLowerCase();
      const label = normalizeImportLabel(node?.label);
      if (!allowedNodeTypes.has(type)) {
        warningCounts.invalidNodes += 1;
        return;
      }
      if (!label) {
        warningCounts.invalidNodes += 1;
        return;
      }
      if (labelSet.has(label)) {
        warningCounts.duplicateNodes += 1;
        return;
      }
      labelSet.add(label);
      validNodeCount += 1;
    });

    relationships.forEach((relationship) => {
      const source = normalizeImportLabel(relationship?.source);
      const target = normalizeImportLabel(relationship?.target);
      const type = String(relationship?.type ?? "").trim().toLowerCase();

      if (!source || !target) {
        warningCounts.invalidRelationships += 1;
        return;
      }
      if (!allowedRelationshipTypes.has(type)) {
        warningCounts.invalidRelationships += 1;
        return;
      }
      if (source === target) {
        warningCounts.selfRelationships += 1;
        return;
      }
      if (!labelSet.has(source) || !labelSet.has(target)) {
        warningCounts.relationshipsMissingNodes += 1;
      }
    });

    highlights.forEach((highlight) => {
      if (!String(highlight?.title ?? "").trim() || !String(highlight?.summary ?? "").trim()) {
        warningCounts.invalidHighlights += 1;
      }
    });

    if (!validNodeCount) {
      issues.push("No importable nodes remain after normalization.");
    }
    if (warningCounts.invalidNodes) warnings.push(`Will skip ${warningCounts.invalidNodes} invalid node${warningCounts.invalidNodes === 1 ? "" : "s"}.`);
    if (warningCounts.duplicateNodes) warnings.push(`Will merge ${warningCounts.duplicateNodes} duplicate node label${warningCounts.duplicateNodes === 1 ? "" : "s"} after normalization.`);
    if (warningCounts.invalidRelationships) warnings.push(`Will skip ${warningCounts.invalidRelationships} invalid relationship${warningCounts.invalidRelationships === 1 ? "" : "s"}.`);
    if (warningCounts.relationshipsMissingNodes) warnings.push(`Will skip ${warningCounts.relationshipsMissingNodes} relationship${warningCounts.relationshipsMissingNodes === 1 ? "" : "s"} that reference missing nodes.`);
    if (warningCounts.selfRelationships) warnings.push(`Will skip ${warningCounts.selfRelationships} self-link relationship${warningCounts.selfRelationships === 1 ? "" : "s"}.`);
    if (warningCounts.invalidHighlights) warnings.push(`Will skip ${warningCounts.invalidHighlights} invalid conversation highlight${warningCounts.invalidHighlights === 1 ? "" : "s"}.`);

    return {
      state: "ready",
      provider: String(parsed?.provider ?? "").trim(),
      title: String(parsed?.title ?? "Untitled import").trim() || "Untitled import",
      summary: String(parsed?.summary ?? "").trim(),
      schemaVersion: String(parsed?.schema_version ?? "").trim(),
      nodeCount: nodes.length,
      relationshipCount: relationships.length,
      highlightCount: highlights.length,
      issues,
      warnings
    };
  } catch {
    return {
      state: "error",
      message: "Could not parse JSON yet. Paste the raw response from ChatGPT or Claude, including fenced JSON if needed."
    };
  }
}
