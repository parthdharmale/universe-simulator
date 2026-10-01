import { useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { FeedCategory } from '../engine/sim/types';

const FILTERS: { key: FeedCategory | 'all'; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'civ', label: 'Civ' },
  { key: 'life', label: 'Life' },
  { key: 'star', label: 'Stars' },
  { key: 'intervention', label: 'User' },
];

const wallTime = (ms: number) => new Date(ms).toLocaleTimeString('en-GB', { hour12: false });

export function EventFeed() {
  const feed = useUI((s) => s.feed);
  const tog = useUI((s) => s.togglePanel);
  const [filter, setFilter] = useState<FeedCategory | 'all'>('all');
  const items = feed.filter((e) => filter === 'all' || e.category === filter || (filter === 'star' && (e.category === 'cosmic' || e.category === 'galaxy'))).slice().reverse();
  return (
    <div className="panel feed">
      <div className="panel-head">
        <span className="panel-title">
          <span className="dot" style={{ background: 'var(--good)', boxShadow: '0 0 8px var(--good)' }} /> Event feed
        </span>
        <div className="feed-filters">
          {FILTERS.map((f) => (
            <button key={f.key} className={`chip ${filter === f.key ? 'on' : ''}`} onClick={() => setFilter(f.key)}>
              {f.label}
            </button>
          ))}
          <button className="icon-btn" onClick={() => tog('feed')}>
            ✕
          </button>
        </div>
      </div>
      <div className="feed-list">
        {items.length === 0 && <div className="empty">The universe is quiet… for now.</div>}
        {items.map((e) => (
          <div key={e.id} className={`feed-item ${e.severity}`} onClick={() => e.ref && runtime.select(e.ref, true)} title={e.ref ? 'Click to locate' : undefined}>
            <div className="ts">
              [{wallTime(e.wall)}]
              <br />
              <span className="faint">{(e.t / 1e9).toFixed(3)} Gyr</span>
            </div>
            <div>
              <div className="ttl">{e.title}</div>
              <div className="body">{e.body}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
