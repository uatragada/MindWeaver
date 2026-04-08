import React from "react";

export class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error("MindWeaver UI error", error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="page-shell">
          <div className="empty-state">
            <p className="panel-title">MindWeaver</p>
            <h1>Something went wrong in the interface.</h1>
            <p className="panel-subtitle">
              Your local data is still on the server. Reload the app, or return to all maps and reopen this session.
            </p>
            <div className="action-row">
              <button className="primary-button" onClick={() => window.location.reload()}>Reload App</button>
              <button className="secondary-button" onClick={() => window.location.assign(window.location.pathname)}>All Maps</button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
