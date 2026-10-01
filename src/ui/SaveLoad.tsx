import { useRef, useState } from 'react';
import { runtime } from '../app/runtime';
import { useUI } from '../store/store';
import { listLocalSaves, readLocalSave, validateSave, writeLocalSave } from '../engine/persistence/save';
import { formatDuration } from '../engine/core/time';

export function SaveLoadModal() {
  const set = useUI((s) => s.set);
  const seed = useUI((s) => s.seed);
  const [name, setName] = useState(`Universe ${seed}`);
  const [msg, setMsg] = useState<{ text: string; tone: 'good' | 'bad' } | null>(null);
  const [saves, setSaves] = useState(() => listLocalSaves());
  const fileRef = useRef<HTMLInputElement>(null);

  const save = () => {
    const s = runtime.makeSave(name);
    if (!s) {
      setMsg({ text: 'Cannot save while the universe is generating or a time-machine jump is running.', tone: 'bad' });
      return;
    }
    try {
      writeLocalSave(s);
      setSaves(listLocalSaves());
      setMsg({ text: `Saved “${name}” (${(JSON.stringify(s).length / 1024).toFixed(1)} KB).`, tone: 'good' });
    } catch (e) {
      setMsg({ text: `Could not save: ${String(e)}`, tone: 'bad' });
    }
  };
  const exportFile = () => {
    const s = runtime.makeSave(name);
    if (!s) {
      setMsg({ text: 'Cannot export while the universe is generating or a time-machine jump is running.', tone: 'bad' });
      return;
    }
    const blob = new Blob([JSON.stringify(s)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${name.replace(/[^\w\-]+/g, '_')}.universe.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };
  const importFile = async (f: File) => {
    try {
      const data = validateSave(JSON.parse(await f.text()));
      set({ modal: null });
      await runtime.loadSave(data);
    } catch (e) {
      setMsg({ text: `Import failed: ${e instanceof Error ? e.message : String(e)}`, tone: 'bad' });
    }
  };
  return (
    <div className="modal-backdrop" onClick={() => set({ modal: null })}>
      <div className="modal" style={{ width: 520 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <div style={{ fontSize: 14, fontWeight: 600 }}>Save · Load · Export · Import</div>
          <button className="icon-btn" onClick={() => set({ modal: null })}>
            ✕
          </button>
        </div>
        <div className="modal-body">
          <div className="field">
            <label>Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="toggle-row">
            <button className="btn" onClick={save}>
              Save to browser
            </button>
            <button className="btn ghost" onClick={exportFile}>
              Export file
            </button>
            <button className="btn ghost" onClick={() => fileRef.current?.click()}>
              Import file
            </button>
            <input ref={fileRef} type="file" accept=".json,application/json" style={{ display: 'none' }} onChange={(e) => e.target.files?.[0] && importFile(e.target.files[0])} />
          </div>
          {msg && <div className={msg.tone} style={{ marginTop: 10, fontSize: 11.5 }}>{msg.text}</div>}
          <div className="iv-note">
            Saves store the seed, time, intervention log, civilization state and recent events — never the generated universe, which is regenerated deterministically from the seed.
          </div>
          <div className="section">
            <div className="section-title">Saved universes</div>
            {saves.length === 0 && <div className="faint">None yet.</div>}
            {saves.map((s) => (
              <div className="save-item" key={s.key}>
                <div>
                  <div>{s.name}</div>
                  <div className="mono faint" style={{ fontSize: 10 }}>
                    seed {s.seed} · {formatDuration(s.years)} · {new Date(s.savedAt).toLocaleString()}
                  </div>
                </div>
                <div className="toggle-row">
                  <button
                    className="btn small"
                    onClick={async () => {
                      try {
                        const data = readLocalSave(s.key);
                        set({ modal: null });
                        await runtime.loadSave(data);
                      } catch (e) {
                        setMsg({ text: `Load failed: ${e instanceof Error ? e.message : String(e)}`, tone: 'bad' });
                      }
                    }}
                  >
                    Load
                  </button>
                  <button
                    className="btn danger small"
                    onClick={() => {
                      localStorage.removeItem(s.key);
                      setSaves(listLocalSaves());
                    }}
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
