import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

interface ErrorBoundaryState {
  error: Error | null;
}

class AppErrorBoundary extends React.Component<
  { children: React.ReactNode },
  ErrorBoundaryState
> {
  constructor(props: { children: React.ReactNode }) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  render() {
    if (this.state.error) {
      return (
        <div className="w-screen h-screen bg-[#160c2e] text-slate-100 flex items-center justify-center p-6">
          <div className="studio-panel max-w-lg w-full p-5 space-y-3 text-xs">
            <h1 className="text-sm font-bold text-amber-300">
              3D Movie Maker failed to render
            </h1>
            <p className="text-purple-200 break-words font-mono bg-[#120624] p-2 border border-purple-800">
              {this.state.error.message || String(this.state.error)}
            </p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="studio-btn px-3 py-1.5 font-bold text-white"
            >
              Reload Studio
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById('root')!).render(
  <AppErrorBoundary>
    <App />
  </AppErrorBoundary>
);
