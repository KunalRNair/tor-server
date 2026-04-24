// ═══════════════════════════════════════════
// RD API HELPER
// ═══════════════════════════════════════════
async function rdAPI(method, rdPath, body) {
  const opts = { method, headers: {} };
  if (body) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
  const res = await fetch('/api/rd/' + rdPath, opts);
  if (res.status === 204) return {};
  if (!res.ok) { const err = await res.json().catch(() => ({})); throw new Error(err.error || `RD error (${res.status})`); }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

// ═══════════════════════════════════════════
// TRACKERS & SOURCES
// ═══════════════════════════════════════════
const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce','udp://tracker.openbittorrent.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce','udp://tracker.moeking.me:6969/announce',
  'wss://tracker.btorrent.xyz','wss://tracker.openwebtorrent.com'
];
const trString = TRACKERS.map(tr => '&tr=' + encodeURIComponent(tr)).join('');
const TORRENTIO_PROVIDERS = 'providers=yts,eztv,rarbg,1337x,thepiratebay,kickasstorrents,torrentgalaxy,magnetdl,horriblesubs,nyaasi,tokyotosho,anidex';
const TORRENTIO_BASE = `https://torrentio.strem.fun/${TORRENTIO_PROVIDERS}`;
const YTS_DOMAINS = ['yts.mx', 'yts.rs', 'yts.do'];

async function safeFetchJSON(url, timeoutMs = 8000) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    const res = await fetch(url, { signal: ctrl.signal });
    clearTimeout(timer);
    const text = await res.text();
    if (text.trim().startsWith('<')) return null;
    return JSON.parse(text);
  } catch { return null; }
}

function fmtDate(unix) {
  if (!unix) return '';
  const d = new Date(unix * 1000);
  if (isNaN(d.getTime())) return '';
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
}

function parseTorrentioStreams(streams) {
  const out = [];
  for (const s of streams) {
    if (!s.infoHash) continue;
    let seeders = 0, size = 'Unknown', released = '';
    if (s.title) {
      const sm = s.title.match(/\u{1F464}\s*(\d+)/u); if (sm) seeders = parseInt(sm[1], 10);
      const szm = s.title.match(/\u{1F4BE}\s*([^\u2699\n]+)/u); if (szm) size = szm[1].trim();
      const dm = s.title.match(/\u{1F4C5}\s*([^\n]+)/u); if (dm) released = dm[1].trim();
      if (!released) { const dm2 = s.title.match(/(\d{4}-\d{2}-\d{2})/); if (dm2) released = dm2[1]; }
    }
    const name = (s.title || '').split('\n')[0];
    const source = (s.name || '').split('\n')[0];
    out.push({ name, source, size, seeders, released, infoHash: s.infoHash.toLowerCase(),
      magnet: `magnet:?xt=urn:btih:${s.infoHash}&dn=${encodeURIComponent(name)}${trString}` });
  }
  return out;
}

// ═══════════════════════════════════════════
// SEARCH
// ═══════════════════════════════════════════
async function executeSearch() {
  const query = input.value.trim();
  if (!query) return;
  showOverlay('Searching', 'Finding the best sources.');

  try {
    const seMatch = query.match(/s(\d{1,2})e(\d{1,2})/i);
    const reqS = seMatch ? parseInt(seMatch[1], 10) : null;
    const reqE = seMatch ? parseInt(seMatch[2], 10) : null;
    const cleanQ = query.replace(/s\d{1,2}e\d{1,2}/i, '').trim();
    const cat = activeCategory;

    // Adult search (TPB cat 500 + SolidTorrents)
    if (cat === 'porn') {
      const [tpbData, solidData] = await Promise.all([
        safeFetchJSON(`/api/search/adult?q=${encodeURIComponent(cleanQ)}`),
        safeFetchJSON(`/api/search/solid?q=${encodeURIComponent(cleanQ + ' xxx')}`)
      ]);
      let results = [];
      const seen = new Set();
      if (tpbData && tpbData.length > 0 && tpbData[0]?.name !== 'No results returned') {
        for (const t of tpbData) {
          const hash = (t.info_hash || '').toLowerCase();
          if (!hash || seen.has(hash)) continue;
          seen.add(hash);
          const sz = parseInt(t.size, 10) || 0;
          results.push({ name: t.name, source: 'TPB', size: sz > 1073741824 ? (sz/1073741824).toFixed(2)+' GB' : (sz/1048576).toFixed(1)+' MB',
            seeders: parseInt(t.seeders, 10) || 0, released: fmtDate(parseInt(t.added, 10)), infoHash: hash,
            magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.name)}${trString}` });
        }
      }
      if (solidData?.results?.length) {
        for (const t of solidData.results) {
          const hash = (t.infohash || '').toLowerCase();
          if (!hash || seen.has(hash)) continue;
          seen.add(hash);
          results.push({ name: t.title, source: 'Solid', size: t.size ? (t.size > 1073741824 ? (t.size/1073741824).toFixed(2)+' GB' : (t.size/1048576).toFixed(1)+' MB') : 'Unknown',
            seeders: t.swarm?.seeders || 0, infoHash: hash,
            magnet: t.magnet || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.title)}${trString}` });
        }
      }
      if (results.length === 0) throw new Error("No results found.");
      results.sort((a,b) => b.seeders - a.seeders);
      showFlatResults(results, cleanQ);
      return;
    }

    // Hentai search (TPB adult + nyaa.si anime)
    if (cat === 'hentai') {
      const hentaiQ = cleanQ.toLowerCase().includes('hentai') ? cleanQ : cleanQ + ' hentai';
      const [tpbData, nyaaData] = await Promise.all([
        safeFetchJSON(`/api/search/adult?q=${encodeURIComponent(hentaiQ)}`),
        safeFetchJSON(`/api/search/nyaa?q=${encodeURIComponent(cleanQ)}`)
      ]);
      let results = [];
      if (tpbData && tpbData.length > 0 && tpbData[0]?.name !== 'No results returned') {
        results.push(...tpbData.map(t => {
          const hash = (t.info_hash || '').toLowerCase();
          const sz = parseInt(t.size, 10) || 0;
          return { name: t.name, source: 'TPB', size: sz > 1073741824 ? (sz/1073741824).toFixed(2)+' GB' : (sz/1048576).toFixed(1)+' MB',
            seeders: parseInt(t.seeders, 10) || 0, released: fmtDate(parseInt(t.added, 10)), infoHash: hash,
            magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.name)}${trString}` };
        }));
      }
      if (nyaaData && nyaaData.length > 0) {
        results.push(...nyaaData.map(t => {
          const hash = (t.hash || '').toLowerCase();
          return { name: t.name, source: 'Nyaa', size: t.size || 'Unknown',
            seeders: parseInt(t.seeders, 10) || 0, infoHash: hash,
            magnet: t.magnet || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.name)}${trString}` };
        }));
      }
      if (results.length === 0) throw new Error("No results found.");
      results.sort((a,b) => b.seeders - a.seeders);
      showFlatResults(results, cleanQ);
      return;
    }

    // Cinemeta search
    const searchMovie = cat === 'all' || cat === 'movie';
    const searchSeries = cat === 'all' || cat === 'series' || !!reqS;
    const [movieMeta, seriesMeta] = await Promise.all([
      searchMovie ? safeFetchJSON(`https://v3-cinemeta.strem.io/catalog/movie/top/search=${encodeURIComponent(cleanQ)}.json`) : null,
      searchSeries ? safeFetchJSON(`https://v3-cinemeta.strem.io/catalog/series/top/search=${encodeURIComponent(cleanQ)}.json`) : null,
    ]);
    const sMetas = ((seriesMeta?.metas) || []).slice(0, 20);
    const mMetas = (reqS || cat === 'series') ? [] : ((movieMeta?.metas) || []).slice(0, 20);
    const allMetas = [...sMetas, ...mMetas];

    const fetchPromises = allMetas.map(async (meta) => {
      const imdbId = meta.imdb_id || meta.id;
      if (!imdbId) return null;
      if (meta.type === 'series') {
        if (reqS && reqE) {
          const [torData, ezData] = await Promise.all([
            safeFetchJSON(`${TORRENTIO_BASE}/stream/series/${imdbId}:${reqS}:${reqE}.json`),
            safeFetchJSON(`/api/search/eztv?imdb=${imdbId}`)
          ]);
          let torrents = torData?.streams ? parseTorrentioStreams(torData.streams) : [];
          if (ezData?.torrents?.length) {
            const seen = new Set(torrents.map(t => t.infoHash));
            for (const et of ezData.torrents) {
              if (!et.hash) continue;
              const hash = et.hash.toLowerCase();
              if (seen.has(hash)) continue;
              if (parseInt(et.season) !== reqS || parseInt(et.episode) !== reqE) continue;
              seen.add(hash);
              const sz = et.size_bytes > 1073741824 ? (et.size_bytes/1073741824).toFixed(2)+' GB' : (et.size_bytes/1048576).toFixed(1)+' MB';
              torrents.push({ name: et.title || et.filename, source: 'EZTV', size: sz, seeders: et.seeds || 0,
                released: et.date_released_unix ? fmtDate(et.date_released_unix) : '', infoHash: hash,
                magnet: et.magnet_url || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(et.title || '')}${trString}` });
            }
          }
          return { meta, episodes: [{ season: reqS, episode: reqE, torrents }] };
        } else {
          const detail = await safeFetchJSON(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
          const videos = detail?.meta?.videos || [];
          const allEps = videos.filter(v => v.season && v.episode).sort((a,b) => a.season - b.season || a.episode - b.episode);
          if (allEps.length === 0) allEps.push({ season: 1, episode: 1 });
          // Group by season
          const seasons = {};
          for (const ep of allEps) {
            if (!seasons[ep.season]) seasons[ep.season] = [];
            seasons[ep.season].push({ season: ep.season, episode: ep.episode, name: ep.name || '' });
          }
          return { meta, seasons, imdbId, episodes: [] };
        }
      } else {
        const torData = await safeFetchJSON(`${TORRENTIO_BASE}/stream/movie/${imdbId}.json`);
        const torrents = torData?.streams ? parseTorrentioStreams(torData.streams) : [];
        return { meta, torrents };
      }
    });

    const ytsPromise = cat === 'series' ? Promise.resolve([]) : (async () => {
      for (const domain of YTS_DOMAINS) {
        const data = await safeFetchJSON(`https://${domain}/api/v2/list_movies.json?query_term=${encodeURIComponent(cleanQ)}&limit=10`, 5000);
        if (data?.data?.movies) return data.data.movies;
      }
      return [];
    })();

    const [ytsMovies, ...groups] = await Promise.all([ytsPromise, ...fetchPromises]);

    const validGroups = groups.filter(Boolean);
    if (ytsMovies.length > 0) {
      const movieGroup = validGroups.find(g => g.meta.type === 'movie');
      if (movieGroup && movieGroup.torrents) {
        const seen = new Set(movieGroup.torrents.map(t => t.infoHash));
        for (const movie of ytsMovies) {
          for (const t of (movie.torrents || [])) {
            const hash = (t.hash || '').toLowerCase();
            if (hash && !seen.has(hash)) {
              seen.add(hash);
              movieGroup.torrents.push({ name: `${movie.title} (${movie.year}) [${t.quality}]`, source: 'YTS',
                size: t.size || 'Unknown', seeders: t.seeds || 0, released: fmtDate(t.date_uploaded_unix || movie.date_uploaded_unix), infoHash: hash,
                magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(movie.title)}${trString}` });
            }
          }
        }
      }
    }

    if (validGroups.length === 0 || validGroups.every(g => (g.torrents?.length || 0) === 0 && (g.episodes?.length || 0) === 0 && !g.seasons)) {
      // Fallback: TPB + SolidTorrents + 1337x direct search
      const [tpbData, solidData] = await Promise.all([
        safeFetchJSON(`/api/search/tpb?q=${encodeURIComponent(cleanQ)}`),
        safeFetchJSON(`/api/search/solid?q=${encodeURIComponent(cleanQ)}`)
      ]);
      let results = [];
      const seen = new Set();
      if (tpbData && tpbData.length > 0 && tpbData[0]?.name !== 'No results returned') {
        for (const t of tpbData) {
          const hash = (t.info_hash || '').toLowerCase();
          if (!hash || seen.has(hash)) continue;
          seen.add(hash);
          const sz = parseInt(t.size, 10) || 0;
          results.push({ name: t.name, source: 'TPB', size: sz > 1073741824 ? (sz/1073741824).toFixed(2)+' GB' : (sz/1048576).toFixed(1)+' MB',
            seeders: parseInt(t.seeders, 10) || 0, released: fmtDate(parseInt(t.added, 10)), infoHash: hash,
            magnet: `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.name)}${trString}` });
        }
      }
      if (solidData?.results?.length) {
        for (const t of solidData.results) {
          const hash = (t.infohash || '').toLowerCase();
          if (!hash || seen.has(hash)) continue;
          seen.add(hash);
          results.push({ name: t.title, source: 'Solid', size: t.size ? (t.size > 1073741824 ? (t.size/1073741824).toFixed(2)+' GB' : (t.size/1048576).toFixed(1)+' MB') : 'Unknown',
            seeders: t.swarm?.seeders || 0, infoHash: hash,
            magnet: t.magnet || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(t.title)}${trString}` });
        }
      }
      if (results.length > 0) {
        results.sort((a,b) => b.seeders - a.seeders);
        showFlatResults(results, cleanQ);
        return;
      }
      throw new Error("No results found. Try different keywords.");
    }

    showGroupedResults(validGroups);
  } catch (e) {
    setLoadingText('No Results');
    setLoadingSubtext(e.message);
    setTimeout(() => hideOverlay(), 3000);
  }
}

// ═══════════════════════════════════════════
// LAZY EPISODE TORRENT FETCH
// ═══════════════════════════════════════════
async function fetchEpisodeTorrents(imdbId, season, episode) {
  const [torData, ezData] = await Promise.all([
    safeFetchJSON(`${TORRENTIO_BASE}/stream/series/${imdbId}:${season}:${episode}.json`),
    safeFetchJSON(`/api/search/eztv?imdb=${imdbId}`)
  ]);
  let torrents = torData?.streams ? parseTorrentioStreams(torData.streams) : [];
  if (ezData?.torrents?.length) {
    const seen = new Set(torrents.map(t => t.infoHash));
    for (const et of ezData.torrents) {
      if (!et.hash) continue;
      const hash = et.hash.toLowerCase();
      if (seen.has(hash)) continue;
      if (parseInt(et.season) !== season || parseInt(et.episode) !== episode) continue;
      seen.add(hash);
      const sz = et.size_bytes > 1073741824 ? (et.size_bytes/1073741824).toFixed(2)+' GB' : (et.size_bytes/1048576).toFixed(1)+' MB';
      torrents.push({ name: et.title || et.filename, source: 'EZTV', size: sz, seeders: et.seeds || 0,
        released: et.date_released_unix ? fmtDate(et.date_released_unix) : '', infoHash: hash,
        magnet: et.magnet_url || `magnet:?xt=urn:btih:${hash}&dn=${encodeURIComponent(et.title || '')}${trString}` });
    }
  }
  return torrents;
}

// ═══════════════════════════════════════════
// DOWNLOAD
// ═══════════════════════════════════════════
async function startDownload(encodedMagnet, name) {
  const magnetUri = decodeURIComponent(encodedMagnet);
  if (hasRD()) await downloadWithRD(magnetUri, name);
  else await downloadWithWebTorrent(encodedMagnet, name);
}

async function downloadWithRD(magnetUri, name) {
  showOverlay('Sending to Real-Debrid', 'Checking cache...');
  try {
    const addRes = await rdAPI('POST', 'torrents/addMagnet', { magnet: magnetUri });
    if (!addRes.id) throw new Error('RD did not return an ID.');
    let info = await rdAPI('GET', `torrents/info/${addRes.id}`);
    if (info.files?.length > 0) {
      const largest = info.files.reduce((a, b) => a.bytes > b.bytes ? a : b);
      await rdAPI('POST', `torrents/selectFiles/${addRes.id}`, { files: String(largest.id) });
    } else {
      await rdAPI('POST', `torrents/selectFiles/${addRes.id}`, { files: 'all' });
    }
    setLoadingText('Processing');
    for (let i = 0; i < 60; i++) {
      info = await rdAPI('GET', `torrents/info/${addRes.id}`);
      if (info.status === 'downloaded') break;
      if (['error','dead','virus','magnet_error'].includes(info.status)) throw new Error(`RD: ${info.status}`);
      setLoadingSubtext(info.status === 'downloading' ? `${info.progress || 0}%` : info.status);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (info.status !== 'downloaded') throw new Error('Still downloading. Try again later.');
    if (!info.links?.length) throw new Error('No links from RD.');
    const unrestricted = await rdAPI('POST', 'unrestrict/link', { link: info.links[0] });
    if (!unrestricted.download) throw new Error('Could not get download link.');
    setLoadingText('Starting Download');
    window.location.href = unrestricted.download;
    setTimeout(() => hideOverlay(), 2000);
  } catch (e) {
    setLoadingText('Error');
    setLoadingSubtext(e.message);
    setTimeout(() => hideOverlay(), 4000);
  }
}

async function downloadWithWebTorrent(encodedMagnet, name) {
  showOverlay('Connecting', 'Finding peers...');
  try {
    const metaRes = await fetch('/api/metadata?magnet=' + encodedMagnet);
    const metaData = await metaRes.json();
    if (!metaRes.ok) throw new Error(metaData.error || "Metadata error.");
    if (!metaData.files?.length) throw new Error("No files found.");
    const f = metaData.files.reduce((a, b) => a.sizeBytes > b.sizeBytes ? a : b);
    window.location.href = `/api/download?magnet=${encodedMagnet}&fileIndex=${f.index}`;
    setTimeout(() => hideOverlay(), 2000);
  } catch (e) {
    setLoadingText('Error');
    setLoadingSubtext(e.message);
    setTimeout(() => hideOverlay(), 4000);
  }
}

// ═══════════════════════════════════════════
// STREAMING — RD unrestrict → player
// ═══════════════════════════════════════════
async function startStream(encodedMagnet, name) {
  const magnetUri = decodeURIComponent(encodedMagnet);
  if (!hasRD()) {
    await downloadWithWebTorrent(encodedMagnet, name);
    return;
  }
  showOverlay('Preparing Stream', 'Getting video link from Real-Debrid...');
  try {
    const addRes = await rdAPI('POST', 'torrents/addMagnet', { magnet: magnetUri });
    if (!addRes.id) throw new Error('RD did not return an ID.');
    let info = await rdAPI('GET', `torrents/info/${addRes.id}`);
    if (info.files?.length > 0) {
      const videoExts = ['.mp4', '.mkv', '.avi', '.webm', '.mov', '.m4v'];
      const videoFiles = info.files.filter(f => videoExts.some(ext => f.path.toLowerCase().endsWith(ext)));
      // Prefer MP4/WebM (browser-playable) over MKV for streaming
      const mp4Files = videoFiles.filter(f => /\.(mp4|webm|m4v)$/i.test(f.path));
      const target = mp4Files.length > 0
        ? mp4Files.reduce((a, b) => a.bytes > b.bytes ? a : b)
        : videoFiles.length > 0
          ? videoFiles.reduce((a, b) => a.bytes > b.bytes ? a : b)
          : info.files.reduce((a, b) => a.bytes > b.bytes ? a : b);
      await rdAPI('POST', `torrents/selectFiles/${addRes.id}`, { files: String(target.id) });
    } else {
      await rdAPI('POST', `torrents/selectFiles/${addRes.id}`, { files: 'all' });
    }

    setLoadingText('Processing');
    for (let i = 0; i < 60; i++) {
      info = await rdAPI('GET', `torrents/info/${addRes.id}`);
      if (info.status === 'downloaded') break;
      if (['error','dead','virus','magnet_error'].includes(info.status)) throw new Error(`RD: ${info.status}`);
      setLoadingSubtext(info.status === 'downloading' ? `${info.progress || 0}%` : info.status);
      await new Promise(r => setTimeout(r, 2000));
    }
    if (info.status !== 'downloaded') throw new Error('Not cached. Try downloading instead.');
    if (!info.links?.length) throw new Error('No links from RD.');

    setLoadingText('Getting Stream');
    let unrestricted;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        unrestricted = await rdAPI('POST', 'unrestrict/link', { link: info.links[0] });
        if (unrestricted.download) break;
      } catch (e) {
        if (attempt === 2) throw e;
        await new Promise(r => setTimeout(r, 1000));
      }
    }
    if (!unrestricted?.download) throw new Error('Could not get stream link.');

    hideOverlay();
    const dl = unrestricted.download;
    // Route through server proxy (avoids CORS/hotlink blocks from RD)
    // Server is smart: MP4 = byte pipe (no FFmpeg), MKV = FFmpeg remux
    const proxyUrl = '/api/stream?url=' + encodeURIComponent(dl);
    openPlayer(proxyUrl, name, dl);

    // Auto-detect episode and set up "Next Episode" (Netflix-style)
    autoSetupNextEp(name);
  } catch (e) {
    console.error('[startStream] Error:', e);
    setLoadingText('Stream Error');
    setLoadingSubtext(e.message);
    setTimeout(() => hideOverlay(), 6000);
  }
}

// ═══════════════════════════════════════════
// NEXT EPISODE — auto-detect + auto-setup
// ═══════════════════════════════════════════
function autoSetupNextEp(torrentName) {
  // Try to detect current season/episode from torrent name
  const seMatch = (torrentName || '').match(/s(\d{1,2})\s*e(\d{1,2})/i);
  if (!seMatch) return;
  const curS = parseInt(seMatch[1], 10);
  const curE = parseInt(seMatch[2], 10);

  // Check if we have series context (set by showEditorialDetail)
  const ctx = window._seriesCtx;
  if (!ctx || !ctx.episodes || ctx.episodes.length === 0) {
    // No series context loaded — try to load it from Cinemeta via IMDB detection
    // (best effort: parse IMDB ID from page URL)
    const detailMatch = window.location.pathname.match(/\/detail\/series\/([a-z]{2}\d+)/);
    if (detailMatch) {
      loadSeriesContextAndSetup(detailMatch[1], curS, curE);
    }
    return;
  }

  setupNextEpFromCtx(ctx, curS, curE);
}

async function loadSeriesContextAndSetup(imdbId, curS, curE) {
  try {
    const metaRes = await safeFetchJSON(`https://v3-cinemeta.strem.io/meta/series/${imdbId}.json`);
    if (!metaRes?.meta?.videos) return;
    const videos = metaRes.meta.videos;
    const allEps = videos.filter(v => v.season && v.episode)
      .sort((a,b) => a.season - b.season || a.episode - b.episode)
      .map(v => ({ season: v.season, episode: v.episode, name: v.name || '' }));
    window._seriesCtx = { imdbId, episodes: allEps, title: metaRes.meta.name };
    setupNextEpFromCtx(window._seriesCtx, curS, curE);
  } catch {}
}

function setupNextEpFromCtx(ctx, curS, curE) {
  const eps = ctx.episodes;
  const curIdx = eps.findIndex(e => e.season === curS && e.episode === curE);
  if (curIdx < 0 || curIdx >= eps.length - 1) {
    nextEpInfo = null;
    return;
  }
  const next = eps[curIdx + 1];
  const nextLabel = `S${String(next.season).padStart(2,'0')}E${String(next.episode).padStart(2,'0')}${next.name ? ' — ' + next.name : ''}`;
  nextEpInfo = {
    label: nextLabel,
    onPlay: async () => {
      closePlayerInternal();
      showOverlay('Next Episode', `Loading ${nextLabel}...`);
      try {
        const torrents = await fetchEpisodeTorrents(ctx.imdbId, next.season, next.episode);
        if (torrents.length === 0) throw new Error('No sources for next episode');
        torrents.sort((a,b) => b.seeders - a.seeders);
        const best = torrents[0];
        hideOverlay();
        await startStream(encodeURIComponent(best.magnet), (best.name || '').replace(/'/g, "\\'"));
      } catch (e) {
        setLoadingText('Error');
        setLoadingSubtext(e.message);
        setTimeout(() => hideOverlay(), 3000);
      }
    }
  };
}
