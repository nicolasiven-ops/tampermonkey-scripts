// ==UserScript==
// @name         Crunchyroll Player Tweaks
// @namespace    https://github.com/nicolasiven-ops/tampermonkey-scripts
// @version      0.1.0
// @description  Peppt den Crunchyroll-Player auf: Auto-Skip für Intro & Outro
// @author       nicolasiven-ops
// @match        https://www.crunchyroll.com/*
// @match        https://static.crunchyroll.com/vilos-v2/*
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
    scanIntervalMs: 500, // wie oft nach Skip-Buttons gesucht wird
  };

  // Crunchyroll rendert den eigentlichen Player in einem iframe auf
  // static.crunchyroll.com — das Script läuft daher in beiden Kontexten
  // und klickt die Buttons dort, wo sie tatsächlich existieren.

  // Textmuster der Skip-Buttons (EN + DE UI), aufgeteilt nach Kategorie,
  // damit sich Intro und Outro getrennt schalten lassen.
  const PATTERNS = {
    intro: /skip\s*(intro|opening)|(intro|vorspann|opening)\s*überspringen/i,
    outro: /skip\s*(credits|ending|outro)|(abspann|outro|ending|credits)\s*überspringen/i,
  };

  // Direkte Selektoren des Vilos-Players (schneller & robuster als Textsuche,
  // Textsuche bleibt als Fallback für UI-/Sprachvarianten).
  const TESTID_SELECTORS = {
    intro: '[data-testid="skipIntroText"]',
    outro: '[data-testid="skipCreditsText"]',
  };

  // Merkt sich bereits geklickte Buttons, damit derselbe Button nicht im
  // 500-ms-Takt erneut geklickt wird (z. B. wenn der Skip kurz braucht).
  const clicked = new WeakSet();

  function clickable(el) {
    // Der Text sitzt oft in einem inneren <span>/<div>; geklickt werden
    // muss der Button bzw. das role=button-Element darüber.
    return el.closest('button, [role="button"], a') || el;
  }

  function tryClick(el, category) {
    if (!el) return;
    const target = clickable(el);
    if (clicked.has(target)) return;
    clicked.add(target);
    target.click();
    console.info(`[CR Tweaks] ${category === 'intro' ? 'Intro' : 'Outro'} übersprungen`);
  }

  function findByText(category) {
    const candidates = document.querySelectorAll('button, [role="button"]');
    for (const el of candidates) {
      const text = (el.textContent || '').trim();
      if (text && text.length < 40 && PATTERNS[category].test(text)) return el;
    }
    return null;
  }

  function scan() {
    for (const category of ['intro', 'outro']) {
      if (category === 'intro' && !CONFIG.skipIntro) continue;
      if (category === 'outro' && !CONFIG.skipOutro) continue;
      const el = document.querySelector(TESTID_SELECTORS[category]) || findByText(category);
      if (el) tryClick(el, category);
    }
  }

  setInterval(scan, CONFIG.scanIntervalMs);
})();
