// ==UserScript==
// @name         Crunchyroll Player Tweaks
// @namespace    https://github.com/nicolasiven-ops/tampermonkey-scripts
// @version      0.4.0
// @description  Peppt den Crunchyroll-Player auf: Auto-Skip für Intro & Outro, Doppelklick für Vollbild
// @author       nicolasiven-ops
// @match        https://*.crunchyroll.com/*
// @match        https://crunchyroll.com/*
// @grant        none
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/nicolasiven-ops/tampermonkey-scripts/main/crunchyroll-player-tweaks.user.js
// @updateURL    https://raw.githubusercontent.com/nicolasiven-ops/tampermonkey-scripts/main/crunchyroll-player-tweaks.user.js
// ==/UserScript==

(function () {
  'use strict';

  // ------------------------------------------------------------------
  // Einstellungen — hier Features an-/abschalten
  // ------------------------------------------------------------------
  const CONFIG = {
    skipIntro: true,
    skipOutro: true,
    doubleClickFullscreen: true,
    showBadge: true,        // dauerhafte Statusanzeige oben rechts
    scanIntervalMs: 500,    // wie oft nach Skip-Buttons gesucht wird
    clickCooldownMs: 5000,  // Mindestabstand zwischen zwei Skip-Klicks derselben Art
    badgeIdleMs: 3000,      // Badge blendet aus, wenn die Maus so lange still ist
  };

  const PATTERNS = {
    intro: /skip\s*(intro|opening)|(intro|vorspann|opening)\s*überspringen/i,
    outro: /skip\s*(credits|ending|outro)|(abspann|outro|ending|credits)\s*überspringen/i,
  };

  const TESTID_PATTERNS = {
    intro: /skip[-_]?intro/i,
    outro: /skip[-_]?(credits|outro|ending)/i,
  };

  console.info(`[CR Tweaks] geladen in ${location.href}`);

  // ------------------------------------------------------------------
  // Statusanzeige: dauerhaftes Badge, blendet mit der Player-Navigation
  // ein und aus (Mausbewegung zeigt es, Stillstand blendet es aus).
  // ------------------------------------------------------------------
  let badgeEl = null;
  let flashUntil = 0;
  let lastMouseMove = 0;

  function ensureBadge() {
    if (badgeEl && badgeEl.isConnected) return badgeEl;
    badgeEl = document.createElement('div');
    badgeEl.id = 'cr-tweaks-badge';
    badgeEl.style.cssText = [
      'position:fixed', 'top:76px', 'right:16px', 'z-index:2147483647',
      'padding:5px 11px', 'border-radius:6px',
      'background:rgba(20,20,24,0.8)', 'color:#fff',
      'font:600 12px/1.4 sans-serif', 'letter-spacing:0.2px',
      'border-left:3px solid #f47521', // Crunchyroll-Orange
      'pointer-events:none', 'opacity:0', 'transition:opacity 0.35s',
    ].join(';');
    // Im Vollbild rendert der Browser nur den Teilbaum des
    // Vollbild-Elements — das Badge muss also dort hinein.
    (document.fullscreenElement || document.body).appendChild(badgeEl);
    return badgeEl;
  }

  function setBadgeText(text) {
    ensureBadge().textContent = text;
  }

  function flashBadge(text, durationMs) {
    setBadgeText(text);
    flashUntil = Date.now() + durationMs;
  }

  function defaultBadgeText() {
    const parts = [];
    if (CONFIG.skipIntro || CONFIG.skipOutro) parts.push('Auto-Skip an');
    if (CONFIG.doubleClickFullscreen) parts.push('2×Klick = Vollbild');
    return `⏭ CR Tweaks · ${parts.join(' · ')}`;
  }

  function updateBadgeVisibility() {
    if (!CONFIG.showBadge || !document.body || !document.querySelector('video')) return;
    const el = ensureBadge();
    const now = Date.now();
    if (now < flashUntil) {
      el.style.opacity = '1';
      return;
    }
    if (el.textContent !== defaultBadgeText()) setBadgeText(defaultBadgeText());
    // Sichtbar solange die Maus in Bewegung ist — wie die Player-Controls.
    el.style.opacity = now - lastMouseMove < CONFIG.badgeIdleMs ? '1' : '0';
  }

  document.addEventListener('mousemove', () => { lastMouseMove = Date.now(); }, { passive: true });
  document.addEventListener('fullscreenchange', () => {
    // Badge in den Vollbild-Teilbaum umhängen (bzw. zurück in <body>).
    if (badgeEl) {
      (document.fullscreenElement || document.body).appendChild(badgeEl);
      lastMouseMove = Date.now();
    }
  });

  // ------------------------------------------------------------------
  // Auto-Skip: Skip-Buttons finden und wie ein echter Mausklick auslösen
  // ------------------------------------------------------------------
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

  // Crunchyroll baut Skip-Buttons teils als <div> ohne button-Rolle:
  // der Treffer ist dann nur das Text-/Icon-Element, klickbar ist erst
  // ein Vorfahre (erkennbar an cursor:pointer oder onclick).
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

  // .click() reicht bei React-/Custom-Playern nicht immer — eine volle
  // Pointer-Sequenz entspricht dem, was ein echter Mausklick auslöst.
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

  const lastClickAt = { intro: 0, outro: 0 };

  function findButton(category) {
    const candidates = document.querySelectorAll('button, [role="button"], a, [data-testid]');
    for (const el of candidates) {
      if (matchesCategory(el, category)) {
        const target = findClickTarget(el);
        if (isVisible(target)) return { match: el, target };
      }
    }
    return null;
  }

  function scan() {
    for (const category of ['intro', 'outro']) {
      if (category === 'intro' && !CONFIG.skipIntro) continue;
      if (category === 'outro' && !CONFIG.skipOutro) continue;
      if (Date.now() - lastClickAt[category] < CONFIG.clickCooldownMs) continue;
      const found = findButton(category);
      if (found) {
        lastClickAt[category] = Date.now();
        simulateClick(found.target);
        const name = category === 'intro' ? 'Intro' : 'Outro';
        console.info(`[CR Tweaks] ${name}-Skip: Treffer ${describe(found.match)} → geklickt ${describe(found.target)}`);
        flashBadge(`⏭ ${name} übersprungen`, 2500);
      }
    }
  }

  // ------------------------------------------------------------------
  // Doppelklick auf das Video = Vollbild an/aus (wie bei YouTube)
  // ------------------------------------------------------------------
  function toggleFullscreen() {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const root = document.documentElement;
    const request = root.requestFullscreen || root.webkitRequestFullscreen;
    if (request) {
      const result = request.call(root);
      if (result && result.catch) result.catch(() => {});
    }
  }

  function onDoubleClick(e) {
    if (!document.querySelector('video')) return;
    if (e.target.closest('button, [role="button"], a, input, [role="slider"], [role="menu"]')) return;
    toggleFullscreen();
  }

  if (CONFIG.doubleClickFullscreen) {
    document.addEventListener('dblclick', onDoubleClick, true);
  }

  // ------------------------------------------------------------------
  // Hauptschleife
  // ------------------------------------------------------------------
  let announced = false;

  setInterval(() => {
    if (!announced && document.querySelector('video')) {
      announced = true;
      lastMouseMove = Date.now();
      flashBadge(defaultBadgeText(), 4000);
      console.info('[CR Tweaks] Player erkannt — Features aktiv');
    }
    scan();
    updateBadgeVisibility();
  }, CONFIG.scanIntervalMs);
})();
