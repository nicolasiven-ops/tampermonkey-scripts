// ==UserScript==
// @name         Crunchyroll Player Tweaks
// @namespace    https://github.com/nicolasiven-ops/tampermonkey-scripts
// @version      0.9.0
// @description  Peppt den Crunchyroll-Player auf: Auto-Skip für Intro & Outro, Doppelklick für Vollbild, Wiedergabetempo, Player offen halten, Einstellungsmenü
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
    playbackRate: 1.0,
    keepPlayerOpen: true,
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

  // ------------------------------------------------------------------
  // Diagnose-Log: die letzten 120 Ereignisse überleben Reloads
  // (localStorage) und lassen sich über das Menü kopieren.
  // ------------------------------------------------------------------
  const LOG_KEY = 'crTweaksLog';

  function log(msg) {
    console.info(`[CR Tweaks] ${msg}`);
    try {
      const entries = JSON.parse(localStorage.getItem(LOG_KEY) || '[]');
      entries.push(`${new Date().toLocaleTimeString('de-DE')} ${msg}`);
      localStorage.setItem(LOG_KEY, JSON.stringify(entries.slice(-120)));
    } catch (e) { /* egal */ }
  }

  function readLog() {
    try { return JSON.parse(localStorage.getItem(LOG_KEY) || '[]').join('\n'); } catch (e) { return ''; }
  }

  log(`geladen in ${location.href} (Referrer: ${document.referrer || '—'})`);
  window.addEventListener('beforeunload', () => log(`Seite wird entladen: ${location.href}`));
  document.addEventListener('visibilitychange', () => log(`Tab ${document.visibilityState === 'hidden' ? 'in den Hintergrund' : 'in den Vordergrund'}`));

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
    log(`Skip-Daten empfangen: ${parts.join(', ') || 'keine Segmente'}`);
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
  let speedValueEl = null;
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
        ['keepPlayerOpen', 'Player offen halten (Anti-Idle)'],
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

      // Tempo-Regler in 0.1er-Schritten
      const speedRow = document.createElement('div');
      speedRow.style.cssText = 'display:flex;align-items:center;gap:8px;margin:10px 0 4px;font-weight:400';
      const speedButtonCss = 'width:26px;height:26px;border:none;border-radius:4px;background:#3a3a42;color:#fff;cursor:pointer;font:700 15px/1 sans-serif;padding:0';
      const makeSpeedButton = (text, delta) => {
        const button = document.createElement('button');
        button.textContent = text;
        button.style.cssText = speedButtonCss;
        button.addEventListener('click', (e) => {
          e.stopPropagation();
          setPlaybackRate(SETTINGS.playbackRate + delta);
        });
        return button;
      };
      speedValueEl = document.createElement('span');
      speedValueEl.style.cssText = 'min-width:38px;text-align:center;font-weight:600';
      speedValueEl.textContent = SETTINGS.playbackRate.toFixed(1) + '×';
      speedRow.appendChild(document.createTextNode('Tempo'));
      speedRow.appendChild(makeSpeedButton('−', -0.1));
      speedRow.appendChild(speedValueEl);
      speedRow.appendChild(makeSpeedButton('+', +0.1));
      panelEl.appendChild(speedRow);

      // Diagnose-Log kopieren (für Fehlersuche)
      const diagButton = document.createElement('button');
      diagButton.textContent = 'Diagnose-Log kopieren';
      diagButton.style.cssText = 'margin-top:8px;border:none;border-radius:4px;background:#3a3a42;color:#fff;cursor:pointer;font:600 11px/1 sans-serif;padding:6px 9px';
      diagButton.addEventListener('click', (e) => {
        e.stopPropagation();
        const text = readLog() || '(Log ist leer)';
        navigator.clipboard.writeText(text).then(
          () => flashBadge('📋 Log kopiert', 2000),
          () => {
            console.info(`[CR Tweaks] Log:\n${text}`);
            flashBadge('Log in Konsole ausgegeben (F12)', 2500);
          }
        );
      });
      panelEl.appendChild(diagButton);

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
    const speed = SETTINGS.playbackRate !== 1 ? ` · ${SETTINGS.playbackRate.toFixed(1)}×` : '';
    badgeEl.textContent = `⏭ CR Tweaks · Auto-Skip ${skipOn ? 'an' : 'aus'}${speed} ⚙`;
  }

  function flashBadge(text, durationMs) {
    if (!badgeEl) return;
    badgeEl.textContent = text;
    flashUntil = Date.now() + durationMs;
  }

  function updateBadgeVisibility() {
    if (!badgeEl) return;
    // Badge auf allen CR-Seiten zeigen (nicht nur mit Video), damit das
    // Menü samt Diagnose-Log auch nach einem Rauswurf erreichbar ist.
    if (!SETTINGS.showBadge) {
      badgeEl.style.opacity = '0';
      return;
    }
    const active = panelOpen || Date.now() < flashUntil || Date.now() - lastMouseMove < BADGE_IDLE_MS;
    badgeEl.style.opacity = active ? '1' : '0';
    if (Date.now() >= flashUntil) refreshBadgeText();
  }

  // Nur echte Mausbewegungen zählen — die simulierten Anti-Idle-Events
  // (isTrusted=false) sollen das Badge nicht dauerhaft einblenden.
  document.addEventListener('mousemove', (e) => {
    if (e.isTrusted) lastMouseMove = Date.now();
  }, { passive: true });
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

  // ------------------------------------------------------------------
  // Wiedergabetempo: in 0.1er-Schritten einstellbar, wird gespeichert
  // und bei jeder (neuen) Folge wieder durchgesetzt.
  // ------------------------------------------------------------------
  function setPlaybackRate(rate) {
    rate = Math.round(Math.min(3, Math.max(0.5, rate)) * 10) / 10;
    SETTINGS.playbackRate = rate;
    saveSettings();
    const video = mainVideo();
    if (video) video.playbackRate = rate;
    if (speedValueEl) speedValueEl.textContent = rate.toFixed(1) + '×';
    flashBadge(`⏱ Tempo ${rate.toFixed(1)}×`, 1500);
    console.info(`[CR Tweaks] Tempo auf ${rate.toFixed(1)}× gesetzt`);
  }

  function enforcePlaybackRate() {
    const video = mainVideo();
    if (!video) return;
    // Der Player setzt das Tempo bei Folgenwechseln auf 1× zurück —
    // hier wird das gespeicherte Tempo wieder angelegt.
    if (Math.abs(video.playbackRate - SETTINGS.playbackRate) > 0.01) {
      video.playbackRate = SETTINGS.playbackRate;
    }
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
        log(`${name} übersprungen (${Math.round(t)}s → ${Math.round(seg.end)}s)`);
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
  // Player offen halten: Crunchyroll wirft einen nach längerer
  // Inaktivität zurück auf die Serienseite. Dagegen helfen zwei Dinge:
  // 1. regelmäßig simulierte Aktivität, damit der Idle-Timer nie abläuft
  // 2. falls doch ein "Noch da?"-Dialog erscheint, ihn wegklicken
  // ------------------------------------------------------------------
  const STILL_WATCHING_QUESTION = /noch da|schaust du noch|siehst du noch|still watching|still there|weiterhin ansehen|inaktivität/i;
  const CONTINUE_BUTTON = /weiter|fortsetzen|ja\b|continue|yes\b|keep watching|resume|bleiben/i;

  function simulateActivity() {
    // Leicht wandernde Koordinaten, damit es nicht wie ein statischer
    // Wiederholungs-Event aussieht.
    const x = 200 + Math.floor(Math.random() * 40);
    const y = 200 + Math.floor(Math.random() * 40);
    const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
    document.dispatchEvent(new PointerEvent('pointermove', opts));
    document.dispatchEvent(new MouseEvent('mousemove', opts));
    console.debug('[CR Tweaks] Anti-Idle-Ping');
  }

  function dismissStillWatchingDialog() {
    for (const dialog of document.querySelectorAll('[role="dialog"], [role="alertdialog"], [class*="modal" i]')) {
      if (dialog.closest('#cr-tweaks-ui')) continue;
      if (!STILL_WATCHING_QUESTION.test(dialog.textContent || '')) continue;
      for (const btn of dialog.querySelectorAll('button, [role="button"]')) {
        const label = `${btn.textContent || ''} ${btn.getAttribute('aria-label') || ''}`;
        if (CONTINUE_BUTTON.test(label)) {
          simulateClick(findClickTarget(btn));
          log(`"Noch da?"-Dialog weggeklickt über ${describe(btn)}`);
          flashBadge('▶ Player offen gehalten', 2500);
          return;
        }
      }
    }
  }

  // ------------------------------------------------------------------
  // Rauswurf-Schutz: Crunchyroll navigiert nach langer Pause von der
  // Watch-Seite zurück zur Serienseite. Drei Verteidigungslinien:
  // 1. Programmatische SPA-Navigation weg von /watch/ blockieren,
  //    wenn kurz zuvor KEINE echte Nutzereingabe stattfand.
  // 2. Rutscht doch eine Navigation durch, sofort zur Folge zurück.
  // 3. Position laufend speichern und nach Rücksprung dort fortsetzen.
  // ------------------------------------------------------------------
  const RESUME_KEY = 'crTweaksResume';
  const USER_INTENT_WINDOW_MS = 10000; // so lange gilt eine Eingabe als "der Nutzer wollte das"
  const BOUNCE_COOLDOWN_MS = 120000;

  let lastTrustedInteraction = 0;
  let restoreDone = false;

  // Bounce-Sperre in sessionStorage, damit sie den Reload überlebt
  function canBounce() {
    try { return Date.now() - (parseInt(sessionStorage.getItem('crTweaksBounceAt') || '0', 10)) > BOUNCE_COOLDOWN_MS; } catch (e) { return false; }
  }
  function markBounce() {
    try { sessionStorage.setItem('crTweaksBounceAt', String(Date.now())); } catch (e) { /* egal */ }
  }

  for (const type of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
    document.addEventListener(type, (e) => {
      if (e.isTrusted) lastTrustedInteraction = Date.now();
    }, { capture: true, passive: true });
  }

  function isWatchUrl(url) {
    try { return new URL(url, location.href).pathname.includes('/watch/'); } catch (e) { return false; }
  }

  function userRecentlyActive() {
    return Date.now() - lastTrustedInteraction < USER_INTENT_WINDOW_MS;
  }

  // Linie 1: pushState/replaceState weg von /watch/ ohne Nutzereingabe blocken
  function guardHistory(method) {
    const orig = history[method];
    history[method] = function (state, title, url) {
      try {
        if (url != null && SETTINGS.keepPlayerOpen && isWatchUrl(location.href) && !isWatchUrl(url) && !userRecentlyActive()) {
          log(`Automatische Navigation blockiert (${method} → ${url})`);
          flashBadge('⛔ Rauswurf blockiert', 3000);
          return undefined;
        }
      } catch (e) { /* im Zweifel durchlassen */ }
      return orig.apply(this, arguments);
    };
  }
  guardHistory('pushState');
  guardHistory('replaceState');

  function saveResumePoint(video) {
    try {
      localStorage.setItem(RESUME_KEY, JSON.stringify({
        url: location.href,
        time: video.currentTime,
        at: Date.now(),
        lastInput: lastTrustedInteraction,
      }));
    } catch (e) { /* egal */ }
  }

  function loadResumePoint() {
    try { return JSON.parse(localStorage.getItem(RESUME_KEY) || 'null'); } catch (e) { return null; }
  }

  // Linie 2: durchgerutschte Navigation → zurück zur Folge
  function handleNavigation(fromUrl) {
    if (!SETTINGS.keepPlayerOpen) return;
    if (!isWatchUrl(fromUrl) || isWatchUrl(location.href)) return;
    if (userRecentlyActive()) return; // Nutzer hat selbst navigiert
    if (!canBounce()) return;
    const resume = loadResumePoint();
    if (!resume || Date.now() - resume.at > 60000) return;
    markBounce();
    log(`Rauswurf erkannt (SPA) — zurück zu ${resume.url} bei ${Math.round(resume.time)}s`);
    location.assign(resume.url);
  }

  // Linie 2b: Rauswurf per komplettem Seiten-Reload. Den sieht der
  // pushState-Wächter nicht — erkennbar aber daran, dass wir frisch auf
  // einer Nicht-Watch-Seite landen, der Referrer die Watch-Seite ist,
  // Sekunden zuvor noch geschaut wurde und der Nutzer nichts gedrückt hat.
  function bounceAfterReloadKick() {
    if (!SETTINGS.keepPlayerOpen) return;
    if (isWatchUrl(location.href)) return;
    const resume = loadResumePoint();
    if (!resume || Date.now() - resume.at > 120000) return;
    if (!document.referrer || !isWatchUrl(document.referrer)) return;
    if (resume.lastInput && resume.at - resume.lastInput < USER_INTENT_WINDOW_MS) return;
    if (!canBounce()) return;
    markBounce();
    log(`Rauswurf erkannt (Reload) — zurück zu ${resume.url} bei ${Math.round(resume.time)}s`);
    location.assign(resume.url);
  }
  bounceAfterReloadKick();

  // Linie 3: nach (Rück-)Laden der Watch-Seite an gespeicherter Stelle fortsetzen
  function restoreResumePoint() {
    if (restoreDone) return;
    const video = mainVideo();
    if (!video || video.readyState < 2 || !video.duration) return;
    restoreDone = true;
    const resume = loadResumePoint();
    if (!resume || Date.now() - resume.at > 600000) return;
    try {
      if (new URL(resume.url).pathname !== location.pathname) return;
    } catch (e) { return; }
    if (resume.time > video.currentTime + 5 && resume.time < video.duration - 5) {
      video.currentTime = resume.time;
      const min = Math.floor(resume.time / 60);
      const sec = String(Math.floor(resume.time % 60)).padStart(2, '0');
      log(`Position wiederhergestellt: ${min}:${sec}`);
      flashBadge(`▶ Fortgesetzt bei ${min}:${sec}`, 3000);
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
  let videoPresent = false;
  let tick = 0;

  setInterval(() => {
    tick++;
    if (location.href !== lastHref) {
      const fromUrl = lastHref;
      lastHref = location.href;
      skipEvents = null;
      log(`Navigation: ${fromUrl} → ${location.href}`);
      handleNavigation(fromUrl);
    }
    buildUi();
    // Verschwindet das Video, ohne dass sich die URL ändert, ist das die
    // heiße Spur für den Rauswurf-Mechanismus — unbedingt festhalten.
    const videoNow = !!document.querySelector('video');
    if (videoNow !== videoPresent) {
      videoPresent = videoNow;
      log(videoNow ? `Video-Element da (${location.href})` : `Video-Element VERSCHWUNDEN, URL: ${location.href}`);
    }
    if (!announced && videoNow) {
      announced = true;
      lastMouseMove = Date.now();
      flashBadge('✓ CR Tweaks aktiv — Klick aufs Badge für Einstellungen', 4000);
    }
    timeBasedSkip();
    buttonFallbackSkip();
    enforcePlaybackRate();
    if (SETTINGS.keepPlayerOpen && document.querySelector('video')) {
      // alle ~60 s Aktivität vortäuschen, alle ~5 s nach Dialog schauen
      if (tick % 200 === 0) simulateActivity();
      if (tick % 16 === 0) dismissStillWatchingDialog();
      // Position regelmäßig sichern, solange wir auf einer Watch-Seite sind
      if (tick % 16 === 8 && isWatchUrl(location.href)) {
        const video = mainVideo();
        if (video && video.currentTime > 0) saveResumePoint(video);
      }
      restoreResumePoint();
    }
    updateBadgeVisibility();
  }, SCAN_INTERVAL_MS);
})();
