// ═══════════════════════════════════════════
// LOADER A — InlineSourceLoader
// Props: { episodeId, onReady? }
// Usage: const loader = createInlineLoader('s5e1');
//        container.appendChild(loader.el);
//        // when done: loader.destroy();
// ═══════════════════════════════════════════

const INLINE_VERBS = ['hunting sources', 'scanning trackers', 'checking mirrors', 'gathering peers', 'matching seeds'];
const SEARCH_VERBS = ['sprinting through the archive', 'chasing down sources', 'hunting trackers', 'dashing past mirrors', 'racing to finish'];
const LOTTIE_INLINE = 'https://lottie.host/06831428-142e-44b1-bdda-d9a550de6f4b/rYOiTwxLtN.lottie';
const LOTTIE_SEARCH = 'https://lottie.host/5bf6990c-9b97-4187-b1cd-a68d1e1302fc/RqJz6SNyGQ.lottie';

function createInlineLoader(episodeId) {
  const el = document.createElement('div');
  el.className = 'inline-loader';
  el.dataset.epId = episodeId;

  el.innerHTML = `
    <div class="inline-loader-ground"></div>
    <div class="inline-loader-runner">
      <dotlottie-wc src="${LOTTIE_INLINE}" autoplay loop speed="0.6"></dotlottie-wc>
    </div>
    <div class="inline-loader-status">
      <div class="inline-loader-label">
        <span class="inline-loader-dot"></span>
        <span class="inline-loader-verb">${INLINE_VERBS[0]}</span>
      </div>
      <span class="inline-loader-count">0 FOUND</span>
    </div>
  `;

  let verbIdx = 0;
  let count = 0;
  let destroyed = false;

  const verbTimer = setInterval(() => {
    if (destroyed) return;
    verbIdx = (verbIdx + 1) % INLINE_VERBS.length;
    const verbEl = el.querySelector('.inline-loader-verb');
    if (verbEl) verbEl.textContent = INLINE_VERBS[verbIdx];
  }, 1800);

  const countTimer = setInterval(() => {
    if (destroyed) return;
    count += Math.floor(Math.random() * 4) + 1;
    const countEl = el.querySelector('.inline-loader-count');
    if (countEl) countEl.textContent = `${count} FOUND`;
  }, 800);

  function destroy() {
    destroyed = true;
    clearInterval(verbTimer);
    clearInterval(countTimer);
    el.remove();
  }

  return { el, destroy };
}

// ═══════════════════════════════════════════
// LOADER B — SearchPageLoader
// Props: { query, onCancel, minDurationMs? }
// Usage: const loader = createSearchLoader({ query: 'the boys', onCancel: () => ctrl.abort() });
//        document.body.appendChild(loader.el);
//        // when done: loader.hide();
// ═══════════════════════════════════════════

function createSearchLoader({ query, onCancel, minDurationMs = 600 }) {
  const el = document.createElement('div');
  el.className = 'search-loader';

  const hillsPath = 'M0,40 Q15,10 30,40 Q45,15 60,40 Q75,5 90,40 Q105,15 120,40 Q135,8 150,40 Q165,18 180,40 Q195,10 210,40 Q225,20 240,40 L240,60 L0,60 Z';
  const treesPath = 'M0,40 L5,40 L8,20 L11,40 L20,40 L24,15 L28,40 L40,40 L44,22 L48,40 L55,40 L58,18 L61,40 L70,40 L74,25 L78,40 L85,40 L88,12 L91,40 L100,40 L104,20 L108,40 L120,40 L120,60 L0,60 Z';

  el.innerHTML = `
    <div class="search-loader-top">
      <div class="search-loader-brand">
        <span style="font-family:'Noto Sans Devanagari',sans-serif;font-weight:500;font-size:28px;line-height:0.78;color:#fff;letter-spacing:-0.01em">तु</span>
        <div style="display:flex;flex-direction:column;align-items:flex-start;padding-bottom:2px;gap:2px">
          <svg style="width:14px;height:auto;display:block" viewBox="0 0 34 16" fill="none">
            <path d="M2 2 L8 8 L2 14" stroke="#E8A263" stroke-width="2" fill="none" stroke-linejoin="miter" stroke-linecap="square"/>
            <path d="M12 2 L18 8 L12 14" stroke="#E8A263" stroke-width="2" fill="none" stroke-linejoin="miter" stroke-linecap="square"/>
            <path d="M22 2 L28 8 L22 14" stroke="#E8A263" stroke-width="2" fill="none" stroke-linejoin="miter" stroke-linecap="square"/>
          </svg>
          <span style="font-family:'Inter',sans-serif;font-weight:500;font-size:8px;line-height:1;color:#fff;letter-spacing:0.02em">rant</span>
        </div>
      </div>
      <div class="search-loader-pulse"></div>
    </div>
    <div class="search-loader-query">
      <div class="search-loader-query-pill">
        <span class="search-loader-query-label">QUERY</span>
        <span class="search-loader-query-text">${escapeHtml(query)}</span>
      </div>
    </div>
    <div class="search-loader-stage">
      <div class="search-loader-parallax">
        <div class="search-loader-hills">
          <svg viewBox="0 0 240 60" preserveAspectRatio="none">
            <path d="${hillsPath}" fill="#0E0E0E"/>
          </svg>
        </div>
        <div class="search-loader-trees">
          <svg viewBox="0 0 120 60" preserveAspectRatio="none">
            <path d="${treesPath}" fill="#161616"/>
          </svg>
        </div>
      </div>
      <div class="search-loader-ground"></div>
      <div class="search-loader-character">
        <dotlottie-wc src="${LOTTIE_SEARCH}" autoplay loop></dotlottie-wc>
      </div>
    </div>
    <div class="search-loader-statuswrap">
      <div class="search-loader-verb">${SEARCH_VERBS[0]}</div>
      <div class="search-loader-elapsed">0.0s ELAPSED</div>
    </div>
    <div class="search-loader-stats">
      <div class="search-loader-stat">
        <div class="search-loader-stat-label">SCANNED</div>
        <div class="search-loader-stat-value" id="slScanned">0</div>
        <div class="search-loader-stat-sub">entries</div>
      </div>
      <div class="search-loader-stat">
        <div class="search-loader-stat-label">MATCHED</div>
        <div class="search-loader-stat-value green" id="slMatched">0</div>
        <div class="search-loader-stat-sub">results</div>
      </div>
      <div class="search-loader-stat">
        <div class="search-loader-stat-label">SOURCES</div>
        <div class="search-loader-stat-value" id="slSources">0</div>
        <div class="search-loader-stat-sub">providers</div>
      </div>
    </div>
    <div class="search-loader-cancel-wrap" id="slCancelWrap">
      <div class="search-loader-cancel-msg">TAKING LONGER THAN USUAL</div>
      <button class="search-loader-cancel-btn" id="slCancelBtn">CANCEL</button>
    </div>
  `;

  let destroyed = false;
  let verbIdx = 0;
  const startTime = performance.now();

  // Verb rotation
  const verbTimer = setInterval(() => {
    if (destroyed) return;
    verbIdx = (verbIdx + 1) % SEARCH_VERBS.length;
    const v = el.querySelector('.search-loader-verb');
    if (v) v.textContent = SEARCH_VERBS[verbIdx];
  }, 2200);

  // Elapsed timer
  const elapsedTimer = setInterval(() => {
    if (destroyed) return;
    const sec = ((performance.now() - startTime) / 1000).toFixed(1);
    const e = el.querySelector('.search-loader-elapsed');
    if (e) e.textContent = `${sec}s ELAPSED`;
  }, 100);

  // Stats simulation
  let scanned = 0, matched = 0, sources = 0;
  const statsTimer = setInterval(() => {
    if (destroyed) return;
    const elapsed = (performance.now() - startTime) / 1000;

    // Scanned: fast at first, then slow
    if (elapsed < 6) {
      scanned += Math.floor(Math.random() * 80000) + 40000;
    } else {
      scanned += Math.floor(Math.random() * 5000) + 1000;
    }
    if (scanned > 2400000) scanned = 2400000;

    // Matched: grows fast then narrows
    if (elapsed < 3.5) {
      matched += Math.floor(Math.random() * 60) + 20;
      if (matched > 900) matched = 900;
    } else {
      matched = Math.max(4, matched - Math.floor(Math.random() * 40));
    }

    // Sources: slow increment
    if (elapsed > 1 && sources < 9) {
      if (Math.random() < 0.15) sources++;
    }

    const sEl = el.querySelector('#slScanned');
    const mEl = el.querySelector('#slMatched');
    const srcEl = el.querySelector('#slSources');
    if (sEl) sEl.textContent = scanned.toLocaleString();
    if (mEl) mEl.textContent = matched.toLocaleString();
    if (srcEl) srcEl.textContent = sources;
  }, 200);

  // Cancel after 8s
  const cancelTimer = setTimeout(() => {
    if (destroyed) return;
    const wrap = el.querySelector('#slCancelWrap');
    if (wrap) wrap.classList.add('visible');
  }, 8000);

  // Cancel button
  setTimeout(() => {
    const btn = el.querySelector('#slCancelBtn');
    if (btn) btn.addEventListener('click', () => { if (onCancel) onCancel(); });
  }, 0);

  function hide() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(verbTimer);
    clearInterval(elapsedTimer);
    clearInterval(statsTimer);
    clearTimeout(cancelTimer);
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 300);
  }

  return { el, hide, startTime, minDurationMs };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
