const path = require('path');
const fs = require('fs');
const os = require('os');
const express = require('express');

// ── Server-side RD token storage ──
const RD_TOKEN_FILE = path.join(__dirname, '.rd_token');

function getRdToken() {
  try { return fs.readFileSync(RD_TOKEN_FILE, 'utf8').trim(); } catch { return ''; }
}

function setRdToken(token) {
  fs.writeFileSync(RD_TOKEN_FILE, token, 'utf8');
}

function clearRdToken() {
  try { fs.unlinkSync(RD_TOKEN_FILE); } catch {}
}

async function startServer() {
  const { default: WebTorrent } = await import('webtorrent');

  const client = new WebTorrent({
    dht: false,
    maxConns: 30,
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
  app.use(express.static(path.join(__dirname, 'public')));
  app.use(express.json());

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
    const rdPath = req.params.rdPath;
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
      fetchOpts.body = new URLSearchParams(req.body).toString();
    }

    try {
      const rdRes = await fetch(rdUrl, fetchOpts);
      const contentType = rdRes.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        const data = await rdRes.json();
        res.status(rdRes.status).json(data);
      } else {
        const text = await rdRes.text();
        res.status(rdRes.status).send(text);
      }
    } catch (e) {
      console.error('RD proxy error:', e.message);
      res.status(502).json({ error: 'Real-Debrid API error: ' + e.message });
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

  app.listen(3000, () => {
    console.log('Server listening on port 3000');
  });
}

startServer().catch(err => console.error('Failed to start server:', err));
