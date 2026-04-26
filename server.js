const path = require('path');
const os = require('os');
const express = require('express');
const { spawn } = require('child_process');

// ── Server-side RD token (env var with fallback) ──
let RD_TOKEN = process.env.RD_TOKEN || '';

// ── URL validation (SSRF prevention) ──
function isValidStreamUrl(url) {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    // Block private/internal IPs
    const host = u.hostname;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return false;
    if (/^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(host)) return false;
    if (host === '0.0.0.0' || host.endsWith('.local')) return false;
    return true;
  } catch { return false; }
}

// ── Concurrent FFmpeg limiter ──
let activeFFmpeg = 0;
const MAX_FFMPEG = 2;

function getRdToken() { return RD_TOKEN; }

function setRdToken(token) { RD_TOKEN = token; }

function clearRdToken() { RD_TOKEN = ''; }

async function startServer() {
  const { default: WebTorrent } = await import('webtorrent');

  const client = new WebTorrent({
    dht: false,
    maxConns: 10,
    tracker: true,
  });
  client.on('error', err => console.error('WebTorrent client error:', err.message || err));

  const MAX_TORRENTS = 3;
  const METADATA_TIMEOUT_MS = 45_000;

  function extractInfoHash(magnet) {
    const m = magnet.match(/xt=urn:btih:([a-fA-F0-9]{40}|[A-Za-z2-7]{32})/);
    return m ? m[1].toLowerCase() : null;
  }

  function findExistingTorrent(magnet) {
    const hash = extractInfoHash(magnet);
    if (!hash) return null;
    return client.torrents.find(t => t.infoHash && t.infoHash.toLowerCase() === hash) || null;
  }

  function evictOldestIfNeeded() {
    while (client.torrents.length >= MAX_TORRENTS) {
      const oldest = client.torrents[0];
      console.log(`Evicting old torrent: ${oldest.infoHash}`);
      oldest.destroy({ destroyStore: true });
    }
  }

  function getTorrentReady(magnet) {
    return new Promise((resolve, reject) => {
      const existing = findExistingTorrent(magnet);

      const waitForMeta = (t) => {
        if (t.files && t.files.length > 0) return resolve(t);
        const timer = setTimeout(() => {
          reject(new Error('Metadata timeout. This torrent may have no seeders.'));
        }, METADATA_TIMEOUT_MS);
        t.once('metadata', () => { clearTimeout(timer); resolve(t); });
        t.once('error', (err) => { clearTimeout(timer); reject(err); });
      };

      if (existing) { waitForMeta(existing); return; }
      evictOldestIfNeeded();

      try {
        const added = client.add(magnet, { path: os.tmpdir() }, (t) => {
          t.files.forEach(f => f.deselect());
        });
        waitForMeta(added);
      } catch (err) {
        const raced = findExistingTorrent(magnet);
        if (raced) waitForMeta(raced);
        else reject(err);
      }
    });
  }

  const app = express();
  // Gzip compression for all responses
  try { const compression = require('compression'); app.use(compression()); } catch {}
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

  // Simple in-memory cache for catalog/search (1hr TTL)
  const apiCache = new Map();
  function cachedFetch(key, fetchFn, ttlMs = 3600000) {
    const cached = apiCache.get(key);
    if (cached && Date.now() - cached.ts < ttlMs) return Promise.resolve(cached.data);
    return fetchFn().then(data => { apiCache.set(key, { data, ts: Date.now() }); if (apiCache.size > 50) { const oldest = apiCache.keys().next().value; apiCache.delete(oldest); } return data; });
  }

  // ======================================================================
  // Real-Debrid Token Management (server-side storage)
  // ======================================================================
  app.post('/api/rd-token', (req, res) => {
    const { token } = req.body;
    if (!token || typeof token !== 'string' || token.length < 10) {
      return res.status(400).json({ error: 'Invalid token' });
    }
    setRdToken(token);
    res.json({ ok: true });
  });

  app.delete('/api/rd-token', (_req, res) => {
    clearRdToken();
    res.json({ ok: true });
  });

  app.get('/api/rd-token/status', async (_req, res) => {
    const token = getRdToken();
    if (!token) return res.json({ connected: false });
    try {
      const rdRes = await fetch('https://api.real-debrid.com/rest/1.0/user', {
        headers: { 'Authorization': 'Bearer ' + token }
      });
      const data = await rdRes.json();
      if (data.username) {
        res.json({ connected: true, username: data.username, type: data.type });
      } else {
        res.json({ connected: false });
      }
    } catch {
      res.json({ connected: false });
    }
  });

  // ======================================================================
  // Real-Debrid API Proxy (token is server-side, no client auth needed)
  // ======================================================================
  app.all('/api/rd/{*rdPath}', async (req, res) => {
    const rdPathRaw = req.params.rdPath;
    const rdPath = Array.isArray(rdPathRaw) ? rdPathRaw.join('/') : rdPathRaw;
    if (!rdPath) return res.status(400).json({ error: 'Missing RD API path' });

    const token = getRdToken();
    if (!token) return res.status(401).json({ error: 'No RD token configured' });

    const rdUrl = `https://api.real-debrid.com/rest/1.0/${rdPath}`;
    const fetchOpts = {
      method: req.method,
      headers: { 'Authorization': 'Bearer ' + token }
    };

    if (req.method === 'POST' && req.body && Object.keys(req.body).length > 0) {
      fetchOpts.headers['Content-Type'] = 'application/x-www-form-urlencoded';
      fetchOpts.body = Object.entries(req.body)
        .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
        .join('&');
    }

    try {
      const rdRes = await fetch(rdUrl, fetchOpts);

      // 204 No Content — return empty success
      if (rdRes.status === 204) {
        return res.status(204).end();
      }

      const text = await rdRes.text();
      if (!text) return res.status(rdRes.status).json({});

      const contentType = rdRes.headers.get('content-type') || '';
      if (contentType.includes('application/json')) {
        res.status(rdRes.status).json(JSON.parse(text));
      } else {
        res.status(rdRes.status).send(text);
      }
    } catch (e) {
      console.error('RD proxy error:', e.message);
      res.status(502).json({ error: 'Real-Debrid API error: ' + e.message });
    }
  });

  // ======================================================================
  // Catalog proxy (Cinemeta trending — handles redirects)
  // ======================================================================
  app.get('/api/catalog/:type/:catalogId', async (req, res) => {
    const { type, catalogId } = req.params;
    if (!['movie', 'series'].includes(type)) {
      return res.status(400).json({ error: 'Invalid type' });
    }
    if (!['top', 'year', 'imdbRating', 'last-videos'].includes(catalogId)) {
      return res.status(400).json({ error: 'Invalid catalog' });
    }
    try {
      const cacheKey = `catalog:${type}:${catalogId}`;
      const data = await cachedFetch(cacheKey, async () => {
        const cRes = await fetch(
          `https://v3-cinemeta.strem.io/catalog/${type}/${catalogId}.json`,
          { redirect: 'follow' }
        );
        return cRes.json();
      });
      res.json(data);
    } catch (e) {
      console.error('Catalog error:', e.message);
      res.status(502).json({ error: 'Catalog fetch failed' });
    }
  });

  // ======================================================================
  // TPB torrent search proxy (avoids CORS)
  // ======================================================================
  app.get('/api/search/tpb', async (req, res) => {
    const q = req.query.q;
    const cat = req.query.cat || '';
    if (!q) return res.status(400).json({ error: 'Missing query' });
    try {
      const url = cat
        ? `https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=${cat}`
        : `https://apibay.org/q.php?q=${encodeURIComponent(q)}`;
      const tpbRes = await fetch(url);
      const data = await tpbRes.json();
      res.json(data);
    } catch (e) {
      console.error('TPB search error:', e.message);
      res.status(502).json({ error: 'Search failed: ' + e.message });
    }
  });

  // Backward compat alias
  app.get('/api/search/adult', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query' });
    try {
      const tpbRes = await fetch(
        `https://apibay.org/q.php?q=${encodeURIComponent(q)}&cat=500`
      );
      const data = await tpbRes.json();
      res.json(data);
    } catch (e) {
      console.error('TPB search error:', e.message);
      res.status(502).json({ error: 'Search failed: ' + e.message });
    }
  });

  // ======================================================================
  // Nyaa.si search proxy (anime/hentai torrents — avoids CORS)
  // ======================================================================
  app.get('/api/search/nyaa', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query' });
    try {
      // Nyaa.si RSS feed returns XML, parse it for torrents
      // Using the sukebei (adult) subdomain for hentai, nyaa.si for regular anime
      const urls = [
        `https://sukebei.nyaa.si/?page=search&q=${encodeURIComponent(q)}&f=0&c=0_0&s=seeders&o=desc`,
      ];
      // Nyaa doesn't have a JSON API — scrape the RSS feed instead
      const rssUrl = `https://sukebei.nyaa.si/?page=rss&q=${encodeURIComponent(q)}&c=0_0&f=0`;
      const rssRes = await fetch(rssUrl, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      const rssText = await rssRes.text();

      // Parse RSS XML for items
      const items = [];
      const itemRegex = /<item>([\s\S]*?)<\/item>/g;
      let match;
      while ((match = itemRegex.exec(rssText)) !== null) {
        const block = match[1];
        const title = (block.match(/<title><!\[CDATA\[(.*?)\]\]>/)||block.match(/<title>(.*?)<\/title>/)||[])[1] || '';
        const link = (block.match(/<link>(.*?)<\/link>/)||[])[1] || '';
        const seeders = (block.match(/<nyaa:seeders>(\d+)<\/nyaa:seeders>/)||[])[1] || '0';
        const size = (block.match(/<nyaa:size>(.*?)<\/nyaa:size>/)||[])[1] || 'Unknown';
        const hash = (block.match(/<nyaa:infoHash>([a-fA-F0-9]+)<\/nyaa:infoHash>/)||[])[1] || '';
        if (title && hash) {
          items.push({ name: title, hash: hash.toLowerCase(), seeders, size, magnet: `magnet:?xt=urn:btih:${hash.toLowerCase()}&dn=${encodeURIComponent(title)}` });
        }
      }
      res.json(items.slice(0, 30));
    } catch (e) {
      console.error('Nyaa search error:', e.message);
      res.json([]);  // Return empty instead of error so other sources still work
    }
  });

  // ======================================================================
  // EZTV search proxy (TV series torrents by IMDB ID — avoids CORS)
  // ======================================================================
  app.get('/api/search/eztv', async (req, res) => {
    const imdb = req.query.imdb;
    if (!imdb) return res.status(400).json({ error: 'Missing imdb' });
    try {
      const imdbNum = imdb.replace('tt', '');
      const ezRes = await fetch(
        `https://eztvx.to/api/get-torrents?imdb_id=${imdbNum}&limit=30`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await ezRes.json();
      res.json(data);
    } catch (e) {
      console.error('EZTV search error:', e.message);
      res.json({ torrents: [] });
    }
  });

  // ======================================================================
  // YTS search proxy (avoids CORS — YTS domains block cross-origin)
  // ======================================================================
  const YTS_DOMAINS = ['yts.mx', 'yts.rs', 'yts.do'];
  app.get('/api/search/yts', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query' });
    for (const domain of YTS_DOMAINS) {
      try {
        const ytsRes = await fetch(
          `https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(q)}&limit=10`,
          { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) }
        );
        const data = await ytsRes.json();
        if (data?.data?.movies) return res.json(data);
      } catch {}
    }
    res.json({ data: { movies: [] } });
  });

  // ======================================================================
  // SolidTorrents search proxy (DHT index — avoids CORS)
  // ======================================================================
  app.get('/api/search/solid', async (req, res) => {
    const q = req.query.q;
    if (!q) return res.status(400).json({ error: 'Missing query' });
    try {
      const stRes = await fetch(
        `https://solidtorrents.to/api/v1/search?q=${encodeURIComponent(q)}&sort=seeders`,
        { headers: { 'User-Agent': 'Mozilla/5.0' } }
      );
      const data = await stRes.json();
      res.json(data);
    } catch (e) {
      console.error('SolidTorrents search error:', e.message);
      res.json({ results: [] });
    }
  });

  // ======================================================================
  // Stream proxy — pipes RD video URL through server to avoid CORS
  // ======================================================================
  app.get('/api/stream', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    if (!isValidStreamUrl(url)) return res.status(403).json({ error: 'Invalid URL' });
    const urlLower = url.toLowerCase();
    const isMKV = urlLower.includes('.mkv');
    const forceTranscode = req.query.transcode === '1';

    // MKV or forced transcode → pipe through FFmpeg remux/transcode
    if (isMKV || forceTranscode) {
      if (activeFFmpeg >= MAX_FFMPEG) return res.status(503).json({ error: 'Server busy — try again in a moment' });
      const startSec = parseFloat(req.query.start) || 0;
      console.log(`Stream+FFmpeg [${activeFFmpeg + 1}/${MAX_FFMPEG}]:`, url.slice(0, 80) + '...', startSec ? `seek=${startSec}s` : '');
      activeFFmpeg++;
      try {
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Transfer-Encoding', 'chunked');
        res.setHeader('Cache-Control', 'no-cache');

        // transcode=1 → full re-encode (guaranteed sync, heavy CPU)
        // default → copy video + transcode audio to AAC (light CPU, compatible)
        const fullTranscode = forceTranscode || req.query.transcode === '1';
        const ffArgs = [
          '-analyzeduration', '3000000',
          '-probesize', '3000000',
          ...(startSec > 0 ? ['-ss', String(startSec)] : []),
          '-i', url,
          '-movflags', 'frag_keyframe+empty_moov+faststart',
          '-frag_duration', '1000000',
          '-f', 'mp4',
          ...(fullTranscode
            ? ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23']
            : ['-c:v', 'copy']),
          '-c:a', 'aac', '-b:a', '192k',
          '-fflags', '+genpts+discardcorrupt',
          '-avoid_negative_ts', 'make_zero',
          '-async', '1',
          '-map', '0:v:0', '-map', '0:a:0',
          '-'
        ];

        const ff = spawn('ffmpeg', ffArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
        let stderrBuf = '';

        ff.stderr.on('data', (d) => { stderrBuf += d.toString(); });

        ff.stdout.pipe(res);

        ff.on('close', (code) => {
          activeFFmpeg = Math.max(0, activeFFmpeg - 1);
          if (code !== 0 && !res.writableEnded) {
            console.error('FFmpeg exit code:', code, stderrBuf.slice(-300));
          }
          if (!res.writableEnded) res.end();
        });

        req.on('close', () => {
          ff.kill('SIGKILL');
        });
      } catch (e) {
        activeFFmpeg = Math.max(0, activeFFmpeg - 1);
        console.error('FFmpeg stream error:', e.message);
        if (!res.headersSent) res.status(502).json({ error: 'Stream failed: ' + e.message });
      }
      return;
    }

    // Regular MP4/WebM — direct proxy
    console.log('Stream proxy:', url.slice(0, 80) + '...');
    try {
      const headers = {};
      if (req.headers.range) {
        headers['Range'] = req.headers.range;
      }
      const upstream = await fetch(url, { headers, redirect: 'follow' });

      res.status(upstream.status);
      const fwd = ['content-length', 'content-range', 'accept-ranges'];
      for (const h of fwd) {
        const val = upstream.headers.get(h);
        if (val) res.setHeader(h, val);
      }

      let ct = upstream.headers.get('content-type') || 'application/octet-stream';
      if (urlLower.includes('.mp4') || urlLower.includes('.m4v')) {
        ct = 'video/mp4';
      } else if (urlLower.includes('.webm')) {
        ct = 'video/webm';
      } else if (ct === 'application/octet-stream' || ct === 'application/force-download') {
        ct = 'video/mp4';
      }
      res.setHeader('Content-Type', ct);

      if (!upstream.headers.get('accept-ranges')) {
        res.setHeader('Accept-Ranges', 'bytes');
      }

      const reader = upstream.body.getReader();
      const pump = async () => {
        while (true) {
          const { done, value } = await reader.read();
          if (done) { res.end(); break; }
          if (!res.writableEnded) res.write(Buffer.from(value));
        }
      };
      pump().catch(err => {
        if (!/aborted|closed/i.test(err.message || '')) {
          console.error('Stream pipe error:', err.message);
        }
      });
      req.on('close', () => reader.cancel().catch(() => {}));
    } catch (e) {
      console.error('Stream proxy error:', e.message);
      if (!res.headersSent) res.status(502).json({ error: 'Stream failed: ' + e.message });
    }
  });

  // ======================================================================
  // FFprobe — get video duration for seekable progress bar
  // ======================================================================
  app.get('/api/stream/probe', async (req, res) => {
    const url = req.query.url;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    if (!isValidStreamUrl(url)) return res.status(403).json({ error: 'Invalid URL' });
    try {
      const ff = spawn('ffprobe', [
        '-v', 'quiet', '-print_format', 'json', '-show_format', '-show_streams',
        '-analyzeduration', '5000000', '-probesize', '5000000',
        '-i', url
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '';
      ff.stdout.on('data', d => { out += d.toString(); });
      ff.stderr.on('data', () => {});  // drain stderr
      ff.on('close', () => {
        try {
          const info = JSON.parse(out);
          const duration = parseFloat(info.format?.duration) || 0;
          // Filter out bitmap-based subs (PGS, DVD) — can't convert to text WebVTT
          const BITMAP_CODECS = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];
          const subs = (info.streams || [])
            .filter(s => s.codec_type === 'subtitle' && !BITMAP_CODECS.includes(s.codec_name))
            .map((s, i) => ({
              index: s.index,
              lang: s.tags?.language || `sub_${i}`,
              title: s.tags?.title || s.tags?.language || `Track ${i + 1}`,
              codec: s.codec_name
            }));
          res.json({ duration, subtitles: subs });
        } catch { res.json({ duration: 0, subtitles: [] }); }
      });
      setTimeout(() => ff.kill(), 20000);
    } catch { res.json({ duration: 0, subtitles: [] }); }
  });

  // ======================================================================
  // FFmpeg thumbnail extraction — single frame for timeline preview
  // ======================================================================
  // ======================================================================
  // Sprite sheet — all thumbnails in one image, generated once per stream
  // ======================================================================
  const spriteCache = new Map(); // key: url hash → { data, cols, rows, interval }
  let spriteGenerating = false;

  app.get('/api/stream/sprites', async (req, res) => {
    const url = req.query.url;
    const dur = parseFloat(req.query.dur) || 0;
    if (!url || dur <= 0) return res.status(400).end();

    // Cache check
    const cacheKey = url.slice(-60) + ':' + Math.floor(dur);
    if (spriteCache.has(cacheKey)) {
      const cached = spriteCache.get(cacheKey);
      res.setHeader('Content-Type', 'application/json');
      res.json({ cols: cached.cols, rows: cached.rows, interval: cached.interval, image: '/api/stream/sprites/img?k=' + encodeURIComponent(cacheKey) });
      return;
    }

    if (spriteGenerating) return res.status(429).json({ error: 'busy' });
    spriteGenerating = true;

    // Calculate interval: ~40-80 thumbnails
    const interval = dur < 600 ? 5 : dur < 3600 ? 10 : 30;
    const frameCount = Math.ceil(dur / interval);
    const cols = 10;
    const rows = Math.ceil(frameCount / cols);

    try {
      const headRes = await fetch(url, { method: 'HEAD', redirect: 'follow' });
      const finalUrl = headRes.url || url;

      const ff = spawn('ffmpeg', [
        '-i', finalUrl,
        '-vf', `fps=1/${interval},scale=160:90,tile=${cols}x${rows}`,
        '-frames:v', '1',
        '-q:v', '6',
        '-f', 'image2',
        '-update', '1',
        'pipe:1'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });

      const chunks = [];
      ff.stdout.on('data', (d) => chunks.push(d));
      ff.stderr.on('data', () => {});

      ff.on('close', (code) => {
        spriteGenerating = false;
        if (chunks.length > 0) {
          const imgBuf = Buffer.concat(chunks);
          spriteCache.set(cacheKey, { data: imgBuf, cols, rows, interval });
          // Limit cache to 3 entries
          if (spriteCache.size > 3) {
            const oldest = spriteCache.keys().next().value;
            spriteCache.delete(oldest);
          }
          if (!res.headersSent) {
            res.json({ cols, rows, interval, image: '/api/stream/sprites/img?k=' + encodeURIComponent(cacheKey) });
          }
        } else {
          if (!res.headersSent) res.status(500).json({ error: 'generation failed' });
        }
      });
      req.on('close', () => ff.kill('SIGKILL'));
      setTimeout(() => ff.kill(), 120000); // 2 min max
    } catch {
      spriteGenerating = false;
      if (!res.headersSent) res.status(500).end();
    }
  });

  // Serve cached sprite image
  app.get('/api/stream/sprites/img', (req, res) => {
    const k = req.query.k;
    const cached = spriteCache.get(k);
    if (!cached) return res.status(404).end();
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=600');
    res.end(cached.data);
  });

  // Extract subtitle track as WebVTT
  app.get('/api/stream/subs', async (req, res) => {
    const url = req.query.url;
    const track = parseInt(req.query.track) || 0;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    if (!isValidStreamUrl(url)) return res.status(403).json({ error: 'Invalid URL' });
    console.log(`[subs/extract] Track ${track} from ${url.slice(0, 60)}...`);
    try {
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      const ff = spawn('ffmpeg', [
        '-analyzeduration', '0',
        '-probesize', '50000000',
        '-i', url,
        '-map', `0:s:${track}`,
        '-f', 'webvtt',
        '-'
      ], { stdio: ['ignore', 'pipe', 'pipe'] });
      // Stream VTT as it comes — client parses incrementally
      ff.stdout.pipe(res);
      let stderrChunk = '';
      ff.stderr.on('data', (d) => { stderrChunk = d.toString().slice(-200); });
      ff.on('close', (code) => {
        console.log(`[subs/extract] FFmpeg exit code: ${code}${code !== 0 ? ' stderr: ' + stderrChunk : ''}`);
        if (!res.writableEnded) res.end();
      });
      req.on('close', () => ff.kill('SIGKILL'));
      setTimeout(() => { console.log('[subs/extract] 120s timeout — killing'); ff.kill(); }, 120000);
    } catch (e) {
      console.error('[subs/extract] Error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // ======================================================================
  // Subtitle search via Stremio OpenSubtitles addon (free, no auth)
  // ======================================================================
  app.get('/api/subs/search', async (req, res) => {
    const { imdb, type, season, episode } = req.query;
    if (!imdb) return res.json([]);
    try {
      const t = type || 'movie';
      // Series needs imdb:season:episode format for correct episode subs
      const subId = (t === 'series' && season && episode) ? `${imdb}:${season}:${episode}` : imdb;
      const r = await fetch(`https://opensubtitles-v3.strem.io/subtitles/${t}/${subId}.json`);
      const data = await r.json();
      // Group by language, take top results
      // Deduplicate: one sub per language, prefer first (highest rated)
      const seen = new Set();
      const subs = [];
      for (const s of (data.subtitles || [])) {
        if (!s.lang || !s.url) continue;
        if (seen.has(s.lang)) continue;
        seen.add(s.lang);
        subs.push({ id: s.id, lang: s.lang, url: s.url });
      }
      res.json(subs);
    } catch (e) {
      res.json([]);
    }
  });

  // Download + convert subtitle to WebVTT (proxied to avoid CORS)
  app.get('/api/subs/download', async (req, res) => {
    const { url } = req.query;
    if (!url) return res.status(400).json({ error: 'Missing url' });
    console.log('[subs/download] Fetching:', url.slice(0, 120));
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 10000);
      const subRes = await fetch(url, { redirect: 'follow', signal: ctrl.signal });
      clearTimeout(timer);
      console.log('[subs/download] Response:', subRes.status, 'type:', subRes.headers.get('content-type'));
      if (!subRes.ok) throw new Error(`Subtitle fetch failed: ${subRes.status}`);

      const buf = Buffer.from(await subRes.arrayBuffer());

      // Detect gzip (Stremio addon often serves .gz subs)
      let subText;
      if (buf[0] === 0x1f && buf[1] === 0x8b) {
        const { gunzipSync } = require('zlib');
        subText = gunzipSync(buf).toString('utf-8');
      } else {
        subText = buf.toString('utf-8');
      }

      // Convert SRT to WebVTT if needed
      let vtt = subText;
      if (!subText.trim().startsWith('WEBVTT')) {
        vtt = 'WEBVTT\n\n' + subText
          .replace(/\r\n/g, '\n')
          .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
      }
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.send(vtt);
    } catch (e) {
      console.error('[subs/download] Error:', e.message);
      if (!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // ======================================================================
  // WebTorrent fallback endpoints (used when RD token is not set)
  // ======================================================================
  app.get('/api/metadata', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet link' });
    console.log('Fetching metadata for magnet...');
    try {
      const torrent = await getTorrentReady(magnet);
      const files = torrent.files.map((f, index) => ({ name: f.name, sizeBytes: f.length, index }));
      console.log(`Metadata OK: ${files.length} files, peers=${torrent.numPeers}`);
      res.json({ files, peers: torrent.numPeers });
    } catch (e) {
      console.error('Metadata error:', e.message);
      if (!res.headersSent) res.status(504).json({ error: e.message });
    }
  });

  app.get('/api/download', async (req, res) => {
    const magnet = req.query.magnet;
    const fileIndex = parseInt(req.query.fileIndex, 10);
    if (!magnet || isNaN(fileIndex)) return res.status(400).send('Invalid request');
    console.log(`Download requested: index ${fileIndex}`);
    try {
      const torrent = await getTorrentReady(magnet);
      const file = torrent.files[fileIndex];
      if (!file) return res.status(404).send('File not found inside torrent');
      file.select();
      const safeName = file.name.replace(/[^\w\s.-]/g, '_');
      res.setHeader('Content-Length', file.length);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');
      const stream = file.createReadStream();
      stream.pipe(res);
      const cleanup = () => { if (!stream.destroyed) stream.destroy(); };
      req.on('close', cleanup);
      res.on('close', cleanup);
      stream.on('error', (err) => {
        if (!/closed prematurely|premature close/i.test(err.message || '')) {
          console.error('Stream error:', err.message);
        }
      });
    } catch (e) {
      console.error('Download error:', e.message);
      if (!res.headersSent) res.status(504).send('Error: ' + e.message);
    }
  });

  // ======================================================================
  // Clean URL routes — serve HTML pages for all client-side routes
  // ======================================================================
  app.get('/search', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'search.html'));
  });
  app.get('/detail/:type/:id', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'search.html'));
  });
  app.get('/watch', (req, res) => {
    // Player URL — served by whichever page the user came from (SPA catch-all handles it)
    res.sendFile(path.join(__dirname, 'public', 'search.html'));
  });
  // Catch-all for client-side routes (SPA fallback)
  app.get('/{*path}', (req, res) => {
    // Don't intercept API or static file requests
    if (req.path.startsWith('/api/') || req.path.includes('.')) return res.status(404).end();
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  });

  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
}

startServer().catch(err => console.error('Failed to start server:', err));
