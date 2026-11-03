import { useCallback, useContext, useEffect, useRef, useState } from 'react';
import { SettingsCtx, Icon, bytes, hue } from './lib';
// @ts-ignore -- CSS imports are handled by the bundler.
import './discover.css';
// @ts-ignore -- CSS imports are handled by the bundler.
import './discover-seasons.css';

type BotItem = {
  title: string;
  year?: number;
  category?: string;
  season?: number;
  episode?: number;
  source?: string;
  adapter?: string;
  page_url?: string;
  poster_url?: string;
};

type Tab = 'new' | 'rec' | 'genres' | 'search' | 'queue' | 'watching' | 'scheduled' | 'history';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'new', label: 'New', icon: 'bolt' },
  { id: 'rec', label: 'For You', icon: 'sparkle' },
  { id: 'genres', label: 'Genres', icon: 'grid' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'queue', label: 'Queue', icon: 'down' },
  { id: 'watching', label: 'Watching', icon: 'bookmark' },
  { id: 'scheduled', label: 'Scheduled', icon: 'clock' },
  { id: 'history', label: 'History', icon: 'clock' },
];

const SUBTITLE: Record<Tab, string> = {
  new: 'Freshly added movies and shows.',
  rec: 'Picked for you from what you watch.',
  genres: 'Pick a genre to browse.',
  search: 'Find any movie or show and send it to your server.',
  queue: 'What your server is downloading right now.',
  watching: 'Shows your bot checks for new episodes and downloads automatically.',
  scheduled: 'Downloads waiting for their start time.',
  history: 'Everything you have downloaded before.',
};

/* ---------- helpers ---------- */

// A poster URL from the bot can be relative ("/posters/x.jpg") – on localhost that would
// wrongly resolve against the Vite dev server. Always resolve against the bot's own address.
function resolveUrl(u: string | undefined, base: string): string {
  if (!u) return '';
  try { return new URL(u, base + '/').href; } catch { return ''; }
}

function useInView<T extends Element>() {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    if (typeof IntersectionObserver === 'undefined') { setSeen(true); return; }
    const io = new IntersectionObserver(([e]) => { if (e.isIntersecting) { setSeen(true); io.disconnect(); } }, { rootMargin: '300px' });
    io.observe(el);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen] as const;
}

// Same cleaning the bot uses (core/titles.display_name), so a watch made here matches what the bot's monitor compares.
const DASH = '(?:[–—\\-]|to)';
function botDisplayName(title: string): string {
  const original = (title || '').trim();
  let t = original.split(' | ')[0];
  t = t.replace(/\(\s*Episodes?\b[^)]*\)/gi, ' '); // "(Episode 3 Added)" is site noise, not part of the show name
  t = t.replace(/\(\s*Complet\w*[^)]*\)?/gi, ' ');
  t = t.replace(new RegExp(`\\bSeasons?\\s*\\d+(?:\\s*${DASH}\\s*\\d+)?(?:\\s*,?\\s*Episodes?\\s*\\d+(?:\\s*${DASH}\\s*\\d+)?)?`, 'gi'), ' ');
  t = t.replace(new RegExp(`\\bEpisodes?\\s*\\d+(?:\\s*${DASH}\\s*\\d+)?`, 'gi'), ' ');
  t = t.replace(/\bS\d{1,2}(?:\s*E\d{1,3})?\b/gi, ' ');
  t = t.replace(/\(\s*(?:19|20)\d{2}\s*\)/g, ' ');
  t = t.replace(/\s+/g, ' ').trim().replace(/^[ \-–—:|]+|[ \-–—:|]+$/g, '');
  return t || original || 'Untitled';
}
const watchQuery = (title: string) => botDisplayName(title).replace(/[^\p{L}\p{N}_\s]/gu, ' ').replace(/\s+/g, ' ').trim();
const when = (unix: number) => { try { return new Date(unix * 1000).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }); } catch { return ''; } };

const initials = (t: string) =>
  t.replace(/[^\p{L}\p{N} ]/gu, '').split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';

/* ---------- poster with a 3-step fallback ----------
   1. the poster the bot sent (resolved against the bot URL)
   2. the app's own TMDB poster  (/api/poster cleans the title, fetches from TMDB and caches it)
   3. a coloured placeholder with the title                                                  */
function Poster({ item, base }: { item: BotItem; base: string }) {
  const [ref, seen] = useInView<HTMLSpanElement>();
  const [stage, setStage] = useState<0 | 1 | 2>(item.poster_url ? 0 : 1);
  const [src, setSrc] = useState(() => resolveUrl(item.poster_url, base));
  const [ok, setOk] = useState(false);
  const [tries, setTries] = useState(0);
  const q = encodeURIComponent(item.title);
  const y = item.year || 0;

  // Stage 1: go straight to /api/poster. It strips junk like "S01 (Episode 3 Added) | Korean Drama",
  // looks the title up on TMDB, caches the poster and serves it. A 404 falls through to the placeholder.
  useEffect(() => {
    if (!seen || stage !== 1 || src) return;
    setSrc(`/api/poster?q=${q}&year=${y}&r=${tries}`);
  }, [seen, stage, src, q, y, tries]);

  // A lookup can fail for a moment (server restarting, slow network). Retry a few times before settling on the placeholder.
  const failed = () => {
    setOk(false);
    setSrc('');
    if (stage === 0) { setStage(1); return; }
    if (tries < 3) {
      const wait = [5000, 15000, 40000][tries];
      window.setTimeout(() => setTries(n => n + 1), wait);
      return;
    }
    setStage(2);
  };

  return (
    <span ref={ref} className="dc-poster-fill" style={{ position: 'absolute', inset: 0 }}>
      {!ok && stage < 2 && <span className="dc-shimmer" />}
      {(!ok) && (
        <span className="dc-ph" style={{ ['--h' as any]: hue(item.title) }}>
          {stage === 2 && (<><b>{initials(item.title)}</b><i>{item.title}</i></>)}
        </span>
      )}
      {src && stage < 2 && (
        <img
          className={ok ? 'dc-img on' : 'dc-img'}
          src={src}
          alt=""
          loading="lazy"
          referrerPolicy="no-referrer"
          onLoad={() => setOk(true)}
          onError={failed}
        />
      )}
    </span>
  );
}


/* ---------- season / episode browser ----------
   Asks the bot for every season it can find for this show, then lets you pick episodes. */
type Ep = { season: number; episode: number; url?: string };
type SeasonInfo = {
  season: number; title: string; adapter: string; source: string; page_url: string;
  year?: number; complete: boolean; episodes: Ep[] | null; result: any;
};

const isSeries = (i: BotItem) => !!i.season || /\bseason\b|\bepisode\b|\bS\d{1,2}\b/i.test(i.title);

function SeasonBrowser({ item, fetchBot, busy, onGo }: {
  item: BotItem;
  fetchBot: (path: string) => Promise<any>;
  busy: boolean;
  onGo: (result: any, episodes: number[] | undefined, label: string) => void;
}) {
  const [seasons, setSeasons] = useState<SeasonInfo[] | null>(null);
  const [err, setErr] = useState('');
  const [cur, setCur] = useState<number | null>(null);
  const [eps, setEps] = useState<Record<number, Ep[]>>({});
  const [busyEps, setBusyEps] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());

  const openSeason = useCallback(async (s: SeasonInfo) => {
    setCur(s.season); setSel(new Set()); setErr('');
    if (s.episodes) { setEps(m => ({ ...m, [s.season]: s.episodes as Ep[] })); return; }
    if (eps[s.season]) return;
    setBusyEps(true);
    try {
      const d = await fetchBot(`/api/season?page_url=${encodeURIComponent(s.page_url)}&season=${s.season}`);
      setEps(m => ({ ...m, [s.season]: d.episodes || [] }));
    } catch (e: any) { setErr(e.message); }
    finally { setBusyEps(false); }
  }, [fetchBot, eps]);

  useEffect(() => {
    let dead = false;
    setSeasons(null); setErr(''); setCur(null); setEps({}); setSel(new Set());
    fetchBot(`/api/show?title=${encodeURIComponent(item.title)}`)
      .then(d => {
        if (dead) return;
        const list: SeasonInfo[] = d.seasons || [];
        setSeasons(list);
        const start = list.find(s => s.season === item.season) ?? list[0];
        if (start) openSeason(start);
      })
      .catch(e => { if (!dead) { setErr(e.message); setSeasons([]); } });
    return () => { dead = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [item.title]);

  const season = seasons?.find(s => s.season === cur) ?? null;
  const list = (cur != null && eps[cur]) || [];
  const toggle = (n: number) => setSel(p => { const x = new Set(p); x.has(n) ? x.delete(n) : x.add(n); return x; });
  const go = () => {
    if (!season) return;
    const chosen = [...sel].sort((a, b) => a - b);
    onGo({ ...season.result, _episodes: list }, chosen.length ? chosen : undefined,
      chosen.length ? `${season.title} · ${chosen.length} episode${chosen.length > 1 ? 's' : ''}` : season.title);
  };

  if (seasons === null) return <div className="dc-seasons"><p className="dc-note"><span className="dc-spin" />Looking for every season…</p></div>;
  if (!seasons.length) return <div className="dc-seasons"><p className={err ? 'dc-note err' : 'dc-note'}>{err || 'Your sources only list this one item for this show.'}</p></div>;

  return (
    <div className="dc-seasons">
      <h3>Seasons <span>{seasons.length} found</span></h3>
      <div className="dc-schips">
        {seasons.map(s => (
          <button key={s.season} className={cur === s.season ? 'dc-sch on' : 'dc-sch'} onClick={() => openSeason(s)}>
            Season {s.season}{s.episodes ? ` · ${s.episodes.length}` : ''}
          </button>
        ))}
      </div>
      {err && <p className="dc-note err">{err}</p>}
      {busyEps && <p className="dc-note"><span className="dc-spin" />Reading the episode list…</p>}
      {season && !busyEps && (
        list.length === 0
          ? <p className="dc-note">No episode list found for this season. “Download season” will still try the whole page.</p>
          : <>
              <div className="dc-seasons-bar">
                <span className="dc-note">{list.length} episode{list.length > 1 ? 's' : ''} · {season.source}{season.complete ? ' · complete' : ''}</span>
                <span className="sp" />
                <button className="dc-link" onClick={() => setSel(new Set(list.map(e => e.episode)))}>Select all</button>
                <button className="dc-link" onClick={() => setSel(new Set())}>Clear</button>
              </div>
              <div className="dc-eps">
                {list.map(e => (
                  <button key={e.episode} className={sel.has(e.episode) ? 'dc-ep on' : 'dc-ep'} onClick={() => toggle(e.episode)} title={`Season ${e.season} Episode ${e.episode}`}>
                    E{e.episode}
                  </button>
                ))}
              </div>
            </>
      )}
      {season && !busyEps && (
        <div className="dc-seasons-bar">
          <button className="dc-dlsel" disabled={busy} onClick={go}>
            <Icon n="down" s={15} />
            {sel.size ? `Download ${sel.size} selected` : `Download season ${season.season}`}
          </button>
        </div>
      )}
    </div>
  );
}

function Card({ item, base, onOpen }: { item: BotItem; base: string; onOpen: (i: BotItem) => void }) {
  const badge = item.season ? `S${item.season}${item.episode ? ` · E${item.episode}` : ''}` : item.category || '';
  return (
    <li className="dc-card">
      <button className="dc-open" onClick={() => onOpen(item)} aria-label={`Open ${item.title}`}>
        <span className="dc-poster">
          <Poster item={item} base={base} />
          {badge && <span className="dc-badge">{badge}</span>}
          <span className="dc-over"><span className="dc-pill"><Icon n="down" s={15} /> Download</span></span>
        </span>
        <span className="dc-title">{item.title}</span>
        <span className="dc-sub">{[item.year || null, item.source].filter(Boolean).join(' · ') || 'Unknown'}</span>
      </button>
    </li>
  );
}

function Skeleton({ n = 12 }: { n?: number }) {
  return (
    <ul className="dc-grid dc-skel" aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <li key={i}>
          <span className="dc-poster"><span className="dc-shimmer" /></span>
          <div className="dc-line" /><div className="dc-line s" />
        </li>
      ))}
    </ul>
  );
}

function Empty({ icon, title, text }: { icon: string; title: string; text?: string }) {
  return (
    <div className="dc-empty">
      <Icon n={icon} s={34} />
      <h3>{title}</h3>
      {text && <p>{text}</p>}
    </div>
  );
}

/* ---------- page ---------- */

export function Discover() {
  const { s } = useContext(SettingsCtx);
  const apiKey = s.botApiKey;
  const apiUrl = (s.botApiUrl || '').replace(/\/$/, '');
  const userId = s.telegramId;
  const ready = !!(apiKey && apiUrl && userId);

  const [tab, setTab] = useState<Tab>('new');
  const [items, setItems] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [genre, setGenre] = useState('');
  const [queue, setQueue] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);
  const [watches, setWatches] = useState<any[]>([]);
  const [scheduled, setScheduled] = useState<any[]>([]);
  const [trailer, setTrailer] = useState<{ title: string; key: string } | null>(null);
  const [trailerBusy, setTrailerBusy] = useState(false);
  const [pick, setPick] = useState<BotItem | null>(null);
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState('');
  const req = useRef(0); // ignore answers that arrive after the user already moved on

  const fetchBot = useCallback(async (path: string, options?: RequestInit) => {
    if (!ready) throw new Error('Configure Bot API in Settings first.');
    const url = `${apiUrl}${path}${path.includes('?') ? '&' : '?'}user_id=${encodeURIComponent(userId)}`;
    let res: Response;
    try {
      res = await fetch(url, { ...options, headers: { 'x-api-key': apiKey, ...(options?.headers || {}) } });
    } catch {
      throw new Error(`Cannot reach the bot at ${apiUrl}. Check the address in Settings and that the server is running.`);
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || res.statusText || `Bot answered ${res.status}`);
    }
    return res.json();
  }, [ready, apiUrl, apiKey, userId]);

  const flash = (m: string) => { setToast(m); window.setTimeout(() => setToast(''), 6000); };

  // Load whatever the current tab needs. `silent` = background refresh (no skeleton flicker).
  const load = useCallback(async (t: Tab, silent = false) => {
    const id = ++req.current;
    if (!silent) { setLoading(true); setErr(''); }
    try {
      if (t === 'new') { const d = await fetchBot('/api/latest'); if (id === req.current) setItems(d.items || []); }
      else if (t === 'rec') { const d = await fetchBot('/api/recommend'); if (id === req.current) setItems((d.items || []).map((r: any) => r.hit || r)); }
      else if (t === 'genres') { const d = await fetchBot('/api/genres'); if (id === req.current) setGenres(d.genres || []); }
      else if (t === 'queue') { const d = await fetchBot('/api/queue'); if (id === req.current) setQueue(d.items || []); }
      else if (t === 'watching') { const d = await fetchBot('/api/watching'); if (id === req.current) setWatches(d.items || []); }
      else if (t === 'scheduled') { const d = await fetchBot('/api/scheduled'); if (id === req.current) setScheduled(d.items || []); }
      else if (t === 'history') { const d = await fetchBot('/api/history'); if (id === req.current) setHistory(d.items || []); }
    } catch (e: any) {
      if (id === req.current && !silent) setErr(e.message);
    } finally {
      if (id === req.current && !silent) setLoading(false);
    }
  }, [fetchBot]);

  // switching tab: clear the grid so the previous tab's posters never flash, then load
  useEffect(() => {
    if (!ready) return;
    setErr('');
    if (tab === 'new' || tab === 'rec') setItems([]);
    if (tab === 'genres') { setItems([]); setGenre(''); }
    if (tab === 'search') { setItems([]); setSearched(''); }
    if (tab !== 'search') load(tab);
    else setLoading(false);
  }, [tab, ready, load]);

  // queue refreshes itself while you look at it
  useEffect(() => {
    if (tab !== 'queue' || !ready) return;
    const t = setInterval(() => load('queue', true), 3000);
    return () => clearInterval(t);
  }, [tab, ready, load]);

  // keep the little Queue counter fresh from anywhere
  useEffect(() => {
    if (!ready || tab === 'queue') return;
    fetchBot('/api/queue').then(d => setQueue(d.items || [])).catch(() => {});
  }, [ready, tab, fetchBot]);

  const runSearch = async () => {
    const q = query.trim();
    if (!q) return;
    const id = ++req.current;
    setLoading(true); setErr(''); setSearched(q);
    try { const d = await fetchBot(`/api/search?q=${encodeURIComponent(q)}`); if (id === req.current) setItems(d.items || []); }
    catch (e: any) { if (id === req.current) { setErr(e.message); setItems([]); } }
    finally { if (id === req.current) setLoading(false); }
  };

  const pickGenre = async (g: string) => {
    const id = ++req.current;
    setGenre(g); setLoading(true); setErr(''); setItems([]);
    try { const d = await fetchBot(`/api/genre?genre=${encodeURIComponent(g)}`); if (id === req.current) setItems(d.items || []); }
    catch (e: any) { if (id === req.current) setErr(e.message); }
    finally { if (id === req.current) setLoading(false); }
  };

  const download = async (item: BotItem, episodes?: number[], label?: string) => {
    setBusy(true); setErr('');
    try {
      await fetchBot('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: parseInt(userId, 10), result: item, adapter: item.adapter || item.source, ...(episodes?.length ? { episodes } : {}) }),
      });
      setPick(null);
      flash(`Added “${label || item.title}” to the queue`);
      setTab('queue');
    } catch (e: any) { setErr(e.message); setPick(null); }
    finally { setBusy(false); }
  };

  const cancel = async (jobId: string) => {
    try {
      await fetchBot('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: parseInt(userId, 10), job_id: jobId }),
      });
      load('queue', true);
    } catch (e: any) { setErr(e.message); }
  };

  const watchShow = async (item: BotItem) => {
    const source = item.adapter || item.source || '';
    if (!source) { setErr('This title has no source, so it cannot be watched.'); return; }
    setBusy(true); setErr('');
    try {
      await fetchBot('/api/watching', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: parseInt(userId, 10), chat_id: 0, source,
          query: watchQuery(item.title), show_key: watchQuery(item.title).toLowerCase(),
          title: item.title, last_season: item.season || 0, last_episode: item.episode || 0,
        }),
      });
      setPick(null);
      flash(`Watching “${botDisplayName(item.title)}” for new episodes`);
      load('watching', true);
    } catch (e: any) { setErr(e.message); }
    finally { setBusy(false); }
  };

  const unwatch = async (id: number) => {
    try { await fetchBot(`/api/watching/${id}`, { method: 'DELETE' }); setWatches(w => w.filter(x => x.id !== id)); }
    catch (e: any) { setErr(e.message); }
  };

  const unschedule = async (id: number) => {
    try { await fetchBot(`/api/scheduled/${id}`, { method: 'DELETE' }); setScheduled(w => w.filter(x => x.id !== id)); }
    catch (e: any) { setErr(e.message); }
  };

  const watchTrailer = async (item: BotItem) => {
    setTrailerBusy(true); setErr('');
    try {
      const name = botDisplayName(item.title).replace(/\s*\|.*$/, '');
      const kind = isSeries(item) ? 'tv' : item.category === 'movie' ? 'movie' : '';
      const r = await fetch(`/api/trailer?q=${encodeURIComponent(name)}&year=${item.year || 0}&kind=${kind}`);
      const d = await r.json().catch(() => null);
      if (!d) throw new Error(r.status === 404
        ? 'Your Cinema server has no /api/trailer route yet. Add it to server/index.ts and let it restart.'
        : `Trailer lookup failed (server answered ${r.status}).`);
      if (!r.ok) throw new Error(d.error || 'Could not look up the trailer.');
      if (!d.key) { flash('No trailer found for this title'); return; }
      setTrailer({ title: item.title, key: d.key });
    } catch (e: any) { console.error('[trailer]', e); flash(e.message || 'Trailer failed'); }
    finally { setTrailerBusy(false); }
  };

  useEffect(() => {
    if (!pick) return;
    const k = (e: KeyboardEvent) => { if (e.key !== 'Escape') return; if (trailer) setTrailer(null); else setPick(null); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [pick, trailer]);

  /* ----- not configured ----- */
  if (!ready) {
    return (
      <div className="home dc">
        <div className="dc-head"><div><h1>Discover</h1><p>{SUBTITLE.new}</p></div></div>
        <Empty icon="server" title="Connect your bot first" text="Open Settings → Bot and fill in the Bot API address, API key and your Telegram ID. Then come back here." />
      </div>
    );
  }

  const planTitle = (r: any) => { try { return JSON.parse(r.plan_json || '{}').title || 'Scheduled download'; } catch { return 'Scheduled download'; } };
  const active = queue.filter(j => j.status === 'downloading' || j.status === 'queued').length;
  const showGrid = tab === 'new' || tab === 'rec' || tab === 'search' || tab === 'genres';

  return (
    <div className="home dc">
      <div className="dc-head">
        <div>
          <h1>Discover</h1>
          <p>{SUBTITLE[tab]}</p>
        </div>
        {tab !== 'search' && tab !== 'genres' && (
          <button className="dc-refresh" disabled={loading} onClick={() => load(tab)}><Icon n="rotate" s={15} /> Refresh</button>
        )}
      </div>

      <nav className="dc-tabs" role="tablist">
        {TABS.map(t => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'dc-tab on' : 'dc-tab'} onClick={() => setTab(t.id)}>
            <Icon n={t.icon} s={15} /> {t.label}
            {t.id === 'queue' && active > 0 && <span className="dc-count">{active}</span>}
            {t.id === 'watching' && watches.length > 0 && <span className="dc-count">{watches.length}</span>}
          </button>
        ))}
      </nav>

      {err && <div className="dc-err"><Icon n="info" s={16} /> {err}</div>}

      {tab === 'search' && (
        <form className="dc-search" onSubmit={e => { e.preventDefault(); runSearch(); }}>
          <label className="dc-field">
            <Icon n="search" s={17} />
            <input autoFocus placeholder="Search movies or shows…" value={query} onChange={e => setQuery(e.target.value)} />
          </label>
          <button className="dc-go" type="submit" disabled={loading || !query.trim()}>Search</button>
        </form>
      )}

      {tab === 'genres' && (
        <div className="dc-chips">
          {genres.map(g => (
            <button key={g} className={genre === g ? 'dc-chip on' : 'dc-chip'} onClick={() => pickGenre(g)}>{g}</button>
          ))}
        </div>
      )}

      {/* grids */}
      {showGrid && loading && <Skeleton />}

      {showGrid && !loading && items.length > 0 && (
        <section>
          {(tab === 'search' || tab === 'genres') && (
            <h2 className="dc-label">{tab === 'search' ? `Results for “${searched}”` : genre}<span>{items.length} titles</span></h2>
          )}
          <ul className="dc-grid">
            {items.map((item, i) => <Card key={`${item.title}-${item.year}-${i}`} item={item} base={apiUrl} onOpen={setPick} />)}
          </ul>
        </section>
      )}

      {showGrid && !loading && items.length === 0 && !err && (
        tab === 'search'
          ? (searched ? <Empty icon="film" title="Nothing found" text={`No results for “${searched}”. Try a different spelling or fewer words.`} />
                      : <Empty icon="search" title="Search anything" text="Type a movie or show name above and press Enter." />)
          : tab === 'genres'
            ? (!genre && genres.length > 0 ? <Empty icon="grid" title="Choose a genre" text="Pick one of the genres above to see what is available." /> : genre ? <Empty icon="film" title="Nothing in this genre yet" /> : null)
            : <Empty icon="film" title="Nothing here yet" text="The bot did not return any titles. Hit Refresh in a moment." />
      )}

      {/* queue */}
      {tab === 'queue' && (
        queue.length === 0
          ? (!loading && <Empty icon="down" title="Nothing downloading" text="Pick a title from New, For You or Search and it will show up here." />)
          : (
            <div className="dc-rows">
              {queue.map(job => (
                <div key={job.id} className={`dc-row ${job.status}`}>
                  <span className="dc-ico"><Icon n={job.status === 'downloading' ? 'down' : 'clock'} s={20} /></span>
                  <div className="dc-main">
                    <strong title={job.title}>{job.title}</strong>
                    <div className="dc-meta">
                      <span className={`dc-status ${job.status}`}>{job.status}</span>
                      {job.status === 'downloading' && <>
                        {job.episode && <span>{job.episode}</span>}
                        <span>{job.speed_mbps} MB/s</span>
                        <span>{Math.round(job.progress_pct || 0)}%</span>
                      </>}
                    </div>
                    {job.status === 'downloading' && <i className="dc-bar"><b style={{ width: `${Math.min(100, job.progress_pct || 0)}%` }} /></i>}
                  </div>
                  <button className="dc-x" onClick={() => cancel(job.id)}>Cancel</button>
                </div>
              ))}
            </div>
          )
      )}

      {/* watching */}
      {tab === 'watching' && (
        loading ? <Skeleton n={0} /> :
        watches.length === 0
          ? <Empty icon="bookmark" title="Not watching anything" text="Open a series from New or Search and press “Watch for new episodes”. Your bot will download new episodes as they appear." />
          : (
            <div className="dc-rows">
              {watches.map(w => (
                <div key={w.id} className="dc-row">
                  <span className="dc-ico"><Icon n="bookmark" s={20} /></span>
                  <div className="dc-main">
                    <strong title={w.title || w.query}>{w.title || w.query}</strong>
                    <div className="dc-meta">
                      <span className="dc-status downloading">watching</span>
                      <span>{w.source}</span>
                      <span>Last seen S{String(w.last_season || 0).padStart(2, '0')}E{String(w.last_episode || 0).padStart(2, '0')}</span>
                      {w.last_checked ? <span>Checked {String(w.last_checked).replace('T', ' ')}</span> : <span>Not checked yet</span>}
                    </div>
                  </div>
                  <button className="dc-x" onClick={() => unwatch(w.id)}>Stop</button>
                </div>
              ))}
            </div>
          )
      )}

      {/* scheduled */}
      {tab === 'scheduled' && (
        loading ? <Skeleton n={0} /> :
        scheduled.length === 0
          ? <Empty icon="clock" title="Nothing scheduled" text="Downloads you schedule from the bot will wait here until their start time." />
          : (
            <div className="dc-rows">
              {scheduled.map(r => (
                <div key={r.id} className="dc-row">
                  <span className="dc-ico"><Icon n="clock" s={20} /></span>
                  <div className="dc-main">
                    <strong title={planTitle(r)}>{planTitle(r)}</strong>
                    <div className="dc-meta">
                      <span className="dc-status">pending</span>
                      <span>Starts {when(r.scheduled_at)}</span>
                    </div>
                  </div>
                  <button className="dc-x" onClick={() => unschedule(r.id)}>Remove</button>
                </div>
              ))}
            </div>
          )
      )}

      {/* history */}
      {tab === 'history' && (
        loading ? <Skeleton n={0} /> :
        history.length === 0
          ? <Empty icon="clock" title="No history yet" text="Finished downloads will be listed here." />
          : (
            <div className="dc-rows">
              {history.map(row => (
                <div key={row.id} className={`dc-row ${row.status}`}>
                  <span className="dc-ico"><Icon n={row.status === 'failed' || row.status === 'error' ? 'close' : 'check'} s={20} /></span>
                  <div className="dc-main">
                    <strong title={row.title}>{row.title}</strong>
                    <div className="dc-meta">
                      <span className={`dc-status ${row.status}`}>{row.status}</span>
                      {row.size ? <span>{bytes(row.size)}</span> : null}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )
      )}

      {/* detail sheet – nothing downloads until you press the button */}
      {pick && (
        <div className="dc-modal" onClick={() => setPick(null)}>
          <div className="dc-sheet" role="dialog" aria-modal="true" aria-label={pick.title} onClick={e => e.stopPropagation()}>
            <button className="dc-close" onClick={() => setPick(null)} aria-label="Close"><Icon n="close" s={16} /></button>
            <span className="dc-poster"><Poster item={pick} base={apiUrl} /></span>
            <div className="dc-info">
              <h2>{pick.title}</h2>
              <div className="dc-tags">
                {pick.year ? <span className="dc-tag">{pick.year}</span> : null}
                {pick.category && <span className="dc-tag">{pick.category}</span>}
                {pick.season ? <span className="dc-tag">Season {pick.season}{pick.episode ? ` · Episode ${pick.episode}` : ''}</span> : null}
                {pick.source && <span className="dc-tag">{pick.source}</span>}
              </div>
              <p>This will be downloaded to your server. You can watch its progress in the Queue tab and play it from your Library when it finishes.</p>
              {isSeries(pick) && <SeasonBrowser key={pick.title} item={pick} fetchBot={fetchBot} busy={busy} onGo={(r, e, l) => download(r, e, l)} />}
              <div className="dc-acts">
                <button className="dc-big" disabled={busy} onClick={() => download(pick)}><Icon n="down" s={18} /> {busy ? 'Adding…' : isSeries(pick) ? 'Download this listing' : 'Download'}</button>
                {isSeries(pick) && (
                  <button className="dc-ghost" disabled={busy} onClick={() => watchShow(pick)}><Icon n="bookmark" s={16} /> Watch for new episodes</button>
                )}
                <button className="dc-ghost" disabled={trailerBusy} onClick={() => watchTrailer(pick)}><Icon n="play" s={16} /> {trailerBusy ? 'Finding…' : 'Watch trailer'}</button>
                <button className="dc-ghost" onClick={() => setPick(null)}>Cancel</button>
              </div>
            </div>
          </div>
        </div>
      )}

      {trailer && (
        <div className="dc-modal dc-tmodal" onClick={() => setTrailer(null)}>
          <div className="dc-tbox" onClick={e => e.stopPropagation()}>
            <button className="dc-close" onClick={() => setTrailer(null)} aria-label="Close trailer"><Icon n="close" s={16} /></button>
            <div className="dc-frame">
              <iframe
                src={`https://www.youtube-nocookie.com/embed/${trailer.key}?autoplay=1&rel=0&playsinline=1`}
                title={`Trailer: ${trailer.title}`}
                allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
                allowFullScreen
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>
            <p className="dc-note">
              Trailer for {botDisplayName(trailer.title)}. If YouTube asks you to sign in or says it cannot play it here,{' '}
              <a className="dc-link" href={`https://www.youtube.com/watch?v=${trailer.key}`} target="_blank" rel="noreferrer">open it on YouTube</a>.
            </p>
          </div>
        </div>
      )}

      {toast && <div className="dc-toast"><Icon n="check" s={16} /> {toast}</div>}
    </div>
  );
}