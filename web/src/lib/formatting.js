import { SOURCE_TYPE_OPTIONS } from "./app-constants.js";

export function groupVerificationResults(quiz, answers) {
  const buckets = {
    correct: [],
    incorrect: []
  };

  for (const question of quiz) {
    const selectedIndex = answers[question.id];
    if (selectedIndex === undefined) continue;
    const bucket = selectedIndex === question.correct ? "correct" : "incorrect";
    buckets[bucket].push(question.conceptId);
  }

  return buckets;
}

export function formatTimestamp(value) {
  if (!value) return "Not scheduled";
  const date = new Date(value);
  return date.toLocaleString();
}

export function describeReviewDate(value) {
  if (!value) return "Not scheduled";
  return value <= Date.now() ? "Due now" : `Next review: ${new Date(value).toLocaleDateString()}`;
}

export function getSafeFileName(value) {
  return String(value || "mindweaver-map")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "mindweaver-map";
}

export function getMapName(session, fallback = "Untitled map") {
  return String(session?.goal ?? "").trim() || fallback;
}

export function downloadTextFile(content, fileName, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export function formatSourceTypeLabel(value) {
  const normalized = String(value ?? "").trim().toLowerCase();
  if (!normalized) return "page";

  return (
    [
      ...SOURCE_TYPE_OPTIONS,
      { value: "chatgpt", label: "ChatGPT History" },
      { value: "claude", label: "Claude History" },
      { value: "other", label: "AI Chat History" }
    ].find((option) => option.value === normalized)?.label ?? normalized
  );
}
