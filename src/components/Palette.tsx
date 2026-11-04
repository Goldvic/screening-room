import { useState } from 'react';

export function Palette({ cmds, onClose }: { cmds: { t: string; k: string; run: () => void }[]; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [i, setI] = useState(0);
  const list = cmds.filter((c) => q.split(/\s+/).every((w) => c.t.toLowerCase().includes(w.toLowerCase()))).slice(0, 12);
  const go = (c?: { run: () => void }) => { if (!c) return; onClose(); c.run(); };
  return (
    <div className="scrim top" onClick={onClose}>
      <div className="palette" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <input
          autoFocus
          placeholder="Type a command or the name of a video…"
          value={q}
          onChange={(e) => { setQ(e.target.value); setI(0); }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') { e.preventDefault(); setI((x) => Math.min(list.length - 1, x + 1)); }
            else if (e.key === 'ArrowUp') { e.preventDefault(); setI((x) => Math.max(0, x - 1)); }
            else if (e.key === 'Enter') go(list[i]);
            else if (e.key === 'Escape') onClose();
          }}
        />
        <div className="pal-list" role="listbox">
          {list.map((c, n) => (
            <button key={c.t + n} role="option" aria-selected={n === i} className={n === i ? 'on' : ''} onMouseEnter={() => setI(n)} onClick={() => go(c)}>
              <span>{c.t}</span>{c.k && <kbd>{c.k}</kbd>}
            </button>
          ))}
          {!list.length && <p className="muted small">Nothing matches “{q}”.</p>}
        </div>
      </div>
    </div>
  );
}

export function Sheet({ onClose }: { onClose: () => void }) {
  const rows = [
    ['Ctrl + K', 'Command palette'],
    ['Ctrl + 1 / 2 / 3', 'Home, Library, Playlists'],
    ['Ctrl + 4 or Ctrl + D', 'Downloads'],
    ['Ctrl + ,', 'Settings'],
    ['Ctrl + F or /', 'Search this folder'],
    ['Ctrl + A', 'Select every video'],
    ['Delete', 'Delete the selected videos'],
    ['F5 or Ctrl + R', 'Refresh'],
    ['Ctrl + O', 'Open a video from this computer'],
    ['Esc', 'Close or clear selection'],
    ['?', 'This sheet'],
    ['In the player', 'Press H for the player shortcuts'],
  ];
  return (
    <div className="scrim" onClick={onClose}>
      <div className="dialog" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Keyboard shortcuts">
        <h3>Keyboard shortcuts</h3>
        <div className="sheet-grid">{rows.map(([k, d]) => <p key={k}><kbd>{k}</kbd><span>{d}</span></p>)}</div>
      </div>
    </div>
  );
}