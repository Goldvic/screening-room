import { useEffect, useState } from 'react';
import { ItemMeta } from '../Extras';
import { Stars, TagsEditor } from '../Extras';
import { Icon, Prog, api, bytes, clock, parseTitle, post } from '../lib';
import { Meta, forgetMeta, posterUrl } from './Art';

export function Details({ name, folder, meta, allTags, onMeta, remote, onClose, onPlay, onSave, size, prog }: {
  size?: number; prog?: Prog; name: string; folder: string; meta: ItemMeta; allTags: string[];
  onMeta: (p: Partial<ItemMeta>) => void; remote: boolean;
  onClose: () => void; onPlay: () => void; onSave: () => void;
}) {
  const [m, setM] = useState<Meta | null | undefined>(undefined);
  const [err, setErr] = useState('');
  const t = parseTitle(name, folder);
  const [fix, setFix] = useState(false);
  const [fq, setFq] = useState('');
  const [cands, setCands] = useState<{ id: number; kind: string; title: string; year: number; poster: string; overview: string }[]>([]);
  const [fbusy, setFbusy] = useState(false);
  const [pv, setPv] = useState(0);

  const search = async () => {
    setFbusy(true);
    try { setCands((await api<{ items: typeof cands }>('meta/search', { q: fq || t.title })).items); }
    catch (e: any) { setErr(e.message); }
    setFbusy(false);
  };

  const choose = async (c: (typeof cands)[number]) => {
    setFbusy(true);
    try {
      const nm = await post<Meta>('meta/choose', { q: t.title, year: t.year, id: c.id, kind: c.kind });
      forgetMeta(name, folder);
      setM(nm); setFix(false); setErr(''); setPv((x) => x + 1);
    } catch (e: any) { setErr(e.message); }
    setFbusy(false);
  };

  useEffect(() => {
    api<Meta>('meta', { q: t.title, year: t.year }).then(setM).catch((e) => { setErr(e.message); setM(null); });
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [name]); // eslint-disable-line react-hooks/exhaustive-deps

  const title = m?.title ?? t.title;
  const yr = m?.year ?? t.year;
  const part = !!prog && !prog.watched && prog.pos > 30;
  const label = part ? 'Resume' : prog?.watched ? 'Watch again' : 'Play';

  return (
    <div className="scrim dt-scrim" onClick={onClose}>
      <div className="dt" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="About this video">
        {m?.poster && <div className="dt-bg" aria-hidden="true" style={{ backgroundImage: `url(${posterUrl(name, folder)}&r=${pv})` }} />}
        <button className="dt-close" onClick={onClose} aria-label="Close"><Icon n="close" s={18} /></button>
        <div className="dt-main">
          <div className="dt-poster">{m?.poster ? <img alt="" src={`${posterUrl(name, folder)}&r=${pv}`} /> : <span className="dt-ph"><Icon n="film" s={38} /></span>}</div>
          <div className="dt-info">
            <div className="dt-chips">
              {yr ? <span>{yr}</span> : null}
              {m?.rating ? <span className="dt-star">★ {m.rating}</span> : null}
              {(m?.genres ?? []).slice(0, 3).map((g) => <span key={g}>{g}</span>)}
              {prog?.watched && <span className="dt-ok"><Icon n="check" s={12} /> Watched</span>}
            </div>
            <h2>{title}</h2>
            {m === undefined && <div className="dt-skel"><i /><i /><i /></div>}
            {m?.found && <p className="dt-over">{m.overview || 'No description available.'}</p>}
            {m && !m.found && <p className="muted">Nothing found for “{t.title}”. You can search for it below.</p>}
            {err && <p className="muted small">{err}</p>}
            {part && prog && (
              <div className="dt-prog">
                <i className="bar"><b style={{ width: `${Math.min(100, (prog.pos / Math.max(1, prog.dur)) * 100)}%` }} /></i>
                <span className="small muted">{clock(prog.pos)} watched{prog.dur > prog.pos ? ` · ${clock(prog.dur - prog.pos)} left` : ''}</span>
              </div>
            )}
            <div className="dt-actions">
              <button className="btn big" onClick={onPlay}><Icon n="play" s={16} /> {label}</button>
              {remote && <button className="btn ghost big" onClick={onSave}><Icon n="save" s={16} /> Save offline</button>}
            </div>
          </div>
        </div>
        <div className="dt-grid">
          <section><h4>Your rating</h4><Stars value={meta.r ?? 0} onChange={(n) => onMeta({ r: n })} /></section>
          <section><h4>Tags</h4><TagsEditor tags={meta.t ?? []} all={allTags} onChange={(t) => onMeta({ t })} /></section>
        </div>
        <div className="dt-foot">
          <span className="dt-file" title={name}><Icon n="film" s={14} /> <span>{name}</span>{size ? <em>{bytes(size)}</em> : null}</span>
          <button className="dt-link" onClick={() => { setFix(!fix); setFq(t.title); setCands([]); }}>{m?.found ? 'Wrong match?' : 'Find it manually'}</button>
        </div>
        {fix && (
          <div className="fixbox">
            <span className="inline">
              <input autoFocus value={fq} onChange={(e) => setFq(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && search()} placeholder="Type the real title" />
              <button className="btn" disabled={fbusy} onClick={search}>Search</button>
            </span>
            {cands.map((c) => (
              <button key={c.kind + c.id} className="cand" onClick={() => choose(c)}>
                {c.poster ? <img alt="" src={c.poster} /> : <span className="cand-ph"><Icon n="film" s={18} /></span>}
                <span><b>{c.title}{c.year ? ` (${c.year})` : ''}</b><small>{c.kind === 'tv' ? 'Series' : 'Movie'} · {c.overview.slice(0, 90)}{c.overview.length > 90 ? '…' : ''}</small></span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}