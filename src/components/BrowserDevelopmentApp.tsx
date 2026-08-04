import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type Dispatch,
  type RefObject,
  type SetStateAction,
} from 'react';

const demoImages = [
  { name: 'alpine-lake.jpg', color: '#41749d' },
  { name: 'studio-light.png', color: '#9a5a60' },
  { name: 'night-market.webp', color: '#72569b' },
  { name: 'wildflowers.jpg', color: '#4f8a67' },
];
type DemoView = 'home' | 'viewer' | 'grid' | 'compare';

function DemoHeader({
  view,
  setView,
  openSettings,
  openPalette,
  settingsRef,
  paletteRef,
}: {
  view: DemoView;
  setView: (view: DemoView) => void;
  openSettings: () => void;
  openPalette: () => void;
  settingsRef: RefObject<HTMLButtonElement | null>;
  paletteRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <header className="browser-demo__header">
      <div>
        <strong>LightFrame</strong> <span>Development / demo mode</span>
      </div>
      <nav aria-label="Demo navigation">
        {(['home', 'viewer', 'grid', 'compare'] as DemoView[]).map((item) => (
          <button
            key={item}
            className={view === item ? 'active' : ''}
            onClick={() => setView(item)}
          >
            {item}
          </button>
        ))}
        <button ref={settingsRef} onClick={openSettings}>
          Settings
        </button>
        <button ref={paletteRef} onClick={openPalette}>
          Command palette
        </button>
      </nav>
    </header>
  );
}

function DemoViewer({
  index,
  setIndex,
  curation,
  setCuration,
}: {
  index: number;
  setIndex: (index: number) => void;
  curation: Record<string, { favorite: boolean; rating: number }>;
  setCuration: Dispatch<SetStateAction<Record<string, { favorite: boolean; rating: number }>>>;
}) {
  const image = demoImages[index];
  const value = curation[image.name] ?? { favorite: false, rating: 0 };
  return (
    <section className="browser-demo__viewer">
      <div
        className="browser-demo__image"
        style={{ background: image.color }}
        aria-label={image.name}
      >
        {image.name}
      </div>
      <div className="browser-demo__controls">
        <button onClick={() => setIndex((index + demoImages.length - 1) % demoImages.length)}>
          Previous
        </button>
        <span>
          {index + 1} / {demoImages.length}
        </span>
        <button onClick={() => setIndex((index + 1) % demoImages.length)}>Next</button>
        <button
          aria-pressed={value.favorite}
          onClick={() =>
            setCuration((state) => ({
              ...state,
              [image.name]: { ...value, favorite: !value.favorite },
            }))
          }
        >
          {value.favorite ? 'Favorite' : 'Mark favorite'}
        </button>
        <label>
          Rating{' '}
          <select
            value={value.rating}
            onChange={(event) =>
              setCuration((state) => ({
                ...state,
                [image.name]: { ...value, rating: Number(event.target.value) },
              }))
            }
          >
            {[0, 1, 2, 3, 4, 5].map((value) => (
              <option key={value} value={value}>
                {value}
              </option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

function DemoSurface({
  view,
  index,
  setIndex,
  setView,
  curation,
  setCuration,
}: {
  view: DemoView;
  index: number;
  setIndex: (index: number) => void;
  setView: (view: DemoView) => void;
  curation: Record<string, { favorite: boolean; rating: number }>;
  setCuration: Dispatch<SetStateAction<Record<string, { favorite: boolean; rating: number }>>>;
}) {
  if (view === 'home')
    return (
      <section className="browser-demo__home">
        <h1>Welcome to LightFrame</h1>
        <p>A deterministic four-image catalog is ready for UI development.</p>
        <button onClick={() => setView('viewer')}>Open demo catalog</button>
      </section>
    );
  if (view === 'viewer')
    return (
      <DemoViewer index={index} setIndex={setIndex} curation={curation} setCuration={setCuration} />
    );
  if (view === 'grid')
    return (
      <section className="browser-demo__grid" aria-label="Demo image grid">
        {demoImages.map((item, itemIndex) => (
          <button
            key={item.name}
            onClick={() => {
              setIndex(itemIndex);
              setView('viewer');
            }}
            style={{ background: item.color }}
          >
            {item.name}
          </button>
        ))}
      </section>
    );
  return (
    <section className="browser-demo__compare">
      <div style={{ background: demoImages[index].color }}>{demoImages[index].name}</div>
      <div style={{ background: demoImages[(index + 1) % demoImages.length].color }}>
        {demoImages[(index + 1) % demoImages.length].name}
      </div>
    </section>
  );
}

function DemoModal({ settingsOpen, close }: { settingsOpen: boolean; close: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const title = settingsOpen ? 'Settings' : 'Command palette';
  return (
    <div className="browser-demo__modal" role="dialog" aria-modal="true" aria-label={title}>
      <h2>{title}</h2>
      <p>
        {settingsOpen
          ? 'Settings are reset when the page reloads in demo mode.'
          : 'Try viewer, grid, compare, and settings without native access.'}
      </p>
      <button ref={closeRef} autoFocus onClick={close}>
        Close
      </button>
    </div>
  );
}

/** A deterministic UI-only catalog: no personal files, browser uploads, or native actions. */
export function BrowserDevelopmentApp() {
  const [view, setView] = useState<DemoView>('home');
  const [index, setIndex] = useState(0);
  const [curation, setCuration] = useState<Record<string, { favorite: boolean; rating: number }>>(
    {}
  );
  const [modal, setModal] = useState<'settings' | 'palette' | null>(null);
  const settingsTriggerRef = useRef<HTMLButtonElement>(null);
  const paletteTriggerRef = useRef<HTMLButtonElement>(null);
  const closeModal = useCallback(() => {
    const trigger = modal === 'settings' ? settingsTriggerRef.current : paletteTriggerRef.current;
    setModal(null);
    queueMicrotask(() => trigger?.focus());
  }, [modal]);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && modal) closeModal();
      if (modal) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setModal('palette');
      }
      if ((event.ctrlKey || event.metaKey) && event.key === ',') {
        event.preventDefault();
        setModal('settings');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [closeModal, modal]);
  return (
    <main className="browser-demo" data-testid="browser-demo">
      <DemoHeader
        view={view}
        setView={setView}
        openSettings={() => setModal('settings')}
        openPalette={() => setModal('palette')}
        settingsRef={settingsTriggerRef}
        paletteRef={paletteTriggerRef}
      />
      <aside className="browser-demo__notice" role="note">
        Demo catalog only. File access, drag/drop, updates, process restart, reveal, and destructive
        actions are disabled. Use <code>pnpm tauri dev</code> for native behavior.
      </aside>
      <section
        aria-label="Native actions unavailable in demo mode"
        className="browser-demo__controls"
      >
        <button disabled title="Native file access is unavailable in demo mode">
          Open personal file
        </button>
        <button disabled title="Destructive actions are unavailable in demo mode">
          Delete or move image
        </button>
        <button disabled title="Updates and restart are unavailable in demo mode">
          Update, restart, or reveal
        </button>
      </section>
      <DemoSurface
        view={view}
        index={index}
        setIndex={setIndex}
        setView={setView}
        curation={curation}
        setCuration={setCuration}
      />
      {modal && <DemoModal settingsOpen={modal === 'settings'} close={closeModal} />}
    </main>
  );
}
