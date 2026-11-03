import { useEffect, useState, useContext } from 'react';
import { SettingsCtx, Icon, bytes } from './lib';

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

export function Discover() {
  const { s } = useContext(SettingsCtx);
  const [tab, setTab] = useState<'new' | 'rec' | 'genres' | 'search' | 'queue' | 'history'>('new');
  const [items, setItems] = useState<BotItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState('');
  const [query, setQuery] = useState('');
  const [genres, setGenres] = useState<string[]>([]);
  const [selectedGenre, setSelectedGenre] = useState('');
  
  const [queue, setQueue] = useState<any[]>([]);
  const [history, setHistory] = useState<any[]>([]);

  const apiKey = s.botApiKey;
  const apiUrl = (s.botApiUrl || '').replace(/\/$/, '');
  const userId = s.telegramId;

  const fetchBot = async (path: string, options?: RequestInit) => {
    if (!apiKey || !apiUrl || !userId) throw new Error("Configure Bot API in Settings first.");
    const sep = path.includes('?') ? '&' : '?';
    const url = `${apiUrl}${path}${sep}user_id=${userId}`;
    const res = await fetch(url, {
      ...options,
      headers: { 'x-api-key': apiKey, ...(options?.headers || {}) }
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.detail || res.statusText);
    }
    return res.json();
  };

  const load = async () => {
    setLoading(true);
    setErr('');
    try {
      if (tab === 'new') {
        const data = await fetchBot('/api/latest');
        setItems(data.items);
      } else if (tab === 'rec') {
        const data = await fetchBot('/api/recommend');
        setItems(data.items.map((r: any) => r.hit));
      } else if (tab === 'genres') {
        const data = await fetchBot('/api/genres');
        setGenres(data.genres);
      } else if (tab === 'queue') {
        const data = await fetchBot('/api/queue');
        setQueue(data.items);
      } else if (tab === 'history') {
        const data = await fetchBot('/api/history');
        setHistory(data.items);
      }
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (tab !== 'queue' && tab !== 'history') load();
  }, [tab]);

  useEffect(() => {
    if (tab !== 'queue') return;
    load();
    const interval = setInterval(load, 3000);
    return () => clearInterval(interval);
  }, [tab, apiUrl, apiKey, userId]);

  const download = async (item: BotItem) => {
    try {
      setErr('');
      await fetchBot('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: parseInt(userId), result: item, adapter: item.adapter || item.source })
      });
      setTab('queue');
    } catch (e: any) {
      setErr(e.message);
    }
  };

  const cancel = async (jobId: string) => {
    try {
      await fetchBot('/api/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_id: parseInt(userId), job_id: jobId })
      });
      load();
    } catch (e: any) {
      setErr(e.message);
    }
  };

  if (!apiKey || !apiUrl || !userId) {
    return (
      <div className="home">
        <h1 className="page-h">Discover</h1>
        <p className="note err">Please configure your Telegram ID and Bot API credentials in Settings.</p>
      </div>
    );
  }

  const posterUrl = (title: string, year?: number) => `/api/poster?q=${encodeURIComponent(title)}&year=${year || 0}`;

  return (
    <div className="home">
      <div className="greet-top">
        <h1 className="page-h">Discover</h1>
      </div>

      <div className="pills" style={{ marginBottom: 24, flexWrap: 'wrap' }}>
        {(['new', 'rec', 'genres', 'search', 'queue', 'history'] as const).map(t => (
          <button key={t} className={tab === t ? 'pill on' : 'pill'} onClick={() => setTab(t)}>
            {t === 'new' ? '🔥 New' : t === 'rec' ? '🔮 For You' : t === 'genres' ? '🎭 Genres' : t === 'search' ? '🔎 Search' : t === 'queue' ? '📋 Queue' : '🕘 History'}
          </button>
        ))}
      </div>

      {err && <div className="note err">{err}</div>}

      {tab === 'search' && (
        <div className="lib-search c2" style={{ maxWidth: 600, marginBottom: 20 }}>
          <Icon n="search" s={16} />
          <input placeholder="Search movies or shows..." value={query} onChange={e => setQuery(e.target.value)} onKeyDown={e => e.key === 'Enter' && (async () => {
            if (!query) return;
            setLoading(true); setErr('');
            try {
              const data = await fetchBot(`/api/search?q=${encodeURIComponent(query)}`);
              setItems(data.items);
            } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
          })()} />
        </div>
      )}

      {tab === 'genres' && (
        <div className="pills" style={{ marginBottom: 20, flexWrap: 'wrap' }}>
          {genres.map(g => (
            <button key={g} className={selectedGenre === g ? 'pill on' : 'pill'} onClick={async () => {
              setSelectedGenre(g);
              setLoading(true); setErr('');
              try {
                const data = await fetchBot(`/api/genre?genre=${encodeURIComponent(g)}`);
                setItems(data.items);
              } catch (e: any) { setErr(e.message); } finally { setLoading(false); }
            }}>{g}</button>
          ))}
        </div>
      )}

      {loading && <p className="muted">Loading...</p>}

      {(tab === 'new' || tab === 'rec' || (tab === 'search' && items.length > 0) || (tab === 'genres' && selectedGenre && items.length > 0)) && !loading && (
        <ul className="posters portrait" style={{ listStyle: 'none', padding: 0 }}>
          {items.map((item, i) => (
            <li key={i} className="poster">
              <button className="poster-open" onClick={() => download(item)}>
                <span className="frame">
                   <img src={item.poster_url || posterUrl(item.title, item.year)} loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                   <span className="go"><Icon n="down" s={18} /></span>
                </span>
                <span className="p-name">{item.title}</span>
                <span className="small muted">{item.year || 'Unknown'}</span>
              </button>
            </li>
          ))}
        </ul>
      )}

      {tab === 'queue' && !loading && (
        <div className="dl-dock-body" style={{ background: 'transparent', padding: 0 }}>
          {queue.length === 0 && <p className="muted">Nothing downloading right now.</p>}
          {queue.map(job => (
            <div key={job.id} className="dl-dock-row" style={{ border: '1px solid var(--line)', borderRadius: 12, marginBottom: 10 }}>
              <div className="dl-dock-main">
                <strong>{job.title}</strong>
                <span className="muted">{job.status === 'downloading' ? `⬇️ ${job.episode ? job.episode + ' · ' : ''}${job.speed_mbps} MB/s` : job.status}</span>
                {job.status === 'downloading' && (
                  <i className="dl-dock-bar"><b style={{ width: `${job.progress_pct}%` }} /></i>
                )}
              </div>
              <div className="dl-dock-act">
                 <button className="btn ghost" onClick={() => cancel(job.id)}>Cancel</button>
              </div>
            </div>
          ))}
        </div>
      )}

      {tab === 'history' && !loading && (
        <div className="dl-dock-body" style={{ background: 'transparent', padding: 0 }}>
          {history.length === 0 && <p className="muted">No history yet.</p>}
          {history.map(row => (
            <div key={row.id} className="dl-dock-row" style={{ border: '1px solid var(--line)', borderRadius: 12, marginBottom: 10 }}>
              <div className="dl-dock-main">
                <strong>{row.title}</strong>
                <span className="muted">{row.status} · {bytes(row.size)}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}