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

const MONTHS = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

/** Turn a raw folder name like "Oppenheimer.2023.1080p.BluRay.x264" into { title: "Oppenheimer", year: 2023 }. */
export function cleanTitle(name: string): { title: string; year: number } {
  let t = name.replace(/[\[(][^\])]*(?:\.(?:com|tv|net|org|to|cc|me|ws)|www|\b(?:1080p|720p|480p|x264|x265|webrip|bluray|web-dl)\b)[^\])]*[\])]/gi, ' ');
  t = t.replace(/\bwww\.[^\s]+/gi, ' ');
  t = t.replace(/\s*\|.*$/, '');                                   // "... | Korean Drama" site suffixes
  t = t.replace(/\s*[(\[]\s*(?:episode|ep)\b[^)\]]*[)\]]?.*$/i, ''); // "(Episode 3 Added)"
  t = t.replace(/\s+(?:season|series)\s*\d+\b.*$/i, '');            // "Season 2 Episode 5"
  t = t.replace(/\s+S\d{1,2}\b.*$/i, '');                           // "S01 ..."
  const ep = /[Ss](\d{1,2})[ ._-]*[Ee](\d{1,3})/.exec(t);
  if (ep) t = t.slice(0, ep.index);
  const ym = /[ ._(\[-]((?:19|20)\d{2})(?=[ ._)\]-]|$)/.exec(t);
  const year = ym ? Number(ym[1]) : 0;
  if (ym) t = t.slice(0, ym.index);
  // Episode dates on shows like "WWE RAW: 2nd November" / "WWE RAW 2 Nov" / "Late Show November 2nd"
  t = t.replace(new RegExp(`[\\s:,\\-–]*\\b\\d{1,2}(?:st|nd|rd|th)?\\s+${MONTHS}\\b.*$`, 'i'), '');
  t = t.replace(new RegExp(`[\\s:,\\-–]*\\b${MONTHS}\\s+\\d{1,2}(?:st|nd|rd|th)?\\b.*$`, 'i'), '');
  t = t.replace(/\b(2160p|1080p|720p|480p|360p|4k|uhd|bluray|blu-ray|brrip|bdrip|webrip|web-dl|webdl|web|hdrip|dvdrip|hdtv|x264|x265|h264|h265|hevc|av1|aac|ac3|dts|10bit|remux|proper|repack|extended|unrated|yify|rarbg|amzn|nf|dsnp|hmax|hdr|dv|multi|dual|subbed|dubbed|complete)\b.*$/i, '');
  t = t.replace(/[._]+/g, ' ').replace(/\s*[-\[(:,]+\s*$/, '').replace(/\s+/g, ' ').trim();
  return { title: t || name.replace(/[._-]+/g, ' ').trim(), year };
}

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
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const p = await fetch(url, { signal: AbortSignal.timeout(15000), headers: { 'User-Agent': UA } });
        if (p.ok) {
          const buf = Buffer.from(await p.arrayBuffer());
          if (buf.length > 500) { fs.writeFileSync(this.posterFile(q, year), buf); return true; }
        }
      } catch { /* network hiccup: try again */ }
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
    console.warn('[poster] could not download image for', JSON.stringify(q), '-', url);
    return false;
  }
  private metaFromTmdb(hit: any, kind: string): Meta {
    const date: string = hit.release_date || hit.first_air_date || '';
    const genres = (hit.genre_ids ?? hit.genres?.map((g: any) => g.id) ?? []).map((g: number) => GENRES[g]).filter(Boolean);
    return { found: true, kind, title: hit.title || hit.name, year: Number(date.slice(0, 4)) || undefined, overview: hit.overview || '', rating: Math.round((hit.vote_average ?? 0) * 10) / 10, genres };
  }

  /** TMDB first (with retries on looser searches), then TVmaze (series) and iTunes (movies), which need no key. */
  private inflight = new Map<string, Promise<Meta>>();
  private active = 0;
  private waiters: (() => void)[] = [];
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= 4) await new Promise<void>((ok) => this.waiters.push(ok)); // at most 4 lookups at once
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); }
  }
  /** Same title asked for twice at once (grid card + detail sheet) shares one lookup. */
  meta(q: string, year: number): Promise<Meta> {
    const k = this.keyOf(q, year);
    let p = this.inflight.get(k);
    if (!p) {
      p = this.slot(() => this.metaRaw(q, year)).finally(() => this.inflight.delete(k));
      this.inflight.set(k, p);
    }
    return p;
  }
  private async metaRaw(q: string, year: number): Promise<Meta> {
    const key = this.cfg().tmdbKey.trim();
    const file = path.join(this.dir, `${this.keyOf(q, year)}.json`);
    try {
      const cached: Meta = JSON.parse(fs.readFileSync(file, 'utf8'));
      const fresh = Date.now() - fs.statSync(file).mtimeMs < 20 * 1000;
      // A cached miss, or a hit whose poster never downloaded, is retried after 20 seconds instead of sticking forever.
      if ((cached.found && cached.poster) || fresh) return cached;
    } catch { /* not cached yet */ }
    let out: Meta = { found: false };
    let tmdbError: HttpError | null = null;
    if (key) {
      try {
        const colonHead = q.split(/\s*:\s*|\s[-–]\s/)[0];                 // "Show: Subtitle" -> "Show"
        const noArticle = q.replace(/^(?:the|a|an)\s+/i, '');             // "The Show" -> "Show"
        const tries: [string, string][] = [
          [q, String(year || '')], [q, ''], [colonHead, ''],
          [q.replace(/\b(part|vol|volume)\s*\w+$/i, '').trim(), ''],
          [noArticle, ''],
          [q.replace(/[^\p{L}\p{N} ]+/gu, ' ').replace(/\s+/g, ' ').trim(), ''], // punctuation stripped
        ].filter((x, i, a) => x[0] && a.findIndex((y) => y[0] === x[0] && y[1] === x[1]) === i) as [string, string][];
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
    if (!out.found) console.warn('[poster] nothing found on TMDB/TVmaze/iTunes for', JSON.stringify(q), year || '');
    else if (!out.poster) console.warn('[poster] found', JSON.stringify(out.title), 'but it has no poster image');
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