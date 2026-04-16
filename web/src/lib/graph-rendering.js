
import { forceCollide } from "d3-force-3d";

const NODE_PALETTE = {
  goal: {
    fill: "#f7d87a",
    stroke: "#ffeab0",
    selectedStroke: "#fff7de",
    shadowColor: "rgba(247, 216, 122, 0.42)",
    textFill: "#07111d",
    minWidth: 236,
    minHeight: 76,
    maxTextWidth: 208,
    fontSize: 12.4,
    lineHeight: 14.6,
    maxLines: 3
  },
  area: {
    fill: "#d7a7ff",
    stroke: "#edd7ff",
    selectedStroke: "#f8efff",
    shadowColor: "rgba(215, 167, 255, 0.34)",
    textFill: "#07111d",
    minWidth: 210,
    minHeight: 66,
    maxTextWidth: 182,
    fontSize: 11.8,
    lineHeight: 14.2,
    maxLines: 2
  },
  domain: {
    fill: "#8cb6ff",
    stroke: "#d4e2ff",
    selectedStroke: "#edf3ff",
    shadowColor: "rgba(140, 182, 255, 0.38)",
    textFill: "#07111d",
    minWidth: 184,
    minHeight: 60,
    maxTextWidth: 158,
    fontSize: 11.4,
    lineHeight: 13.8,
    maxLines: 2
  },
  topic: {
    fill: "#ffb780",
    stroke: "#ffe0c2",
    selectedStroke: "#fff1e4",
    shadowColor: "rgba(255, 183, 128, 0.32)",
    textFill: "#07111d",
    minWidth: 164,
    minHeight: 54,
    maxTextWidth: 138,
    fontSize: 11,
    lineHeight: 13.2,
    maxLines: 2
  },
  skill: {
    fill: "#78d8ca",
    stroke: "#bdf2ea",
    selectedStroke: "#e8fffb",
    shadowColor: "rgba(120, 216, 202, 0.34)",
    textFill: "#07111d",
    minWidth: 148,
    minHeight: 50,
    maxTextWidth: 124,
    fontSize: 10.8,
    lineHeight: 13,
    maxLines: 2
  },
  concept: {
    fill: "#9fd6a2",
    stroke: "#d4f0d6",
    selectedStroke: "#f0fff0",
    shadowColor: "rgba(159, 214, 162, 0.3)",
    textFill: "#07111d",
    minWidth: 120,
    minHeight: 42,
    maxTextWidth: 102,
    fontSize: 10,
    lineHeight: 12.4,
    maxLines: 2
  }
};

const BRANCH_PALETTE = [
  { fill: "#7fb3ff", stroke: "#d7e6ff", shadowColor: "rgba(127, 179, 255, 0.32)" },
  { fill: "#c39cff", stroke: "#ecdfff", shadowColor: "rgba(195, 156, 255, 0.3)" },
  { fill: "#79d8b2", stroke: "#cbf6e8", shadowColor: "rgba(121, 216, 178, 0.3)" },
  { fill: "#ffb77a", stroke: "#ffe2c4", shadowColor: "rgba(255, 183, 122, 0.3)" },
  { fill: "#f089b0", stroke: "#ffd7e4", shadowColor: "rgba(240, 137, 176, 0.28)" },
  { fill: "#8bd5f0", stroke: "#d8f4fb", shadowColor: "rgba(139, 213, 240, 0.28)" },
  { fill: "#c3d96f", stroke: "#eff7cc", shadowColor: "rgba(195, 217, 111, 0.28)" },
  { fill: "#e1a0ff", stroke: "#f4dcff", shadowColor: "rgba(225, 160, 255, 0.28)" }
];
const NEUTRAL_BRANCH_STYLE = {
  fill: "#97a1b2",
  stroke: "#dce3ef",
  shadowColor: "rgba(151, 161, 178, 0.26)"
};

const FALLBACK_NODE_STYLE = {
  fill: "#c9d2e3",
  stroke: "#edf2ff",
  selectedStroke: "#ffffff",
  shadowColor: "rgba(201, 210, 227, 0.32)",
  textFill: "#07111d",
  minWidth: 118,
  minHeight: 42,
  maxTextWidth: 98,
  fontSize: 10,
  lineHeight: 12.4,
  maxLines: 2
};

const LINK_PALETTE = {
  pursues: { stroke: "rgba(247, 216, 122, 0.3)", lineWidth: 1.2, dash: [] },
  focuses_on: { stroke: "rgba(140, 182, 255, 0.28)", lineWidth: 1.3, dash: [] },
  contains: { stroke: "rgba(120, 216, 202, 0.24)", lineWidth: 1.2, dash: [] },
  builds_on: { stroke: "rgba(159, 214, 162, 0.26)", lineWidth: 1.15, dash: [] },
  related: { stroke: "rgba(255, 255, 255, 0.18)", lineWidth: 1.05, dash: [] },
  supports: { stroke: "rgba(120, 216, 202, 0.34)", lineWidth: 1.35, dash: [2, 6] },
  contrasts: { stroke: "rgba(210, 171, 255, 0.36)", lineWidth: 1.28, dash: [10, 4] },
  prerequisite: { stroke: "rgba(247, 216, 122, 0.42)", lineWidth: 1.5, dash: [7, 5] },
  needs: { stroke: "rgba(247, 216, 122, 0.5)", lineWidth: 1.6, dash: [5, 4] }
};

const FALLBACK_LINK_STYLE = LINK_PALETTE.related;
const NODE_FONT_FAMILY = "\"Aptos\", \"Segoe UI\", sans-serif";
const NODE_FONT_WEIGHT = 700;
const NODE_LAYOUT_CACHE_LIMIT = 2048;
const nodeLayoutCache = new Map();
const nodeCollisionRadiusCache = new Map();

export const NODE_HIERARCHY_LEVELS = {
  goal: 0,
  area: 1,
  domain: 2,
  topic: 3,
  skill: 4,
  concept: 5
};

export const NODE_TYPE_LEGEND = [
  { type: "goal", label: "Goal", fill: NODE_PALETTE.goal.fill, stroke: NODE_PALETTE.goal.stroke },
  { type: "area", label: "Area", fill: NODE_PALETTE.area.fill, stroke: NODE_PALETTE.area.stroke },
  { type: "domain", label: "Domain", fill: NODE_PALETTE.domain.fill, stroke: NODE_PALETTE.domain.stroke },
  { type: "topic", label: "Topic", fill: NODE_PALETTE.topic.fill, stroke: NODE_PALETTE.topic.stroke },
  { type: "skill", label: "Skill", fill: NODE_PALETTE.skill.fill, stroke: NODE_PALETTE.skill.stroke },
  { type: "concept", label: "Concept", fill: NODE_PALETTE.concept.fill, stroke: NODE_PALETTE.concept.stroke }
];

function hashString(value) {
  let hash = 0;
  for (const character of String(value ?? "")) {
    hash = ((hash << 5) - hash) + character.charCodeAt(0);
    hash |= 0;
  }
  return Math.abs(hash);
}

export function getBranchVisualStyle(branchKey) {
  if (!branchKey) return NEUTRAL_BRANCH_STYLE;
  return BRANCH_PALETTE[hashString(branchKey) % BRANCH_PALETTE.length];
}

function getResolvedNodePaletteStyle(node) {
  const baseStyle = NODE_PALETTE[node?.type] ?? FALLBACK_NODE_STYLE;
  if (!node?.colorOverrideFill && !node?.colorOverrideStroke && !node?.colorOverrideShadowColor) {
    return baseStyle;
  }

  return {
    ...baseStyle,
    fill: node.colorOverrideFill ?? baseStyle.fill,
    stroke: node.colorOverrideStroke ?? baseStyle.stroke,
    shadowColor: node.colorOverrideShadowColor ?? baseStyle.shadowColor,
    selectedStroke: node.colorOverrideSelectedStroke ?? baseStyle.selectedStroke
  };
}

export function getNodeVisualStyle(node) {
  const baseStyle = getResolvedNodePaletteStyle(node);
  const hierarchyScale = Number.isFinite(node?.hierarchyScale) ? node.hierarchyScale : 1;
  const textScale = Math.max(0.95, Math.min(1.18, 0.97 + (hierarchyScale - 1) * 0.58));
  const lineScale = Math.max(0.96, Math.min(1.22, 0.98 + (hierarchyScale - 1) * 0.68));

  return {
    ...baseStyle,
    width: Math.round(baseStyle.minWidth * hierarchyScale),
    height: Math.round(baseStyle.minHeight * hierarchyScale),
    maxTextWidth: Math.round(baseStyle.maxTextWidth * hierarchyScale),
    fontSize: Number((baseStyle.fontSize * textScale).toFixed(2)),
    lineHeight: Number((baseStyle.lineHeight * lineScale).toFixed(2))
  };
}

export function getNodeFont(style) {
  return `${NODE_FONT_WEIGHT} ${style.fontSize}px ${NODE_FONT_FAMILY}`;
}

function getNodeLayoutCacheKey(node) {
  return [
    String(node?.type ?? ""),
    Number.isFinite(node?.hierarchyScale) ? Number(node.hierarchyScale).toFixed(3) : "1.000",
    String(node?.label ?? ""),
    String(node?.colorOverrideFill ?? ""),
    String(node?.colorOverrideStroke ?? ""),
    String(node?.colorOverrideShadowColor ?? ""),
    String(node?.colorOverrideSelectedStroke ?? "")
  ].join("|");
}

function setCachedValue(cache, key, value) {
  if (cache.size >= NODE_LAYOUT_CACHE_LIMIT) cache.clear();
  cache.set(key, value);
  return value;
}

export function drawRoundedRect(ctx, x, y, width, height, radius = 8) {
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.lineTo(x + width - radius, y);
  ctx.quadraticCurveTo(x + width, y, x + width, y + radius);
  ctx.lineTo(x + width, y + height - radius);
  ctx.quadraticCurveTo(x + width, y + height, x + width - radius, y + height);
  ctx.lineTo(x + radius, y + height);
  ctx.quadraticCurveTo(x, y + height, x, y + height - radius);
  ctx.lineTo(x, y + radius);
  ctx.quadraticCurveTo(x, y, x + radius, y);
  ctx.closePath();
}

function splitLongWord(ctx, word, maxWidth) {
  const segments = [];
  let segment = "";

  for (const character of word) {
    const nextSegment = `${segment}${character}`;
    if (segment && ctx.measureText(nextSegment).width > maxWidth) {
      segments.push(segment);
      segment = character;
    } else {
      segment = nextSegment;
    }
  }

  if (segment) segments.push(segment);
  return segments.length ? segments : [word];
}

function truncateTextToWidth(ctx, text, maxWidth) {
  let output = "";
  for (const character of text) {
    const nextText = `${output}${character}`;
    if (ctx.measureText(nextText).width > maxWidth) break;
    output = nextText;
  }
  return output.trim();
}

function appendEllipsisToWidth(ctx, text, maxWidth) {
  const ellipsis = "…";
  if (ctx.measureText(text).width <= maxWidth) return text;
  const truncated = truncateTextToWidth(ctx, text, Math.max(0, maxWidth - ctx.measureText(ellipsis).width));
  return truncated ? `${truncated}${ellipsis}` : ellipsis;
}

function wrapNodeLabel(ctx, label, maxWidth) {
  const tokens = String(label ?? "")
    .split(/\s+/)
    .flatMap((token) => (ctx.measureText(token).width > maxWidth ? splitLongWord(ctx, token, maxWidth) : token))
    .filter(Boolean);

  if (!tokens.length) return [""];

  const lines = [];
  let currentLine = "";

  for (const token of tokens) {
    const nextLine = currentLine ? `${currentLine} ${token}` : token;
    if (currentLine && ctx.measureText(nextLine).width > maxWidth) {
      lines.push(currentLine);
      currentLine = token;
    } else {
      currentLine = nextLine;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines;
}

export function getNodeMetrics(node, ctx) {
  const cacheKey = getNodeLayoutCacheKey(node);
  const cachedMetrics = nodeLayoutCache.get(cacheKey);

  let layoutMetrics = cachedMetrics;
  if (!layoutMetrics) {
    const style = getNodeVisualStyle(node);

    ctx.save();
    ctx.font = getNodeFont(style);
    const wrappedLines = wrapNodeLabel(ctx, node.label, style.maxTextWidth);
    const lines = wrappedLines.slice(0, style.maxLines);
    const overflow = wrappedLines.length > style.maxLines;
    if (overflow && lines.length) {
      lines[lines.length - 1] = appendEllipsisToWidth(ctx, lines[lines.length - 1], style.maxTextWidth);
    }

    const textWidth = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
    const textHeight = Math.max(style.lineHeight * lines.length, style.lineHeight);
    const compactLine = appendEllipsisToWidth(ctx, String(node.label ?? ""), style.maxTextWidth);
    ctx.restore();

    layoutMetrics = setCachedValue(nodeLayoutCache, cacheKey, {
      style,
      lines,
      compactLine,
      width: Math.max(style.width, Math.ceil(textWidth) + 28),
      height: Math.max(style.height, Math.ceil(textHeight) + 22)
    });
  }

  const safeX = Number.isFinite(node?.x) ? node.x : 0;
  const safeY = Number.isFinite(node?.y) ? node.y : 0;
  const { style, lines, compactLine, width, height } = layoutMetrics;

  return {
    ...style,
    style,
    lines,
    compactLine,
    width,
    height,
    x: safeX - width / 2,
    y: safeY - height / 2,
    textY: safeY - ((lines.length - 1) * style.lineHeight) / 2
  };
}

function getNodeCollisionRadius(node) {
  const cacheKey = getNodeLayoutCacheKey(node);
  const cachedRadius = nodeCollisionRadiusCache.get(cacheKey);
  if (Number.isFinite(cachedRadius)) return cachedRadius;

  const style = getNodeVisualStyle(node);
  const hierarchyScale = Number.isFinite(node?.hierarchyScale) ? Number(node.hierarchyScale) : 1;
  return setCachedValue(
    nodeCollisionRadiusCache,
    cacheKey,
    Math.max(style.width * 0.58, style.height * 1.22) + 14 + Math.max(0, (hierarchyScale - 1) * 6)
  );
}

export function getChargeStrength(nodeCount) {
  if (nodeCount >= 80) return -580;
  if (nodeCount >= 48) return -480;
  if (nodeCount >= 24) return -390;
  return -320;
}

export function getLinkDistance(link) {
  const source = typeof link?.source === "object" ? link.source : null;
  const target = typeof link?.target === "object" ? link.target : null;
  const shallowestLevel = Math.min(
    NODE_HIERARCHY_LEVELS[source?.type] ?? 5,
    NODE_HIERARCHY_LEVELS[target?.type] ?? 5
  );
  const deepestLevel = Math.max(
    NODE_HIERARCHY_LEVELS[source?.type] ?? 5,
    NODE_HIERARCHY_LEVELS[target?.type] ?? 5
  );
  const type = String(link?.type ?? "").trim().toLowerCase();

  let baseDistance = 152;
  if (type === "pursues" || type === "focuses_on") {
    baseDistance = 238;
  } else if (type === "contains") {
    baseDistance = shallowestLevel <= 2 ? 206 : 182;
  } else if (type === "builds_on") {
    baseDistance = 168;
  } else if (type === "prerequisite" || type === "needs") {
    baseDistance = 184;
  } else if (type === "supports" || type === "contrasts") {
    baseDistance = 172;
  }

  return baseDistance + Math.max(0, deepestLevel - shallowestLevel) * 12;
}

export function getLinkVisualStyle(link) {
  return LINK_PALETTE[String(link?.type ?? "").trim().toLowerCase()] ?? FALLBACK_LINK_STYLE;
}

export function getNodeRenderDetail(globalScale) {
  if (!Number.isFinite(globalScale) || globalScale >= 0.75) return "full";
  if (globalScale >= 0.42) return "compact";
  return "minimal";
}

export function createNodeCollisionForce({ iterations = 2, strength = 0.9 } = {}) {
  return forceCollide((node) => getNodeCollisionRadius(node))
    .iterations(iterations)
    .strength(strength);
}

export function withAlpha(color, alpha = 1) {
  const safeAlpha = Math.max(0, Math.min(1, Number(alpha) || 0));
  const normalizedColor = String(color ?? "").trim();
  if (!normalizedColor) return `rgba(255, 255, 255, ${safeAlpha})`;

  if (normalizedColor.startsWith("#")) {
    const hex = normalizedColor.slice(1);
    const expandedHex = hex.length === 3
      ? hex.split("").map((character) => `${character}${character}`).join("")
      : hex;

    if (expandedHex.length === 6) {
      const channels = expandedHex.match(/.{2}/g)?.map((channel) => Number.parseInt(channel, 16)) ?? [];
      if (channels.length === 3 && channels.every(Number.isFinite)) {
        return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${safeAlpha})`;
      }
    }
  }

  const rgbaMatch = normalizedColor.match(/^rgba?\(([^)]+)\)$/i);
  if (rgbaMatch) {
    const channels = rgbaMatch[1].split(",").map((value) => value.trim());
    if (channels.length >= 3) {
      return `rgba(${channels[0]}, ${channels[1]}, ${channels[2]}, ${safeAlpha})`;
    }
  }

  return normalizedColor;
}

export function drawArrowHead(ctx, x1, y1, x2, y2, {
  length = 10,
  width = 6,
  inset = 0
} = {}) {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const tipX = x2 - Math.cos(angle) * inset;
  const tipY = y2 - Math.sin(angle) * inset;
  const baseX = tipX - Math.cos(angle) * length;
  const baseY = tipY - Math.sin(angle) * length;
  const normalX = Math.sin(angle) * (width / 2);
  const normalY = -Math.cos(angle) * (width / 2);

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + normalX, baseY + normalY);
  ctx.lineTo(baseX - normalX, baseY - normalY);
  ctx.closePath();
  ctx.fill();
}
