'use client';

export const dynamic = 'force-dynamic';

import { useState } from 'react';

type DiscoverResult = {
  ok: boolean;
  results: {
    token_info?: { valid?: boolean; type?: string; scopes?: string[]; expires_at?: string };
    pages?: Array<{
      META_PAGE_ID: string;
      name: string;
      META_IG_ACCOUNT_ID: string | null;
      META_PAGE_ACCESS_TOKEN: string | null;
      tasks: string[];
    }>;
    ad_accounts?: Array<{
      META_AD_ACCOUNT_ID: string;
      name: string;
      status: string;
      currency: string | null;
    }>;
  };
  errors?: string[];
  hint?: string;
};

export default function MetaSetupPage() {
  const [token, setToken] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<DiscoverResult | null>(null);

  async function discover() {
    if (!token.trim()) return;
    setLoading(true);
    setResult(null);
    try {
      const res = await fetch('/api/setup/meta-discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: token.trim() }),
      });
      const data = await res.json();
      setResult(data as DiscoverResult);
    } catch (err) {
      setResult({ ok: false, results: {}, errors: [String(err)] });
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full overflow-y-auto bg-surface-900">
      <div className="px-6 py-4 border-b border-surface-600 bg-surface-800 shrink-0">
        <h2 className="text-base font-semibold text-gray-100">Configurar Meta (Facebook + Instagram + Ads)</h2>
        <p className="text-xs text-gray-500">Pega tu User Access Token de Meta Graph API Explorer para auto-descubrir los IDs.</p>
      </div>

      <div className="p-6 space-y-4 max-w-3xl mx-auto w-full">
        <section className="card p-4 space-y-3">
          <p className="text-sm text-gray-300">
            1. Ve a{' '}
            <a
              href="https://developers.facebook.com/tools/explorer/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-brand-400 hover:underline"
            >
              Graph API Explorer
            </a>{' '}
            → selecciona tu App → <strong>Get User Access Token</strong> → marca los permisos:
          </p>
          <ul className="text-xs text-gray-500 list-disc list-inside space-y-0.5 pl-2">
            <li><code className="text-gray-400">pages_show_list</code>, <code className="text-gray-400">pages_read_engagement</code>, <code className="text-gray-400">pages_manage_posts</code></li>
            <li><code className="text-gray-400">instagram_basic</code>, <code className="text-gray-400">instagram_content_publish</code></li>
            <li><code className="text-gray-400">ads_read</code> (para ver gasto de anuncios)</li>
          </ul>
          <p className="text-xs text-gray-500">2. Copia el token que aparece y pégalo abajo:</p>

          <textarea
            value={token}
            onChange={(e) => setToken(e.target.value)}
            placeholder="EAAG..."
            rows={3}
            className="w-full p-3 rounded-lg bg-surface-800 border border-surface-600 text-xs font-mono text-gray-300 focus:outline-none focus:border-brand-500"
          />

          <button
            type="button"
            onClick={discover}
            disabled={loading || !token.trim()}
            className="px-4 py-2 rounded-lg bg-brand-600 hover:bg-brand-500 text-white text-sm font-medium transition-colors disabled:opacity-50"
          >
            {loading ? 'Consultando Meta…' : '🔍 Descubrir IDs'}
          </button>
        </section>

        {result && (
          <>
            {result.errors && result.errors.length > 0 && (
              <section className="card p-4 border border-red-800 bg-red-950/20">
                <p className="text-xs font-semibold text-red-400 mb-2">Errores</p>
                <ul className="text-xs text-red-300 space-y-1">
                  {result.errors.map((e, i) => <li key={i}>• {e}</li>)}
                </ul>
              </section>
            )}

            {result.results.token_info && (
              <section className="card p-4">
                <p className="text-xs font-semibold text-gray-400 mb-2">Token</p>
                <dl className="text-xs text-gray-300 space-y-1">
                  <div className="flex gap-2"><dt className="text-gray-500 w-24">Válido:</dt><dd>{result.results.token_info.valid ? '✅' : '❌'}</dd></div>
                  <div className="flex gap-2"><dt className="text-gray-500 w-24">Tipo:</dt><dd>{result.results.token_info.type}</dd></div>
                  <div className="flex gap-2"><dt className="text-gray-500 w-24">Expira:</dt><dd>{result.results.token_info.expires_at}</dd></div>
                  <div className="flex gap-2">
                    <dt className="text-gray-500 w-24">Scopes:</dt>
                    <dd className="font-mono text-[10px] break-all">{result.results.token_info.scopes?.join(', ')}</dd>
                  </div>
                </dl>
              </section>
            )}

            {result.results.pages && result.results.pages.length > 0 && (
              <section className="card p-4">
                <p className="text-xs font-semibold text-gray-400 mb-2">Páginas ({result.results.pages.length})</p>
                {result.results.pages.map((p) => (
                  <div key={p.META_PAGE_ID} className="mb-3 pb-3 border-b border-surface-700 last:border-0 last:mb-0 last:pb-0">
                    <p className="text-sm text-gray-200 mb-2">{p.name}</p>
                    <dl className="text-xs font-mono space-y-0.5">
                      <div><span className="text-gray-500">META_PAGE_ID=</span><span className="text-green-400 break-all select-all">{p.META_PAGE_ID}</span></div>
                      {p.META_IG_ACCOUNT_ID && (
                        <div><span className="text-gray-500">META_IG_ACCOUNT_ID=</span><span className="text-green-400 break-all select-all">{p.META_IG_ACCOUNT_ID}</span></div>
                      )}
                      {p.META_PAGE_ACCESS_TOKEN && (
                        <div><span className="text-gray-500">META_PAGE_ACCESS_TOKEN=</span><span className="text-green-400 break-all select-all">{p.META_PAGE_ACCESS_TOKEN}</span></div>
                      )}
                    </dl>
                  </div>
                ))}
              </section>
            )}

            {result.results.ad_accounts && result.results.ad_accounts.length > 0 && (
              <section className="card p-4">
                <p className="text-xs font-semibold text-gray-400 mb-2">Cuentas de Anuncios ({result.results.ad_accounts.length})</p>
                {result.results.ad_accounts.map((a) => (
                  <div key={a.META_AD_ACCOUNT_ID} className="mb-2 text-xs">
                    <p className="text-gray-300">{a.name} <span className="text-gray-600">· {a.status} · {a.currency}</span></p>
                    <p className="font-mono">
                      <span className="text-gray-500">META_AD_ACCOUNT_ID=</span>
                      <span className="text-green-400 select-all">{a.META_AD_ACCOUNT_ID}</span>
                    </p>
                  </div>
                ))}
              </section>
            )}

            {result.hint && (
              <section className="card p-4 bg-surface-800/50">
                <p className="text-xs text-gray-400">{result.hint}</p>
                <p className="text-xs text-gray-500 mt-2">
                  Vercel → tu proyecto → <strong>Settings → Environment Variables</strong> → pega cada variable en <em>Production</em>.
                </p>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}
