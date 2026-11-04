import { Icon, bytes, clock, mbps, rate } from '../lib';

export type DL = { id: string; name: string; done: number; total: number; speed: number; state: 'run' | 'done' | 'error' | 'cancel'; error?: string; ctl: AbortController };

export function Tray({ dls, onDismiss }: { dls: DL[]; onDismiss: (id: string) => void }) {
  return (
    <aside className="dl-tray" aria-label="Browser downloads">
      {dls.map((d) => (
        <div key={d.id} className={`dl-tray-item is-${d.state}`}>
          <div className="dl-tray-top">
            <strong className="dl-tray-name" title={d.name}>{d.name}</strong>
            {d.state === 'run'
              ? <button className="icon sm" onClick={() => d.ctl.abort()} title="Cancel" aria-label="Cancel download"><Icon n="close" s={15} /></button>
              : <button className="icon sm" onClick={() => onDismiss(d.id)} title="Dismiss" aria-label="Dismiss"><Icon n="close" s={15} /></button>}
          </div>
          <i className="dl-tray-bar"><b style={{ width: `${Math.min(100, (d.done / d.total) * 100)}%` }} /></i>
          <span className="dl-tray-info">
            {d.state === 'run' && `${bytes(d.done)} of ${bytes(d.total)}, ${rate(d.speed)} (${mbps(d.speed)})${d.speed > 0 ? `, ${clock((d.total - d.done) / d.speed)} left` : ''}`}
            {d.state === 'done' && `Saved, ${bytes(d.total)}`}
            {d.state === 'cancel' && 'Cancelled'}
            {d.state === 'error' && `Failed: ${d.error ?? 'unknown error'}`}
          </span>
        </div>
      ))}
    </aside>
  );
}