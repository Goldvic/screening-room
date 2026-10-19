import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { HttpError } from './backend';

const UA = 'Cinema v1.0';
const GENRES: Record<number, string> = {
  28: 'Action', 12: 'Adventure', 16: 'Animation', 35: 'Comedy', 80: 'Crime', 99: 'Documentary', 18: 'Drama', 10751: 'Family',
  14: 'Fantasy', 36: 'History', 27: 'Horror', 10402: 'Music', 9648: 'Mystery', 10749: 'Romance', 878: 'Sci-Fi', 10770: 'TV Movie',
  53: 'Thriller', 10752: 'War', 37: 'Western', 10759: 'Action & Adventure', 10762: 'Kids', 10763: 'News', 10764: 'Reality',
  10765: 'Sci-Fi & Fantasy', 10766: 'Soap', 10767: 'Talk', 10768: 'War & Politics',
};

export type Meta = { found: boolean; title?: string; year?: number; overview?: string; rating?: number; genres?: string[]; kind?: string; poster?: boolean };

export class Online {
  constructor(private dir: string, private cfg: () => { tmdbKey: string; osKey: string; osUser: string; osPass: string }) {
    fs.mkdirSync(dir, { recursive: true });
  }
  private keyOf(q: string, year: number) { return createHash('sha1').update(`${q.toLowerCase()}|${year}`).digest('hex').slice(0, 24); }
  posterFile(q: string, year: number) { return path.join(this.dir, `${this.keyOf(q, year)}.jpg`); }

  private tmdbHeaders(key: string): Record<string, string> { return key.length > 40 ? { Authorization: `Bearer ${key}` } : {}; }
  private tmdbUrl(p: string, key: string, params: Record<string, string> = {}) {
    const u = new URL(`https://api.themoviedb.org/3/${p}`);
    for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
    if (key.length <= 40) u.searchParams.set('api_key', key);
    return u;
  }
  private norm(x: string) { return x.toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim(); }
  private async savePoster(q: string, year: number, url: string) {
    try { const p = await fetch(url); if (p.ok) { fs.writeFileSync(this.posterFile(q, year), Buffer.from(await p.arrayBuffer())); return true; } } catch { /* poster is optional */ }
    return false;
  }
  private metaFromTmdb(hit: any, kind: string): Meta {
    const date: string = hit.release_date || hit.first_air_date || '';
    const genres = (hit.genre_ids ?? hit.genres?.map((g: any) => g.id) ?? []).map((g: number) => GENRES[g]).filter(Boolean);
    return { found: true, kind, title: hit.title || hit.name, year: Number(date.slice(0, 4)) || undefined, overview: hit.overview || '', rating: Math.round((hit.vote_average ?? 0) * 10) / 10, genres };
  }

  /** TMDB first (with retries on looser searches), then TVmaze (series) and iTunes (movies), which need no key. */
  async meta(q: string, year: number): Promise<Meta> {
    const key = this.cfg().tmdbKey.trim();
    const file = path.join(this.dir, `${this.keyOf(q, year)}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }
    let out: Meta = { found: false };
    let tmdbError: HttpError | null = null;
    if (key) {
      try {
        const tries: [string, string][] = [[q, String(year || '')], [q, ''], [q.split(/\s[-:–]\s/)[0], ''], [q.replace(/\b(part|vol|volume)\s*\w+$/i, '').trim(), '']].filter((x, i, a) => x[0] && a.findIndex((y) => y[0] === x[0] && y[1] === x[1]) === i) as [string, string][];
        for (const [query, y] of tries) {
          const r = await fetch(this.tmdbUrl('search/multi', key, { query, year: y }), { headers: this.tmdbHeaders(key) }).catch(() => { throw new HttpError(502, 'Could not reach TMDB. Check your internet connection.'); });
          if (r.status === 401) throw new HttpError(400, 'TMDB rejected the key. Check it in Settings.');
          if (!r.ok) throw new HttpError(502, `TMDB answered ${r.status}`);
          const list: any[] = ((await r.json()) as any).results?.filter((x: any) => x.media_type === 'movie' || x.media_type === 'tv') ?? [];
          const n = this.norm(query);
          const hit = list.find((x) => this.norm(x.title || x.name || '') === n && (!year || String(x.release_date || x.first_air_date || '').startsWith(String(year)))) ?? list.find((x) => this.norm(x.title || x.name || '') === n) ?? list[0];
          if (hit) { out = this.metaFromTmdb(hit, hit.media_type); if (hit.poster_path) out.poster = await this.savePoster(q, year, `https://image.tmdb.org/t/p/w342${hit.poster_path}`); break; }
        }
      } catch (e) { if (e instanceof HttpError) tmdbError = e; }
    }
    if (!out.found) out = (await this.tvmaze(q, year)) ?? (await this.itunes(q, year)) ?? out;
    if (!out.found && tmdbError && !key) throw tmdbError;
    if (!out.found && !key) throw new HttpError(400, 'Nothing found. Add a TMDB key in Settings for better results.');
    if (tmdbError && !out.found) throw tmdbError;
    fs.writeFileSync(file, JSON.stringify(out));
    return out;
  }
  private async tvmaze(q: string, year: number): Promise<Meta | null> {
    try {
      const r = await fetch(`https://api.tvmaze.com/search/shows?q=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return null;
      const list: any[] = ((await r.json()) as any[]).map((x) => x.show);
      const n = this.norm(q);
      const hit = list.find((x) => this.norm(x.name) === n) ?? (list[0] && this.norm(list[0].name).includes(n) ? list[0] : null);
      if (!hit) return null;
      const out: Meta = { found: true, kind: 'tv', title: hit.name, year: Number(String(hit.premiered ?? '').slice(0, 4)) || undefined, overview: String(hit.summary ?? '').replace(/<[^>]+>/g, '').trim(), rating: hit.rating?.average ?? 0, genres: hit.genres ?? [] };
      const img = hit.image?.original || hit.image?.medium;
      if (img) out.poster = await this.savePoster(q, year, img);
      return out;
    } catch { return null; }
  }
  private async itunes(q: string, year: number): Promise<Meta | null> {
    try {
      const r = await fetch(`https://itunes.apple.com/search?media=movie&entity=movie&limit=5&term=${encodeURIComponent(q)}`, { headers: { 'User-Agent': UA } });
      if (!r.ok) return null;
      const list: any[] = ((await r.json()) as any).results ?? [];
      const n = this.norm(q);
      const hit = list.find((x) => this.norm(x.trackName ?? '') === n && (!year || String(x.releaseDate).startsWith(String(year)))) ?? list.find((x) => this.norm(x.trackName ?? '') === n);
      if (!hit) return null;
      const out: Meta = { found: true, kind: 'movie', title: hit.trackName, year: Number(String(hit.releaseDate ?? '').slice(0, 4)) || undefined, overview: hit.longDescription || hit.shortDescription || '', genres: hit.primaryGenreName ? [hit.primaryGenreName] : [] };
      if (hit.artworkUrl100) out.poster = await this.savePoster(q, year, String(hit.artworkUrl100).replace('100x100bb', '600x900bb'));
      return out;
    } catch { return null; }
  }

  /** Manual search for the "Wrong match?" box. */
  async candidates(q: string) {
    const key = this.cfg().tmdbKey.trim();
    if (!key) throw new HttpError(400, 'Add a TMDB key in Settings to search by hand.');
    const r = await fetch(this.tmdbUrl('search/multi', key, { query: q }), { headers: this.tmdbHeaders(key) });
    if (!r.ok) throw new HttpError(502, `TMDB answered ${r.status}`);
    return (((await r.json()) as any).results ?? []).filter((x: any) => x.media_type === 'movie' || x.media_type === 'tv').slice(0, 8).map((x: any) => ({
      id: x.id, kind: x.media_type, title: x.title || x.name, year: Number(String(x.release_date || x.first_air_date || '').slice(0, 4)) || 0,
      poster: x.poster_path ? `https://image.tmdb.org/t/p/w92${x.poster_path}` : '', overview: x.overview || '',
    }));
  }
  /** The person picked the right title: store it for this file name. */
  async choose(q: string, year: number, id: number, kind: string): Promise<Meta> {
    const key = this.cfg().tmdbKey.trim();
    if (!key) throw new HttpError(400, 'Add a TMDB key in Settings.');
    const r = await fetch(this.tmdbUrl(`${kind === 'tv' ? 'tv' : 'movie'}/${id}`, key), { headers: this.tmdbHeaders(key) });
    if (!r.ok) throw new HttpError(502, `TMDB answered ${r.status}`);
    const hit: any = await r.json();
    const out = this.metaFromTmdb(hit, kind === 'tv' ? 'tv' : 'movie');
    try { fs.rmSync(this.posterFile(q, year), { force: true }); } catch { /* none yet */ }
    if (hit.poster_path) out.poster = await this.savePoster(q, year, `https://image.tmdb.org/t/p/w342${hit.poster_path}`);
    fs.writeFileSync(path.join(this.dir, `${this.keyOf(q, year)}.json`), JSON.stringify(out));
    return out;
  }

  // ---------- OpenSubtitles (api.opensubtitles.com) ----------
  private osHeaders(extra: Record<string, string> = {}) {
    const k = this.cfg().osKey.trim();
    if (!k) throw new HttpError(400, 'Add your OpenSubtitles API key in Settings.');
    return { 'Api-Key': k, 'User-Agent': UA, 'Content-Type': 'application/json', Accept: 'application/json', ...extra };
  }
  async osSearch(query: string, lang: string, year: number, season: number, episode: number) {
    const u = new URL('https://api.opensubtitles.com/api/v1/subtitles');
    u.searchParams.set('query', query);
    u.searchParams.set('languages', lang || 'en');
    if (year) u.searchParams.set('year', String(year));
    if (season) u.searchParams.set('season_number', String(season));
    if (episode) u.searchParams.set('episode_number', String(episode));
    u.searchParams.set('order_by', 'download_count');
    const r = await fetch(u, { headers: this.osHeaders() });
    if (r.status === 401 || r.status === 403) throw new HttpError(400, 'OpenSubtitles rejected the API key.');
    if (!r.ok) throw new HttpError(502, `OpenSubtitles answered ${r.status}`);
    const j: any = await r.json();
    return (j.data ?? []).slice(0, 20).map((d: any) => ({
      id: d.attributes?.files?.[0]?.file_id as number,
      name: d.attributes?.release || d.attributes?.files?.[0]?.file_name || 'Subtitle',
      lang: d.attributes?.language ?? '',
      downloads: d.attributes?.download_count ?? 0,
    })).filter((x: any) => x.id);
  }
  async osGet(fileId: number): Promise<string> {
    const { osUser, osPass } = this.cfg();
    if (!osUser || !osPass) throw new HttpError(400, 'Downloading needs your OpenSubtitles username and password in Settings.');
    const lr = await fetch('https://api.opensubtitles.com/api/v1/login', { method: 'POST', headers: this.osHeaders(), body: JSON.stringify({ username: osUser, password: osPass }) });
    if (!lr.ok) throw new HttpError(400, 'OpenSubtitles login failed. Check your username and password.');
    const token = ((await lr.json()) as any).token;
    const dr = await fetch('https://api.opensubtitles.com/api/v1/download', { method: 'POST', headers: this.osHeaders({ Authorization: `Bearer ${token}` }), body: JSON.stringify({ file_id: fileId }) });
    if (dr.status === 406) throw new HttpError(429, 'OpenSubtitles daily download limit reached.');
    if (!dr.ok) throw new HttpError(502, `OpenSubtitles answered ${dr.status}`);
    const link = ((await dr.json()) as any).link;
    const fr = await fetch(link);
    if (!fr.ok) throw new HttpError(502, 'Could not fetch the subtitle file.');
    return fr.text();
  }
}