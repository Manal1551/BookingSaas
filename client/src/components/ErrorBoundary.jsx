import React from 'react';

/**
 * Global boundary for unexpected render/runtime errors.
 *
 * API failures are handled where they happen (query error states + toasts);
 * this is the last line of defence so a component bug shows a recoverable
 * screen instead of a blank page.
 */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    // In a real deployment this is where the error would go to Sentry et al.
    console.error('[ui] unhandled error', error, info?.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 p-6">
        <div className="card w-full max-w-md p-6 text-center">
          <h1 className="text-lg font-semibold text-slate-900">
            Something went wrong
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            The page hit an unexpected error. Reloading usually fixes it.
          </p>
          {import.meta.env.DEV && (
            <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-slate-100 p-3 text-left text-xs text-slate-600">
              {String(this.state.error?.message || this.state.error)}
            </pre>
          )}
          <div className="mt-5 flex justify-center gap-2">
            <button
              className="btn-ghost"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
            <button className="btn-primary" onClick={() => window.location.reload()}>
              Reload page
            </button>
          </div>
        </div>
      </div>
    );
  }
}
