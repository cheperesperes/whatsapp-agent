// ============================================================
// Widget test page
// ============================================================
// Visit https://whatsapp-agent-ebon-nine.vercel.app/widget-test
// to preview the embeddable widget exactly as it will appear on
// oiikon.com. Useful for QA before pasting the <script> tag into
// Hostinger Horizon.

export const dynamic = 'force-dynamic';

export default function WidgetTestPage() {
  return (
    <div
      style={{
        fontFamily: 'system-ui, -apple-system, sans-serif',
        maxWidth: 720,
        margin: '60px auto',
        padding: '0 20px',
        color: '#1f2937',
        lineHeight: 1.6,
      }}
    >
      <h1 style={{ fontSize: 28, marginBottom: 8 }}>Sol Web Chat — Test Page</h1>
      <p style={{ color: '#6b7280', marginBottom: 24 }}>
        This page mounts the same widget that will live on oiikon.com.
        Click the orange bubble in the bottom-right to chat with Sol.
      </p>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>How to embed on Hostinger Horizon</h2>
      <p>Paste this single line into the site&apos;s global HTML (footer or head section):</p>
      <pre
        style={{
          background: '#0f172a',
          color: '#e5e7eb',
          padding: 16,
          borderRadius: 8,
          overflowX: 'auto',
          fontSize: 13,
          marginBottom: 24,
        }}
      >
        {`<script src="https://whatsapp-agent-ebon-nine.vercel.app/widget.js" defer></script>`}
      </pre>

      <h2 style={{ fontSize: 18, marginTop: 32, marginBottom: 8 }}>What works</h2>
      <ul>
        <li>Anonymous browser session (no phone needed)</li>
        <li>Conversations land in the same dashboard, tagged <code>channel=web</code></li>
        <li>Same Sol brain — product catalog, knowledge base, lead scoring, language detection</li>
        <li>Cuban customers can chat — Meta sanctions filter is bypassed</li>
        <li>Session + history persist across page reloads via <code>localStorage</code></li>
      </ul>

      <p style={{ marginTop: 32, padding: 14, background: '#fef3c7', borderRadius: 8, fontSize: 14 }}>
        <strong>Heads up:</strong> the database migration <code>scripts/add-web-channel.sql</code> must be applied in Supabase before this works. Without it, <code>POST /api/chat</code> will 500 on insert.
      </p>

      <script src="/widget.js" defer></script>
    </div>
  );
}
