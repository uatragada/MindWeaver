import { useMemo } from "react";
import { getNodeVisualStyle, withAlpha } from "../../lib/graph-rendering.js";

const MINI_MAP_WIDTH = 224;
const MINI_MAP_HEIGHT = 152;
const MINI_MAP_PADDING = 12;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export default function GraphMiniMap({
  nodes,
  links,
  graphSize,
  viewport,
  selectedNodeId,
  selectedNodeIds,
  onCenterNode,
  onSelectNode
}) {
  const {
    positionedNodes,
    positionedLinks,
    viewportRect
  } = useMemo(() => {
    const renderableNodes = (Array.isArray(nodes) ? nodes : []).filter(
      (node) => Number.isFinite(node?.x) && Number.isFinite(node?.y)
    );
    if (!renderableNodes.length) {
      return {
        positionedNodes: [],
        positionedLinks: [],
        viewportRect: null
      };
    }

    const minX = Math.min(...renderableNodes.map((node) => node.x));
    const maxX = Math.max(...renderableNodes.map((node) => node.x));
    const minY = Math.min(...renderableNodes.map((node) => node.y));
    const maxY = Math.max(...renderableNodes.map((node) => node.y));
    const safeWidth = Math.max(1, maxX - minX);
    const safeHeight = Math.max(1, maxY - minY);
    const scale = Math.min(
      (MINI_MAP_WIDTH - MINI_MAP_PADDING * 2) / safeWidth,
      (MINI_MAP_HEIGHT - MINI_MAP_PADDING * 2) / safeHeight
    );
    const offsetX = MINI_MAP_PADDING + (MINI_MAP_WIDTH - MINI_MAP_PADDING * 2 - safeWidth * scale) / 2;
    const offsetY = MINI_MAP_PADDING + (MINI_MAP_HEIGHT - MINI_MAP_PADDING * 2 - safeHeight * scale) / 2;
    const projectX = (graphX) => offsetX + (graphX - minX) * scale;
    const projectY = (graphY) => offsetY + (graphY - minY) * scale;
    const positionedNodeMap = new Map();

    const nextPositionedNodes = renderableNodes.map((node) => {
      const point = {
        ...node,
        miniMapX: projectX(node.x),
        miniMapY: projectY(node.y)
      };
      positionedNodeMap.set(node.id, point);
      return point;
    });

    const nextPositionedLinks = (Array.isArray(links) ? links : [])
      .map((link) => {
        const sourceId = typeof link.source === "object" ? link.source.id : link.source;
        const targetId = typeof link.target === "object" ? link.target.id : link.target;
        const source = positionedNodeMap.get(sourceId);
        const target = positionedNodeMap.get(targetId);
        if (!source || !target) return null;
        return {
          ...link,
          source,
          target
        };
      })
      .filter(Boolean);

    let nextViewportRect = null;
    const zoom = Number(viewport?.zoom) || 1;
    if (viewport && Number.isFinite(viewport.centerX) && Number.isFinite(viewport.centerY) && zoom > 0) {
      const graphViewportWidth = (Number(graphSize?.width) || 0) / zoom;
      const graphViewportHeight = (Number(graphSize?.height) || 0) / zoom;
      const left = projectX(viewport.centerX - graphViewportWidth / 2);
      const right = projectX(viewport.centerX + graphViewportWidth / 2);
      const top = projectY(viewport.centerY - graphViewportHeight / 2);
      const bottom = projectY(viewport.centerY + graphViewportHeight / 2);

      nextViewportRect = {
        x: clamp(left, 0, MINI_MAP_WIDTH),
        y: clamp(top, 0, MINI_MAP_HEIGHT),
        width: clamp(right - left, 6, MINI_MAP_WIDTH),
        height: clamp(bottom - top, 6, MINI_MAP_HEIGHT)
      };
    }

    return {
      positionedNodes: nextPositionedNodes,
      positionedLinks: nextPositionedLinks,
      viewportRect: nextViewportRect
    };
  }, [
    graphSize?.height,
    graphSize?.width,
    links,
    nodes,
    viewport?.centerX,
    viewport?.centerY,
    viewport?.zoom
  ]);

  const selectedNodeIdSet = useMemo(
    () => new Set((Array.isArray(selectedNodeIds) ? selectedNodeIds : []).filter(Boolean)),
    [selectedNodeIds]
  );

  if (!positionedNodes.length) return null;

  return (
    <div className="graph-minimap-card" aria-label="Graph minimap">
      <div className="graph-minimap-header">
        <strong>Overview Map</strong>
        <span>{positionedNodes.length} nodes</span>
      </div>
      <svg
        className="graph-minimap"
        viewBox={`0 0 ${MINI_MAP_WIDTH} ${MINI_MAP_HEIGHT}`}
        role="img"
        aria-label="Miniature graph overview"
      >
        <rect
          x="0.5"
          y="0.5"
          width={MINI_MAP_WIDTH - 1}
          height={MINI_MAP_HEIGHT - 1}
          rx="12"
          fill="rgba(5, 5, 5, 0.78)"
          stroke="rgba(255, 255, 255, 0.08)"
        />
        {positionedLinks.map((link) => (
          <line
            key={link.key ?? `${link.source.id}:${link.target.id}`}
            x1={link.source.miniMapX}
            y1={link.source.miniMapY}
            x2={link.target.miniMapX}
            y2={link.target.miniMapY}
            stroke={withAlpha(link.isDimmed ? "rgba(255,255,255,0.08)" : "rgba(255,255,255,0.26)", 1)}
            strokeWidth={link.isPath ? 1.8 : 1}
          />
        ))}
        {viewportRect ? (
          <rect
            x={viewportRect.x}
            y={viewportRect.y}
            width={viewportRect.width}
            height={viewportRect.height}
            rx="8"
            fill="rgba(255, 255, 255, 0.03)"
            stroke="rgba(255, 255, 255, 0.58)"
            strokeWidth="1"
          />
        ) : null}
        {positionedNodes.map((node) => {
          const style = getNodeVisualStyle(node);
          const isPrimarySelection = node.id === selectedNodeId;
          const isGroupSelection = selectedNodeIdSet.has(node.id);
          const radius = isPrimarySelection ? 5 : isGroupSelection ? 4 : 3;
          const fill = node.isDimmed ? withAlpha(style.fill, 0.32) : style.fill;
          const stroke = isPrimarySelection || isGroupSelection ? style.selectedStroke : style.stroke;

          return (
            <g key={node.id}>
              <circle
                cx={node.miniMapX}
                cy={node.miniMapY}
                r={radius}
                fill={fill}
                stroke={stroke}
                strokeWidth={isPrimarySelection ? 1.8 : 1}
                onPointerDown={(event) => {
                  event.preventDefault();
                  onSelectNode?.(node.id, { additive: Boolean(event.shiftKey) });
                  onCenterNode?.(node.id);
                }}
              >
                <title>{node.label}</title>
              </circle>
            </g>
          );
        })}
      </svg>
      <div className="graph-minimap-meta">Click a node to center the main graph.</div>
    </div>
  );
}
