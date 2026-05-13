import { LoadingButton } from "../ui/Shell.jsx";

export default function MapOverviewCard({
  mapName,
  nodeCount,
  sourceCount,
  reviewCount,
  onRunGapAnalysis,
  isLoadingGaps,
  canRunGapAnalysis,
  onGenerateQuiz,
  isLoadingQuiz,
  onEndSession,
  isEndingSession,
  isEnded,
  statusMessage,
  errorMessage
}) {
  return (
    <section className="panel hero-card">
      <p className="panel-title">Map Overview</p>
      <h1>{mapName}</h1>
      <p>
        Turn passive browsing into a map you can trust, review, and strengthen with better evidence.
      </p>
      <div className="stat-grid">
        <div className="stat-card">
          <span className="stat-label">Nodes</span>
          <span className="stat-value">{nodeCount}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Sources</span>
          <span className="stat-value">{sourceCount}</span>
        </div>
        <div className="stat-card">
          <span className="stat-label">Needs Review</span>
          <span className="stat-value">{reviewCount}</span>
        </div>
      </div>
      <div className="action-row">
        <LoadingButton className="primary-button" onClick={onRunGapAnalysis} disabled={!canRunGapAnalysis} isLoading={isLoadingGaps} loadingLabel="Finding map gaps">
          Run Gap Analysis
        </LoadingButton>
        <LoadingButton className="secondary-button" onClick={onGenerateQuiz} isLoading={isLoadingQuiz} loadingLabel="Building quiz">
          Generate Quiz
        </LoadingButton>
        <LoadingButton className="ghost-button" onClick={onEndSession} disabled={isEnded} isLoading={isEndingSession} loadingLabel="Ending session">
          {isEnded ? "Session Ended" : "End Session"}
        </LoadingButton>
      </div>
      {statusMessage ? <div className="message-banner">{statusMessage}</div> : null}
      {errorMessage ? <div className="message-banner error-banner">{errorMessage}</div> : null}
    </section>
  );
}
