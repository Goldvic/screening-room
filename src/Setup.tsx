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

export default function Setup({ firstRun, onClose, onChanged, onOffline }: {
  firstRun: boolean; onClose: () => void; onChanged: () => void; onOffline: () => void;
}) {
  const [list, setList] = useState<List>({ active: '', servers: [] });
  const [form, setForm] = useState<Form | null>(null);
  const [test, setTest] = useState<Test | null>(null);
  const [busy, setBusy] = useState('');
  const [err, setErr] = useState('');
  const [showPw, setShowPw] = useState(false);

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
    <div className={firstRun ? 'setup-card' : 'srv-modal'} onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Servers">
      
      <div className="srv-modal-head">
        <div>
          <h3>{firstRun ? 'Sign in to your server' : 'Servers'}</h3>
          <p>{firstRun ? 'Enter where your movies live. Keys are stored encrypted.' : 'Where your library lives and streams from.'}</p>
        </div>
        {!firstRun && <button className="icon sm" onClick={onClose} aria-label="Close"><Icon n="close" /></button>}
      </div>

      {!form && (
        <>
          <div className="srv-modal-body">
            <div className="srv-list-grid">
              {list.servers.map((s) => (
                <div key={s.id} className={s.id === list.active ? 'srv-card on' : 'srv-card'}>
                  <span className="srv-card-icon"><Icon n="server" s={20} /></span>
                  <div className="srv-card-info">
                    <b>{s.name}</b>
                    <span>{s.user}@{s.host}{s.port !== 22 ? `:${s.port}` : ''}</span>
                  </div>
                  <div className="srv-card-actions">
                    {s.id === list.active
                      ? <span className="kstat ok">✓ In use</span>
                      : <button type="button" className="btn ghost sm" onClick={() => use(s.id)}>Use</button>}
                    <button type="button" className="btn ghost sm" onClick={() => { setForm(toForm(s)); setTest(null); }}>Edit</button>
                    <button type="button" className="icon danger" onClick={() => remove(s)} aria-label={`Remove ${s.name}`}><Icon n="trash" s={18} /></button>
                  </div>
                </div>
              ))}
              
              {!list.servers.length && (
                <div className="srv-empty">
                  <Icon n="server" s={40} />
                  <p>No servers added yet. Connect a VPS or local folder to start streaming your library.</p>
                </div>
              )}
            </div>
          </div>
          <div className="srv-modal-foot">
            <span className="muted small">{list.servers.length} server{list.servers.length === 1 ? '' : 's'} configured</span>
            <button type="button" className="btn" onClick={() => { setForm(blank); setTest(null); }}>
              <Icon n="plus" s={16} /> Add a server
            </button>
          </div>
        </>
      )}

      {form && (
        <>
          <div className="srv-modal-body">
            <div className="srv-form-grid">
              
              <div className="srv-field full">
                <label>Name</label>
                <small>Anything you like to identify this server.</small>
                <input value={form.name} onChange={(e) => up({ name: e.target.value })} placeholder="My VPS" autoFocus />
              </div>

              <div className="srv-field full">
                <label>Address</label>
                <small>IP address or domain name.</small>
                <input value={form.host} onChange={(e) => up({ host: e.target.value })} placeholder="203.0.113.10" />
              </div>

              <div className="srv-field">
                <label>SSH Port</label>
                <input value={form.port} inputMode="numeric" onChange={(e) => up({ port: e.target.value })} />
              </div>

              <div className="srv-field">
                <label>User</label>
                <input value={form.user} onChange={(e) => up({ user: e.target.value })} />
              </div>

              <div className="srv-field full">
                <label>Authentication Method</label>
                <div className="srv-auth-cards">
                  <button type="button" className={form.auth === 'key' ? 'srv-auth-card on' : 'srv-auth-card'} onClick={() => up({ auth: 'key' })}>
                    <Icon n="server" s={16} /> SSH Key
                  </button>
                  <button type="button" className={form.auth === 'password' ? 'srv-auth-card on' : 'srv-auth-card'} onClick={() => up({ auth: 'password' })}>
                    <Icon n="info" s={16} /> Password
                  </button>
                </div>
              </div>

              {form.auth === 'key' ? (
                <>
                  <div className="srv-field full">
                    <label>Key File Path</label>
                    <small>Path to your private key (e.g. C:\Users\you\.ssh\id_ed25519).</small>
                    <div style={{ display: 'flex', gap: '8px' }}>
                      <input value={form.keyPath} onChange={(e) => up({ keyPath: e.target.value })} placeholder="~/.ssh/id_ed25519" style={{ flex: 1 }} />
                      {bridge && <button className="btn ghost" type="button" onClick={browseKey} style={{ flex: 'none' }}>Browse…</button>}
                    </div>
                  </div>
                  <div className="srv-field full">
                    <label>Or paste the key</label>
                    <small>{list.servers.find((s) => s.id === form.id)?.hasKeyText ? 'A key is saved. Leave empty to keep it.' : 'Stored encrypted by your OS.'}</small>
                    <textarea rows={3} value={form.keyText} onChange={(e) => up({ keyText: e.target.value })} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----" spellCheck={false} />
                  </div>
                  <div className="srv-field full">
                    <label>Key Passphrase</label>
                    <small>Only if your key is protected.</small>
                    <input type="password" value={form.passphrase} onChange={(e) => up({ passphrase: e.target.value })} autoComplete="off" />
                  </div>
                </>
              ) : (
                <div className="srv-field full">
                  <label>Password</label>
                  <small>{list.servers.find((s) => s.id === form.id)?.hasPassword ? 'A password is saved. Leave empty to keep it.' : 'Stored encrypted by your OS.'}</small>
                  <div style={{ display: 'flex', gap: '8px' }}>
                    <input type={showPw ? 'text' : 'password'} value={form.password} onChange={(e) => up({ password: e.target.value })} autoComplete="off" style={{ flex: 1 }} />
                    <button type="button" className="btn ghost" onClick={() => setShowPw((x) => !x)} style={{ flex: 'none' }}>{showPw ? 'Hide' : 'Show'}</button>
                  </div>
                </div>
              )}

              <div className="srv-field full">
                <label>Media Folders (optional)</label>
                <small>One per line as Name=/path. Overrides automatic search.</small>
                <textarea rows={2} value={form.rootsText} onChange={(e) => up({ rootsText: e.target.value })} placeholder={'Movies=/srv/media/movies\nSeries=/srv/media/series'} spellCheck={false} />
              </div>

              {test && (
                <div className={test.ok ? 'note good' : 'note err'}>
                  {test.ok ? (
                    <>
                      <strong>Connected!</strong> {test.ffmpeg ? 'ffmpeg is installed.' : 'ffmpeg not found (streaming conversion will fail).'}
                      {test.roots && test.roots.length > 0 && <div style={{ marginTop: '4px' }}>Found: {test.roots.map((r) => `${r.name}`).join(', ')}</div>}
                    </>
                  ) : <><strong>Connection failed.</strong> {test.error}</>}
                </div>
              )}
              {err && <div className="note err">{err}</div>}
            </div>
          </div>

          <div className="srv-modal-foot">
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn ghost" onClick={() => { setForm(null); setTest(null); setErr(''); if (!list.servers.length && firstRun) setForm(blank); }} disabled={!list.servers.length && !firstRun}>
                Cancel
              </button>
              {firstRun && <button className="btn ghost" onClick={onOffline}>Skip</button>}
            </div>
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="btn ghost" onClick={runTest} disabled={!form.host.trim() || busy !== ''}>
                {busy === 'test' ? 'Testing…' : 'Test'}
              </button>
              <button className="btn" onClick={save} disabled={!form.host.trim() || busy !== ''}>
                {busy === 'save' ? 'Saving…' : 'Save Server'}
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );

  const hero = (
    <aside className="login-hero">
      <div className="brand"><span className="lamp" />{APP_NAME}</div>
      <h1>Your private<br />screening room.</h1>
      <ul>
        <li>Stream from your own server</li>
        <li>Save while you watch, replay offline</li>
        <li>Build playlists in two clicks</li>
      </ul>
    </aside>
  );
  
  return firstRun ? <div className="setup-wrap login">{hero}{inner}</div> : <div className="scrim" onClick={onClose}>{inner}</div>;
}