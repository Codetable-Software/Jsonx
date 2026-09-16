import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type DragEvent, type ReactNode } from 'react';
import {
  AlertTriangle, ArrowDown, ArrowUp, Braces, ChevronDown, ChevronLeft, ChevronRight, Clipboard,
  Code2, Command, Copy, Download, FileJson, Filter, FolderOpen, History, LayoutGrid, ListFilter,
  Menu, MoreHorizontal, PanelLeftClose, Plus, Redo2, Search, ShieldCheck, SlidersHorizontal,
  Sparkles, Trash2, Undo2, Upload, WandSparkles, X, Zap
} from 'lucide-react';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type Row = Record<string, JsonValue>;
type ViewMode = 'table' | 'tree' | 'raw';
type ToolMode = 'jsonpath' | 'pointer' | 'diff' | 'schema' | 'validate' | 'api';

type Dataset = {
  id: string;
  name: string;
  source: string;
  root: JsonValue;
  rows: Row[];
  createdAt: number;
};

type HistoryState = { past: Row[][]; future: Row[][] };

const STORAGE_KEY = 'jsonx-workspace-v1';
const PAGE_SIZE = 25;

const uid = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
const pretty = (value: JsonValue) => JSON.stringify(value, null, 2);
const compact = (value: JsonValue) => JSON.stringify(value);
const isObject = (value: JsonValue): value is Record<string, JsonValue> => typeof value === 'object' && value !== null && !Array.isArray(value);
const cloneRows = (rows: Row[]) => JSON.parse(JSON.stringify(rows)) as Row[];
const displayValue = (value: JsonValue) => value === null ? 'null' : typeof value === 'object' ? compact(value) : String(value);

function normalizeRoot(root: JsonValue): Row[] {
  if (Array.isArray(root)) {
    return root.map((item) => isObject(item) ? item : { value: item });
  }
  return [isObject(root) ? root : { value: root }];
}

function datasetFrom(name: string, root: JsonValue): Dataset {
  const base = name.replace(/\.json$/i, '') || 'untitled';
  return { id: uid(), name: base, source: 'Local file', root, rows: normalizeRoot(root), createdAt: Date.now() };
}

function columnsFor(rows: Row[]): string[] {
  const keys: string[] = [];
  rows.forEach((row) => Object.keys(row).forEach((key) => { if (!keys.includes(key)) keys.push(key); }));
  return keys;
}

function valueTone(value: JsonValue) {
  if (value === null) return 'null';
  if (Array.isArray(value) || isObject(value)) return 'key';
  return typeof value;
}

function getPath(root: JsonValue, path: string): JsonValue {
  if (!path.trim() || path === '$' || path === '.') return root;
  const clean = path.trim().replace(/^\$\.?/, '').replace(/^\./, '');
  if (!clean) return root;
  const tokens = clean.match(/[^.[\]]+/g) ?? [];
  let current: JsonValue = root;
  for (const token of tokens) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (isObject(current)) current = current[token];
    else return null;
    if (current === undefined) return null;
  }
  return current;
}

function pointerPath(root: JsonValue, pointer: string): JsonValue {
  if (!pointer || pointer === '/') return root;
  let current: JsonValue = root;
  for (const token of pointer.split('/').slice(1).map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~'))) {
    if (Array.isArray(current)) current = current[Number(token)];
    else if (isObject(current)) current = current[token];
    else return null;
    if (current === undefined) return null;
  }
  return current;
}

function schemaFor(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return { type: 'array', items: value.length ? schemaFor(value[0]) : {} };
  if (value === null) return { type: 'null' };
  if (typeof value !== 'object') return { type: typeof value };
  const properties: Record<string, JsonValue> = {};
  Object.entries(value).forEach(([key, child]) => { properties[key] = schemaFor(child); });
  return { type: 'object', properties };
}

function collectText(value: JsonValue): string {
  return typeof value === 'object' && value !== null ? Object.entries(value).map(([key, child]) => `${key} ${collectText(child)}`).join(' ') : String(value ?? 'null');
}

function openWorkspaceDb() {
  return new Promise<IDBDatabase | null>((resolve) => {
    if (!('indexedDB' in window)) return resolve(null);
    const request = indexedDB.open('jsonx-local', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspace');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
  });
}

async function saveWorkspace(datasets: Dataset[]) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(datasets));
  const db = await openWorkspaceDb();
  if (!db) return;
  const tx = db.transaction('workspace', 'readwrite');
  tx.objectStore('workspace').put({ datasets, savedAt: Date.now() }, 'current');
}

function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: 'muted' | 'green' | 'amber' | 'blue' }) {
  const colors = { muted: 'text-slate-400 bg-slate-500/10', green: 'text-emerald-300 bg-emerald-400/10', amber: 'text-amber-300 bg-amber-400/10', blue: 'text-cyan-300 bg-cyan-400/10' };
  return <span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${colors[tone]}`}>{children}</span>;
}

function IconButton({ label, onClick, children, disabled = false, testId }: { label: string; onClick: () => void; children: ReactNode; disabled?: boolean; testId: string }) {
  return <button type="button" aria-label={label} title={label} onClick={onClick} disabled={disabled} data-testid={testId} className="icon-btn control h-8 w-8">{children}</button>;
}

function EmptyState({ onOpen, onPaste, onSample, onFiles }: { onOpen: () => void; onPaste: () => void; onSample: () => void; onFiles: (files: File[]) => void }) {
  const [isOver, setIsOver] = useState(false);
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsOver(false);
    const files = Array.from(event.dataTransfer.files);
    if (files.length) onFiles(files);
  };
  return (
    <main className="jsonx-grid flex min-h-[calc(100dvh-3.5rem)] items-center justify-center p-5 md:p-10">
      <div className="animate-in w-full max-w-2xl text-center">
        <div className="mx-auto mb-7 flex h-16 w-16 items-center justify-center rounded-2xl border border-emerald-300/30 bg-emerald-300/10 text-emerald-300">
          <Braces size={30} strokeWidth={1.5} />
        </div>
        <p className="mono mb-3 text-[11px] uppercase tracking-[.24em] text-emerald-300">local workspace / ready</p>
        <h1 className="mb-3 text-3xl font-semibold tracking-tight text-slate-100 md:text-5xl">Inspect JSON without<br className="hidden md:block" /> sending it anywhere.</h1>
        <p className="mx-auto mb-8 max-w-lg text-sm leading-6 text-slate-400">Drop a file into the cockpit, or open raw JSON from your clipboard. JSONX processes everything in this browser — no account, network, or telemetry.</p>
        <div onDragOver={(event) => { event.preventDefault(); setIsOver(true); }} onDragLeave={() => setIsOver(false)} onDrop={handleDrop} className={`dropzone rounded-xl p-8 transition-colors ${isOver ? 'is-over' : ''}`} data-testid="dropzone-json">
          <Upload className="mx-auto mb-3 text-emerald-300" size={22} />
          <p className="mb-1 text-sm font-medium text-slate-200">Drop one or more .json files here</p>
          <p className="mono mb-5 text-[11px] text-slate-500">or choose from your device</p>
          <div className="flex flex-wrap justify-center gap-2">
            <button type="button" onClick={onOpen} data-testid="button-open-json" className="btn-primary inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm font-semibold"><FolderOpen size={15} /> Open JSON</button>
            <button type="button" onClick={onPaste} data-testid="button-paste-json" className="btn-quiet inline-flex h-9 items-center gap-2 rounded-md px-4 text-sm"><Clipboard size={15} /> Paste JSON</button>
          </div>
        </div>
        <button type="button" onClick={onSample} data-testid="button-load-sample" className="mt-5 text-xs text-slate-500 underline decoration-slate-700 underline-offset-4 hover:text-emerald-300">Load a small local sample to explore</button>
        <div className="mt-10 flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[11px] text-slate-500"><span className="inline-flex items-center gap-1.5"><ShieldCheck size={13} className="text-emerald-400" /> Browser-only processing</span><span className="inline-flex items-center gap-1.5"><Zap size={13} className="text-cyan-300" /> No setup required</span><span className="inline-flex items-center gap-1.5"><History size={13} /> Autosaves locally</span></div>
      </div>
    </main>
  );
}

function TreeView({ value, depth = 0, path = '$' }: { value: JsonValue; depth?: number; path?: string }) {
  const [open, setOpen] = useState(depth < 1);
  if (!Array.isArray(value) && !isObject(value)) return <span className={`mono text-xs ${valueTone(value)}`}>{JSON.stringify(value)}</span>;
  const entries = Array.isArray(value) ? value.map((child, index) => [String(index), child] as [string, JsonValue]) : Object.entries(value);
  return <div className="mono text-xs" style={{ paddingLeft: depth ? 16 : 0 }}>
    <button type="button" onClick={() => setOpen(!open)} className="mr-1 inline-flex items-center text-slate-500 hover:text-emerald-300" data-testid={`button-tree-toggle-${path}`}>{open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</button>
    <span className="text-slate-500">{Array.isArray(value) ? `[${value.length}]` : `{${entries.length}}`}</span>
    {open && <div className="mt-1 space-y-1 border-l border-slate-800 pl-3">{entries.map(([key, child]) => <div key={`${path}.${key}`}><span className="key">{key}</span><span className="text-slate-600">: </span><TreeView value={child} depth={depth + 1} path={`${path}.${key}`} /></div>)}</div>}
  </div>;
}

function CommandPalette({ onClose, onImport, onTool, onView, onExport }: { onClose: () => void; onImport: () => void; onTool: (tool: ToolMode) => void; onView: (view: ViewMode) => void; onExport: () => void }) {
  const [query, setQuery] = useState('');
  const commands = [
    { label: 'Open JSON file', hint: 'Import local file', icon: FolderOpen, action: onImport },
    { label: 'Export current dataset', hint: 'Download as JSON', icon: Download, action: onExport },
    { label: 'Table view', hint: '⌘ 1', icon: LayoutGrid, action: () => onView('table') },
    { label: 'Tree view', hint: '⌘ 2', icon: Braces, action: () => onView('tree') },
    { label: 'Raw JSON view', hint: '⌘ 3', icon: Code2, action: () => onView('raw') },
    { label: 'JSONPath explorer', hint: 'Tool', icon: Search, action: () => onTool('jsonpath') },
    { label: 'Generate schema', hint: 'Tool', icon: WandSparkles, action: () => onTool('schema') },
    { label: 'Validate JSON', hint: 'Tool', icon: ShieldCheck, action: () => onTool('validate') },
  ].filter((item) => item.label.toLowerCase().includes(query.toLowerCase()));
  return <div className="fixed inset-0 z-40 flex items-start justify-center bg-black/60 px-4 pt-[13vh]" onClick={onClose}>
    <div className="panel animate-in w-full max-w-xl overflow-hidden rounded-xl" onClick={(event) => event.stopPropagation()}>
      <div className="flex items-center gap-3 border-b border-slate-800 px-4"><Search size={17} className="text-slate-500" /><input autoFocus value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search commands..." data-testid="input-command-search" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600" /><kbd className="mono rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">ESC</kbd></div>
      <div className="max-h-[52vh] overflow-y-auto p-2 scrollbar-thin">{commands.length ? commands.map(({ label, hint, icon: Icon, action }) => <button type="button" key={label} onClick={() => { action(); onClose(); }} className="flex w-full items-center gap-3 rounded-md px-3 py-3 text-left hover:bg-slate-800/80" data-testid={`command-${label.toLowerCase().replaceAll(' ', '-')}`}><Icon size={16} className="text-emerald-300" /><span className="flex-1 text-sm text-slate-200">{label}</span><span className="mono text-[10px] text-slate-600">{hint}</span></button>) : <p className="px-3 py-8 text-center text-xs text-slate-500">No matching commands</p>}</div>
      <div className="flex items-center gap-2 border-t border-slate-800 px-4 py-2 text-[10px] text-slate-600"><Command size={12} /> Navigate with arrow keys <span className="mx-1">·</span> Enter to run</div>
    </div>
  </div>;
}

function PasteDialog({ onClose, onImport }: { onClose: () => void; onImport: (text: string, name: string) => void }) {
  const [text, setText] = useState('');
  const [name, setName] = useState('pasted-json');
  const [error, setError] = useState('');
  const submit = () => { try { onImport(text, name); onClose(); } catch (err) { setError(err instanceof Error ? err.message : 'Invalid JSON'); } };
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}><div className="panel animate-in w-full max-w-2xl rounded-xl" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-800 px-5 py-4"><div><h2 className="text-sm font-semibold text-slate-100">Paste JSON</h2><p className="mt-1 text-xs text-slate-500">Nothing leaves this browser.</p></div><IconButton label="Close dialog" onClick={onClose} testId="button-close-paste"><X size={16} /></IconButton></div><div className="space-y-3 p-5"><input value={name} onChange={(event) => setName(event.target.value)} data-testid="input-paste-name" className="control h-9 w-full rounded-md px-3 text-xs" placeholder="Dataset name" /><textarea autoFocus value={text} onChange={(event) => setText(event.target.value)} data-testid="textarea-paste-json" className="control mono min-h-64 w-full resize-y rounded-md p-3 text-xs leading-5" placeholder={'{\n  "hello": "world"\n}'} />{error && <p className="flex items-center gap-2 text-xs text-red-300"><AlertTriangle size={14} /> {error}</p>}<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="btn-quiet rounded-md px-4 py-2 text-xs">Cancel</button><button type="button" onClick={submit} data-testid="button-import-pasted" className="btn-primary rounded-md px-4 py-2 text-xs font-semibold">Import JSON</button></div></div></div></div>;
}

function ToolPanel({ mode, dataset, onClose }: { mode: ToolMode; dataset: Dataset; onClose: () => void }) {
  const [input, setInput] = useState(mode === 'jsonpath' ? '$' : mode === 'pointer' ? '/' : '');
  const [compare, setCompare] = useState('');
  const [apiInput, setApiInput] = useState('');
  const [result, setResult] = useState<JsonValue | string | null>(null);
  const run = () => {
    try {
      if (mode === 'jsonpath') setResult(getPath(dataset.root, input));
      if (mode === 'pointer') setResult(pointerPath(dataset.root, input));
      if (mode === 'schema') setResult(schemaFor(dataset.root));
      if (mode === 'validate') { JSON.parse(pretty(dataset.root)); setResult('Valid JSON — structure parsed successfully.'); }
      if (mode === 'diff') { const left = pretty(dataset.root); const right = pretty(JSON.parse(compare)); setResult(left === right ? 'No differences.' : `Difference detected.\n\nCurrent: ${left.slice(0, 420)}\n\nCompared: ${right.slice(0, 420)}`); }
      if (mode === 'api') setResult(JSON.parse(apiInput));
    } catch (err) { setResult(err instanceof Error ? `Error: ${err.message}` : 'Could not evaluate input.'); }
  };
  const titles: Record<ToolMode, string> = { jsonpath: 'JSONPath explorer', pointer: 'JSON Pointer', diff: 'JSON diff', schema: 'Schema generator', validate: 'Validate JSON', api: 'API response viewer' };
  return <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/70 p-4" onClick={onClose}><div className="panel animate-in flex max-h-[86vh] w-full max-w-3xl flex-col rounded-xl" onClick={(event) => event.stopPropagation()}><div className="flex items-center justify-between border-b border-slate-800 px-5 py-4"><div><div className="mono mb-1 text-[10px] uppercase tracking-widest text-emerald-300">json tools</div><h2 className="text-sm font-semibold text-slate-100">{titles[mode]}</h2></div><IconButton label="Close tool" onClick={onClose} testId="button-close-tool"><X size={16} /></IconButton></div><div className="grid min-h-0 flex-1 gap-4 overflow-y-auto p-5 md:grid-cols-2"><div className="space-y-3"><p className="text-xs leading-5 text-slate-500">{mode === 'jsonpath' && 'Query nested values with a lightweight JSONPath syntax. Example: $.users[0].email'}{mode === 'pointer' && 'Address an exact value using RFC 6901 JSON Pointer notation.'}{mode === 'schema' && 'Infer a compact JSON Schema from the current dataset.'}{mode === 'validate' && 'Run a local parse and structural check on the active document.'}{mode === 'diff' && 'Compare another JSON document against the active root.'}{mode === 'api' && 'Paste a captured response body to inspect it as JSON.'}</p>{mode === 'diff' ? <textarea value={compare} onChange={(event) => setCompare(event.target.value)} data-testid="textarea-tool-compare" className="control mono min-h-52 w-full resize-y rounded-md p-3 text-xs" placeholder="Paste comparison JSON..." /> : mode === 'api' ? <textarea value={apiInput} onChange={(event) => setApiInput(event.target.value)} data-testid="textarea-tool-api" className="control mono min-h-52 w-full resize-y rounded-md p-3 text-xs" placeholder="Paste API response JSON..." /> : mode === 'schema' || mode === 'validate' ? <div className="rounded-lg border border-slate-800 bg-slate-950/30 p-4 text-xs text-slate-500">Active source<br /><strong className="mt-1 block font-normal text-slate-200">{dataset.name}</strong><span className="mono mt-2 block text-[11px] text-slate-600">{compact(dataset.root).length.toLocaleString()} bytes in memory</span></div> : <input value={input} onChange={(event) => setInput(event.target.value)} data-testid="input-tool-path" className="control mono h-10 w-full rounded-md px-3 text-xs" placeholder={mode === 'jsonpath' ? '$.users[0]' : '/users/0'} />}<button type="button" onClick={run} data-testid={`button-run-${mode}`} className="btn-primary inline-flex h-9 items-center gap-2 rounded-md px-4 text-xs font-semibold"><Sparkles size={14} /> Run locally</button></div><div className="min-h-52 rounded-lg border border-slate-800 bg-slate-950/50 p-4">{result === null ? <div className="flex h-full min-h-44 items-center justify-center text-center text-xs text-slate-600">Result appears here<br />after you run the tool</div> : <pre data-testid="display-tool-result" className="mono max-h-[48vh] overflow-auto whitespace-pre-wrap text-xs leading-5 text-slate-300 scrollbar-thin">{typeof result === 'string' ? result : pretty(result)}</pre>}</div></div></div></div>;
}

function App() {
  const [datasets, setDatasets] = useState<Dataset[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [view, setView] = useState<ViewMode>('table');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [isReady, setIsReady] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [commandOpen, setCommandOpen] = useState(false);
  const [tool, setTool] = useState<ToolMode | null>(null);
  const [query, setQuery] = useState('');
  const [searchScope, setSearchScope] = useState<'all' | 'key' | 'value'>('all');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [sort, setSort] = useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [page, setPage] = useState(1);
  const [visibleColumns, setVisibleColumns] = useState<string[]>([]);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [history, setHistory] = useState<Record<string, HistoryState>>({});
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let restored = false;
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const loaded = JSON.parse(saved) as Dataset[];
        if (loaded.length) { restored = true; setDatasets(loaded); setActiveId(loaded[0].id); }
      }
    } catch { /* local workspace can be safely reset */ }
    if (!restored) {
      void openWorkspaceDb().then((db) => {
        if (!db) return;
        const request = db.transaction('workspace', 'readonly').objectStore('workspace').get('current');
        request.onsuccess = () => {
          const saved = request.result as { datasets?: Dataset[] } | undefined;
          if (saved?.datasets?.length) { setDatasets(saved.datasets); setActiveId(saved.datasets[0].id); }
        };
      });
    }
    const timer = window.setTimeout(() => setIsReady(true), 240);
    return () => window.clearTimeout(timer);
  }, []);

  const active = datasets.find((dataset) => dataset.id === activeId) ?? null;
  const allColumns = useMemo(() => columnsFor(active?.rows ?? []), [active]);
  useEffect(() => { setVisibleColumns((current) => current.length ? current.filter((key) => allColumns.includes(key)) : allColumns); }, [allColumns]);
  useEffect(() => { void saveWorkspace(datasets); }, [datasets]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey;
      if (mod && event.key.toLowerCase() === 'k') { event.preventDefault(); setCommandOpen(true); }
      if (event.key === 'Escape') { setCommandOpen(false); setPasteOpen(false); setTool(null); setColumnsOpen(false); }
      if (mod && event.key === 'o') { event.preventDefault(); fileInputRef.current?.click(); }
      if (mod && event.key === '1') { event.preventDefault(); setView('table'); }
      if (mod && event.key === '2') { event.preventDefault(); setView('tree'); }
      if (mod && event.key === '3') { event.preventDefault(); setView('raw'); }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const importText = useCallback((text: string, name: string) => {
    const root = JSON.parse(text) as JsonValue;
    const next = datasetFrom(name, root);
    setDatasets((current) => [...current, next]);
    setActiveId(next.id);
    setPage(1);
  }, []);
  const handleFileList = (files: File[]) => {
    files.forEach((file) => {
      const reader = new FileReader();
      reader.onload = () => { try { importText(String(reader.result), file.name); } catch { /* invalid files remain local and are ignored */ } };
      reader.readAsText(file);
    });
  };
  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    handleFileList(Array.from(event.target.files ?? []));
    event.target.value = '';
  };
  const createSample = () => importText(JSON.stringify([
    { id: 'usr_0142', name: 'Mira Chen', role: 'engineer', active: true, projects: 4, region: 'eu-west' },
    { id: 'usr_0143', name: 'Jon Bell', role: 'designer', active: true, projects: 2, region: 'us-east' },
    { id: 'usr_0144', name: 'Asha Raman', role: 'engineer', active: false, projects: 7, region: 'ap-south' },
    { id: 'usr_0145', name: 'Ravi Noor', role: 'analyst', active: true, projects: 3, region: 'eu-west' },
  ]), 'workspace-sample.json');
  const openPicker = () => fileInputRef.current?.click();
  const closeDataset = (id: string) => { setDatasets((current) => current.filter((dataset) => dataset.id !== id)); if (activeId === id) { const next = datasets.find((dataset) => dataset.id !== id); setActiveId(next?.id ?? null); } };
  const updateRows = (nextRows: Row[], recordHistory = true) => {
    if (!active) return;
    if (recordHistory) setHistory((current) => ({ ...current, [active.id]: { past: [...(current[active.id]?.past ?? []), cloneRows(active.rows)].slice(-40), future: [] } }));
    setDatasets((current) => current.map((dataset) => dataset.id === active.id ? { ...dataset, rows: nextRows, root: Array.isArray(dataset.root) ? nextRows : nextRows[0] ?? {} } : dataset));
  };
  const undo = () => {
    if (!active) return;
    const currentHistory = history[active.id];
    const previous = currentHistory?.past.at(-1);
    if (!previous) return;
    setHistory((current) => ({ ...current, [active.id]: { past: currentHistory.past.slice(0, -1), future: [cloneRows(active.rows), ...currentHistory.future] } }));
    updateRows(previous, false);
  };
  const redo = () => {
    if (!active) return;
    const currentHistory = history[active.id];
    const next = currentHistory?.future[0];
    if (!next) return;
    setHistory((current) => ({ ...current, [active.id]: { past: [...currentHistory.past, cloneRows(active.rows)], future: currentHistory.future.slice(1) } }));
    updateRows(next, false);
  };
  const addRow = () => {
    if (!active) return;
    const nextRow: Row = allColumns.length ? {} : { value: '' };
    updateRows([...active.rows, nextRow]);
  };
  const deleteRow = (index: number) => updateRows((active?.rows ?? []).filter((_, rowIndex) => rowIndex !== index));
  const duplicateRow = (index: number) => { if (!active) return; const rows = cloneRows(active.rows); rows.splice(index + 1, 0, rows[index]); updateRows(rows); };
  const editCell = (rowIndex: number, key: string, raw: string) => {
    if (!active) return;
    const rows = cloneRows(active.rows);
    let value: JsonValue = raw;
    try { value = JSON.parse(raw) as JsonValue; } catch { /* plain string remains a string */ }
    rows[rowIndex] = { ...rows[rowIndex], [key]: value };
    updateRows(rows);
  };
  const renameDataset = () => {
    if (!active) return;
    const nextName = window.prompt('Rename dataset', active.name);
    if (nextName?.trim()) setDatasets((current) => current.map((dataset) => dataset.id === active.id ? { ...dataset, name: nextName.trim() } : dataset));
  };
  const exportData = () => {
    if (!active) return;
    const blob = new Blob([pretty(active.root)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${active.name || 'export'}.json`; anchor.click(); URL.revokeObjectURL(url);
  };
  const copyValue = async (value: JsonValue) => { await navigator.clipboard?.writeText(pretty(value)); };

  const filteredRows = useMemo(() => {
    if (!active) return [];
    const search = caseSensitive ? query : query.toLowerCase();
    let rows = active.rows.filter((row) => {
      if (!search) return true;
      try {
        const regexValue = regex ? new RegExp(query, caseSensitive ? '' : 'i') : null;
        const matches = (value: string) => regexValue ? regexValue.test(value) : (caseSensitive ? value.includes(search) : value.toLowerCase().includes(search));
        if (searchScope === 'key') return Object.keys(row).some(matches);
        if (searchScope === 'value') return Object.values(row).some((value) => matches(collectText(value)));
        return Object.entries(row).some(([key, value]) => matches(key) || matches(collectText(value)));
      } catch { return false; }
    });
    if (sort) rows = [...rows].sort((a, b) => {
      const av = displayValue(a[sort.key] ?? null); const bv = displayValue(b[sort.key] ?? null);
      return av.localeCompare(bv, undefined, { numeric: true }) * (sort.direction === 'asc' ? 1 : -1);
    });
    return rows;
  }, [active, query, searchScope, caseSensitive, regex, sort]);
  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const currentRows = filteredRows.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  useEffect(() => { setPage(1); }, [query, searchScope, caseSensitive, regex, sort, activeId]);
  const canUndo = !!active && !!history[active.id]?.past.length;
  const canRedo = !!active && !!history[active.id]?.future.length;

  if (!isReady) return <div className="jsonx-shell noise flex min-h-[100dvh] items-center justify-center"><div className="mono flex items-center gap-2 text-xs text-slate-500"><span className="status-dot pulse-soft" /> Initializing local workspace</div></div>;

  return <div className="jsonx-shell noise min-h-[100dvh]">
    <input ref={fileInputRef} type="file" accept=".json,application/json" multiple onChange={handleFiles} className="hidden" data-testid="input-file-json" />
    <header className="flex h-14 items-center justify-between border-b border-slate-800/90 bg-slate-950/40 px-3 md:px-5">
      <div className="flex min-w-0 items-center gap-3"><button type="button" onClick={() => setSidebarOpen(!sidebarOpen)} className="icon-btn h-8 w-8 text-slate-400 hover:text-slate-100 md:hidden" data-testid="button-toggle-sidebar"><Menu size={18} /></button><div className="flex items-center gap-2"><div className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-300 text-slate-950"><Braces size={16} /></div><span className="text-sm font-semibold tracking-tight text-slate-100">JSONX</span></div><span className="hidden h-4 w-px bg-slate-800 sm:block" /><span className="hidden truncate text-xs text-slate-500 sm:block">private data cockpit</span></div>
      <div className="flex items-center gap-1.5"><div className="hidden items-center gap-2 rounded-md border border-slate-800 bg-slate-900/60 px-3 py-1.5 text-[11px] text-slate-500 md:flex"><Search size={13} /><span>Search workspace</span><kbd className="mono ml-3 rounded border border-slate-700 px-1.5 py-0.5 text-[10px] text-slate-500">⌘ K</kbd></div><button type="button" onClick={() => setCommandOpen(true)} className="icon-btn h-8 w-8 text-slate-400 hover:text-emerald-300 md:hidden" data-testid="button-command-palette"><Command size={16} /></button><button type="button" onClick={openPicker} className="btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-xs font-semibold" data-testid="button-header-open"><Plus size={14} /> <span className="hidden sm:inline">Open JSON</span></button></div>
    </header>
    {!datasets.length ? <EmptyState onOpen={openPicker} onPaste={() => setPasteOpen(true)} onSample={createSample} onFiles={handleFileList} /> : <div className="flex min-h-[calc(100dvh-3.5rem)]">
      <aside className={`${sidebarOpen ? 'fixed inset-y-14 left-0 z-30 flex' : 'hidden'} w-64 shrink-0 flex-col border-r border-slate-800 bg-[#0b0d13] md:static md:flex`}>
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3"><span className="mono text-[10px] uppercase tracking-widest text-slate-500">workspace</span><button type="button" onClick={() => setSidebarOpen(false)} className="hidden text-slate-500 hover:text-slate-200 md:block" data-testid="button-collapse-sidebar"><PanelLeftClose size={15} /></button></div>
        <div className="flex-1 overflow-y-auto p-2 scrollbar-thin"><div className="mb-2 flex items-center justify-between px-2 pt-1 text-[10px] uppercase tracking-widest text-slate-600"><span>Documents</span><button type="button" onClick={openPicker} className="text-slate-500 hover:text-emerald-300" data-testid="button-add-document"><Plus size={14} /></button></div>{datasets.map((dataset) => <div key={dataset.id} className={`group mb-1 rounded-md border ${dataset.id === activeId ? 'border-emerald-300/20 bg-emerald-300/[.07]' : 'border-transparent hover:bg-slate-900'}`}><button type="button" onClick={() => { setActiveId(dataset.id); setSidebarOpen(false); }} className="flex w-full items-center gap-2 px-2.5 py-2 text-left" data-testid={`button-dataset-${dataset.id}`}><FileJson size={14} className={dataset.id === activeId ? 'text-emerald-300' : 'text-slate-500'} /><span className="min-w-0 flex-1 truncate text-xs text-slate-300">{dataset.name}</span><span className="mono text-[9px] text-slate-600">{dataset.rows.length}</span></button><div className="hidden items-center gap-1 px-2.5 pb-2 group-hover:flex"><button type="button" onClick={renameDataset} className="text-[10px] text-slate-500 hover:text-slate-200" data-testid={`button-rename-${dataset.id}`}>Rename</button><span className="text-slate-700">·</span><button type="button" onClick={() => closeDataset(dataset.id)} className="text-[10px] text-slate-500 hover:text-red-300" data-testid={`button-close-${dataset.id}`}>Close</button></div></div>)}</div>
        <div className="border-t border-slate-800 p-3"><div className="flex items-center gap-2 text-[11px] text-slate-500"><ShieldCheck size={14} className="text-emerald-400" /><span>Local only</span><span className="ml-auto mono text-[10px] text-slate-600">{datasets.length} file{datasets.length === 1 ? '' : 's'}</span></div><p className="mt-2 text-[10px] leading-4 text-slate-600">IndexedDB autosave is on. Your files never leave this device.</p></div>
      </aside>
      {sidebarOpen && <button type="button" onClick={() => setSidebarOpen(false)} className="fixed inset-0 z-20 bg-black/50 md:hidden" aria-label="Close sidebar" data-testid="button-dismiss-sidebar" />}
      <main className="min-w-0 flex-1">
        {!active ? <div className="flex h-full items-center justify-center text-sm text-slate-500">Select a document</div> : <div className="flex h-full min-w-0 flex-col">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-4 py-3 md:px-6"><div className="flex min-w-0 items-center gap-2"><FileJson size={17} className="shrink-0 text-emerald-300" /><div className="min-w-0"><h1 className="truncate text-sm font-medium text-slate-100" data-testid="text-active-dataset">{active.name}</h1><div className="mono mt-0.5 text-[10px] text-slate-600">in memory · autosaved locally</div></div><Pill tone="green"><span className="status-dot" /> private</Pill></div><div className="flex items-center gap-1.5"><IconButton label="Undo" onClick={undo} disabled={!canUndo} testId="button-undo"><Undo2 size={15} /></IconButton><IconButton label="Redo" onClick={redo} disabled={!canRedo} testId="button-redo"><Redo2 size={15} /></IconButton><div className="mx-1 h-5 w-px bg-slate-800" /><button type="button" onClick={() => setTool('schema')} className="btn-quiet hidden h-8 items-center gap-1.5 rounded-md px-2.5 text-xs sm:inline-flex" data-testid="button-tools"><WandSparkles size={14} /> Tools</button><button type="button" onClick={exportData} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs" data-testid="button-export-json"><Download size={14} /> <span className="hidden sm:inline">Export</span></button><IconButton label="More tools" onClick={() => setTool('api')} testId="button-more-tools"><MoreHorizontal size={16} /></IconButton></div></div>
          <div className="flex min-w-0 flex-wrap items-center gap-2 border-b border-slate-800 px-4 py-2 md:px-6"><div className="relative min-w-[190px] flex-1 md:max-w-md"><Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-600" /><input value={query} onChange={(event) => setQuery(event.target.value)} data-testid="input-global-search" className="control h-8 w-full rounded-md pl-9 pr-3 text-xs placeholder:text-slate-600" placeholder="Search keys and values..." /></div><select value={searchScope} onChange={(event) => setSearchScope(event.target.value as 'all' | 'key' | 'value')} data-testid="select-search-scope" className="control h-8 rounded-md px-2 text-[11px]"><option value="all">All fields</option><option value="key">Keys only</option><option value="value">Values only</option></select><button type="button" onClick={() => setCaseSensitive(!caseSensitive)} className={`control h-8 rounded-md px-2.5 text-[11px] ${caseSensitive ? 'border-emerald-300/60 text-emerald-300' : 'text-slate-500'}`} data-testid="button-case-sensitive">Aa</button><button type="button" onClick={() => setRegex(!regex)} className={`control h-8 rounded-md px-2.5 text-[11px] ${regex ? 'border-cyan-300/60 text-cyan-300' : 'text-slate-500'}`} data-testid="button-regex">.*</button><div className="ml-auto flex items-center gap-1"><div className="relative"><button type="button" onClick={() => setColumnsOpen(!columnsOpen)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs" data-testid="button-columns"><SlidersHorizontal size={14} /> <span className="hidden sm:inline">Columns</span></button>{columnsOpen && <div className="panel absolute right-0 top-10 z-20 w-52 rounded-lg p-2">{allColumns.map((column) => <label key={column} className="flex cursor-pointer items-center gap-2 rounded px-2 py-2 text-xs text-slate-300 hover:bg-slate-800"><input type="checkbox" checked={visibleColumns.includes(column)} onChange={() => setVisibleColumns((current) => current.includes(column) ? current.filter((item) => item !== column) : [...current, column])} data-testid={`checkbox-column-${column}`} className="accent-emerald-400" />{column}</label>)}</div>}</div><button type="button" onClick={addRow} className="btn-primary inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs font-semibold" data-testid="button-add-record"><Plus size={14} /> <span className="hidden sm:inline">Record</span></button></div></div>
          <div className="flex items-center justify-between border-b border-slate-800 px-4 md:px-6"><div className="flex items-center gap-4"><button type="button" onClick={() => setView('table')} className={`flex h-10 items-center gap-1.5 text-xs ${view === 'table' ? 'tab-active' : 'text-slate-500 hover:text-slate-300'}`} data-testid="tab-table"><LayoutGrid size={14} /> Table</button><button type="button" onClick={() => setView('tree')} className={`flex h-10 items-center gap-1.5 text-xs ${view === 'tree' ? 'tab-active' : 'text-slate-500 hover:text-slate-300'}`} data-testid="tab-tree"><Braces size={14} /> Tree</button><button type="button" onClick={() => setView('raw')} className={`flex h-10 items-center gap-1.5 text-xs ${view === 'raw' ? 'tab-active' : 'text-slate-500 hover:text-slate-300'}`} data-testid="tab-raw"><Code2 size={14} /> Raw</button></div><div className="mono hidden items-center gap-2 text-[10px] text-slate-600 sm:flex"><span>{filteredRows.length.toLocaleString()} records</span><span>·</span><span>{allColumns.length} columns</span></div></div>
          <div className="min-h-0 flex-1 overflow-auto p-4 md:p-6 scrollbar-thin">
            {view === 'table' && <div className="panel min-w-[680px] overflow-hidden rounded-lg">
              <div className="flex items-center justify-between border-b border-slate-800 bg-slate-950/35 px-3 py-2">
                <div className="flex items-center gap-2 text-[11px] text-slate-500"><ListFilter size={13} /> {query ? `${filteredRows.length} matching records` : 'All records'}</div>
                <span className="mono text-[10px] text-slate-600">double-click values to edit</span>
              </div>
              <table className="w-full border-collapse text-left">
                <thead><tr className="border-b border-slate-800">{visibleColumns.map((column) => <th key={column} className="mono whitespace-nowrap px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-slate-500"><button type="button" onClick={() => setSort((current) => current?.key === column ? { key: column, direction: current.direction === 'asc' ? 'desc' : 'asc' } : { key: column, direction: 'asc' })} className="inline-flex items-center gap-1 hover:text-emerald-300" data-testid={`button-sort-${column}`}>{column}{sort?.key === column && (sort.direction === 'asc' ? <ArrowUp size={11} /> : <ArrowDown size={11} />)}</button></th>)}<th className="w-20 px-2" /></tr></thead>
                <tbody>{currentRows.length ? currentRows.map((row) => {
                  const realIndex = active.rows.indexOf(row);
                  return <tr key={`${active.id}-${realIndex}-${compact(row)}`} className="group border-b border-slate-800/70 last:border-0 hover:bg-slate-900/60" data-testid={`row-record-${realIndex}`}>
                    {visibleColumns.map((column) => <td key={column} className="max-w-[280px] px-3 py-2 align-top"><input key={`${active.id}-${realIndex}-${column}-${compact(row[column] ?? null)}`} defaultValue={displayValue(row[column] ?? null)} onBlur={(event) => editCell(realIndex, column, event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur(); }} data-testid={`input-cell-${realIndex}-${column}`} className={`mono w-full min-w-24 bg-transparent text-xs outline-none ${valueTone(row[column] ?? null)} focus:rounded focus:bg-slate-950 focus:px-2 focus:py-1`} /></td>)}
                    <td className="px-2"><div className="flex items-center justify-end gap-1 opacity-0 transition-opacity group-hover:opacity-100"><IconButton label="Duplicate record" onClick={() => duplicateRow(realIndex)} testId={`button-duplicate-${realIndex}`}><Copy size={13} /></IconButton><IconButton label="Delete record" onClick={() => deleteRow(realIndex)} testId={`button-delete-${realIndex}`}><Trash2 size={13} /></IconButton></div></td>
                  </tr>;
                }) : <tr><td colSpan={visibleColumns.length + 1} className="py-16 text-center"><Filter className="mx-auto mb-3 text-slate-700" size={22} /><p className="text-xs text-slate-500">No records match this search.</p><button type="button" onClick={() => setQuery('')} className="mt-2 text-xs text-emerald-300 hover:underline" data-testid="button-clear-search">Clear search</button></td></tr>}</tbody>
              </table>
            </div>}
            {view === 'tree' && <div className="panel rounded-lg p-4 md:p-6"><div className="mb-5 flex items-center justify-between border-b border-slate-800 pb-3"><div><p className="mono text-[10px] uppercase tracking-widest text-emerald-300">nested inspector</p><h2 className="mt-1 text-sm text-slate-200">{active.name}</h2></div><button type="button" onClick={() => copyValue(active.root)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs" data-testid="button-copy-tree"><Copy size={13} /> Copy</button></div><TreeView value={active.root} /></div>}
            {view === 'raw' && <div className="panel rounded-lg p-4"><div className="mb-3 flex items-center justify-between"><span className="mono text-[10px] uppercase tracking-widest text-slate-600">raw.json</span><button type="button" onClick={() => copyValue(active.root)} className="btn-quiet inline-flex h-8 items-center gap-1.5 rounded-md px-2.5 text-xs" data-testid="button-copy-raw"><Copy size={13} /> Copy JSON</button></div><pre data-testid="display-raw-json" className="mono overflow-auto whitespace-pre-wrap text-xs leading-6 text-slate-300 scrollbar-thin">{pretty(active.root)}</pre></div>}
          </div>
          {view === 'table' && <div className="flex items-center justify-between border-t border-slate-800 px-4 py-2 md:px-6"><p className="mono text-[10px] text-slate-600">Showing {filteredRows.length ? (page - 1) * PAGE_SIZE + 1 : 0}–{Math.min(page * PAGE_SIZE, filteredRows.length)} of {filteredRows.length}</p><div className="flex items-center gap-1"><button type="button" onClick={() => setPage(Math.max(1, page - 1))} disabled={page === 1} className="icon-btn control h-7 w-7" data-testid="button-page-prev"><ChevronLeft size={14} /></button><span className="mono px-2 text-[10px] text-slate-500">{page} / {totalPages}</span><button type="button" onClick={() => setPage(Math.min(totalPages, page + 1))} disabled={page === totalPages} className="icon-btn control h-7 w-7" data-testid="button-page-next"><ChevronRight size={14} /></button></div></div>}
        </div>}
      </main>
    </div>}
    {pasteOpen && <PasteDialog onClose={() => setPasteOpen(false)} onImport={importText} />}
    {commandOpen && <CommandPalette onClose={() => setCommandOpen(false)} onImport={openPicker} onTool={setTool} onView={setView} onExport={exportData} />}
    {tool && active && <ToolPanel mode={tool} dataset={active} onClose={() => setTool(null)} />}
  </div>;
}

export default App;