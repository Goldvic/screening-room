import { CSSProperties, useRef } from 'react';
import { Icon, Prog, SavedList, bytes, clock, hue, pct } from './lib';

export type HomeCard = { k: string; rid: number; dir: string; name: string; p?: Prog; offlineRel?: string };
export type SavedFile = { rel: string; name: string; size: number; mtime: number };

const ago = (t: number) => {
  const d = Math.floor((Date.now() - t * 1000) / 86400000);
  return d <= 0 ? 'today' : d === 1 ? 'yesterday' : d < 30 ? `${d} days ago` : new Date(t * 1000).toLocaleDateString();
};

// A horizontally scrolling row of cards with hover arrows.
export function Rail({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  const row = useRef<HTMLDivElement>(null);
  const go = (d: -1 | 1) => row.current?.scrollBy({ left: d * Math.max(260, (row.current?.clientWidth ?? 600) * 0.85), behavior: 'smooth' });
  return (
    <section className="rail">
      <div className="rail-h"><h2><i />{title}</h2>{hint && <span className="muted small">{hint}</span>}</div>
      <div className="rail-wrap">
        <button className="rail-arrow l" onClick={() => go(-1)} aria-label="Scroll left"><Icon n="back" s={18} /></button>
        <div className="rail-row" ref={row}>{children}</div>
        <button className="rail-arrow r" onClick={() => go(1)} aria-label="Scroll right"><Icon n="back" s={18} /></button>
      </div>
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

export type PoolItem = { k: string; title: string; art: React.ReactNode };

// Full-width cinematic header: what to watch right now, with the other unfinished videos as a quick switcher.
export function Hero({ title, line, eyebrow, art, onPlay, onMore, label, greeting, progress, left, pool, activeKey, onPick, onCustomize }: {
  title: string; line: string; eyebrow: string; art: React.ReactNode; onPlay: () => void; onMore?: () => void; label: string;
  greeting?: string; progress?: number; left?: string; pool?: PoolItem[]; activeKey?: string; onPick?: (k: string) => void; onCustomize?: () => void;
}) {
  return (
    <section className="hero v2">
      <div className="hero-art">{art}</div>
      <div className="hero-shade" />
      {(greeting || onCustomize) && (
        <div className="hero-top">
          <span className="hello">{greeting}</span>
          {onCustomize && <button className="btn ghost sm" onClick={onCustomize}><Icon n="sliders" s={14} /> Customise</button>}
        </div>
      )}
      <div className="hero-body">
        <span className="eyebrow">{eyebrow}</span>
        <h1>{title}</h1>
        {line && <p>{line}{left ? ` · ${left}` : ''}</p>}
        {progress ? <i className="hero-prog"><b style={{ width: `${progress}%` }} /></i> : null}
        <div className="inline">
          <button className="btn big" onClick={onPlay}><Icon n="play" s={18} /> {label}</button>
          {onMore && <button className="btn ghost big" onClick={onMore}><Icon n="info" s={16} /> Details</button>}
        </div>
      </div>
      {pool && pool.length > 1 && (
        <div className="hero-pool" role="tablist" aria-label="In progress">
          {pool.map((p) => (
            <button key={p.k} role="tab" aria-selected={p.k === activeKey} className={p.k === activeKey ? 'on' : ''} onClick={() => onPick?.(p.k)} title={p.title}>
              <span className="hp-art">{p.art}</span><span className="hp-t">{p.title}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}

// One calm strip: daily goal ring on the left, quick facts as links on the right.
export function Today({ minutes, goal, onGoal, facts }: { minutes: number; goal: number; onGoal: () => void; facts: { label: string; value: number | string; onClick?: () => void }[] }) {
  const f = Math.min(1, minutes / Math.max(1, goal)), C = 2 * Math.PI * 20;
  return (
    <section className="today">
      <button className="ring" onClick={onGoal} title="Change your daily goal">
        <svg viewBox="0 0 48 48" width="52" height="52"><circle cx="24" cy="24" r="20" className="ring-bg" /><circle cx="24" cy="24" r="20" className="ring-fg" strokeDasharray={`${C * f} ${C}`} transform="rotate(-90 24 24)" /></svg>
        <span><b>{minutes}</b><small>of {goal} min today</small></span>
      </button>
      <div className="today-facts">
        {facts.map((x) => (x.onClick
          ? <button key={x.label} onClick={x.onClick}><b>{x.value}</b><small>{x.label}</small></button>
          : <span key={x.label}><b>{x.value}</b><small>{x.label}</small></span>))}
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