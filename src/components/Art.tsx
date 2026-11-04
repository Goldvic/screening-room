import { useContext, useEffect, useRef, useState } from 'react';
import { SettingsCtx, Icon, api, parseTitle, qs } from '../lib';

// ---------- TMDB lookups (shared by Art and Details) ----------
// Fetched a few at a time so a grid of 200 posters doesn't flood TMDB.
let gateN = 0;
const gateQ: (() => void)[] = [];
const gate = async <T,>(fn: () => Promise<T>): Promise<T> => {
  while (gateN >= 3) await new Promise<void>((r) => gateQ.push(r));
  gateN++;
  try { return await fn(); } finally { gateN--; gateQ.shift()?.(); }
};

export type Meta = { found: boolean; title?: string; year?: number; overview?: string; rating?: number; genres?: string[]; poster?: boolean };
const metaCache = new Map<string, Promise<Meta | null>>();

export const getMeta = (name: string, folder = ''): Promise<Meta | null> => {
  const t = parseTitle(name, folder), key = `${t.title}|${t.year}`;
  let p = metaCache.get(key);
  if (!p) {
    p = gate(() => api<Meta>('meta', { q: t.title, year: t.year })).catch(() => null);
    metaCache.set(key, p);
  }
  return p;
};

export const posterUrl = (name: string, folder = '') => {
  const t = parseTitle(name, folder);
  return `/api/poster?${qs({ q: t.title, year: t.year })}`;
};

export const folderPosterUrl = (root: number, folder: string) =>
  `/api/folder-poster?${qs({ root, path: folder })}`;

// Forget a cached lookup (used by Details after "Wrong match? → choose").
export const forgetMeta = (name: string, folder = '') => {
  const t = parseTitle(name, folder);
  metaCache.delete(`${t.title}|${t.year}`);
};

// ---------- <Thumb> ----------
export function Thumb({ root, path, v, icon }: { root: number; path: string; v: number; icon: string }) {
  const { s } = useContext(SettingsCtx);
  const [ok, setOk] = useState(true);
  const [loaded, setLoaded] = useState(false);
  return (
    <>
      <span className="ph"><Icon n={icon} s={28} /></span>
      {s.thumbs && ok && (
        <img
          className={loaded ? 'on' : ''}
          loading="lazy"
          decoding="async"
          alt=""
          src={`/api/thumb?${qs({ root, path, v })}`}
          onLoad={() => setLoaded(true)}
          onError={() => setOk(false)}
        />
      )}
    </>
  );
}

// ---------- <Art> ----------
export function Art({ root, path, v, name }: { root: number; path: string; v: number; name: string }) {
  const { s } = useContext(SettingsCtx);
  const ref = useRef<HTMLSpanElement>(null);
  const [state, setState] = useState<'idle' | 'ok' | 'none'>('idle');

  useEffect(() => {
    if (!s.posters || state !== 'idle' || !ref.current) return;
    const io = new IntersectionObserver((es) => {
      if (!es.some((e) => e.isIntersecting)) return;
      io.disconnect();
      getMeta(name, path.split('/').slice(0, -1).join('/')).then((m) => setState(m?.poster ? 'ok' : 'none'));
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [s.posters, state, name]);

  return (
    <span className="art" ref={ref}>
      <Thumb root={root} path={path} v={v} icon="film" />
      {s.posters && state === 'ok' && (
        <img
          className="poster-img on"
          alt=""
          loading="lazy"
          src={posterUrl(name, path.split('/').slice(0, -1).join('/'))}
          onError={() => setState('none')}
        />
      )}
    </span>
  );
}