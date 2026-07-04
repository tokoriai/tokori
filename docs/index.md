---
layout: page
sidebar: false
aside: false
---

<div class="tk-doc-home">

<section class="tk-hero">
  <div class="tk-hero-grid" aria-hidden="true"></div>
  <div class="tk-hero-inner">
    <p class="tk-eyebrow">Documentation</p>
    <h1 class="tk-hero-title">Build with Tokori.</h1>
    <p class="tk-hero-sub">
      A local-first language tutor. Quickstart in two minutes,
      with a fully documented HTTP API for scripting your study.
    </p>
    <div class="tk-hero-actions">
      <a class="tk-pill tk-pill--solid" href="/guides/quickstart">Quickstart →</a>
      <a class="tk-pill" href="/reference/api">API reference →</a>
    </div>
  </div>
</section>

<section class="tk-section">

## Get started

<p class="tk-section-sub">Everything you need to ship your first session.</p>

<div class="tk-cards">
  <a class="tk-card" href="/guides/quickstart">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/></svg>
      </span>
      <h3>Quickstart</h3>
    </div>
    <p>Install Tokori, pick a language, and have your first conversation with the AI tutor in under two minutes.</p>
  </a>

  <a class="tk-card" href="/guides/install">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
      </span>
      <h3>Install</h3>
    </div>
    <p>Native installers for macOS, Windows, and Linux. Or build from source — Tokori is open under AGPL-3.0.</p>
  </a>

  <a class="tk-card" href="/guides/providers">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3z"/><line x1="7" y1="22" x2="3" y2="22"/></svg>
      </span>
      <h3>Providers</h3>
    </div>
    <p>Connect Ollama, OpenAI, Anthropic, Gemini, OpenRouter, or MiniMax. Bring your own keys; they never leave your machine.</p>
  </a>

  <a class="tk-card" href="/guides/vocabulary">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>
      </span>
      <h3>Vocabulary & SRS</h3>
    </div>
    <p>Save words from chat or the reader. FSRS-5 schedules reviews. Production round drills recall both directions.</p>
  </a>
</div>

</section>

<section class="tk-section">

## Reference

<p class="tk-section-sub">Deep details, every endpoint, every flag.</p>

<div class="tk-cards">
  <a class="tk-card" href="/reference/api">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
      </span>
      <h3>HTTP API</h3>
    </div>
    <p>REST-ish JSON over <code>localhost:53210</code>. Workspaces, vocab, dictionary lookup. Bearer-token auth.</p>
  </a>

  <a class="tk-card" href="/guides/plugins">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/></svg>
      </span>
      <h3>Plugin SDK</h3>
    </div>
    <p>Add a study mode in ~50 lines. Each plugin owns its queue and an optional settings panel.</p>
  </a>

  <a class="tk-card" href="/guides/architecture">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3h7v7H3z"/><path d="M14 3h7v7h-7z"/><path d="M14 14h7v7h-7z"/><path d="M3 14h7v7H3z"/></svg>
      </span>
      <h3>Architecture</h3>
    </div>
    <p>How the React frontend, Rust shell, SQLite store, and optional cloud backend fit together.</p>
  </a>

  <a class="tk-card" href="/reference/pack-format">
    <div class="tk-card-head">
      <span class="tk-card-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
      </span>
      <h3>Pack format</h3>
    </div>
    <p>Author your own vocabulary + textbook packs. Import via the desktop, share with friends, sell via the cloud.</p>
  </a>
</div>

</section>

<footer class="tk-footer">
  <div class="tk-footer-inner">
    <div class="tk-footer-left">
      <strong>Tokori</strong>
      <span class="tk-footer-dot">·</span>
      <span>Local-first AI tutor for language learners.</span>
    </div>
    <div class="tk-footer-right">
      <a href="https://github.com/tokoriai/tokori">GitHub</a>
      <a href="/guides/quickstart">Quickstart</a>
      <a href="/reference/api">API</a>
    </div>
  </div>
  <div class="tk-footer-copy">
    AGPL-3.0 licensed. © 2026 Tokori contributors.
  </div>
</footer>

</div>
