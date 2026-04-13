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
        <button className="primary-button" onClick={onRunGapAnalysis} disabled={isLoadingGaps || !canRunGapAnalysis}>
          {isLoadingGaps ? "Finding gaps..." : "Run Gap Analysis"}
        </button>
        <button className="secondary-button" onClick={onGenerateQuiz} disabled={isLoadingQuiz}>
          {isLoadingQuiz ? "Building quiz..." : "Generate Quiz"}
        </button>
        <button className="ghost-button" onClick={onEndSession} disabled={isEndingSession || isEnded}>
          {isEnded ? "Session Ended" : isEndingSession ? "Ending..." : "End Session"}
        </button>
      </div>
      {statusMessage ? <div className="message-banner">{statusMessage}</div> : null}
      {errorMessage ? <div className="message-banner error-banner">{errorMessage}</div> : null}
    </section>
  );
}
