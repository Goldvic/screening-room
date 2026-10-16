import { CSSProperties } from 'react';
import { Icon, Prog, SavedList, bytes, clock, hue, pct } from './lib';

export type HomeCard = { k: string; rid: number; dir: string; name: string; p?: Prog; offlineRel?: string };
export type SavedFile = { rel: string; name: string; size: number; mtime: number };

const ago = (t: number) => {
  const d = Math.floor((Date.now() - t * 1000) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t * 1000).toLocaleDateString();
};

// A horizontally scrolling row of posters.
export function Rail({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="rail">
      <div className="rail-h"><h2>{title}</h2>{hint && <span className="muted small">{hint}</span>}</div>
      <div className="rail-row">{children}</div>
    </section>
  );
}

export function Tile({ name, sub, progress, onClick, art, badge }: {
  name: string; sub?: string; progress?: number; onClick: () => void; art: React.ReactNode; badge?: string;
}) {
  return (
    <button className="tilecard" style={{ '--h': hue(name) } as CSSProperties} onClick={onClick}>
      <span className="tilecard-art">{art}{badge && <span className="badge-s">{badge}</span>}<span className="go"><Icon n="play" s={18} /></span>
        {progress ? <i className="prog"><b style={{ width: `${progress}%` }} /></i> : null}</span>
      <span className="tilecard-t" title={name}>{name.replace(/\.[^.]+$/, '')}</span>
      {sub && <span className="small muted">{sub}</span>}
    </button>
  );
}

export function Hero({ title, line, eyebrow, art, onPlay, onMore, label }: {
  title: string; line: string; eyebrow: string; art: React.ReactNode; onPlay: () => void; onMore?: () => void; label: string;
}) {
  return (
    <section className="hero">
      <div className="hero-art">{art}</div>
      <div className="hero-shade" />
      <div className="hero-body">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        <p className="muted">{line}</p>
        <div className="inline">
          <button className="btn big" onClick={onPlay}><Icon n="play" s={18} /> {label}</button>
          {onMore && <button className="btn ghost" onClick={onMore}><Icon n="info" s={16} /> Details</button>}
        </div>
      </div>
    </section>
  );
}

export function Welcome({ onLibrary, onOpen }: { onLibrary: () => void; onOpen?: () => void }) {
  return (
    <section className="empty">
      <span className="lamp big" />
      <h2>Nothing to continue yet</h2>
      <p className="muted">Open your library and play something. It will show up here with a resume button, and saved copies appear under “Saved on this laptop”.</p>
      <div className="inline"><button className="btn" onClick={onLibrary}><Icon n="film" s={16} /> Open library</button>{onOpen && <button className="btn ghost" onClick={onOpen}><Icon n="folder" s={16} /> Open a file…</button>}</div>
    </section>
  );
}

export function Playlists({ lists, durOf, onPlay, onDelete, onMove, onRename }: {
  lists: SavedList[]; durOf: (l: SavedList) => number;
  onPlay: (l: SavedList) => void; onDelete: (l: SavedList) => void; onMove: (l: SavedList, i: number, d: -1 | 1) => void; onRename: (l: SavedList) => void;
}) {
  if (!lists.length) return (
    <section className="empty">
      <Icon n="list" s={34} />
      <h2>No playlists yet</h2>
      <p className="muted">In the library press <b>Select</b>, tick some videos, then <b>Save playlist</b>.</p>
    </section>
  );
  return (
    <div className="plists">
      {lists.map((l) => {
        const d = durOf(l);
        return (
          <article key={l.id} className="plist-card">
            <header>
              <div><h3>{l.name}</h3><span className="muted small">{l.items.length} videos{d > 0 ? ` · ${clock(d)} known` : ''} · {l.dir || l.root}</span></div>
              <span className="inline">
                <button className="btn" onClick={() => onPlay(l)}><Icon n="play" s={15} /> Play</button>
                <button className="btn ghost" onClick={() => onRename(l)}>Rename</button>
                <button className="icon danger" onClick={() => onDelete(l)} aria-label={`Delete ${l.name}`}><Icon n="trash" s={16} /></button>
              </span>
            </header>
            <ol>
              {l.items.map((n, i) => (
                <li key={n + i}>
                  <span className="num-b">{i + 1}</span><span className="pl-n" title={n}>{n.replace(/\.[^.]+$/, '')}</span>
                  <span className="inline">
                    <button className="icon sm" disabled={i === 0} onClick={() => onMove(l, i, -1)} aria-label="Move up"><Icon n="back" s={14} /></button>
                    <button className="icon sm flipv" disabled={i === l.items.length - 1} onClick={() => onMove(l, i, 1)} aria-label="Move down"><Icon n="back" s={14} /></button>
                  </span>
                </li>
              ))}
            </ol>
          </article>
        );
      })}
    </div>
  );
}

export const savedSub = (f: SavedFile) => `${bytes(f.size)} · ${ago(f.mtime)}`;
export const progPct = (p?: Prog) => (p && p.dur > 0 && !p.watched ? pct(p) : 0);