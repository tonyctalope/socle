import { Component, type ComponentType, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { boot, words } from './boot.ts';
import { listen } from './data.ts';

const TEXT = words({
  en: {
    title: 'Something went wrong',
    body: 'The app ran into an error. Reloading the page is often enough.',
    reload: 'Reload',
    draft: 'Draft',
  },
  fr: {
    title: 'Un problème est survenu',
    body: 'L’appli a rencontré une erreur. Recharger la page suffit souvent.',
    reload: 'Recharger',
    draft: 'Brouillon',
  },
});

/** Shown instead of a blank page when the app's code throws while rendering. */
class ErrorScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  override render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <main className="mx-auto flex min-h-dvh max-w-md flex-col justify-center gap-4 p-6">
        <h1 className="text-xl font-semibold">{TEXT.title}</h1>
        <p className="text-muted">{TEXT.body}</p>
        <pre className="overflow-auto rounded-xl border border-line bg-card p-3 text-xs text-muted">
          {error.message}
        </pre>
        <button
          type="button"
          className="rounded-xl bg-accent px-4 py-3 font-medium text-accent-ink"
          onClick={() => location.reload()}
        >
          {TEXT.reload}
        </button>
      </main>
    );
  }
}

/** Mounts the app's root component. Called by the platform with the default export of web/main.tsx. */
export function start(App: ComponentType): void {
  const root = document.getElementById('root');
  if (!root) throw new Error('socle: this page was not served by the platform');
  listen();
  createRoot(root).render(
    <ErrorScreen>
      <App />
      {boot.draft && (
        // On the draft's address only: a mark nobody can click or mistake for part of the app.
        <div className="pointer-events-none fixed bottom-2 left-2 z-50 rounded-full bg-warn px-2.5 py-1 text-xs font-semibold text-white opacity-90 shadow">
          {TEXT.draft}
        </div>
      )}
    </ErrorScreen>,
  );
}
