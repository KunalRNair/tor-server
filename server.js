const path = require('path');
const os = require('os');
const express = require('express');

// WebTorrent only supports ES Modules, so we must import it dynamically
async function startServer() {
  const { default: WebTorrent } = await import('webtorrent');

  // Render limits us to ~75 open ports. DHT opens a new UDP socket per torrent
  // and eats the budget fast. We disable DHT because the client already bakes
  // 11 trackers into every magnet URL, so peer discovery still works fine.
  const client = new WebTorrent({
    dht: false,
    maxConns: 30,
    tracker: true,
  });
  client.on('error', err => console.error('WebTorrent client error:', err.message || err));

  // Cap concurrent torrents so we don't leak ports/disk over time.
  const MAX_TORRENTS = 3;
  const METADATA_TIMEOUT_MS = 45_000;

  // Some browsers (and re-clicks) call /api/metadata then /api/download for
  // the same magnet. WebTorrent throws if the same magnet is added twice, so
  // we always look up by infoHash first.
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

  // Returns a promise that resolves with a torrent that has metadata loaded.
  // Rejects with a helpful error if it takes too long (dead swarm).
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

      if (existing) {
        waitForMeta(existing);
        return;
      }

      evictOldestIfNeeded();

      try {
        const added = client.add(magnet, { path: os.tmpdir() }, (t) => {
          t.files.forEach(f => f.deselect()); // don't auto-download everything
        });
        waitForMeta(added);
      } catch (err) {
        // Race: another request added it between our check and add().
        const raced = findExistingTorrent(magnet);
        if (raced) waitForMeta(raced);
        else reject(err);
      }
    });
  }

  const app = express();
  app.use(express.static(path.join(__dirname, 'public')));

  // ----------------------------------------------------------------------
  // 1. Fetch the metadata to see internal files
  // ----------------------------------------------------------------------
  app.get('/api/metadata', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet link' });

    console.log('Fetching metadata for magnet...');

    try {
      const torrent = await getTorrentReady(magnet);
      const files = torrent.files.map((f, index) => ({
        name: f.name,
        sizeBytes: f.length,
        index,
      }));
      console.log(`Metadata OK: ${files.length} files, peers=${torrent.numPeers}`);
      res.json({ files, peers: torrent.numPeers });
    } catch (e) {
      console.error('Metadata error:', e.message);
      if (!res.headersSent) res.status(504).json({ error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // 2. Initiate the raw download stream for a specific file index
  // ----------------------------------------------------------------------
  app.get('/api/download', async (req, res) => {
    const magnet = req.query.magnet;
    const fileIndex = parseInt(req.query.fileIndex, 10);

    if (!magnet || isNaN(fileIndex)) return res.status(400).send('Invalid request');
    console.log(`Download requested: index ${fileIndex}`);

    try {
      const torrent = await getTorrentReady(magnet);
      const file = torrent.files[fileIndex];
      if (!file) return res.status(404).send('File not found inside torrent');

      file.select(); // prioritize pieces for this file

      // Safe filename for Content-Disposition header
      const safeName = file.name.replace(/[^\w\s.-]/g, '_');
      res.setHeader('Content-Length', file.length);
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
      res.setHeader('Content-Type', 'application/octet-stream');

      const stream = file.createReadStream();
      stream.pipe(res);

      const cleanup = () => {
        if (!stream.destroyed) stream.destroy();
      };
      req.on('close', cleanup);
      res.on('close', cleanup);

      stream.on('error', (err) => {
        // "Writable stream closed prematurely" just means the client
        // disconnected (closed tab, lost network). Not a real error.
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
    console.log('Visit http://localhost:3000 in your browser to start downloading.');
  });
}

startServer().catch(err => {
  console.error('Failed to start server:', err);
});
