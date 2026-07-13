// ==UserScript==
// @name         Crunchyroll Player Tweaks
// @namespace    https://github.com/nicolasiven-ops/tampermonkey-scripts
// @version      0.5.0
// @description  Peppt den Crunchyroll-Player auf: Auto-Skip für Intro & Outro, Doppelklick für Vollbild, Einstellungsmenü
// @author       nicolasiven-ops
// @match        https://*.crunchyroll.com/*
// @match        https://crunchyroll.com/*
// @grant        none
// @run-at       document-start
// @downloadURL  https://raw.githubusercontent.com/nicolasiven-ops/tampermonkey-scripts/main/crunchyroll-player-tweaks.user.js
// @updateURL    https://raw.githubusercontent.com/nicolasiven-ops/tampermonkey-scripts/main/crunchyroll-player-tweaks.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Einstellungen — änderbar über das Menü (Klick auf das Badge),
  // gespeichert in localStorage.
  // ------------------------------------------------------------------
  const DEFAULTS = {
    skipIntro: true,
    skipOutro: true,
    doubleClickFullscreen: true,
    showBadge: true,
  };
  const STORAGE_KEY = 'crTweaksSettings';

  function loadSettings() {
    try {
      return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') };
    } catch (e) {
      return { ...DEFAULTS };
    }
  }
  function saveSettings() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(SETTINGS)); } catch (e) { /* egal */ }
  }
  const SETTINGS = loadSettings();

  const SCAN_INTERVAL_MS = 300;
  const CLICK_COOLDOWN_MS = 5000;
  const BADGE_IDLE_MS = 3000;

  console.info(`[CR Tweaks] geladen in ${location.href}`);

  // ------------------------------------------------------------------
  // Skip-Daten abfangen: Der Player lädt pro Folge eine skip-events-JSON
  // mit den exakten Intro-/Outro-Zeitfenstern. Wir hängen uns in fetch
  // und XMLHttpRequest, lesen die Antwort mit und spulen dann selbst —
  // unabhängig davon, ob/wo der Player einen Skip-Button rendert.
  // ------------------------------------------------------------------
  let skipEvents = null; // { intro: {start, end}, credits: {start, end}, ... }

  function handleSkipEventsJson(data) {
    if (!data || typeof data !== 'object') return;
    const found = {};
    for (const key of ['intro', 'credits', 'recap', 'preview']) {
      const seg = data[key];
      if (seg && typeof seg.start === 'number' && typeof seg.end === 'number' && seg.end > seg.start) {
        found[key] = { start: seg.start, end: seg.end };
      }
    }
    skipEvents = found;
    const parts = Object.entries(found).map(([k, s]) => `${k} ${Math.round(s.start)}–${Math.round(s.end)}s`);
    console.info(`[CR Tweaks] Skip-Daten empfangen: ${parts.join(', ') || 'keine Segmente'}`);
  }

  function sniffUrl(url, readBody) {
    if (typeof url === 'string' && url.includes('skip-events')) readBody();
  }

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const promise = origFetch.apply(this, args);
    try {
      const url = typeof args[0] === 'string' ? args[0] : (args[0] && args[0].url) || '';
      sniffUrl(url, () => {
        promise.then((res) => res.clone().json()).then(handleSkipEventsJson).catch(() => {});
      });
    } catch (e) { /* Player nicht stören */ }
    return promise;
  };

  const origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__crTweaksUrl = url;
    return origOpen.call(this, method, url, ...rest);
  };
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    sniffUrl(this.__crTweaksUrl, () => {
      this.addEventListener('load', () => {
        try { handleSkipEventsJson(JSON.parse(this.responseText)); } catch (e) { /* keine JSON */ }
      });
    });
    return origSend.apply(this, args);
  };

  // Bei Folgenwechsel (SPA-Navigation) alte Zeitfenster verwerfen —
  // die neuen kommen mit dem nächsten skip-events-Request.
  let lastHref = location.href;

  // ------------------------------------------------------------------
  // Badge + Einstellungsmenü
  // ------------------------------------------------------------------
  let uiRoot = null;
  let badgeEl = null;
  let panelEl = null;
  let panelOpen = false;
  let flashUntil = 0;
  let lastMouseMove = 0;

  const UI_CSS = {
    root: 'position:fixed;top:76px;right:16px;z-index:2147483647;font:600 12px/1.4 sans-serif;color:#fff;text-align:left',
    badge: 'padding:5px 11px;border-radius:6px;background:rgba(20,20,24,0.8);border-left:3px solid #f47521;cursor:pointer;user-select:none;letter-spacing:0.2px;transition:opacity 0.35s',
    panel: 'margin-top:6px;padding:10px 12px;border-radius:6px;background:rgba(20,20,24,0.92);border-left:3px solid #f47521;display:none;min-width:200px',
    row: 'display:flex;align-items:center;gap:8px;margin:6px 0;cursor:pointer;font-weight:400',
  };

  function buildUi() {
    if (uiRoot && uiRoot.isConnected) return;
    if (!document.body) return;
    if (!uiRoot) {
      uiRoot = document.createElement('div');
      uiRoot.id = 'cr-tweaks-ui';
      uiRoot.style.cssText = UI_CSS.root;

      badgeEl = document.createElement('div');
      badgeEl.style.cssText = UI_CSS.badge;
      badgeEl.style.opacity = '0';
      badgeEl.addEventListener('click', (e) => {
        e.stopPropagation();
        panelOpen = !panelOpen;
        panelEl.style.display = panelOpen ? 'block' : 'none';
      });

      panelEl = document.createElement('div');
      panelEl.style.cssText = UI_CSS.panel;
      panelEl.addEventListener('click', (e) => e.stopPropagation());

      const options = [
        ['skipIntro', 'Intro automatisch überspringen'],
        ['skipOutro', 'Outro automatisch überspringen'],
        ['doubleClickFullscreen', 'Doppelklick = Vollbild'],
      ];
      for (const [key, label] of options) {
        const row = document.createElement('label');
        row.style.cssText = UI_CSS.row;
        const box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = SETTINGS[key];
        box.addEventListener('change', () => {
          SETTINGS[key] = box.checked;
          saveSettings();
          refreshBadgeText();
        });
        row.appendChild(box);
        row.appendChild(document.createTextNode(label));
        panelEl.appendChild(row);
      }

      uiRoot.appendChild(badgeEl);
      uiRoot.appendChild(panelEl);

      // Klick außerhalb schließt das Menü
      document.addEventListener('click', () => {
        if (panelOpen) {
          panelOpen = false;
          panelEl.style.display = 'none';
        }
      });
    }
    // Im Vollbild rendert der Browser nur den Teilbaum des Vollbild-
    // Elements — die UI muss also dort hinein (und wieder zurück).
    (document.fullscreenElement || document.body).appendChild(uiRoot);
    refreshBadgeText();
  }

  function refreshBadgeText() {
    if (!badgeEl || Date.now() < flashUntil) return;
    const skipOn = SETTINGS.skipIntro || SETTINGS.skipOutro;
    badgeEl.textContent = `⏭ CR Tweaks · Auto-Skip ${skipOn ? 'an' : 'aus'} ⚙`;
  }

  function flashBadge(text, durationMs) {
    if (!badgeEl) return;
    badgeEl.textContent = text;
    flashUntil = Date.now() + durationMs;
  }

  function updateBadgeVisibility() {
    if (!badgeEl) return;
    if (!SETTINGS.showBadge || !document.querySelector('video')) {
      badgeEl.style.opacity = '0';
      return;
    }
    const active = panelOpen || Date.now() < flashUntil || Date.now() - lastMouseMove < BADGE_IDLE_MS;
    badgeEl.style.opacity = active ? '1' : '0';
    if (Date.now() >= flashUntil) refreshBadgeText();
  }

  document.addEventListener('mousemove', () => { lastMouseMove = Date.now(); }, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    if (uiRoot) {
      (document.fullscreenElement || document.body).appendChild(uiRoot);
      lastMouseMove = Date.now();
    }
  });

  // ------------------------------------------------------------------
  // Auto-Skip über Zeitfenster (primär)
  // ------------------------------------------------------------------
  function mainVideo() {
    let best = null;
    let bestArea = 0;
    for (const v of document.querySelectorAll('video')) {
      const rect = v.getBoundingClientRect();
      const area = rect.width * rect.height;
      if (area > bestArea) { best = v; bestArea = area; }
    }
    return best;
  }

  const SEGMENT_BY_CATEGORY = { intro: 'intro', outro: 'credits' };

  function timeBasedSkip() {
    if (!skipEvents) return;
    const video = mainVideo();
    // Nicht eingreifen, während pausiert oder gescrubbt wird
    if (!video || video.paused || video.seeking || !video.duration) return;
    const t = video.currentTime;
    for (const category of ['intro', 'outro']) {
      if (category === 'intro' && !SETTINGS.skipIntro) continue;
      if (category === 'outro' && !SETTINGS.skipOutro) continue;
      const seg = skipEvents[SEGMENT_BY_CATEGORY[category]];
      if (seg && t >= seg.start && t < seg.end - 0.5) {
        video.currentTime = Math.min(seg.end, video.duration);
        const name = category === 'intro' ? 'Intro' : 'Outro';
        console.info(`[CR Tweaks] ${name} übersprungen (${Math.round(t)}s → ${Math.round(seg.end)}s)`);
        flashBadge(`⏭ ${name} übersprungen`, 2500);
      }
    }
  }

  // ------------------------------------------------------------------
  // Auto-Skip per Button-Klick (Fallback, falls keine Skip-Daten
  // abgefangen wurden — z. B. weil der Request vor dem Script lief)
  // ------------------------------------------------------------------
  const PATTERNS = {
    intro: /skip\s*(intro|opening)|(intro|vorspann|opening)\s*überspringen/i,
    outro: /skip\s*(credits|ending|outro)|(abspann|outro|ending|credits)\s*überspringen/i,
  };
  const TESTID_PATTERNS = {
    intro: /skip[-_]?intro/i,
    outro: /skip[-_]?(credits|outro|ending)/i,
  };
  const lastClickAt = { intro: 0, outro: 0 };

  function isVisible(el) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    const style = getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  }

  function matchesCategory(el, category) {
    const testid = el.getAttribute('data-testid') || '';
    if (TESTID_PATTERNS[category].test(testid)) return true;
    const label = el.getAttribute('aria-label') || '';
    if (label && PATTERNS[category].test(label)) return true;
    const text = (el.textContent || '').trim();
    return text.length > 0 && text.length < 40 && PATTERNS[category].test(text);
  }

  function findClickTarget(el) {
    const direct = el.closest('button, [role="button"], a');
    if (direct) return direct;
    let node = el;
    for (let i = 0; i < 6 && node && node !== document.body; i++) {
      if (node.onclick || getComputedStyle(node).cursor === 'pointer') return node;
      node = node.parentElement;
    }
    return el;
  }

  function simulateClick(el) {
    const rect = el.getBoundingClientRect();
    const opts = {
      bubbles: true, cancelable: true, view: window, button: 0,
      clientX: rect.left + rect.width / 2,
      clientY: rect.top + rect.height / 2,
    };
    for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      el.dispatchEvent(new Ctor(type, opts));
    }
  }

  function describe(el) {
    const testid = el.getAttribute('data-testid');
    const label = el.getAttribute('aria-label');
    const text = (el.textContent || '').trim().slice(0, 40);
    return `<${el.tagName.toLowerCase()}${testid ? ` data-testid="${testid}"` : ''}${label ? ` aria-label="${label}"` : ''}> "${text}"`;
  }

  function buttonFallbackSkip() {
    if (skipEvents) return; // Zeitfenster-Skip ist zuständig
    for (const category of ['intro', 'outro']) {
      if (category === 'intro' && !SETTINGS.skipIntro) continue;
      if (category === 'outro' && !SETTINGS.skipOutro) continue;
      if (Date.now() - lastClickAt[category] < CLICK_COOLDOWN_MS) continue;
      const candidates = document.querySelectorAll('button, [role="button"], a, [data-testid]');
      for (const el of candidates) {
        if (el.closest('#cr-tweaks-ui')) continue;
        if (!matchesCategory(el, category)) continue;
        const target = findClickTarget(el);
        if (!isVisible(target)) continue;
        lastClickAt[category] = Date.now();
        simulateClick(target);
        const name = category === 'intro' ? 'Intro' : 'Outro';
        console.info(`[CR Tweaks] ${name}-Skip (Fallback): Treffer ${describe(el)} → geklickt ${describe(target)}`);
        flashBadge(`⏭ ${name} übersprungen`, 2500);
        break;
      }
    }
  }

  // ------------------------------------------------------------------
  // Doppelklick = Player-Vollbild (klickt den echten Vollbild-Button
  // des Players, kein Browser-Vollbild)
  // ------------------------------------------------------------------
  function findFullscreenButton() {
    for (const el of document.querySelectorAll('button, [role="button"], [data-testid]')) {
      if (el.closest('#cr-tweaks-ui')) continue;
      const haystack = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('data-testid') || ''}`;
      if (/fullscreen|vollbild/i.test(haystack)) return findClickTarget(el);
    }
    return null;
  }

  function onDoubleClick(e) {
    if (!SETTINGS.doubleClickFullscreen) return;
    if (!document.querySelector('video')) return;
    if (e.target.closest('#cr-tweaks-ui')) return;
    if (e.target.closest('button, [role="button"], a, input, [role="slider"], [role="menu"]')) return;
    const button = findFullscreenButton();
    if (button) {
      simulateClick(button);
      console.info(`[CR Tweaks] Vollbild umgeschaltet über ${describe(button)}`);
    } else {
      // Notnagel: Video-Container in den Browser-Vollbildmodus heben
      const video = mainVideo();
      const container = video && (video.closest('[class*="player" i]') || video.parentElement);
      if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
      else if (container && container.requestFullscreen) container.requestFullscreen().catch(() => {});
      console.info('[CR Tweaks] Kein Vollbild-Button gefunden — Fallback benutzt');
    }
  }

  document.addEventListener('dblclick', onDoubleClick, true);

  // ------------------------------------------------------------------
  // Hauptschleife
  // ------------------------------------------------------------------
  let announced = false;

  setInterval(() => {
    if (location.href !== lastHref) {
      lastHref = location.href;
      skipEvents = null;
      console.info('[CR Tweaks] Navigation erkannt — Skip-Daten zurückgesetzt');
    }
    buildUi();
    if (!announced && document.querySelector('video')) {
      announced = true;
      lastMouseMove = Date.now();
      flashBadge('✓ CR Tweaks aktiv — Klick aufs Badge für Einstellungen', 4000);
      console.info('[CR Tweaks] Player erkannt — Features aktiv');
    }
    timeBasedSkip();
    buttonFallbackSkip();
    updateBadgeVisibility();
  }, SCAN_INTERVAL_MS);
})();
