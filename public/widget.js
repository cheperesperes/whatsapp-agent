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
  var SESSION_KEY = 'oiikon_sol_session';
  var HISTORY_KEY = 'oiikon_sol_history';
  var OPEN_KEY = 'oiikon_sol_open';
  var TEASER_DISMISSED_KEY = 'oiikon_sol_teaser_dismissed';
  var TEASER_LAST_SHOWN_KEY = 'oiikon_sol_teaser_shown_at';
  var TEASER_LANG_KEY = 'oiikon_sol_lang';
  var EMAIL_CAPTURE_KEY = 'oiikon_sol_email_capture'; // 'done' | 'dismissed'

  // ── Language detection ───────────────────────────────────
  // Priority: persisted preference > host-page <html lang> > navigator.language
  // > Spanish default (Cuban/LATAM customer base). The host-page check makes
  // oiikon.com's language toggle override the browser locale, so an EN-speaking
  // visitor browsing the EN version of the site gets EN greetings — not the
  // browser-locale ES that ignored their explicit choice.
  function detectLanguage() {
    try {
      var stored = localStorage.getItem(TEASER_LANG_KEY);
      if (stored === 'es' || stored === 'en') return stored;
    } catch (e) {}
    try {
      var pageLang = (document.documentElement.lang || '').toLowerCase();
      if (pageLang.indexOf('en') === 0) return 'en';
      if (pageLang.indexOf('es') === 0) return 'es';
    } catch (e) {}
    var nav = (navigator.language || 'es').toLowerCase();
    return nav.indexOf('en') === 0 ? 'en' : 'es';
  }

  // Bilingual UI strings. Anything customer-facing in the widget UI lives here.
  // STRICT language rule (Ed 2026-05-20): NEVER show Spanish to an English
  // visitor. If detectLanguage() returns 'en', every label uses STRINGS.en.
  var STRINGS = {
    es: {
      greeting: 'Hola, soy Oiikon. ¿Cómo te ayudamos?',
      header_subtitle: 'Energía solar para tu hogar',
      open_aria: 'Abrir chat con Oiikon',
      close_aria: 'Cerrar',
      send_aria: 'Enviar',
      input_placeholder: 'Escribe tu mensaje...',
      fallback_error: 'Disculpa, hubo un problema. Intenta de nuevo.',
      fallback_network: 'No pude enviar tu mensaje. Revisa tu conexión y vuelve a intentarlo.',
      email_title: '¿Le doy seguimiento por email?',
      email_hint: 'Si tiene que irse, le mando los detalles y le aviso de cualquier duda pendiente.',
      email_placeholder: 'su@email.com',
      email_consent: 'Acepto que Oiikon me envíe un seguimiento y ofertas por email. Puedo darme de baja cuando quiera.',
      email_submit: 'Sí, envíenme el seguimiento',
      email_dismiss: 'No, gracias',
      email_thanks: '¡Listo! Le escribimos pronto. 😊',
      email_error: 'No se pudo guardar. Intente de nuevo.',
      email_invalid: 'Escriba un email válido.',
    },
    en: {
      greeting: "Hi, I'm Oiikon. How can we help?",
      header_subtitle: 'Solar energy for your home',
      open_aria: 'Open chat with Oiikon',
      close_aria: 'Close',
      send_aria: 'Send',
      input_placeholder: 'Type your message...',
      fallback_error: 'Sorry, something went wrong. Try again.',
      fallback_network: "Couldn't send your message. Check your connection and try again.",
      email_title: 'Want a follow-up by email?',
      email_hint: "If you have to run, I'll send you the details and check in on any open questions.",
      email_placeholder: 'you@email.com',
      email_consent: 'I agree to receive a follow-up and offers from Oiikon by email. I can unsubscribe at any time.',
      email_submit: 'Yes, send me the follow-up',
      email_dismiss: 'No, thanks',
      email_thanks: "Done! We'll be in touch soon. 😊",
      email_error: "Couldn't save it. Please try again.",
      email_invalid: 'Please enter a valid email.',
    },
  };
  var LANG = detectLanguage();
  var T = STRINGS[LANG] || STRINGS.es;
  // Allow caller to override greeting via window.OIIKON_SOL.greeting
  var GREETING = CFG.greeting || T.greeting;

  // ── Proactive teaser bubble ──────────────────────────────
  // Shows a one-line preview above the closed widget after a short delay
  // to nudge the visitor into opening the chat. The copy is rotated by
  // *audience signal* (URL / referrer / language) so RV buyers, hurricane
  // preppers, and off-gridders all see something that names THEIR
  // situation — not a generic "need help?" prompt.
  //
  // Why fuel savings is woven through every variant: gas/diesel for
  // backup generators is the comparison-cost most visitors already have
  // a number for in their head. A generator burns ~$15-30 of fuel a day
  // during a real outage; a solar station pays itself off in days, not
  // years, when fuel scarcity hits.
  //
  // Per-audience variants are defined for both Spanish and English. The
  // language picker mirrors what Sol uses server-side: any persisted
  // preference wins, otherwise navigator.language with Spanish kept as
  // a default for the Hispanic-American visitor segment.

  var TEASER_DELAY_MS_GENERIC = 30000; // 30s on home / non-product pages
  var TEASER_DELAY_MS_PRODUCT = 8000;  // 8s on product pages — higher intent
  var TEASER_REPEAT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 1 day between teasers
  var TEASER_AUTO_HIDE_MS = 12000;     // teaser disappears if not clicked

  // Audience tags. The picker scans URL + referrer + simple page-text
  // signals to choose one. Falls back to 'generic'.
  var AUDIENCES = ['hurricane', 'rv', 'offgrid', 'generic'];

  var TEASER_COPY = {
    es: {
      hurricane: [
        '¿Listo para el próximo apagón? En 30 seg te digo qué necesitas (sin gastar en gasolina).',
        '¿Cansado de pagar gasolina al generador? Te muestro la cuenta solar — paga solo.',
        'Antes de la próxima tormenta, 3 preguntas y te digo si una Pecron te alcanza.',
      ],
      rv: [
        '¿RV, casa rodante o cabaña? Te ajusto un Pecron a tu uso real (y dejas de cargar combustible).',
        'Adiós al ruido del generador en el camping — calculemos qué solar te aguanta el viaje.',
        '¿Cuántos días fuera de red? Te digo qué Pecron + paneles te dan autonomía sin gas.',
      ],
      offgrid: [
        '¿Casa off-grid o cabaña? Te diseño el sistema en 3 preguntas — sin generador a gasolina.',
        '¿Cansado de mover bidones de combustible? Te muestro cuánto ahorras yendo solar.',
        'En 30 segundos te calculo qué LiFePO4 + paneles cubren tu carga real.',
      ],
      generic: [
        'En 3 preguntas te digo qué Pecron necesitas — sin presión.',
        '¿Comparas precio de generador vs solar? Te hago la cuenta gratis.',
        '¿Necesitas energía de respaldo? Te diseño la solución en 30 segundos.',
      ],
    },
    en: {
      hurricane: [
        'Storm prep ready? 30 sec to size what you need — and stop paying for generator fuel.',
        'Tired of $20/day in generator gas during outages? Let me show you the solar math.',
        'Before the next hurricane: 3 questions, real answer on what Pecron fits your home.',
      ],
      rv: [
        'RV or cabin? I\'ll match a Pecron to your real load — no more hauling fuel.',
        'Quiet camping: drop the gas generator. Let\'s see what solar covers your trip.',
        'How many days off-grid? I\'ll size the Pecron + panels for full autonomy.',
      ],
      offgrid: [
        'Off-grid cabin? I\'ll design the system in 3 questions — no gas generator needed.',
        'Tired of running fuel jugs? Here\'s how fast solar pays for itself.',
        '30 sec to size the LiFePO4 + panels that cover your real load.',
      ],
      generic: [
        '3 questions and I\'ll tell you which Pecron fits — no pressure.',
        'Comparing generator vs solar cost? I\'ll do the math, free.',
        'Need backup power? I\'ll design the solution in 30 seconds.',
      ],
    },
  };

  function detectAudience() {
    var url = '';
    var ref = '';
    var bodyText = '';
    try {
      url = (location.pathname + ' ' + location.search).toLowerCase();
      ref = (document.referrer || '').toLowerCase();
      bodyText = (document.title + ' ' +
        (document.querySelector('meta[name="description"]') || {}).content ||
        '').toLowerCase();
    } catch (e) {}

    var hay = url + ' ' + ref + ' ' + bodyText;
    if (/\b(hurricane|tormenta|apag(o|ó)n|huracan|storm|backup)\b/.test(hay)) return 'hurricane';
    if (/\b(rv|motorhome|caravan|trailer|camping|van[- ]?life|nautico|boat|bote|barco)\b/.test(hay)) return 'rv';
    if (/\b(off[- ]?grid|cabin|cabana|caba(n|ñ)a|finca|rancho|remoto)\b/.test(hay)) return 'offgrid';
    return 'generic';
  }

  function isProductPage() {
    try {
      return /\/product(s)?\//.test(location.pathname);
    } catch (e) { return false; }
  }

  function pickTeaserCopy() {
    var lang = detectLanguage();
    var audience = detectAudience();
    var bucket = (TEASER_COPY[lang] || TEASER_COPY.es)[audience]
      || TEASER_COPY[lang].generic
      || TEASER_COPY.es.generic;
    return bucket[Math.floor(Math.random() * bucket.length)];
  }

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
    // ── Teaser tooltip (shown above the closed bubble) ──
    '#oiikon-sol-teaser{',
    '  position:fixed;right:90px;bottom:32px;max-width:260px;',
    '  background:white;color:#1f2937;border-radius:14px;',
    '  box-shadow:0 8px 24px rgba(0,0,0,.18);padding:12px 14px;',
    '  font:14px/1.35 system-ui,-apple-system,"Segoe UI",sans-serif;',
    '  cursor:pointer;z-index:2147483647;',
    '  opacity:0;transform:translateY(8px);pointer-events:none;',
    '  transition:opacity .3s ease,transform .3s ease;',
    '  border:1px solid #f97316;',
    '}',
    '#oiikon-sol-teaser[data-visible="true"]{opacity:1;transform:translateY(0);pointer-events:auto;}',
    '#oiikon-sol-teaser::after{',
    '  content:"";position:absolute;right:-8px;bottom:18px;',
    '  width:0;height:0;border:8px solid transparent;border-left-color:white;',
    '}',
    '#oiikon-sol-teaser-close{',
    '  position:absolute;top:4px;right:6px;background:none;border:none;',
    '  font-size:14px;color:#9ca3af;cursor:pointer;line-height:1;padding:2px 4px;',
    '}',
    '#oiikon-sol-teaser-close:hover{color:#1f2937;}',
    '@media (max-width:480px){',
    '  #oiikon-sol-teaser{right:14px;bottom:90px;max-width:calc(100vw - 28px);}',
    '  #oiikon-sol-teaser::after{display:none;}',
    '}',
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
  bubble.setAttribute('aria-label', T.open_aria);
  bubble.innerHTML = '💬';

  var panel = document.createElement('div');
  panel.id = 'oiikon-sol-panel';
  panel.innerHTML = [
    '<div class="oiikon-sol-header">',
    '  <div class="oiikon-sol-avatar">☀️</div>',
    '  <div class="oiikon-sol-title">Oiikon<div class="oiikon-sol-subtitle">' + escapeHtml(T.header_subtitle) + '</div></div>',
    '  <button class="oiikon-sol-close" aria-label="' + escapeHtml(T.close_aria) + '">×</button>',
    '</div>',
    '<div class="oiikon-sol-messages" id="oiikon-sol-messages"></div>',
    '<form class="oiikon-sol-input-row" id="oiikon-sol-form">',
    '  <input class="oiikon-sol-input" id="oiikon-sol-input" type="text" placeholder="' + escapeHtml(T.input_placeholder) + '" autocomplete="off" maxlength="2000">',
    '  <button class="oiikon-sol-send" id="oiikon-sol-send" type="submit" aria-label="' + escapeHtml(T.send_aria) + '">➤</button>',
    '</form>',
  ].join('');

  // ── Proactive teaser DOM ─────────────────────────────────
  var teaser = document.createElement('div');
  teaser.id = 'oiikon-sol-teaser';
  teaser.setAttribute('role', 'button');
  teaser.setAttribute('tabindex', '0');
  teaser.setAttribute('aria-label', T.open_aria);
  teaser.innerHTML = [
    '<button id="oiikon-sol-teaser-close" type="button" aria-label="Cerrar">×</button>',
    '<div id="oiikon-sol-teaser-text"></div>',
  ].join('');

  document.body.appendChild(bubble);
  document.body.appendChild(panel);
  document.body.appendChild(teaser);

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

  // ── Email follow-up opt-in card ──────────────────────────
  // Shown ONCE per device, only after Sol has quoted a real product (the
  // reply contains a product link) — that's the "visitor liked a product"
  // signal. The consent checkbox is UNCHECKED by default and the exact
  // consent wording is sent to the server verbatim (legal record). Without
  // the checkbox ticked the server refuses to store the email at all.
  var CONTACT_ENDPOINT = ENDPOINT.replace(/\/api\/chat\/?$/, '/api/web-leads/contact');

  function maybeShowEmailCard(replyText) {
    try {
      if (localStorage.getItem(EMAIL_CAPTURE_KEY)) return;
    } catch (e) {}
    if (!replyText || replyText.indexOf('oiikon.com/product/') === -1) return;
    if (document.getElementById('oiikon-sol-email-card')) return;

    var card = document.createElement('div');
    card.id = 'oiikon-sol-email-card';
    card.className = 'oiikon-sol-msg oiikon-sol-msg-bot';
    card.style.cssText = 'border:1px solid #F97316;border-radius:12px;padding:12px;';
    card.innerHTML =
      '<div style="font-weight:bold;margin-bottom:4px;">' + T.email_title + '</div>' +
      '<div style="font-size:12px;opacity:.85;margin-bottom:8px;">' + T.email_hint + '</div>' +
      '<input type="email" id="oiikon-sol-email-input" placeholder="' + T.email_placeholder + '" ' +
      'style="width:100%;box-sizing:border-box;padding:8px 10px;border:1px solid #d1d5db;border-radius:8px;font-size:13px;margin-bottom:8px;" />' +
      '<label style="display:flex;gap:6px;align-items:flex-start;font-size:11px;line-height:1.4;margin-bottom:8px;cursor:pointer;">' +
      '<input type="checkbox" id="oiikon-sol-email-consent" style="margin-top:2px;" />' +
      '<span>' + T.email_consent + '</span></label>' +
      '<div id="oiikon-sol-email-err" style="display:none;color:#dc2626;font-size:11px;margin-bottom:6px;"></div>' +
      '<button type="button" id="oiikon-sol-email-send" ' +
      'style="background:#F97316;color:#fff;border:none;border-radius:8px;padding:8px 12px;font-size:13px;font-weight:bold;cursor:pointer;width:100%;">' +
      T.email_submit + '</button>' +
      '<button type="button" id="oiikon-sol-email-no" ' +
      'style="background:none;border:none;color:#6b7280;font-size:11px;cursor:pointer;width:100%;margin-top:6px;text-decoration:underline;">' +
      T.email_dismiss + '</button>';
    msgsEl.appendChild(card);
    msgsEl.scrollTop = msgsEl.scrollHeight;

    function showErr(msg) {
      var e = card.querySelector('#oiikon-sol-email-err');
      e.textContent = msg;
      e.style.display = 'block';
    }

    card.querySelector('#oiikon-sol-email-no').addEventListener('click', function () {
      try { localStorage.setItem(EMAIL_CAPTURE_KEY, 'dismissed'); } catch (e) {}
      card.remove();
    });

    card.querySelector('#oiikon-sol-email-send').addEventListener('click', function () {
      var email = (card.querySelector('#oiikon-sol-email-input').value || '').trim();
      var consent = card.querySelector('#oiikon-sol-email-consent').checked;
      if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) { showErr(T.email_invalid); return; }
      if (!consent) { showErr(T.email_consent); return; }
      var btn = card.querySelector('#oiikon-sol-email-send');
      btn.disabled = true;
      fetch(CONTACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: sessionId,
          email: email,
          consent: true,
          consentText: T.email_consent,
          language: LANG,
        }),
      })
        .then(function (res) { if (!res.ok) throw new Error('http_' + res.status); return res.json(); })
        .then(function () {
          try { localStorage.setItem(EMAIL_CAPTURE_KEY, 'done'); } catch (e) {}
          card.innerHTML = '<div style="font-weight:bold;">' + T.email_thanks + '</div>';
          setTimeout(function () { card.remove(); }, 4000);
        })
        .catch(function () {
          btn.disabled = false;
          showErr(T.email_error);
        });
    });
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

    // One-shot retry on transient failure. Covers the two most common
    // Sol error modes seen in the wild:
    //   • Vercel cold-start: the serverless fn slept and the first request
    //     times out before the LLM responds (no body returned).
    //   • Network blip on the client side (wifi drop, VPN reconnect).
    // Retry only ONCE after a 2s backoff — anything that fails twice in a
    // row is a real server-side failure (LLM outage, rate limit, etc.) and
    // we should show the fallback so the customer isn't left hanging.
    function attemptSend(attempt) {
      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: sessionId, message: text }),
      })
        .then(function (res) {
          if (!res.ok) throw new Error('http_' + res.status);
          return res.json();
        })
        .catch(function (err) {
          if (attempt === 0) {
            console.warn('[oiikon-sol] retry after', err && err.message);
            return new Promise(function (resolve) { setTimeout(resolve, 2000); })
              .then(function () { return attemptSend(1); });
          }
          throw err;
        });
    }

    attemptSend(0)
      .then(function (data) {
        hideTyping();
        sendBtn.disabled = false;
        var reply = (data && data.reply) || T.fallback_error;
        var images = (data && data.images) || [];
        history.push({ role: 'assistant', text: reply, images: images });
        saveHistory(history);
        msgsEl.appendChild(renderMessage({ role: 'assistant', text: reply, images: images }));
        msgsEl.scrollTop = msgsEl.scrollHeight;
        maybeShowEmailCard(reply);
      })
      .catch(function (err) {
        hideTyping();
        sendBtn.disabled = false;
        var fallback = T.fallback_network;
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

  // ── Teaser show / dismiss logic ──────────────────────────
  // Skip the teaser entirely when:
  //   • the chat is already open (panel data-open=true)
  //   • the user has dismissed it before AND less than the cooldown has passed
  //   • the user has already exchanged a real message (history > 1 entries
  //     means they got past the canned greeting — they know we exist)
  function shouldShowTeaser() {
    if (panel.getAttribute('data-open') === 'true') return false;
    if (history.length > 1) return false;
    try {
      if (localStorage.getItem(TEASER_DISMISSED_KEY) === '1') return false;
      var lastShown = parseInt(localStorage.getItem(TEASER_LAST_SHOWN_KEY) || '0', 10);
      if (lastShown && Date.now() - lastShown < TEASER_REPEAT_COOLDOWN_MS) return false;
    } catch (e) {}
    return true;
  }

  var teaserHideTimer = null;

  function showTeaser() {
    if (!shouldShowTeaser()) return;
    var copy = pickTeaserCopy();
    var textEl = teaser.querySelector('#oiikon-sol-teaser-text');
    if (textEl) textEl.textContent = copy;
    teaser.setAttribute('data-visible', 'true');
    try { localStorage.setItem(TEASER_LAST_SHOWN_KEY, String(Date.now())); } catch (e) {}
    // Auto-hide if the visitor doesn't engage — but DON'T mark as dismissed
    // (we'll try again on the next page after the cooldown).
    if (teaserHideTimer) clearTimeout(teaserHideTimer);
    teaserHideTimer = setTimeout(function () {
      teaser.setAttribute('data-visible', 'false');
    }, TEASER_AUTO_HIDE_MS);
  }

  function hideTeaser(dismissedByUser) {
    teaser.setAttribute('data-visible', 'false');
    if (teaserHideTimer) { clearTimeout(teaserHideTimer); teaserHideTimer = null; }
    if (dismissedByUser) {
      try { localStorage.setItem(TEASER_DISMISSED_KEY, '1'); } catch (e) {}
    }
  }

  // Clicking the teaser body opens the chat (warm intent — most-likely path
  // to conversion). Clicking the × dismisses it permanently for this device.
  teaser.addEventListener('click', function (e) {
    if (e.target && e.target.id === 'oiikon-sol-teaser-close') {
      hideTeaser(true);
      return;
    }
    hideTeaser(false);
    setOpen(true);
  });
  teaser.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      hideTeaser(false);
      setOpen(true);
    }
  });

  // Schedule the teaser. Product pages get a faster appearance because
  // visitors landing there have already shown intent.
  var teaserDelay = isProductPage() ? TEASER_DELAY_MS_PRODUCT : TEASER_DELAY_MS_GENERIC;
  setTimeout(showTeaser, teaserDelay);
})();
