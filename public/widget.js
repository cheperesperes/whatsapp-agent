// ============================================================
// Oiikon Sol — embeddable website chat widget
// ============================================================
// Drop into any HTML page with:
//   <script src="https://whatsapp-agent-ebon-nine.vercel.app/widget.js"
//           defer></script>
//
// Optional config (set BEFORE the script tag):
//   <script>
//     window.OIIKON_SOL = {
//       endpoint: 'https://whatsapp-agent-ebon-nine.vercel.app/api/chat',
//       greeting: '¡Hola! Soy Sol de Oiikon. ¿En qué te puedo ayudar?',
//     };
//   </script>
//
// The widget injects a floating bubble bottom-right and persists the
// session id + message history in localStorage so refreshes don't lose
// state. No frameworks, no dependencies.

(function () {
  'use strict';
  if (window.__oiikonSolMounted) return;
  window.__oiikonSolMounted = true;

  var CFG = window.OIIKON_SOL || {};
  var ENDPOINT =
    CFG.endpoint || 'https://whatsapp-agent-ebon-nine.vercel.app/api/chat';
  var GREETING =
    CFG.greeting ||
    '¡Hola! Soy Sol de Oiikon ☀️ ¿Necesitas ayuda con energía solar para tu familia?';
  var SESSION_KEY = 'oiikon_sol_session';
  var HISTORY_KEY = 'oiikon_sol_history';
  var OPEN_KEY = 'oiikon_sol_open';

  function genSessionId() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    return 'sess-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  }

  function getSessionId() {
    var id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = genSessionId();
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function loadHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      return raw ? JSON.parse(raw) : [];
    } catch (e) {
      return [];
    }
  }

  function saveHistory(history) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(history.slice(-100)));
    } catch (e) {
      /* quota — ignore */
    }
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // Convert WhatsApp-style *bold* to <strong>, _italic_ to <em>, line
  // breaks to <br>. Keep it minimal — no full markdown.
  function formatText(s) {
    var out = escapeHtml(s);
    out = out.replace(/\*([^\n*]+)\*/g, '<strong>$1</strong>');
    out = out.replace(/_([^\n_]+)_/g, '<em>$1</em>');
    out = out.replace(/\n/g, '<br>');
    return out;
  }

  // ── Inject styles ─────────────────────────────────────────
  var css = [
    '#oiikon-sol-bubble{',
    '  position:fixed;right:20px;bottom:20px;width:60px;height:60px;',
    '  border-radius:50%;background:#f97316;color:white;border:none;',
    '  box-shadow:0 4px 16px rgba(0,0,0,.25);cursor:pointer;z-index:2147483647;',
    '  display:flex;align-items:center;justify-content:center;font-size:28px;',
    '  transition:transform .15s ease;font-family:system-ui,-apple-system,sans-serif;',
    '}',
    '#oiikon-sol-bubble:hover{transform:scale(1.05);}',
    '#oiikon-sol-bubble[data-open="true"]{display:none;}',
    '#oiikon-sol-panel{',
    '  position:fixed;right:20px;bottom:20px;width:360px;max-width:calc(100vw - 40px);',
    '  height:540px;max-height:calc(100vh - 40px);background:white;',
    '  border-radius:16px;box-shadow:0 10px 40px rgba(0,0,0,.3);',
    '  display:none;flex-direction:column;overflow:hidden;z-index:2147483647;',
    '  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;color:#1f2937;',
    '}',
    '#oiikon-sol-panel[data-open="true"]{display:flex;}',
    '.oiikon-sol-header{',
    '  background:linear-gradient(135deg,#f97316,#fb923c);color:white;padding:14px 16px;',
    '  display:flex;align-items:center;gap:10px;',
    '}',
    '.oiikon-sol-avatar{',
    '  width:36px;height:36px;border-radius:50%;background:white;color:#f97316;',
    '  display:flex;align-items:center;justify-content:center;font-size:20px;font-weight:bold;',
    '}',
    '.oiikon-sol-title{flex:1;font-weight:600;font-size:15px;line-height:1.2;}',
    '.oiikon-sol-subtitle{font-size:11px;font-weight:400;opacity:.85;}',
    '.oiikon-sol-close{background:none;border:none;color:white;font-size:24px;cursor:pointer;padding:0 6px;line-height:1;}',
    '.oiikon-sol-messages{',
    '  flex:1;overflow-y:auto;padding:16px;background:#f9fafb;',
    '  display:flex;flex-direction:column;gap:10px;',
    '}',
    '.oiikon-sol-msg{max-width:82%;padding:10px 14px;border-radius:14px;font-size:14px;line-height:1.4;word-wrap:break-word;}',
    '.oiikon-sol-msg-bot{background:white;border:1px solid #e5e7eb;align-self:flex-start;border-bottom-left-radius:4px;}',
    '.oiikon-sol-msg-user{background:#f97316;color:white;align-self:flex-end;border-bottom-right-radius:4px;}',
    '.oiikon-sol-msg-img{margin-top:6px;border-radius:8px;max-width:100%;display:block;}',
    '.oiikon-sol-typing{display:flex;gap:4px;padding:10px 14px;align-self:flex-start;background:white;border:1px solid #e5e7eb;border-radius:14px;border-bottom-left-radius:4px;}',
    '.oiikon-sol-typing span{width:6px;height:6px;border-radius:50%;background:#9ca3af;animation:oiikon-sol-bounce 1.4s infinite ease-in-out both;}',
    '.oiikon-sol-typing span:nth-child(2){animation-delay:.16s;}',
    '.oiikon-sol-typing span:nth-child(3){animation-delay:.32s;}',
    '@keyframes oiikon-sol-bounce{0%,80%,100%{transform:scale(.6);opacity:.5;}40%{transform:scale(1);opacity:1;}}',
    '.oiikon-sol-input-row{display:flex;gap:8px;padding:12px;border-top:1px solid #e5e7eb;background:white;}',
    '.oiikon-sol-input{flex:1;border:1px solid #d1d5db;border-radius:20px;padding:8px 14px;font-size:14px;outline:none;font-family:inherit;}',
    '.oiikon-sol-input:focus{border-color:#f97316;}',
    '.oiikon-sol-send{background:#f97316;color:white;border:none;border-radius:50%;width:36px;height:36px;cursor:pointer;font-size:18px;display:flex;align-items:center;justify-content:center;}',
    '.oiikon-sol-send:disabled{opacity:.5;cursor:not-allowed;}',
    '@media (max-width:480px){',
    '  #oiikon-sol-panel{right:10px;bottom:10px;left:10px;width:auto;height:80vh;}',
    '  #oiikon-sol-bubble{right:14px;bottom:14px;}',
    '}',
  ].join('');
  var style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  // ── Build DOM ────────────────────────────────────────────
  var bubble = document.createElement('button');
  bubble.id = 'oiikon-sol-bubble';
  bubble.setAttribute('aria-label', 'Abrir chat con Sol');
  bubble.innerHTML = '💬';

  var panel = document.createElement('div');
  panel.id = 'oiikon-sol-panel';
  panel.innerHTML = [
    '<div class="oiikon-sol-header">',
    '  <div class="oiikon-sol-avatar">☀️</div>',
    '  <div class="oiikon-sol-title">Sol — Oiikon<div class="oiikon-sol-subtitle">Energía solar para tu familia</div></div>',
    '  <button class="oiikon-sol-close" aria-label="Cerrar">×</button>',
    '</div>',
    '<div class="oiikon-sol-messages" id="oiikon-sol-messages"></div>',
    '<form class="oiikon-sol-input-row" id="oiikon-sol-form">',
    '  <input class="oiikon-sol-input" id="oiikon-sol-input" type="text" placeholder="Escribe tu mensaje..." autocomplete="off" maxlength="2000">',
    '  <button class="oiikon-sol-send" id="oiikon-sol-send" type="submit" aria-label="Enviar">➤</button>',
    '</form>',
  ].join('');

  document.body.appendChild(bubble);
  document.body.appendChild(panel);

  var msgsEl = panel.querySelector('#oiikon-sol-messages');
  var formEl = panel.querySelector('#oiikon-sol-form');
  var inputEl = panel.querySelector('#oiikon-sol-input');
  var sendBtn = panel.querySelector('#oiikon-sol-send');
  var closeBtn = panel.querySelector('.oiikon-sol-close');

  // ── State ────────────────────────────────────────────────
  var sessionId = getSessionId();
  var history = loadHistory();

  // First-time greeting
  if (history.length === 0) {
    history.push({ role: 'assistant', text: GREETING, images: [] });
    saveHistory(history);
  }

  function renderHistory() {
    msgsEl.innerHTML = '';
    history.forEach(function (m) {
      msgsEl.appendChild(renderMessage(m));
    });
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function renderMessage(m) {
    var div = document.createElement('div');
    div.className = 'oiikon-sol-msg ' + (m.role === 'user' ? 'oiikon-sol-msg-user' : 'oiikon-sol-msg-bot');
    div.innerHTML = formatText(m.text || '');
    if (m.images && m.images.length) {
      m.images.forEach(function (img) {
        var imgEl = document.createElement('img');
        imgEl.className = 'oiikon-sol-msg-img';
        imgEl.src = img.url;
        imgEl.alt = img.sku;
        imgEl.loading = 'lazy';
        div.appendChild(imgEl);
      });
    }
    return div;
  }

  function showTyping() {
    var t = document.createElement('div');
    t.className = 'oiikon-sol-typing';
    t.id = 'oiikon-sol-typing';
    t.innerHTML = '<span></span><span></span><span></span>';
    msgsEl.appendChild(t);
    msgsEl.scrollTop = msgsEl.scrollHeight;
  }

  function hideTyping() {
    var t = document.getElementById('oiikon-sol-typing');
    if (t) t.remove();
  }

  function setOpen(open) {
    bubble.setAttribute('data-open', open ? 'true' : 'false');
    panel.setAttribute('data-open', open ? 'true' : 'false');
    try { sessionStorage.setItem(OPEN_KEY, open ? '1' : '0'); } catch (e) {}
    if (open) {
      renderHistory();
      setTimeout(function () { inputEl.focus(); }, 100);
    }
  }

  bubble.addEventListener('click', function () { setOpen(true); });
  closeBtn.addEventListener('click', function () { setOpen(false); });

  formEl.addEventListener('submit', function (e) {
    e.preventDefault();
    var text = inputEl.value.trim();
    if (!text) return;
    if (sendBtn.disabled) return;

    history.push({ role: 'user', text: text, images: [] });
    saveHistory(history);
    msgsEl.appendChild(renderMessage({ role: 'user', text: text }));
    msgsEl.scrollTop = msgsEl.scrollHeight;

    inputEl.value = '';
    sendBtn.disabled = true;
    showTyping();

    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, message: text }),
    })
      .then(function (res) {
        if (!res.ok) throw new Error('http_' + res.status);
        return res.json();
      })
      .then(function (data) {
        hideTyping();
        sendBtn.disabled = false;
        var reply = (data && data.reply) || 'Disculpa, hubo un problema. Intenta de nuevo.';
        var images = (data && data.images) || [];
        history.push({ role: 'assistant', text: reply, images: images });
        saveHistory(history);
        msgsEl.appendChild(renderMessage({ role: 'assistant', text: reply, images: images }));
        msgsEl.scrollTop = msgsEl.scrollHeight;
      })
      .catch(function (err) {
        hideTyping();
        sendBtn.disabled = false;
        var fallback = 'No pude enviar tu mensaje. Revisa tu conexión y vuelve a intentarlo.';
        history.push({ role: 'assistant', text: fallback, images: [] });
        saveHistory(history);
        msgsEl.appendChild(renderMessage({ role: 'assistant', text: fallback }));
        msgsEl.scrollTop = msgsEl.scrollHeight;
        console.warn('[oiikon-sol]', err);
      });
  });

  // Restore open state across page navigations within session
  try {
    if (sessionStorage.getItem(OPEN_KEY) === '1') setOpen(true);
  } catch (e) {}
})();
