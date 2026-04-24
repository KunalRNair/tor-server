// ═══════════════════════════════════════════
// DOM REFERENCES (shared across pages)
// ═══════════════════════════════════════════
const overlay = document.getElementById('loadingOverlay');
const loadingTextEl = document.getElementById('loadingText');
const loadingSubEl = document.getElementById('loadingSubtext');
const overlayCounter = document.getElementById('overlayCounter');

// ═══════════════════════════════════════════
// SCRAMBLE TEXT EFFECT
// ═══════════════════════════════════════════
const SCRAMBLE_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789@#$%&';
let scrambleRAF = null;

function scrambleText(el, finalText, duration = 600) {
  if (scrambleRAF) cancelAnimationFrame(scrambleRAF);
  const start = performance.now();
  const len = finalText.length;

  function tick(now) {
    const elapsed = now - start;
    const progress = Math.min(elapsed / duration, 1);
    const resolved = Math.floor(progress * len);
    let display = '';
    for (let i = 0; i < len; i++) {
      if (finalText[i] === ' ') { display += ' '; continue; }
      if (i < resolved) {
        display += finalText[i];
      } else {
        display += SCRAMBLE_CHARS[Math.floor(Math.random() * SCRAMBLE_CHARS.length)];
      }
    }
    el.textContent = display;
    if (progress < 1) {
      scrambleRAF = requestAnimationFrame(tick);
    } else {
      el.textContent = finalText;
    }
  }
  scrambleRAF = requestAnimationFrame(tick);
}

// Timer counter for overlay
let timerInterval = null;
let timerStart = 0;

function startOverlayTimer() {
  timerStart = Date.now();
  clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    const elapsed = Math.floor((Date.now() - timerStart) / 1000);
    const mins = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const secs = String(elapsed % 60).padStart(2, '0');
    overlayCounter.textContent = `${mins}:${secs}`;
  }, 1000);
}

function stopOverlayTimer() {
  clearInterval(timerInterval);
  overlayCounter.textContent = '00:00';
}

function setLoadingText(text) {
  scrambleText(loadingTextEl, text, 500);
}
function setLoadingSubtext(text) {
  loadingSubEl.textContent = text;
}

function showOverlay(text, subtext) {
  overlay.classList.add('active');
  startOverlayTimer();
  setLoadingText(text || 'Searching');
  setLoadingSubtext(subtext || 'Finding the best sources.');
}
function hideOverlay() {
  overlay.classList.remove('active');
  stopOverlayTimer();
  if (scrambleRAF) cancelAnimationFrame(scrambleRAF);
}

// ═══════════════════════════════════════════
// STAGGER ANIMATION
// ═══════════════════════════════════════════
function staggerReveal(selector, container) {
  const items = (container || document).querySelectorAll(selector);
  items.forEach((el, i) => {
    el.style.transitionDelay = `${i * 0.04}s`;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => el.classList.add('visible'));
    });
  });
}

// ═══════════════════════════════════════════
// BODY LOCK (for overlays)
// ═══════════════════════════════════════════
function body_lock() { document.body.classList.add('detail-open'); }
function body_unlock() { document.body.classList.remove('detail-open'); }

// ═══════════════════════════════════════════
// RD SETTINGS (shared)
// ═══════════════════════════════════════════
const settingsToggle = document.getElementById('settingsToggle');
const settingsPanel = document.getElementById('settingsPanel');
const rdTokenInput = document.getElementById('rdTokenInput');
const rdSaveBtn = document.getElementById('rdSaveBtn');
const rdStatus = document.getElementById('rdStatus');
let rdConnected = false;

async function checkRdStatus() {
  try {
    const res = await fetch('/api/rd-token/status');
    const data = await res.json();
    rdConnected = data.connected;
    if (data.connected) {
      settingsToggle.classList.add('active-rd');
      rdStatus.textContent = `Connected as ${data.username} (${data.type})`;
      rdStatus.className = 'rd-status connected';
      rdTokenInput.value = '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022';
    } else {
      settingsToggle.classList.remove('active-rd');
      rdStatus.textContent = ''; rdTokenInput.value = '';
    }
  } catch { rdConnected = false; }
}
function hasRD() { return rdConnected; }

settingsToggle.addEventListener('click', () => settingsPanel.classList.toggle('open'));
rdSaveBtn.addEventListener('click', async () => {
  const token = rdTokenInput.value.trim();
  if (!token || token === '\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022') {
    await fetch('/api/rd-token', { method: 'DELETE' });
    rdConnected = false; settingsToggle.classList.remove('active-rd');
    rdStatus.textContent = 'Token removed.'; rdStatus.className = 'rd-status';
    rdTokenInput.value = ''; return;
  }
  rdStatus.textContent = 'Verifying...'; rdStatus.className = 'rd-status';
  try {
    await fetch('/api/rd-token', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token }) });
    await checkRdStatus();
    if (!rdConnected) { rdStatus.textContent = 'Invalid token.'; await fetch('/api/rd-token', { method: 'DELETE' }); }
  } catch { rdStatus.textContent = 'Could not verify.'; }
});
localStorage.removeItem('rd_token');
checkRdStatus();

// ═══════════════════════════════════════════
// FILMSTRIP DRAG SCROLL
// ═══════════════════════════════════════════
function enableDragScroll(el) {
  let isDown = false, startX, scrollLeft, moved = false;
  el.addEventListener('mousedown', (e) => {
    isDown = true; moved = false;
    el.style.cursor = 'grabbing';
    startX = e.pageX - el.offsetLeft;
    scrollLeft = el.scrollLeft;
  });
  el.addEventListener('mouseleave', () => { isDown = false; el.style.cursor = 'grab'; });
  el.addEventListener('mouseup', () => { isDown = false; el.style.cursor = 'grab'; });
  el.addEventListener('mousemove', (e) => {
    if (!isDown) return;
    e.preventDefault();
    const x = e.pageX - el.offsetLeft;
    const walk = (x - startX) * 1.5;
    if (Math.abs(walk) > 5) moved = true;
    el.scrollLeft = scrollLeft - walk;
  });
  el._dragMoved = () => moved;
}

// ═══════════════════════════════════════════
// VIDEO PLAYER — minimal custom controls
// ═══════════════════════════════════════════
const playerOverlay = document.getElementById('playerOverlay');
const playerVideo = document.getElementById('playerVideo');
const playerTitle = document.getElementById('playerTitle');
const playerProgress = document.getElementById('playerProgress');
const playerProgressFill = document.getElementById('playerProgressFill');
const playerPlayPause = document.getElementById('playerPlayPause');
const playerTime = document.getElementById('playerTime');
const playerVolumeSlider = document.getElementById('playerVolume');
const playerSubsBtn = document.getElementById('playerSubsBtn');
const playerSubsMenu = document.getElementById('playerSubsMenu');
const playerTimeTooltip = document.getElementById('playerTimeTooltip');
let hideUITimer = null;
let availableSubs = [];
let activeSubTrack = -1;

function fmtTime(s) {
  if (isNaN(s) || !isFinite(s)) return '0:00';
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec < 10 ? '0' : ''}${sec}`;
}

function showUI() {
  playerOverlay.classList.remove('hide-ui');
  clearTimeout(hideUITimer);
  hideUITimer = setTimeout(() => {
    if (!playerVideo.paused) playerOverlay.classList.add('hide-ui');
  }, 3000);
}

let currentStreamDirectUrl = '';
let currentStreamBaseUrl = '';  // base stream URL for seeking
let streamDuration = 0;        // total duration from ffprobe
let loadedSubCues = [];        // parsed subtitle cues [{start, end, text}]
let streamSeekOffset = 0;      // current seek offset in seconds
let isFFmpegStream = false;    // true when playing through FFmpeg

let transcodeRetried = false;

function openPlayer(url, title, directUrl) {
  playerTitle.textContent = title || '';
  currentStreamDirectUrl = directUrl || '';
  currentStreamBaseUrl = url;
  streamSeekOffset = 0;
  streamDuration = 0;
  isFFmpegStream = url.includes('/api/stream?url=') && (directUrl || '').toLowerCase().includes('.mkv');
  transcodeRetried = false;

  // Reset subs
  availableSubs = [];
  activeSubTrack = -1;
  loadedSubCues = [];
  playerSubsBtn.style.display = 'none';
  playerSubsMenu.classList.remove('open');
  playerSubsBtn.classList.remove('active-subs');

  // Fetch duration + subtitles from ffprobe
  if (directUrl) {
    fetch('/api/stream/probe?url=' + encodeURIComponent(directUrl))
      .then(r => r.json())
      .then(d => {
        if (d.duration > 0) streamDuration = d.duration;
        if (d.subtitles && d.subtitles.length > 0) {
          availableSubs = d.subtitles;
          playerSubsBtn.style.display = '';
        }
      })
      .catch(() => {});
  }

  playerVideo.src = url;
  playerOverlay.classList.add('open');
  document.body.style.overflow = 'hidden';
  playerPlayPause.innerHTML = '&#10074;&#10074;';
  showUI();

  function showPlaybackError() {
    const wrap = document.getElementById('playerVideoWrap');
    const dlLink = currentStreamDirectUrl || url.replace('/api/stream?url=', '');
    wrap.innerHTML = `
      <div style="text-align:center;color:#888;padding:2rem">
        <div style="font-size:1.5rem;margin-bottom:1rem">&#9888;</div>
        <div style="font-size:0.85rem;margin-bottom:0.5rem">Browser can't play this format</div>
        <div style="font-size:0.72rem;color:#555;margin-bottom:1.5rem">This file uses a codec your browser doesn't support (likely HEVC/MKV). Try downloading and playing in VLC.</div>
        <a href="${dlLink}" style="color:#F1EBE0;text-decoration:underline;font-size:0.8rem;letter-spacing:0.05em">DOWNLOAD FILE</a>
      </div>
    `;
  }

  let playbackCheckTimer = null;
  const LOTTIE_PLAYER = 'https://lottie.host/6411271b-d7df-41f5-bdfa-780c0e1e9276/fqD8TkeXOG.lottie';

  function showPlayerLoader(msg) {
    const wrap = document.getElementById('playerVideoWrap');
    let loaderEl = wrap.querySelector('.player-loading-overlay');
    if (!loaderEl) {
      loaderEl = document.createElement('div');
      loaderEl.className = 'player-loading-overlay';
      wrap.style.position = 'relative';
      wrap.appendChild(loaderEl);
    }
    loaderEl.innerHTML = `
      <dotlottie-wc src="${LOTTIE_PLAYER}" autoplay loop style="width:120px;height:120px"></dotlottie-wc>
      <div class="player-loading-text">${msg || 'Loading...'}</div>
    `;
  }

  function hidePlayerLoader() {
    const el = document.getElementById('playerVideoWrap')?.querySelector('.player-loading-overlay');
    if (el) el.remove();
  }

  // Compat aliases
  function showTranscodeStatus(msg) { showPlayerLoader(msg); }
  function clearTranscodeStatus() { hidePlayerLoader(); }

  function tryTranscode() {
    console.log('[player] tryTranscode called, retried:', transcodeRetried, 'readyState:', playerVideo.readyState);
    // Remux failed — retry with full transcode
    if (!transcodeRetried && url.includes('/api/stream?url=')) {
      transcodeRetried = true;
      console.log('[player] Retrying with transcode=1');
      playerTitle.textContent = (title || '') + ' (transcoding...)';
      showTranscodeStatus('Transcoding video... please wait');
      const transcodeUrl = url + '&transcode=1';
      playerVideo.src = transcodeUrl;
      playerVideo.load();
      playerVideo.play().catch(() => {});
      // New longer stall timer for transcode
      clearTimeout(playbackCheckTimer);
      playbackCheckTimer = setTimeout(() => {
        console.log('[player] Transcode stall timeout, readyState:', playerVideo.readyState);
        if (playerVideo.readyState < 3 && playerVideo.currentTime === 0) {
          showPlaybackError();
        }
      }, 45000);
      return;
    }
    console.log('[player] Showing playback error');
    showPlaybackError();
  }

  playerVideo.onerror = (e) => {
    console.log('[player] onerror fired:', e, 'error code:', playerVideo.error?.code, 'msg:', playerVideo.error?.message);
    tryTranscode();
  };
  // Stall detection — 15s for FFmpeg remux to start piping data
  playbackCheckTimer = setTimeout(() => {
    console.log('[player] Stall timeout 15s, readyState:', playerVideo.readyState, 'currentTime:', playerVideo.currentTime);
    if (playerVideo.readyState < 3 && playerVideo.currentTime === 0) {
      tryTranscode();
    }
  }, 15000);
  showTranscodeStatus('Preparing stream...');

  playerVideo.addEventListener('loadeddata', () => {
    clearTimeout(playbackCheckTimer);
    hidePlayerLoader();
  });
  playerVideo.addEventListener('playing', () => {
    clearTimeout(playbackCheckTimer);
    hidePlayerLoader();
    if (transcodeRetried) playerTitle.textContent = title || '';
  });
  // Show loader during buffering/seeking
  playerVideo.addEventListener('waiting', () => showPlayerLoader('Buffering...'));
  playerVideo.addEventListener('canplay', () => hidePlayerLoader());
}

function closePlayer() {
  const wrap = document.getElementById('playerVideoWrap');
  // Clear loading overlay
  const loaderEl = wrap.querySelector('.player-loading-overlay');
  if (loaderEl) loaderEl.remove();
  // Clear subtitle overlay
  const subOv = document.getElementById('playerSubOverlay');
  if (subOv) subOv.remove();
  loadedSubCues = [];
  if (!wrap.querySelector('video')) {
    wrap.innerHTML = '<video id="playerVideo" autoplay playsinline></video>';
  }
  const vid = wrap.querySelector('video');
  vid.pause();
  vid.removeAttribute('src');
  vid.load();
  playerOverlay.classList.remove('open', 'hide-ui');
  document.body.style.overflow = '';
  clearTimeout(hideUITimer);
  isFFmpegStream = false;
  streamSeekOffset = 0;
  streamDuration = 0;
}

document.getElementById('playerBack').addEventListener('click', closePlayer);

playerPlayPause.addEventListener('click', () => {
  if (playerVideo.paused) { playerVideo.play(); playerPlayPause.innerHTML = '&#10074;&#10074;'; }
  else { playerVideo.pause(); playerPlayPause.innerHTML = '&#9654;&#xFE0E;'; }
});

document.getElementById('playerVideoWrap').addEventListener('click', (e) => {
  if (e.target === playerVideo || e.target.id === 'playerVideoWrap') {
    if (playerVideo.paused) { playerVideo.play(); playerPlayPause.innerHTML = '&#10074;&#10074;'; }
    else { playerVideo.pause(); playerPlayPause.innerHTML = '&#9654;&#xFE0E;'; }
  }
});

function seekByOffset(delta) {
  if (isFFmpegStream && streamDuration > 0) {
    const newTime = Math.max(0, Math.min(streamDuration, streamSeekOffset + playerVideo.currentTime + delta));
    streamSeekOffset = newTime;
    let seekUrl = currentStreamBaseUrl;
    const sep = seekUrl.includes('?') ? '&' : '?';
    seekUrl += sep + 'start=' + newTime.toFixed(1);
    if (transcodeRetried) seekUrl += '&transcode=1';
    playerVideo.src = seekUrl;
    playerVideo.load();
    playerVideo.play().catch(() => {});
  } else {
    playerVideo.currentTime = Math.max(0, playerVideo.currentTime + delta);
  }
}
document.getElementById('playerSkipBack').addEventListener('click', () => seekByOffset(-10));
document.getElementById('playerSkipFwd').addEventListener('click', () => seekByOffset(10));

playerVolumeSlider.addEventListener('input', () => { playerVideo.volume = parseFloat(playerVolumeSlider.value); });
document.getElementById('playerMute').addEventListener('click', () => {
  playerVideo.muted = !playerVideo.muted;
  document.getElementById('playerMute').innerHTML = playerVideo.muted ? '&#128263;' : '&#128264;';
});

document.getElementById('playerFullscreen').addEventListener('click', (e) => {
  e.stopPropagation();
  if (document.fullscreenElement) document.exitFullscreen();
  else playerOverlay.requestFullscreen().catch(() => {});
});

playerVideo.addEventListener('timeupdate', () => {
  const totalDur = isFFmpegStream && streamDuration > 0 ? streamDuration : playerVideo.duration;
  if (!totalDur) return;
  const actualTime = streamSeekOffset + playerVideo.currentTime;
  const pct = (actualTime / totalDur) * 100;
  playerProgressFill.style.width = pct + '%';
  playerTime.textContent = `${fmtTime(actualTime)} / ${fmtTime(totalDur)}`;

  // Buffer bar
  let bufferEl = playerProgress.querySelector('.player-progress-buffer');
  if (!bufferEl) {
    bufferEl = document.createElement('div');
    bufferEl.className = 'player-progress-buffer';
    playerProgress.insertBefore(bufferEl, playerProgressFill);
  }
  if (playerVideo.buffered.length > 0) {
    const bufferedEnd = playerVideo.buffered.end(playerVideo.buffered.length - 1);
    const bufferedActual = streamSeekOffset + bufferedEnd;
    const bufPct = (bufferedActual / totalDur) * 100;
    bufferEl.style.width = bufPct + '%';
  }
});

playerProgress.addEventListener('click', (e) => {
  const rect = playerProgress.getBoundingClientRect();
  const pct = (e.clientX - rect.left) / rect.width;

  if (isFFmpegStream && streamDuration > 0) {
    // Server-side seek: reload stream with ?start=X
    const seekTo = pct * streamDuration;
    streamSeekOffset = seekTo;
    let seekUrl = currentStreamBaseUrl;
    // Add start param
    const sep = seekUrl.includes('?') ? '&' : '?';
    seekUrl += sep + 'start=' + seekTo.toFixed(1);
    if (transcodeRetried) seekUrl += '&transcode=1';
    playerVideo.src = seekUrl;
    playerVideo.load();
    playerVideo.play().catch(() => {});
  } else {
    playerVideo.currentTime = pct * playerVideo.duration;
  }
});

playerVideo.addEventListener('pause', () => {
  playerPlayPause.innerHTML = '&#9654;&#xFE0E;';
  playerOverlay.classList.remove('hide-ui');
  clearTimeout(hideUITimer);
});
playerVideo.addEventListener('play', () => {
  playerPlayPause.innerHTML = '&#10074;&#10074;';
  showUI();
});

playerOverlay.addEventListener('mousemove', showUI);

document.addEventListener('keydown', (e) => {
  if (!playerOverlay.classList.contains('open')) return;
  if (e.key === 'Escape') { closePlayer(); return; }
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); playerPlayPause.click(); showUI(); }
  if (e.key === 'ArrowLeft' || e.key === 'j') { seekByOffset(-10); showUI(); }
  if (e.key === 'ArrowRight' || e.key === 'l') { seekByOffset(10); showUI(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); playerVideo.volume = Math.min(1, playerVideo.volume + 0.1); playerVolumeSlider.value = playerVideo.volume; showUI(); }
  if (e.key === 'ArrowDown') { e.preventDefault(); playerVideo.volume = Math.max(0, playerVideo.volume - 0.1); playerVolumeSlider.value = playerVideo.volume; showUI(); }
  if (e.key === 'm') { document.getElementById('playerMute').click(); showUI(); }
  if (e.key === 'f') { document.getElementById('playerFullscreen').click(); }
  if (e.key === 'c') { playerSubsBtn.click(); }
});

// ═══════════════════════════════════════════
// SUBTITLE TOGGLE
// ═══════════════════════════════════════════
// Parse WebVTT text into cue array
function parseWebVTT(text) {
  const cues = [];
  const blocks = text.replace(/\r\n/g, '\n').split('\n\n');
  for (const block of blocks) {
    const lines = block.trim().split('\n');
    for (let i = 0; i < lines.length; i++) {
      const timeMatch = lines[i].match(/(\d{0,2}:?\d{2}:\d{2}[.,]\d{3})\s*-->\s*(\d{0,2}:?\d{2}:\d{2}[.,]\d{3})/);
      if (timeMatch) {
        const start = parseVTTTime(timeMatch[1]);
        const end = parseVTTTime(timeMatch[2]);
        const text = lines.slice(i + 1).join('\n').replace(/<[^>]+>/g, '').trim();
        if (text) cues.push({ start, end, text });
        break;
      }
    }
  }
  return cues;
}

function parseVTTTime(t) {
  const parts = t.replace(',', '.').split(':');
  if (parts.length === 2) return parseFloat(parts[0]) * 60 + parseFloat(parts[1]);
  return parseFloat(parts[0]) * 3600 + parseFloat(parts[1]) * 60 + parseFloat(parts[2]);
}

// Subtitle overlay element
function getSubOverlay() {
  let el = document.getElementById('playerSubOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'playerSubOverlay';
    el.style.cssText = 'position:absolute;bottom:60px;left:50%;transform:translateX(-50%);max-width:80%;text-align:center;color:#fff;font-size:1.1rem;line-height:1.5;text-shadow:0 1px 4px rgba(0,0,0,0.9),0 0 2px #000;pointer-events:none;z-index:15;background:rgba(0,0,0,0.5);padding:4px 12px;border-radius:4px;display:none';
    document.getElementById('playerVideoWrap').appendChild(el);
  }
  return el;
}

// Update subtitle display on timeupdate
playerVideo.addEventListener('timeupdate', () => {
  if (activeSubTrack === -1 || loadedSubCues.length === 0) {
    const ov = document.getElementById('playerSubOverlay');
    if (ov) ov.style.display = 'none';
    return;
  }
  const t = streamSeekOffset + playerVideo.currentTime;
  const cue = loadedSubCues.find(c => t >= c.start && t <= c.end);
  const ov = getSubOverlay();
  if (cue) {
    ov.textContent = cue.text;
    ov.style.display = '';
  } else {
    ov.style.display = 'none';
  }
});

playerSubsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  playerSubsMenu.classList.toggle('open');
  if (playerSubsMenu.classList.contains('open')) {
    playerSubsMenu.innerHTML = '';
    // Off option
    const offBtn = document.createElement('button');
    offBtn.className = 'player-subs-option' + (activeSubTrack === -1 ? ' active-sub' : '');
    offBtn.textContent = 'Off';
    offBtn.addEventListener('click', (ev) => {
      ev.stopPropagation();
      activeSubTrack = -1;
      loadedSubCues = [];
      playerSubsBtn.classList.remove('active-subs');
      playerSubsMenu.classList.remove('open');
      const ov = document.getElementById('playerSubOverlay');
      if (ov) ov.style.display = 'none';
    });
    playerSubsMenu.appendChild(offBtn);

    availableSubs.forEach((sub, i) => {
      const btn = document.createElement('button');
      btn.className = 'player-subs-option' + (activeSubTrack === i ? ' active-sub' : '');
      btn.textContent = sub.title;
      btn.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        activeSubTrack = i;
        playerSubsBtn.classList.add('active-subs');
        playerSubsMenu.classList.remove('open');
        // Fetch and parse subtitle
        try {
          const res = await fetch(`/api/stream/subs?url=${encodeURIComponent(currentStreamDirectUrl)}&track=${i}`);
          const vtt = await res.text();
          loadedSubCues = parseWebVTT(vtt);
        } catch { loadedSubCues = []; }
      });
      playerSubsMenu.appendChild(btn);
    });
  }
});

// Close subs menu on click outside
playerOverlay.addEventListener('click', () => {
  playerSubsMenu.classList.remove('open');
});

// ═══════════════════════════════════════════
// PROGRESS BAR TIME TOOLTIP
// ═══════════════════════════════════════════
playerProgress.addEventListener('mousemove', (e) => {
  const totalDur = isFFmpegStream && streamDuration > 0 ? streamDuration : playerVideo.duration;
  if (!totalDur) return;
  const rect = playerProgress.getBoundingClientRect();
  const pct = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
  const hoverTime = pct * totalDur;
  playerTimeTooltip.textContent = fmtTime(hoverTime);
  playerTimeTooltip.classList.add('visible');
  const tooltipWidth = playerTimeTooltip.offsetWidth;
  playerTimeTooltip.style.left = Math.max(rect.left, Math.min(rect.right - tooltipWidth, e.clientX - tooltipWidth / 2)) + 'px';
  playerTimeTooltip.style.top = (rect.top - 32) + 'px';
});

playerProgress.addEventListener('mouseleave', () => {
  playerTimeTooltip.classList.remove('visible');
});

// ═══════════════════════════════════════════
// TORRENT HTML HELPER
// ═══════════════════════════════════════════
function torrentItemHTML(t, rdActive) {
  const dlLabel = rdActive ? `DL<span class="rd-badge">RD</span>` : 'DL';
  const encodedMag = encodeURIComponent(t.magnet);
  const safeName = (t.name||'').replace(/'/g, "\\'");
  const streamBtn = rdActive ? `<button class="stream-btn" onclick="event.stopPropagation(); startStream('${encodedMag}', '${safeName}')">STREAM</button>` : '';
  return `
    <div class="torrent-item">
      <div class="torrent-info">
        <div class="torrent-name">${t.source ? `<span style="color:var(--text-muted);font-size:0.68rem">${t.source}</span> ` : ''}${t.name}</div>
        <div class="torrent-meta"><span>${t.size}</span><span class="seeds">${t.seeders} seeds</span>${t.released ? `<span>${t.released}</span>` : ''}</div>
      </div>
      <div class="btn-pair">
        ${streamBtn}
        <button class="dl-btn" onclick="event.stopPropagation(); startDownload('${encodedMag}', '${safeName}')">${dlLabel}</button>
      </div>
    </div>
  `;
}

// ═══════════════════════════════════════════
// NAVIGATE TO SEARCH (used from index.html)
// ═══════════════════════════════════════════
function navigateToSearch(query, cat) {
  window.location.href = `/search?q=${encodeURIComponent(query)}&cat=${encodeURIComponent(cat || 'all')}`;
}
