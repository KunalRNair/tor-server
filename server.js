const fs = require('fs');
const path = require('path');
const express = require('express');

// Webtorrent only supports ES Modules, so we must import it dynamically inside an async function
async function startServer() {
  const { default: WebTorrent } = await import('webtorrent');
  
  let TorrentAgent, Scraper;
  try {
     // Based on how torrent-agent is exported, we dynamically load it.
     const module = await import('torrent-agent');
     TorrentAgent = module.default || module.TorrentAgent;
     Scraper = module.Scraper;
  } catch (err) {
      console.error("Could not load torrent-agent. Did you run `npm install torrent-agent`?", err);
      process.exit(1);
  }

  // ----------------------------------------------------------------------
  // To avoid Cloudflare blocks and 30000ms timeouts on HTML scrapers, 
  // we can create a custom scraper using a JSON API explicitly for movies.
  // ----------------------------------------------------------------------
  class YTSScraper extends Scraper {
    constructor() {
      super({ name: "YTS/ApiBay Proxy Scraper" });
    }

    async firstTouch(query, limit) {
      const BEST_TRACKERS = [
        'udp://tracker.opentrackr.org:1337/announce',
        'udp://tracker.openbittorrent.com:6969/announce',
        'udp://tracker.torrent.eu.org:451/announce',
        'udp://tracker.moeking.me:6969/announce',
        'udp://tracker.zer0day.to:1337/announce',
        'udp://tracker.leechers-paradise.org:6969/announce',
        'udp://coppersurfer.tk:6969/announce',
        'udp://tracker.internetwarriors.net:1337/announce',
        'wss://tracker.btorrent.xyz',
        'wss://tracker.openwebtorrent.com',
        'wss://tracker.fastcast.nz'
      ];
      const trString = BEST_TRACKERS.map(tr => `&tr=${encodeURIComponent(tr)}`).join('');

      let links = [];
      const ytsDomains = ['yts.mx', 'yts.rs', 'yts.do', 'yts.proxyrar.org'];
      let success = false;

      console.log("Attempting to find an unblocked mirror...");

      // 1. Try various YTS mirrors first
      for (let domain of ytsDomains) {
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 sec timeout per domain
          
          const response = await fetch(`https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(query)}`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          const data = await response.json();

          if (data && data.data && data.data.movies) {
            for (let movie of data.data.movies) {
              if (movie.torrents && movie.torrents.length > 0) {
                let t = movie.torrents[0]; 
                links.push({
                  name: movie.title,
                  provider: "YTS",
                  url: movie.url,
                  seeders: t.seeds || 0,
                  leechers: t.peers || 0,
                  size: t.size || '0',
                  infoHash: t.hash,
                  magnetURI: `magnet:?xt=urn:btih:${t.hash}&dn=${encodeURIComponent(movie.title)}${trString}`
                });
              }
            }
          }
          success = true;
          console.log(`Success! Reached data via ${domain}`);
          break; // Stop looking, we found a working proxy!
        } catch (e) {
          console.log(`  -> Connection to ${domain} failed, attempting next mirror...`);
        }
      }

      // 2. We also scrape ApiBay (The Pirate Bay) concurrently for ultimate global coverage
      console.log("Fetching from ApiBay (The Pirate Bay) for extended results...");
        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          
          const response = await fetch(`https://apibay.org/q.php?q=${encodeURIComponent(query)}`, {
            signal: controller.signal
          });
          clearTimeout(timeoutId);

          const data = await response.json();
          // apibay returns a fake id "0" if nothing is found
          if (Array.isArray(data) && data.length > 0 && data[0].id !== "0") {
            for (let t of data) {
              links.push({
                name: t.name,
                provider: "ApiBay",
                url: "https://thepiratebay.org/description.php?id=" + t.id,
                seeders: parseInt(t.seeders) || 0,
                leechers: parseInt(t.leechers) || 0,
                size: t.size || '0',
                infoHash: t.info_hash,
                magnetURI: `magnet:?xt=urn:btih:${t.info_hash}&dn=${encodeURIComponent(t.name)}${trString}`
              });
            }
          }
          console.log(`Success! Reached data via ApiBay`);
        } catch (e) {
          console.error("ApiBay fallback also failed. Network might be heavily restricted.");
        }


      return links.slice(0, limit || 20);
    }

    async scrapeTorrent(link) {
      // YTS API gives us the exact magnet link inside firstTouch, so we just pass it along
      return {
        name: link.name,
        url: link.url,
        infoHash: link.infoHash,
        leechers: link.leechers,
        seeders: link.seeders,
        provider: link.provider,
        size: link.size,
        magnetURI: link.magnetURI
      };
    }
  }

  // Create a new WebTorrent client instance
  const client = new WebTorrent();
  client.on('error', err => console.error('WebTorrent client error:', err.message || err));

  // Create an instance of TorrentAgent
  const agent = new TorrentAgent();
  const movieScraper = new YTSScraper();

  // Create an Express app to handle HTTP requests
  const app = express();

  // Serve the premium Frontend UI from the "public" directory automatically
  app.use(express.static(path.join(__dirname, 'public')));

  // ----------------------------------------------------------------------
  // 1. Search for a movie and return a list of torrent matches
  // ----------------------------------------------------------------------
  app.get('/api/search', async (req, res) => {
    const movieName = req.query.movie;
    if (!movieName) return res.status(400).json({ error: 'Missing movie query param' });

    try {
      console.log(`Searching for movie: ${movieName}...`);

      const query = await agent.add({
        searchQuery: movieName,
        scrapers: [movieScraper],
        options: { limit: 10, concurrency: 1 },
      });

      let results = [];
      query.on('torrent', (torrent) => {
        const hashOrMagnet = torrent.magnetURI || torrent.infoHash;
        if (hashOrMagnet) {
          results.push({
            name: torrent.name,
            size: torrent.size,
            seeders: torrent.seeders,
            magnet: hashOrMagnet
          });
        }
      });

      query.on('done', () => {
         if (req.query.latest === 'true') {
            results.sort((a, b) => {
               const yearA = parseInt(a.name.match(/\((\d{4})\)/)?.[1] || 0, 10);
               const yearB = parseInt(b.name.match(/\((\d{4})\)/)?.[1] || 0, 10);
               return yearB - yearA;
            });
         }
         res.json({ results });
      });
      query.on('error', (err) => {
         console.error('Scraper Error:', err);
         if (!res.headersSent) res.status(500).json({ error: err.message });
      });
    } catch (e) {
      if(!res.headersSent) res.status(500).json({ error: e.message });
    }
  });

  // ----------------------------------------------------------------------
  // 2. Fetch the metadata to see internal files
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
  // 3. Initiate the raw download stream for a specific file index
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