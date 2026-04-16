const path = require('path');
const express = require('express');

// WebTorrent only supports ES Modules, so we must import it dynamically
async function startServer() {
  const { default: WebTorrent } = await import('webtorrent');

  // Create a new WebTorrent client instance — this is the ONLY job of the server now
  const client = new WebTorrent();
  client.on('error', err => console.error('WebTorrent client error:', err.message || err));

  const app = express();

  // Serve the Frontend UI (which now handles ALL search logic client-side)
  app.use(express.static(path.join(__dirname, 'public')));

  // ----------------------------------------------------------------------
  // 1. Fetch the metadata to see internal files
  // ----------------------------------------------------------------------
  app.get('/api/metadata', async (req, res) => {
    const magnet = req.query.magnet;
    if (!magnet) return res.status(400).json({ error: 'Missing magnet link' });

    console.log("Fetching metadata for magnet...");

    let t = await client.get(magnet);

    const respondFiles = (torrent) => {
       const files = torrent.files.map((f, index) => ({ name: f.name, sizeBytes: f.length, index }));
       if (!res.headersSent) res.json({ files });
    };

    if (t) {
        if (t.files && t.files.length > 0) {
           respondFiles(t);
        } else {
           t.on('metadata', () => respondFiles(t));
        }
    } else {
        client.add(magnet, { path: __dirname }, (newT) => {
           newT.files.forEach(file => file.deselect());
           respondFiles(newT);
        });
    }
  });

  // ----------------------------------------------------------------------
  // 2. Initiate the raw download stream for a specific file index
  // ----------------------------------------------------------------------
  app.get('/api/download', async (req, res) => {
    const magnet = req.query.magnet;
    const fileIndex = parseInt(req.query.fileIndex, 10);
    
    if (!magnet || isNaN(fileIndex)) return res.status(400).send('Invalid request');

    console.log(`Requested download for index ${fileIndex}`);

    let t = await client.get(magnet);
    
    const startStream = (torrent) => {
       const file = torrent.files[fileIndex];
       if (!file) return res.status(404).send('File not found inside torrent');
       
       res.setHeader('Content-Length', file.length);
       res.setHeader('Content-Disposition', `attachment; filename="${file.name}"`);
       res.setHeader('Content-Type', 'application/octet-stream');
       
       const stream = file.createReadStream();
       stream.pipe(res);
       stream.on('error', (err) => console.error("Stream piping error:", err));
    };

    if (t) {
        if (t.files && t.files.length > 0) {
            startStream(t);
        } else {
            let started = false;
            t.on('metadata', () => { if (!started) { started = true; startStream(t); } });
        }
    } else {
        client.add(magnet, { path: __dirname }, (newT) => {
            startStream(newT);
        });
    }
  });

  // Start the Express server on port 3000
  app.listen(3000, () => {
    console.log('Server listening on port 3000');
    console.log('Visit http://localhost:3000 in your browser to start downloading.');
  });
}

// Start the application
startServer().catch(err => {
  console.error("Failed to start server:", err);
});