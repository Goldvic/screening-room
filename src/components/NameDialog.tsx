import { useState } from 'react';
import { Icon } from '../lib';

export type NameAsk = { title: string; value: string; label: string; go: (v: string) => void };

export function NameDialog({ ask, onClose }: { ask: NameAsk; onClose: () => void }) {
  const [v, setV] = useState(ask.value);
  const isGoal = /goal/i.test(ask.title);
  const done = () => { ask.go(v.trim()); onClose(); };
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog de-settings name-dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={ask.title}>
        <div className="set-accent" aria-hidden="true" />
        <div className="dlg-head">
          <div>
            <h3>{ask.title}</h3>
            {isGoal && <span className="dlg-sub">How many minutes you aim to watch each day</span>}
          </div>
          <button type="button" className="icon set-close" onClick={onClose} aria-label="Close"><Icon n="close" /></button>
        </div>
        <div className="name-dialog-body">
          <input
            autoFocus
            type={isGoal ? 'number' : 'text'}
            min={isGoal ? 5 : undefined}
            step={isGoal ? 5 : undefined}
            value={v}
            onChange={(e) => setV(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') done(); if (e.key === 'Escape') onClose(); }}
          />
          {isGoal && <p className="muted small name-dialog-hint">Minimum 5 minutes. No upper limit.</p>}
        </div>
        <div className="dlg-actions">
          <button type="button" className="btn ghost" onClick={onClose}>Cancel</button>
          <button type="button" className="btn" onClick={done} disabled={isGoal ? !(parseInt(v, 10) >= 5) : !v.trim()}>{ask.label}</button>
        </div>
      </div>
    </div>
  );
}