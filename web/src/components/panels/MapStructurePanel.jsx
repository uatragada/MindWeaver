import SelectControl from "../controls/SelectControl.jsx";
import { LoadingButton } from "../ui/Shell.jsx";

export default function MapStructurePanel({
  mapNameDraft,
  onMapNameChange,
  onSaveMapName,
  isRenamingMap,
  hasMapNameChanges,
  quickAddNodeType,
  onQuickAddNodeTypeChange,
  quickAddNodeLabel,
  onQuickAddNodeLabelChange,
  onCreateNode,
  isCreatingNode,
  quickAddNodeTypeOptions,
  primaryGoalNode,
  isRefiningMap,
  onRefineMap,
  canUseLlm,
  llmProviderLabel,
  llmStatusMessage,
  nodeCount
}) {
  return (
    <section className="panel structure-panel">
      <p className="panel-title">Map Structure</p>
      <p className="panel-subtitle">
        Keep the map framing clear. Add areas, topics, or legacy goal nodes when they help, or run a conservative refine pass to clean up the current graph.
      </p>
      <div className="structure-field-stack">
        <div className="toolbar-note">Map name</div>
        <div className="toolbar-inline-form">
          <input
            className="text-input"
            name="mapName"
            autoComplete="off"
            placeholder="Untitled map"
            value={mapNameDraft}
            onChange={(event) => onMapNameChange(event.target.value)}
          />
          <LoadingButton className="secondary-button" type="button" disabled={!hasMapNameChanges} isLoading={isRenamingMap} loadingLabel="Saving map name" onClick={onSaveMapName}>
            Save Map Name
          </LoadingButton>
        </div>
      </div>
      <div className="toolbar-inline-form">
        <SelectControl
          className="topbar-type-filter"
          value={quickAddNodeType}
          onChange={onQuickAddNodeTypeChange}
          options={quickAddNodeTypeOptions}
          ariaLabel="Quick add node type"
        />
        <input
          className="text-input"
          name="quickAddNodeLabel"
          autoComplete="off"
          placeholder={quickAddNodeType === "goal"
            ? (primaryGoalNode ? "Add another top-level goal node" : "Add a top-level goal node")
            : `Add a ${quickAddNodeType} node`}
          value={quickAddNodeLabel}
          onChange={(event) => onQuickAddNodeLabelChange(event.target.value)}
        />
        <LoadingButton className="primary-button" type="button" disabled={!quickAddNodeLabel.trim()} isLoading={isCreatingNode} loadingLabel="Adding node" onClick={onCreateNode}>
          Add {quickAddNodeType.charAt(0).toUpperCase()}{quickAddNodeType.slice(1)}
        </LoadingButton>
      </div>
      <div className="toolbar-note">
        {primaryGoalNode
          ? `Primary goal node: ${primaryGoalNode.label}`
          : "This map does not have a primary goal node yet."}
      </div>
      <div className="structure-action-block">
        <div className="toolbar-note">
          Refine reviews the current map and reorganizes weak, redundant, or misplaced structure without throwing useful information away.
        </div>
        <LoadingButton
          className="secondary-button"
          type="button"
          disabled={!canUseLlm || nodeCount < 2}
          isLoading={isRefiningMap}
          loadingLabel="Refining map"
          onClick={onRefineMap}
        >
          Refine Map
        </LoadingButton>
      </div>
      {!canUseLlm ? (
        <div className="toolbar-note">{llmStatusMessage}</div>
      ) : nodeCount < 2 ? (
        <div className="toolbar-note">Add at least two nodes to this map before running Refine.</div>
      ) : (
        <div className="toolbar-note">Refine will use {llmProviderLabel} for this cleanup pass.</div>
      )}
    </section>
  );
}
