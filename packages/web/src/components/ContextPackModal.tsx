import { useEffect, useState } from 'react';
import { Check, ClipboardCopy, Download, Upload, X } from 'lucide-react';
import { api } from '../api';

interface ContextPackModalProps {
  boardSlug: string;
  initialMode: 'export' | 'import';
  onClose: () => void;
  onApplied: () => void;
}

export function ContextPackModal({
  boardSlug,
  initialMode,
  onClose,
  onApplied,
}: ContextPackModalProps) {
  const [mode, setMode] = useState<'export' | 'import'>(initialMode);
  const [packText, setPackText] = useState('');
  const [includeProtocol, setIncludeProtocol] = useState(true);
  const [copied, setCopied] = useState(false);
  const [importText, setImportText] = useState('');
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (mode === 'export') {
      api
        .getContextPack(boardSlug, includeProtocol)
        .then((res) => setPackText(res.markdown))
        .catch((err) => setErrorMsg(err.message));
    }
  }, [boardSlug, includeProtocol, mode]);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(packText);
    setCopied(true);
    setTimeout(() => setCopied(false), 1800);
  };

  const handleImport = async () => {
    if (!importText.trim()) return;
    setBusy(true);
    setErrorMsg(null);
    setStatusMsg(null);
    try {
      const res = await api.applyContextUpdate(boardSlug, importText);
      setStatusMsg(`Applied ${res.appliedCount} update(s).`);
      setImportText('');
      onApplied();
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4">
      <div className="w-full max-w-3xl rounded-lg border border-zinc-800 bg-zinc-900 overflow-hidden flex flex-col max-h-[85vh]">
        <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setMode('export')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                mode === 'export'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Download className="w-3.5 h-3.5" />
              Copy pack
            </button>
            <button
              type="button"
              onClick={() => setMode('import')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition ${
                mode === 'import'
                  ? 'bg-zinc-800 text-zinc-100 border border-zinc-700'
                  : 'text-zinc-400 hover:text-zinc-200'
              }`}
            >
              <Upload className="w-3.5 h-3.5" />
              Paste update
            </button>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-zinc-400 hover:text-zinc-100 p-1"
            aria-label="Close"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 overflow-y-auto flex-1 space-y-3">
          {mode === 'export' ? (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <label className="inline-flex items-center gap-2 text-xs text-zinc-300 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={includeProtocol}
                    onChange={(e) => setIncludeProtocol(e.target.checked)}
                    className="rounded border-zinc-700 bg-zinc-800"
                  />
                  Include JSON sync-back prompt
                </label>
              </div>
              <textarea
                readOnly
                value={packText}
                className="w-full h-80 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 focus:outline-none"
              />
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={handleCopy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-xs font-medium text-white transition"
                >
                  {copied ? (
                    <Check className="w-3.5 h-3.5" />
                  ) : (
                    <ClipboardCopy className="w-3.5 h-3.5" />
                  )}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>
            </>
          ) : (
            <>
              <textarea
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'{\n  "baseRevision": 1,\n  "sessionTitle": "Architecture Chat",\n  "harness": "grok",\n  "decisions": [{ "title": "...", "summary": "..." }]\n}'}
                className="w-full h-72 rounded-lg border border-zinc-800 bg-zinc-950 p-3 font-mono text-xs text-zinc-200 focus:outline-none focus:border-indigo-500"
              />
              {errorMsg && (
                <div className="rounded-lg border border-rose-500/40 bg-zinc-950 px-3 py-2 text-xs text-rose-300">
                  {errorMsg}
                </div>
              )}
              {statusMsg && (
                <div className="rounded-lg border border-emerald-500/40 bg-zinc-950 px-3 py-2 text-xs text-emerald-300">
                  {statusMsg}
                </div>
              )}
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy || !importText.trim()}
                  onClick={handleImport}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-xs font-medium text-white transition"
                >
                  <Upload className="w-3.5 h-3.5" />
                  {busy ? 'Applying...' : 'Apply update'}
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
