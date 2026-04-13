const NODE_PALETTE = {
  goal: { fill: "#f4f4f4", stroke: "#ffffff", minWidth: 188, minHeight: 62, maxTextWidth: 168, fontSize: 11, lineHeight: 13, maxLines: 3 },
  domain: { fill: "#d8d8d8", stroke: "#f4f4f4", minWidth: 148, minHeight: 48, maxTextWidth: 128, fontSize: 10.5, lineHeight: 13, maxLines: 2 },
  skill: { fill: "#bcbcbc", stroke: "#e2e2e2", minWidth: 128, minHeight: 44, maxTextWidth: 108, fontSize: 10, lineHeight: 12, maxLines: 2 },
  concept: { fill: "#a6a6a6", stroke: "#d8d8d8", minWidth: 122, minHeight: 42, maxTextWidth: 102, fontSize: 10, lineHeight: 12, maxLines: 2 }
};

const FALLBACK_NODE_STYLE = { fill: "#c9c9c9", stroke: "#f4f4f4", minWidth: 118, minHeight: 42, maxTextWidth: 98, fontSize: 10, lineHeight: 12, maxLines: 2 };

export const NODE_HIERARCHY_LEVELS = {
  goal: 0,
  domain: 1,
  skill: 2,
  concept: 3
};

export function getNodeVisualStyle(node) {
  const baseStyle = NODE_PALETTE[node.type] ?? FALLBACK_NODE_STYLE;
  const hierarchyScale = Number.isFinite(node?.hierarchyScale) ? node.hierarchyScale : 1;
  const textScale = Math.max(0.96, Math.min(1.12, 0.98 + (hierarchyScale - 1) * 0.5));
  const lineScale = Math.max(0.96, Math.min(1.16, hierarchyScale));

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
  return Math.max(style.width, style.height) * 0.55;
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
        const minimumDistance = leftRadius + rightRadius + 18;

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
