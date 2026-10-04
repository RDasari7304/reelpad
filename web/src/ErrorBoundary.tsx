import { Component, type ReactNode } from "react";

/** Shows a readable message with a reload button instead of a blank page if anything crashes. */
export class ErrorBoundary extends Component<{ children: ReactNode; fallback?: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error("Reelpad crashed:", error);
    // A page left open across a deploy can ask for build files that no longer exist; reload once to fix it.
    if (/dynamically imported module|Failed to fetch|Importing a module script failed|ChunkLoadError/i.test(error.message)) {
      try {
        if (!sessionStorage.getItem("reelpad-reloaded")) {
          sessionStorage.setItem("reelpad-reloaded", "1");
          window.location.reload();
        }
      } catch {
        /* storage unavailable */
      }
    }
  }

  render() {
    if (!this.state.error) return this.props.children;
    if (this.props.fallback !== undefined) return this.props.fallback;
    return (
      <div className="page narrow crash">
        <h1>Something went wrong</h1>
        <p>This page hit an error. Reloading usually fixes it.</p>
        <pre className="crash-detail">{this.state.error.message}</pre>
        <button className="btn btn-primary" onClick={() => window.location.reload()}>
          Reload
        </button>{" "}
        <a className="btn btn-quiet" href="/">
          Go home
        </a>
      </div>
    );
  }
}
