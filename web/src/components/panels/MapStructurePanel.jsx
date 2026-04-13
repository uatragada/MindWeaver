export default function MapStructurePanel({
  mapNameDraft,
  onMapNameChange,
  onSaveMapName,
  isRenamingMap,
  hasMapNameChanges,
  goalNodeDraft,
  onGoalNodeDraftChange,
  onCreateGoalNode,
  isCreatingGoalNode,
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
        Keep the map framing clear. Add a top-level goal node when it helps, or run a conservative refine pass to clean up the current graph.
      </p>
      <div className="structure-field-stack">
        <div className="toolbar-note">Map name</div>
        <div className="toolbar-inline-form">
          <input
            className="text-input"
            placeholder="Untitled map"
            value={mapNameDraft}
            onChange={(event) => onMapNameChange(event.target.value)}
          />
          <button className="secondary-button" type="button" disabled={isRenamingMap || !hasMapNameChanges} onClick={onSaveMapName}>
            {isRenamingMap ? "Saving..." : "Save Map Name"}
          </button>
        </div>
      </div>
      <div className="toolbar-inline-form">
        <input
          className="text-input"
          placeholder={primaryGoalNode ? "Add another top-level goal node" : "Add a top-level goal node"}
          value={goalNodeDraft}
          onChange={(event) => onGoalNodeDraftChange(event.target.value)}
        />
        <button className="primary-button" type="button" disabled={isCreatingGoalNode || !goalNodeDraft.trim()} onClick={onCreateGoalNode}>
          {isCreatingGoalNode ? "Adding..." : "Add Goal Node"}
        </button>
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
        <button
          className="secondary-button"
          type="button"
          disabled={isRefiningMap || !canUseLlm || nodeCount < 2}
          onClick={onRefineMap}
        >
          {isRefiningMap ? "Refining..." : "Refine Map"}
        </button>
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
