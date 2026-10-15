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

  async meta(q: string, year: number): Promise<Meta> {
    const key = this.cfg().tmdbKey.trim();
    if (!key) throw new HttpError(400, 'Add a TMDB key in Settings to get posters and descriptions.');
    const file = path.join(this.dir, `${this.keyOf(q, year)}.json`);
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* not cached yet */ }

    const bearer = key.length > 40;
    const url = new URL('https://api.themoviedb.org/3/search/multi');
    url.searchParams.set('query', q);
    if (year) url.searchParams.set('year', String(year));
    if (!bearer) url.searchParams.set('api_key', key);
    const r = await fetch(url, { headers: bearer ? { Authorization: `Bearer ${key}` } : {} }).catch(() => { throw new HttpError(502, 'Could not reach TMDB. Check your internet connection.'); });
    if (r.status === 401) throw new HttpError(400, 'TMDB rejected the key. Check it in Settings.');
    if (!r.ok) throw new HttpError(502, `TMDB answered ${r.status}`);
    const j: any = await r.json();
    const hit = (j.results ?? []).find((x: any) => x.media_type === 'movie' || x.media_type === 'tv');
    let out: Meta = { found: false };
    if (hit) {
      const date: string = hit.release_date || hit.first_air_date || '';
      out = {
        found: true, kind: hit.media_type, title: hit.title || hit.name, year: Number(date.slice(0, 4)) || undefined,
        overview: hit.overview || '', rating: Math.round((hit.vote_average ?? 0) * 10) / 10,
        genres: (hit.genre_ids ?? []).map((g: number) => GENRES[g]).filter(Boolean),
      };
      if (hit.poster_path) {
        try {
          const p = await fetch(`https://image.tmdb.org/t/p/w342${hit.poster_path}`);
          if (p.ok) { fs.writeFileSync(this.posterFile(q, year), Buffer.from(await p.arrayBuffer())); out.poster = true; }
        } catch { /* poster is optional */ }
      }
    }
    fs.writeFileSync(file, JSON.stringify(out));
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