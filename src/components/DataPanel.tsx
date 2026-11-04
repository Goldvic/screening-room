import { useContext } from 'react';
import { Toggle } from '../Settings';
import { SAVER, SettingsCtx, Icon, bytes, rate, useNet } from '../lib';

export function DataPanel({ budget, saver, queued, onBudget, onClose, onDownloads, onSettings, onInsights }: {
  budget: number; saver: number; queued: number;
  onBudget: (gb: number) => void; onClose: () => void;
  onDownloads: () => void; onSettings: () => void; onInsights: () => void;
}) {
  const { s, set } = useContext(SettingsCtx);
  const net = useNet(null, 1500);
  const hist = net.hist.length > 1 ? net.hist : [0, 0];
  const peak = Math.max(1, ...hist);
  const used = budget > 0 ? Math.min(100, (net.month / (budget * 1e9)) * 100) : 0;
  const left = budget > 0 ? Math.max(0, budget * 1e9 - net.month) : 0;
  const now = new Date();
  const daysLeft = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate() - now.getDate() + 1;
  const budgetLabel = budget > 0 ? `${budget} GB` : 'No limit';
  const budgetHint = budget > 0
    ? `${bytes(left)} left · ${daysLeft} day${daysLeft > 1 ? 's' : ''} to go`
    : 'Set a cap to keep streaming from eating your plan';
  return (
    <>
      <div className="tn-back" onClick={onClose} />
      <section className="dpanel dp-budget-first" role="dialog" aria-label="Data usage">
        <div className="dp-accent" aria-hidden="true" />

        {/* Budget is the hero */}
        <div className="dp-hero">
          <div className="dp-hero-top">
            <small>Monthly budget</small>
            <span className="muted small">{bytes(net.month)} used this month</span>
          </div>
          <h2>{budgetLabel}</h2>
          <p className="dp-hero-hint">{budgetHint}</p>
          {budget > 0 && <div className={used >= 80 ? 'dp-bar warn' : 'dp-bar'}><i style={{ width: `${used}%` }} /></div>}
          <div className="dp-pick">
            {([0, 5, 10, 20, 50, 100] as const).map((g) => (
              <button key={g} type="button" className={budget === g ? 'on' : ''} onClick={() => onBudget(g)}>
                {g === 0 ? 'No limit' : `${g} GB`}
                <span>{g === 0 ? 'unlimited' : g === 5 ? 'light use' : g === 10 ? 'typical' : ''}</span>
              </button>
            ))}
          </div>
        </div>

        {/* Speed + usage secondary */}
        <div className="dp-secondary">
          <div className="dp-sec">
            <small>{net.active ? 'Transferring' : 'Live speed'}</small>
            <b>{net.ok ? rate(net.speed) : 'Offline'}</b>
            <div className="dp-sec-sub">{net.ok ? (net.active ? (net.mode || 'connected') : `Idle · ${net.mode || 'connected'}`) : 'no connection'}</div>
            <svg className="dp-spark-sm" viewBox="0 0 160 28" preserveAspectRatio="none" aria-hidden="true">
              <path d={`${hist.map((v, i) => `${(i / Math.max(1, hist.length - 1)) * 160},${26 - (v / peak) * 22}`).join(' L').replace(/^/, 'M')} L160,28 L0,28 Z`} className="dp-fill" />
              <path d={`M${hist.map((v, i) => `${(i / Math.max(1, hist.length - 1)) * 160},${26 - (v / peak) * 22}`).join(' L')}`} className="dp-line" />
            </svg>
          </div>
          <div className="dp-sec">
            <small>Usage</small>
            <div className="dp-usage-list">
              <div><span>Today</span><b>{bytes(net.today)}</b></div>
              <div><span>This month</span><b>{bytes(net.month)}</b></div>
              <div><span>All time</span><b>{bytes(net.lifetime)}</b></div>
            </div>
          </div>
        </div>

        {/* Data Saver */}
        <div className="dp-saver">
          <div className="dp-h">
            <strong>Data Saver</strong>
            <span className="muted small">{saver > s.saver ? 'Raised automatically by your budget' : SAVER[saver]?.hint}</span>
          </div>
          <div className="dp-seg" role="group" aria-label="Data Saver">
            {SAVER.map((o) => <button key={o.id} type="button" className={saver === o.id ? 'on' : ''} onClick={() => set({ saver: o.id })}>{o.label}</button>)}
          </div>
          <label className="dp-row"><span>Switch to Low at 80% of the budget</span><Toggle on={s.saverAuto} label="Auto Data Saver" onClick={() => set({ saverAuto: !s.saverAuto })} /></label>
        </div>

        <div className="dp-foot">
          <button type="button" onClick={onDownloads}><Icon n="down" s={15} /> {queued > 0 ? `${queued} downloading` : 'Downloads'}</button>
          <button type="button" onClick={onInsights}><Icon n="gauge" s={15} /> Insights</button>
          <button type="button" onClick={onSettings}><Icon n="sliders" s={15} /> All data settings</button>
        </div>
      </section>
    </>
  );
}

// Live network speed. It has its own timer, so the library is not redrawn every couple of seconds while videos download.
export function NetMini({ onClick }: { onClick: () => void }) {
  const net = useNet(null, 2500);
  return (
    <button className="netmini" onClick={onClick} title={`Network: ${net.ok ? rate(net.speed) : 'offline'} · today ${bytes(net.today)}`}>
      <i className={net.active ? 'netmini-dot on' : 'netmini-dot'} />
      <span className="netmini-speed">{net.ok ? rate(net.speed) : 'offline'}</span>
      <small className="netmini-today">{bytes(net.today)} today</small>
    </button>
  );
}