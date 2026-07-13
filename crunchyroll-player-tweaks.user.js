// ==UserScript==
// @name         Crunchyroll Player Tweaks
// @namespace    https://github.com/nicolasiven-ops/tampermonkey-scripts
// @version      0.3.0
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
    showBadge: true,     // Statusanzeige im Player ein-/ausblenden
    scanIntervalMs: 500, // wie oft nach Skip-Buttons gesucht wird
  };

  // Der Player lebt in einem iframe auf einer crunchyroll.com-Subdomain,
  // dessen genauer Pfad sich immer wieder ändert. Das Script läuft deshalb
  // in JEDEM Frame unter *.crunchyroll.com und wird nur dort aktiv, wo
  // tatsächlich ein <video> existiert.

  const PATTERNS = {
    intro: /skip\s*(intro|opening|op\b)|(intro|vorspann|opening)\s*überspringen/i,
    outro: /skip\s*(credits|ending|outro|ed\b)|(abspann|outro|ending|credits)\s*überspringen/i,
  };

  const TESTID_PATTERNS = {
    intro: /skip[-_]?intro/i,
    outro: /skip[-_]?(credits|outro|ending)/i,
  };

  const clicked = new WeakSet();

  console.info(`[CR Tweaks] geladen in ${location.href}`);

  // ------------------------------------------------------------------
  // Statusanzeige (kleines Overlay oben links im Player)
  // ------------------------------------------------------------------
  let badgeEl = null;
  let badgeTimer = null;

  function showBadge(text, durationMs) {
    if (!CONFIG.showBadge || !document.body) return;
    if (!badgeEl) {
      badgeEl = document.createElement('div');
      badgeEl.style.cssText = [
        'position:fixed', 'top:12px', 'left:12px', 'z-index:2147483647',
        'padding:6px 12px', 'border-radius:6px',
        'background:rgba(20,20,24,0.85)', 'color:#fff',
        'font:600 13px/1.4 sans-serif', 'letter-spacing:0.2px',
        'border-left:3px solid #f47521', // Crunchyroll-Orange
        'pointer-events:none', 'transition:opacity 0.4s',
      ].join(';');
      document.body.appendChild(badgeEl);
    }
    badgeEl.textContent = text;
    badgeEl.style.opacity = '1';
    clearTimeout(badgeTimer);
    badgeTimer = setTimeout(() => { badgeEl.style.opacity = '0'; }, durationMs);
  }

  // ------------------------------------------------------------------
  // Auto-Skip: Skip-Buttons finden und klicken
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

  function findButton(category) {
    // data-testid sitzt teils auf einem inneren Text-Element statt auf dem
    // Button selbst, daher werden auch [data-testid]-Elemente durchsucht.
    const candidates = document.querySelectorAll('button, [role="button"], a, [data-testid]');
    for (const el of candidates) {
      if (matchesCategory(el, category)) {
        const target = el.closest('button, [role="button"], a') || el;
        if (isVisible(target)) return target;
      }
    }
    return null;
  }

  function scan() {
    for (const category of ['intro', 'outro']) {
      if (category === 'intro' && !CONFIG.skipIntro) continue;
      if (category === 'outro' && !CONFIG.skipOutro) continue;
      const button = findButton(category);
      if (button && !clicked.has(button)) {
        clicked.add(button);
        button.click();
        const name = category === 'intro' ? 'Intro' : 'Outro';
        console.info(`[CR Tweaks] ${name} übersprungen`);
        showBadge(`⏭ ${name} übersprungen`, 2500);
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

  // ------------------------------------------------------------------
  // Start: aktiv werden, sobald in diesem Frame ein <video> auftaucht
  // ------------------------------------------------------------------
  let announced = false;

  setInterval(() => {
    if (!announced && document.querySelector('video')) {
      announced = true;
      const features = [];
      if (CONFIG.skipIntro || CONFIG.skipOutro) features.push('Auto-Skip');
      if (CONFIG.doubleClickFullscreen) features.push('Doppelklick-Vollbild');
      console.info(`[CR Tweaks] Player erkannt — aktiv: ${features.join(', ')}`);
      showBadge(`✓ CR Tweaks aktiv (${features.join(' + ')})`, 4000);
    }
    scan();
  }, CONFIG.scanIntervalMs);

  if (CONFIG.doubleClickFullscreen) {
    document.addEventListener('dblclick', onDoubleClick, true);
  }
})();
