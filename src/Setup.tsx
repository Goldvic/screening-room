import { ReactNode, useEffect, useState } from 'react';
import { APP_NAME, Icon, api, bridge, post } from './lib';

type PubServer = {
  id: string; name: string; host: string; port: number; user: string; auth: 'key' | 'password';
  keyPath?: string; container?: string; roots?: { name: string; dir: string }[]; hasKeyText: boolean; hasPassword: boolean;
};
type List = { active: string; servers: PubServer[] };
type Form = {
  id?: string; name: string; host: string; port: string; user: string; auth: 'key' | 'password';
  keyPath: string; keyText: string; passphrase: string; password: string; container: string; rootsText: string;
};
type Test = { ok: boolean; error?: string; ffmpeg?: boolean; docker?: boolean; roots?: { name: string; dir: string }[]; rootsError?: string };

const blank: Form = { name: '', host: '', port: '22', user: 'root', auth: 'key', keyPath: '', keyText: '', passphrase: '', password: '', container: 'media-downloader-bot', rootsText: '' };
const toForm = (s: PubServer): Form => ({
  id: s.id, name: s.name, host: s.host, port: String(s.port), user: s.user, auth: s.auth, keyPath: s.keyPath ?? '', keyText: '', passphrase: '', password: '',
  container: s.container ?? '', rootsText: (s.roots ?? []).map((r) => `${r.name}=${r.dir}`).join('\n'),
});

const F = ({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) => (
  <label className="sfield"><span><b>{label}</b>{hint && <small>{hint}</small>}</span>{children}</label>
);

export default function Setup({ firstRun, onClose, onChanged, onOffline }: {
  firstRun: boolean; onClose: () => void; onChanged: () => void; onOffline: () => void;
}) {
  const [list, setList] = useState<List>({ active: '', servers: [] });
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');

  const load = () => api<List>('servers').then((l) => { setList(l); if (!l.servers.length) setForm((f) => f ?? blank); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useEffect(() => {
    if (firstRun) return;
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape' && !form) onClose(); };
    window.addEventListener('keydown', k);
    return () => window.removeEventListener('keydown', k);
  }, [firstRun, form, onClose]);

  const up = (p: Partial<Form>) => { setForm((f) => (f ? { ...f, ...p } : f)); setTest(null); };
  const body = (f: Form) => ({ ...f, port: Number(f.port) || 22 });

  const runTest = async () => {
    if (!form) return;
    setBusy('test'); setErr(''); setTest(null);
    try { setTest(await post<Test>('servers/test', body(form))); } catch (e: any) { setErr(e.message); }
    setBusy('');
  };
  const save = async () => {
    if (!form) return;
    setBusy('save'); setErr('');
    try {
      const r = await post<List & { saved: string }>('servers', body(form));
      if (r.active !== r.saved) await post('servers/active', { id: r.saved });
      setForm(null); setTest(null);
      await load(); onChanged();
    } catch (e: any) { setErr(e.message); }
    setBusy('');
  };
  const use = async (id: string) => { await post('servers/active', { id }); await load(); onChanged(); };
  const remove = async (s: PubServer) => {
    if (!window.confirm(`Remove “${s.name}” from ${APP_NAME}? Your files on that server are not touched.`)) return;
    await api('servers', { id: s.id }, 'DELETE');
    await load(); onChanged();
  };
  const browseKey = async () => {
    const f = await bridge?.selectFile([{ name: 'SSH keys', extensions: ['pem', 'key', '*'] }]);
    if (f) up({ keyPath: f });
  };

  const inner = (
    <div className={firstRun ? 'setup-card' : 'dialog wide'} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Servers">
      {firstRun ? (
        <div className="welcome">
          <span className="lamp big" />
          <h1>Welcome to {APP_NAME}</h1>
          <p className="muted">Connect to the server where your movies are stored. You can also skip this and only watch what you have downloaded to this laptop.</p>
          <button className="btn ghost" onClick={onOffline}>Skip: only use downloaded files</button>
        </div>
      ) : (
        <div className="dlg-head"><h3>Servers</h3><button className="icon" onClick={onClose} aria-label="Close"><Icon n="close" /></button></div>
      )}

      {!form && (
        <>
          {list.servers.map((s) => (
            <div key={s.id} className={s.id === list.active ? 'srv on' : 'srv'}>
              <Icon n="server" s={22} />
              <div className="srv-t"><strong>{s.name}</strong><span className="muted small">{s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}</span></div>
              {s.id === list.active ? <span className="tag">In use</span> : <button className="btn ghost" onClick={() => use(s.id)}>Use</button>}
              <button className="btn ghost" onClick={() => { setForm(toForm(s)); setTest(null); }}>Edit</button>
              <button className="icon danger" onClick={() => remove(s)} aria-label={`Remove ${s.name}`}><Icon n="trash" s={16} /></button>
            </div>
          ))}
          <div className="dlg-actions spread">
            <button className="btn" onClick={() => { setForm(blank); setTest(null); }}><Icon n="plus" s={15} /> Add a server</button>
          </div>
        </>
      )}

      {form && (
        <div className="sform">
          <F label="Name" hint="Anything you like"><input value={form.name} onChange={(e) => up({ name: e.target.value })} placeholder="My VPS" /></F>
          <F label="Address" hint="IP address or domain of the server"><input value={form.host} onChange={(e) => up({ host: e.target.value })} placeholder="203.0.113.10" autoFocus /></F>
          <div className="two">
            <F label="SSH port"><input value={form.port} inputMode="numeric" onChange={(e) => up({ port: e.target.value })} /></F>
            <F label="User"><input value={form.user} onChange={(e) => up({ user: e.target.value })} /></F>
          </div>
          <F label="Sign in with">
            <span className="seg">
              <button className={form.auth === 'key' ? 'on' : ''} onClick={() => up({ auth: 'key' })}>SSH key</button>
              <button className={form.auth === 'password' ? 'on' : ''} onClick={() => up({ auth: 'password' })}>Password</button>
            </span>
          </F>
          {form.auth === 'key' ? (
            <>
              <F label="Key file" hint="Path to your private key, for example C:\Users\you\.ssh\id_ed25519">
                <span className="inline"><input value={form.keyPath} onChange={(e) => up({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" />
                  {bridge && <button className="btn ghost" onClick={browseKey}>Browse…</button>}</span>
              </F>
              <F label="…or paste the key" hint={list.servers.find((s) => s.id === form.id)?.hasKeyText ? 'A key is saved. Leave empty to keep it.' : 'Stored encrypted by your operating system'}>
                <textarea rows={3} value={form.keyText} onChange={(e) => up({ keyText: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
              </F>
              <F label="Key passphrase" hint="Only if your key has one"><input type="password" value={form.passphrase} onChange={(e) => up({ passphrase: e.target.value })} autoComplete="off" /></F>
            </>
          ) : (
            <F label="Password" hint={list.servers.find((s) => s.id === form.id)?.hasPassword ? 'A password is saved. Leave empty to keep it.' : 'Stored encrypted by your operating system'}>
              <input type="password" value={form.password} onChange={(e) => up({ password: e.target.value })} autoComplete="off" />
            </F>
          )}
          <F label="Docker container of the downloader bot" hint="Used to find the media folder automatically. Leave empty if you list folders below.">
            <input value={form.container} onChange={(e) => up({ container: e.target.value })} placeholder="media-downloader-bot" />
          </F>
          <F label="Media folders (optional)" hint="One per line as Name=/path. Overrides the automatic search.">
            <textarea rows={3} value={form.rootsText} onChange={(e) => up({ rootsText: e.target.value })} placeholder={'Movies=/srv/media/movies\nSeries=/srv/media/series'} spellCheck={false} />
          </F>

          {test && (
            <div className={test.ok ? 'note good' : 'note err'}>
              {test.ok ? (
                <>
                  <strong>Connected.</strong> {test.ffmpeg ? 'ffmpeg is installed on the server.' : 'ffmpeg was not found on the server: streaming conversion and compressed downloads will not work.'}
                  {test.roots && test.roots.length > 0 && <div className="small">Media folders: {test.roots.map((r) => `${r.name} (${r.dir})`).join(', ')}</div>}
                  {test.rootsError && <div className="small">{test.rootsError}</div>}
                </>
              ) : <><strong>Could not connect.</strong> {test.error}</>}
            </div>
          )}
          {err && <p className="err-t">{err}</p>}
          <div className="dlg-actions spread">
            <button className="btn ghost" onClick={() => { setForm(null); setTest(null); setErr(''); if (!list.servers.length && firstRun) setForm(blank); }} disabled={!list.servers.length && !firstRun}>Cancel</button>
            <span className="inline">
              <button className="btn ghost" onClick={runTest} disabled={!form.host.trim() || busy !== ''}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
              <button className="btn" onClick={save} disabled={!form.host.trim() || busy !== ''}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
            </span>
          </div>
        </div>
      )}
      {!form && err && <p className="err-t">{err}</p>}
    </div>
  );

  return firstRun ? <div className="setup-wrap">{inner}</div> : <div className="scrim" onClick={onClose}>{inner}</div>;
}