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

export const NODE_HIERARCHY_LEVELS = {
  goal: 0,
  domain: 1,
  skill: 2,
  concept: 3
};

export const NODE_TYPE_LEGEND = [
  { type: "goal", label: "Goal", fill: NODE_PALETTE.goal.fill, stroke: NODE_PALETTE.goal.stroke },
  { type: "domain", label: "Domain", fill: NODE_PALETTE.domain.fill, stroke: NODE_PALETTE.domain.stroke },
  { type: "skill", label: "Skill", fill: NODE_PALETTE.skill.fill, stroke: NODE_PALETTE.skill.stroke },
  { type: "concept", label: "Concept", fill: NODE_PALETTE.concept.fill, stroke: NODE_PALETTE.concept.stroke }
];

export function getNodeVisualStyle(node) {
  const baseStyle = NODE_PALETTE[node.type] ?? FALLBACK_NODE_STYLE;
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
  const style = getNodeVisualStyle(node);

  ctx.save();
  ctx.font = `${style.fontSize}px "Aptos", "Segoe UI", sans-serif`;
  const wrappedLines = wrapNodeLabel(ctx, node.label, style.maxTextWidth);
  const lines = wrappedLines.slice(0, style.maxLines);
  const overflow = wrappedLines.length > style.maxLines;
  if (overflow && lines.length) {
    lines[lines.length - 1] = appendEllipsisToWidth(ctx, lines[lines.length - 1], style.maxTextWidth);
  }

  const textWidth = lines.reduce((max, line) => Math.max(max, ctx.measureText(line).width), 0);
  const textHeight = Math.max(style.lineHeight * lines.length, style.lineHeight);
  ctx.restore();

  const width = Math.max(style.width, Math.ceil(textWidth) + 28);
  const height = Math.max(style.height, Math.ceil(textHeight) + 22);

  return {
    ...style,
    style,
    lines,
    width,
    height,
    x: node.x - width / 2,
    y: node.y - height / 2,
    textY: node.y - ((lines.length - 1) * style.lineHeight) / 2
  };
}

function getNodeCollisionRadius(node) {
  const style = getNodeVisualStyle(node);
  return Math.max(style.width * 0.58, style.height * 1.22);
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
    NODE_HIERARCHY_LEVELS[source?.type] ?? 3,
    NODE_HIERARCHY_LEVELS[target?.type] ?? 3
  );
  const deepestLevel = Math.max(
    NODE_HIERARCHY_LEVELS[source?.type] ?? 3,
    NODE_HIERARCHY_LEVELS[target?.type] ?? 3
  );
  const type = String(link?.type ?? "").trim().toLowerCase();

  let baseDistance = 152;
  if (type === "pursues" || type === "focuses_on") {
    baseDistance = 238;
  } else if (type === "contains") {
    baseDistance = shallowestLevel <= 1 ? 206 : 182;
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

export function createNodeCollisionForce() {
  let nodes = [];

  function force() {
    for (let i = 0; i < nodes.length; i += 1) {
      const left = nodes[i];
      if (!Number.isFinite(left.x) || !Number.isFinite(left.y)) continue;
      const leftRadius = getNodeCollisionRadius(left);

      for (let j = i + 1; j < nodes.length; j += 1) {
        const right = nodes[j];
        if (!Number.isFinite(right.x) || !Number.isFinite(right.y)) continue;
        const rightRadius = getNodeCollisionRadius(right);
        const dx = right.x - left.x;
        const dy = right.y - left.y;
        const distance = Math.hypot(dx, dy) || 0.0001;
        const padding = 28 + Math.max(0, ((Number(left?.hierarchyScale ?? 1) + Number(right?.hierarchyScale ?? 1)) - 2) * 12);
        const minimumDistance = leftRadius + rightRadius + padding;

        if (distance >= minimumDistance) continue;

        const overlap = (minimumDistance - distance) / distance * 0.5;
        const offsetX = dx * overlap;
        const offsetY = dy * overlap;

        right.x += offsetX;
        right.y += offsetY;
        left.x -= offsetX;
        left.y -= offsetY;
      }
    }
  }

  force.initialize = (nextNodes) => {
    nodes = nextNodes ?? [];
  };

  return force;
}
