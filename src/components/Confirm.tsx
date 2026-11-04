import { useState } from 'react';

export type Ask = { title: string; body: string; label: string; go: () => Promise<void> };

export function Confirm({ ask, onClose, onError }: { ask: Ask; onClose: () => void; onError: (m: string) => void }) {
  const [busy, setBusy] = useState(false);
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="alertdialog">
        <h3>{ask.title}</h3>
        <p className="muted">{ask.body}</p>
        <div className="dlg-actions">
          <button className="btn ghost" onClick={onClose}>Keep it</button>
          <button
            className="btn danger"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              try { await ask.go(); } catch (e: any) { onError(e.message); }
              onClose();
            }}
          >
            {busy ? 'Deleting…' : ask.label}
          </button>
        </div>
      </div>
    </div>
  );
}