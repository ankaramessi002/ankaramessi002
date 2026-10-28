import express from 'express';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { parseListing, parseAlbum, parseProfile, looksBlocked } from './src/parser.js';
import { collectVideoFeedBatch, createVideoFeedSession } from './src/mediaService.js';

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ORIGIN = 'https://www.erome.com';
const VIDEO_TOPICS = {
  all: 'br video',
  'vazados-brasil': 'vazados brasil',
  'caiu-na-net-br': 'caiu na net br',
  'vazadas-do-insta': 'vazadas do insta',
};

app.disable('x-powered-by');
app.use(express.static('public', { maxAge: '1h', immutable: false, etag: true }));

const cache = new Map();
const inFlight = new Map();
const feedSessions = new Map();
const TTL = 45_000;
const FEED_SESSION_TTL = 20 * 60_000;
const MAX_FEED_SESSIONS = 32;

function validPage(value) {
  const page = Number.parseInt(value || '1', 10);
  if (!Number.isInteger(page) || page < 1 || page > 100) throw new Error('Página inválida.');
  return page;
}

function buildUrl(kind, params = {}) {
  const searchKind = kind === 'search' || kind === 'videos-br';
  const url = new URL(searchKind ? '/search' : kind === 'new' ? '/explore/new' : '/explore', ORIGIN);

  if (searchKind) {
    const q = String(params.q || (kind === 'videos-br' ? VIDEO_TOPICS.all : '')).trim();
    if (!q || q.length > 160) throw new Error('Digite um termo de busca com até 160 caracteres.');
    url.searchParams.set('q', q);
  }

  const page = validPage(params.page);
  if (page > 1) url.searchParams.set('page', String(page));
  return url;
}

function validateListingNext(value, kind, query = '') {
  if (!value) return '';
  let url;
  try { url = new URL(value); } catch { return ''; }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.port) return '';

  const searchPath = kind === 'search' || kind === 'videos-br';
  const expectedPath = searchPath
    ? '/search'
    : kind === 'new'
      ? '/explore/new'
      : '/explore';
  if (url.pathname !== expectedPath) return '';
  const allowedParams = searchPath ? new Set(['q', 'page']) : new Set(['page']);
  if ([...url.searchParams.keys()].some((key) => !allowedParams.has(key))) return '';
  if (searchPath && (url.searchParams.getAll('q').length !== 1 || url.searchParams.get('q') !== query)) return '';
  if (url.searchParams.getAll('page').length !== 1) return '';
  const page = url.searchParams.get('page');
  if (!page || !/^\d+$/.test(page) || Number(page) < 1 || Number(page) > 1_000_000) return '';
  url.hash = '';
  return url.href;
}

function cacheKeyFor(url, extra = {}) {
  return JSON.stringify({ url: String(url.href || url), ...extra });
}

function cleanupFeedSessions() {
  const now = Date.now();
  for (const [id, session] of feedSessions) {
    if (now - session.lastUsedAt > FEED_SESSION_TTL) feedSessions.delete(id);
  }
}

async function fetchHtml(url, options = {}) {
  const key = cacheKeyFor(url, options.keyMeta || {});
  const cached = cache.get(key);
  if (cached && Date.now() - cached.time < TTL) return cached.html;

  if (inFlight.has(key)) return inFlight.get(key);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  const request = (async () => {
    let attempt = 0;
    while (attempt < 2) {
      try {
        const response = await fetch(url, {
          signal: controller.signal,
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; MediaBrowser/1.1)',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });

        const html = await response.text();
        if (!response.ok) {
          const retryable = response.status >= 500 || response.status === 429;
          if (retryable && attempt === 0) {
            attempt += 1;
            continue;
          }
          throw Object.assign(new Error(`O site de origem respondeu HTTP ${response.status}.`), { status: 502 });
        }
        if (!/text\/html|application\/xhtml\+xml/i.test(response.headers.get('content-type') || '') && !/<html[\s>]/i.test(html)) {
          throw Object.assign(new Error('A resposta recebida não parece ser HTML.'), { status: 502 });
        }
        if (looksBlocked(html)) {
          throw Object.assign(new Error('A origem retornou uma página de verificação/bloqueio. O aplicativo não tenta contornar essa proteção.'), { status: 502 });
        }

        cache.set(key, { html, time: Date.now() });
        if (cache.size > 120) cache.delete(cache.keys().next().value);
        return html;
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        if (attempt === 0 && (error.message || '').includes('Failed to fetch')) {
          attempt += 1;
          continue;
        }
        throw error;
      }
    }
    throw new Error('Não foi possível carregar a página da origem.');
  })();

  inFlight.set(key, request);
  try {
    return await request;
  } finally {
    inFlight.delete(key);
    clearTimeout(timeout);
  }
}

function asyncRoute(handler) {
  return (req, res) => Promise.resolve(handler(req, res)).catch((error) => {
    res.status(error.status || 400).json({
      error: error.name === 'AbortError' ? 'A origem demorou demais para responder.' : error.message || 'Falha inesperada.',
    });
  });
}

app.get('/api/listing', asyncRoute(async (req, res) => {
  const requestedQuery = String(req.query.q || '').trim();
  const kind = req.query.kind === 'videos-br'
    ? 'videos-br'
    : requestedQuery || req.query.kind === 'search'
      ? 'search'
      : req.query.section === 'new'
        ? 'new'
        : 'hot';
  const topic = String(req.query.topic || 'all');
  const q = requestedQuery || (kind === 'videos-br' ? (VIDEO_TOPICS[topic] || VIDEO_TOPICS.all) : '');
  const sort = String(req.query.sort || 'relevance');
  if (!['relevance', 'new', 'views'].includes(sort)) throw new Error('Ordenação inválida.');
  const nextUrl = req.query.next ? validateListingNext(String(req.query.next), kind, q) : '';
  if (req.query.next && !nextUrl) throw new Error('O link da próxima página não pertence a esta consulta ou não é válido.');
  const url = nextUrl ? new URL(nextUrl) : buildUrl(kind, { q, page: req.query.page, topic });
  const parsed = parseListing(await fetchHtml(url, {
    keyMeta: { kind, q, sort, page: url.searchParams.get('page') || '1', topic },
  }), url.href);
  parsed.next = validateListingNext(parsed.next, kind, q);
  res.json({
    ...parsed,
    page: Number(url.searchParams.get('page') || 1),
    section: kind,
    topic,
    query: q,
    sort,
    sourceUrl: url.href,
  });
}));

app.get('/api/profile', asyncRoute(async (req, res) => {
  const username = String(req.query.username || '').trim();
  if (!/^[A-Za-z0-9_.-]{1,60}$/.test(username)) throw new Error('Nome de perfil inválido.');

  const page = validPage(req.query.page);
  const sort = String(req.query.sort || 'relevance');
  if (!['relevance', 'new', 'views'].includes(sort)) throw new Error('Ordenação inválida.');
  const url = new URL(`/${encodeURIComponent(username)}`, ORIGIN);
  if (page > 1) url.searchParams.set('page', String(page));

  const parsed = parseProfile(await fetchHtml(url, { keyMeta: { kind: 'profile', username, page, sort } }), url.href);
  res.json({ ...parsed, page, section: 'profile', sort });
}));

app.get('/api/album', asyncRoute(async (req, res) => {
  const id = String(req.query.id || '');
  if (!/^[a-zA-Z0-9_-]{3,40}$/.test(id)) throw new Error('Identificador de álbum inválido.');

  const url = new URL(`/a/${encodeURIComponent(id)}`, ORIGIN);
  const rawHtml = await fetchHtml(url, { keyMeta: { kind: 'album', id } });
  const album = parseAlbum(rawHtml, url.href);
  if (!album.media.length) {
    throw Object.assign(new Error('Não foi possível identificar mídias nesta página. A estrutura pode ter mudado ou a origem não as disponibilizou.'), { status: 502 });
  }

  res.json(album);
}));

app.get('/api/video', asyncRoute(async (req, res) => {
  const raw = String(req.query.url || '');
  let videoUrl;
  try { videoUrl = new URL(raw); } catch { throw new Error('URL de vídeo inválida.'); }

  if (videoUrl.protocol !== 'https:' || !/(^|\.)erome\.com$/i.test(videoUrl.hostname) || videoUrl.username || videoUrl.password || videoUrl.port || !/^\/.+\.mp4$/i.test(videoUrl.pathname)) {
    throw new Error('Apenas arquivos MP4 hospedados em domínios do EroMe são aceitos.');
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0',
    'Referer': 'https://www.erome.com/',
    'Accept': '*/*',
  };

  if (req.headers.range) headers.Range = req.headers.range;

  const upstream = await fetch(videoUrl, { headers, redirect: 'follow' });
  if (!upstream.ok && upstream.status !== 206) {
    throw Object.assign(new Error(`A origem não liberou o vídeo (HTTP ${upstream.status}).`), { status: 502 });
  }

  res.status(upstream.status);
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified', 'etag']) {
    const value = upstream.headers.get(name);
    if (value) res.setHeader(name, value);
  }
  res.setHeader('Cache-Control', 'private, max-age=300');

  if (!upstream.body) return res.end();
  Readable.fromWeb(upstream.body).pipe(res);
  req.on('close', () => {
    if (!res.writableEnded) upstream.body.cancel().catch(() => {});
  });
}));

app.get('/api/feed', async (req, res) => {
  const kind = req.query.kind === 'ttok-br' ? 'ttok-br' : 'ttok';
  const requestedSessionId = String(req.query.session || '');
  cleanupFeedSessions();

  let sessionId = requestedSessionId;
  let sessionEntry = sessionId ? feedSessions.get(sessionId) : null;

  if (requestedSessionId && !/^[0-9a-f-]{36}$/i.test(requestedSessionId)) {
    return res.status(400).json({ error: 'Sessão de feed inválida.' });
  }
  if (requestedSessionId && !sessionEntry) {
    return res.status(410).json({ error: 'Esta sessão de feed expirou. Inicie o feed novamente.' });
  }
  if (sessionEntry && sessionEntry.session.kind !== kind) {
    return res.status(400).json({ error: 'A sessão não corresponde a este feed.' });
  }
  if (!sessionEntry) {
    if (feedSessions.size >= MAX_FEED_SESSIONS) {
      return res.status(503).json({ error: 'O limite temporário de feeds foi atingido. Aguarde e tente novamente.' });
    }
    sessionId = randomUUID();
    sessionEntry = {
      session: createVideoFeedSession({ kind }),
      lastUsedAt: Date.now(),
      pendingBatch: null,
    };
    feedSessions.set(sessionId, sessionEntry);
  }

  sessionEntry.lastUsedAt = Date.now();
  try {
    if (!sessionEntry.pendingBatch) {
      sessionEntry.pendingBatch = collectVideoFeedBatch({
        fetchHtml: (url) => fetchHtml(url, { keyMeta: { kind: `feed:${kind}` } }),
        session: sessionEntry.session,
        limit: sessionEntry.session.validMediaCount === 0 ? 1 : 6,
        albumBudget: 8,
      });
    }
    const batch = await sessionEntry.pendingBatch;
    res.json({
      kind,
      sessionId,
      ...batch,
      count: batch.videos.length,
      source: 'shared-media-pipeline',
    });
  } catch (error) {
    res.status(error.status || 502).json({
      error: error.name === 'AbortError' ? 'A origem demorou demais para responder.' : error.message || 'Falha ao carregar o feed.',
      sessionId,
      retryable: true,
      pagesProcessed: sessionEntry.session.pagesProcessed,
      albumsProcessed: sessionEntry.session.albumsProcessed,
      validMediaCount: sessionEntry.session.validMediaCount,
      duplicateMediaCount: sessionEntry.session.duplicateMediaCount,
    });
  } finally {
    sessionEntry.pendingBatch = null;
    sessionEntry.lastUsedAt = Date.now();
  }
});

app.get('/api/health', (_req, res) => res.json({
  ok: true,
  cachedPages: cache.size,
  activeFeedSessions: feedSessions.size,
}));
app.get('*', (_req, res) => res.sendFile(new URL('./public/index.html', import.meta.url).pathname));


app.listen(PORT, '0.0.0.0', () => console.log(`Navegador de mídias disponível na porta ${PORT}`));
