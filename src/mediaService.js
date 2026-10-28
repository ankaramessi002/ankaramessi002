import { createHash } from 'node:crypto';
import { parseAlbum, parseListing } from './parser.js';

const ORIGIN = 'https://www.erome.com';
const DEFAULT_START_URLS = [`${ORIGIN}/explore`, `${ORIGIN}/explore/new`];
const FALLBACK_QUERIES = ['br video', 'vazados brasil', 'caiu na net br', 'vazadas do insta'];
const PAGE_PATHS = new Set(['/explore', '/explore/new', '/search']);
const FEED_VIDEO_HOST = /(^|\.)erome\.com$/i;
const FEED_VIDEO_PATH = /\.mp4$/i;

const normalizeValue = (value) => {
  if (Array.isArray(value)) return value.map(normalizeValue).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return normalizeValue(value.name || value.text || '');
  return String(value || '').normalize('NFKC').toLowerCase();
};

const normalizeText = (...values) => values
  .filter(Boolean)
  .map(normalizeValue)
  .join(' ')
  .replace(/\s+/g, ' ')
  .trim();

export function normalizeFeedPageUrl(value, base = ORIGIN) {
  try {
    const url = new URL(value, base);
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.port) return '';
    const pathname = url.pathname.replace(/\/$/, '') || '/';
    if (!PAGE_PATHS.has(pathname)) return '';
    const allowedParams = pathname === '/search' ? new Set(['q', 'page']) : new Set(['page']);
    if ([...url.searchParams.keys()].some((key) => !allowedParams.has(key))) return '';
    if (url.searchParams.getAll('page').length > 1 || url.searchParams.getAll('q').length > 1) return '';
    if (pathname === '/search' && (!url.searchParams.get('q')?.trim() || url.searchParams.get('q').length > 160)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

export function classifyBrazilian(record = {}) {
  const haystack = normalizeText(
    record.title,
    record.albumTitle,
    record.description,
    record.tags,
    record.commentText,
  );

  if (!haystack) return false;

  return [
    /\b(?:vazados|vazadas)\s+(?:do\s+)?brasil\b/,
    /\b(?:vídeos?|videos?)\s+(?:do\s+)?brasil\b/,
    /\bbrasileir[oa]s?\b/,
    /\bcaiu na net br(?:asil)?\b/,
    /\bbr\s+(?:vídeos?|videos?)\b/,
  ].some((pattern) => pattern.test(haystack));
}

export function dedupeVideoFeed(items = []) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = item?.src || item?.id || '';
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function isPlayableFeedVideo(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:'
      && FEED_VIDEO_HOST.test(url.hostname)
      && !url.username
      && !url.password
      && !url.port
      && FEED_VIDEO_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

function normalizeAlbumUrl(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password) return '';
    if (!/^\/a\/[a-zA-Z0-9_-]{3,80}$/.test(url.pathname)) return '';
    url.hash = '';
    return url.href;
  } catch {
    return '';
  }
}

function stableMediaId(src) {
  return createHash('sha256').update(src).digest('hex');
}

function canonicalMediaKey(value) {
  const url = new URL(value);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid|_ga|mc_eid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href;
}

function shuffle(items) {
  const shuffled = [...items];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }
  return shuffled;
}

export function createVideoFeedSession({
  kind = 'ttok',
  startUrls = DEFAULT_START_URLS,
  fallbackQueries = FALLBACK_QUERIES,
} = {}) {
  const urls = startUrls
    .map((url) => normalizeFeedPageUrl(url))
    .filter(Boolean);

  return {
    kind: kind === 'ttok-br' ? 'ttok-br' : 'ttok',
    pageQueue: [...new Set(urls)],
    queuedPages: new Set(urls),
    visitedPages: new Set(),
    fallbackQueries: [...new Set(fallbackQueries.map((query) => String(query).trim()).filter(Boolean))],
    fallbackQueryIndex: 0,
    currentPageContext: null,
    pendingAlbums: [],
    albumIndex: 0,
    pendingVideos: [],
    pendingVideoIndex: 0,
    seenAlbums: new Set(),
    seenMedia: new Set(),
    pagesProcessed: 0,
    validMediaCount: 0,
    duplicateMediaCount: 0,
    albumsProcessed: 0,
    ended: urls.length === 0,
  };
}

function queueNextPage(session, candidate, base) {
  const nextUrl = normalizeFeedPageUrl(candidate, base);
  if (nextUrl && session.currentPageContext !== pageContext(nextUrl)) return;
  if (!nextUrl || session.visitedPages.has(nextUrl) || session.queuedPages.has(nextUrl)) return;
  session.pageQueue.unshift(nextUrl);
  session.queuedPages.add(nextUrl);
}

function pageContext(value) {
  const url = new URL(value);
  return url.pathname === '/search'
    ? `search:${url.searchParams.get('q') || ''}`
    : `explore:${url.pathname}`;
}

function queueFallbackQuery(session) {
  while (session.fallbackQueryIndex < session.fallbackQueries.length) {
    const query = session.fallbackQueries[session.fallbackQueryIndex];
    session.fallbackQueryIndex += 1;
    const url = new URL('/search', ORIGIN);
    url.searchParams.set('q', query);
    const value = url.href;
    if (session.visitedPages.has(value) || session.queuedPages.has(value)) continue;
    session.currentPageContext = pageContext(value);
    session.pageQueue.push(value);
    session.queuedPages.add(value);
    return true;
  }
  return false;
}

export async function collectVideoFeedBatch({
  fetchHtml,
  session,
  limit = 6,
  albumBudget = 8,
} = {}) {
  if (typeof fetchHtml !== 'function') throw new TypeError('fetchHtml deve ser uma função.');
  if (!session || !Array.isArray(session.pageQueue)) throw new TypeError('Sessão de feed inválida.');

  const videos = [];
  let albumsExamined = 0;
  let pagesFetched = 0;

  while (videos.length < limit && albumsExamined < albumBudget) {
    if (session.pendingVideoIndex < session.pendingVideos.length) {
      videos.push(session.pendingVideos[session.pendingVideoIndex]);
      session.pendingVideoIndex += 1;
      continue;
    }

    session.pendingVideos = [];
    session.pendingVideoIndex = 0;

    if (session.albumIndex >= session.pendingAlbums.length) {
      session.pendingAlbums = [];
      session.albumIndex = 0;
      if (!session.pageQueue.length && !queueFallbackQuery(session)) break;
      if (pagesFetched >= 1) break;

      const pageUrl = session.pageQueue[0];
      const currentContext = pageContext(pageUrl);
      if (session.currentPageContext !== currentContext) session.currentPageContext = currentContext;
      if (session.visitedPages.has(pageUrl)) {
        session.pageQueue.shift();
        session.queuedPages.delete(pageUrl);
        continue;
      }

      const html = await fetchHtml(new URL(pageUrl));
      const parsed = parseListing(html, pageUrl);
      session.pageQueue.shift();
      session.queuedPages.delete(pageUrl);
      session.visitedPages.add(pageUrl);
      session.pagesProcessed += 1;
      pagesFetched += 1;
      queueNextPage(session, parsed.next, pageUrl);
      session.pendingAlbums = shuffle(Array.isArray(parsed.albums) ? parsed.albums : []);
      if (!session.pendingAlbums.length) continue;
    }

    const album = session.pendingAlbums[session.albumIndex];
    const albumUrl = normalizeAlbumUrl(album?.url);
    const albumKey = album?.id || albumUrl;
    if (!albumKey || !albumUrl || session.seenAlbums.has(albumKey)) {
      session.albumIndex += 1;
      session.duplicateMediaCount += 1;
      continue;
    }

    const html = await fetchHtml(new URL(albumUrl));
    const albumData = parseAlbum(html, albumUrl);
    session.albumIndex += 1;
    session.seenAlbums.add(albumKey);
    session.albumsProcessed += 1;
    albumsExamined += 1;

    for (const item of albumData.media || []) {
      if (item?.type !== 'video' || !isPlayableFeedVideo(item.src)) continue;
      const src = new URL(item.src).href;
      const mediaKey = canonicalMediaKey(src);
      if (session.seenMedia.has(mediaKey)) {
        session.duplicateMediaCount += 1;
        continue;
      }

      const fallbackTitle = album.title && album.title !== 'Álbum'
        ? album.title
        : albumData.title && albumData.title !== 'Álbum'
          ? albumData.title
          : 'Álbum';
      const user = albumData.user || album.user || '';
      const isBrazilian = classifyBrazilian({
        title: album.title,
        albumTitle: fallbackTitle,
        description: albumData.description,
        tags: albumData.tags,
      });

      if (session.kind === 'ttok-br' && !isBrazilian) continue;

      session.seenMedia.add(mediaKey);
      session.validMediaCount += 1;
      session.pendingVideos.push({
        id: stableMediaId(mediaKey),
        src,
        thumbnail: item.poster || item.thumbnail || album.thumbnail || '',
        poster: item.poster || item.thumbnail || album.thumbnail || '',
        albumTitle: fallbackTitle,
        title: item.title || fallbackTitle,
        user,
        albumId: albumData.albumId || album.id || '',
        albumUrl: albumData.sourceUrl || album.url || '',
        sourceUrl: albumData.sourceUrl || album.url || '',
        isBrazilian,
      });
    }
  }

  while (videos.length < limit && session.pendingVideoIndex < session.pendingVideos.length) {
    videos.push(session.pendingVideos[session.pendingVideoIndex]);
    session.pendingVideoIndex += 1;
  }

  const hasPendingAlbums = session.albumIndex < session.pendingAlbums.length;
  const hasPendingVideos = session.pendingVideoIndex < session.pendingVideos.length;
  const hasFallbackQueries = session.fallbackQueryIndex < session.fallbackQueries.length;
  const fallbackQueriesProcessed = new Set([...session.visitedPages]
    .map((value) => new URL(value))
    .filter((url) => url.pathname === '/search')
    .map((url) => url.searchParams.get('q'))
    .filter(Boolean)).size;
  session.ended = !hasPendingAlbums && !hasPendingVideos && session.pageQueue.length === 0 && !hasFallbackQueries;

  return {
    videos: dedupeVideoFeed(videos),
    hasMore: !session.ended,
    ended: session.ended,
    pagesProcessed: session.pagesProcessed,
    albumsProcessed: session.albumsProcessed,
    validMediaCount: session.validMediaCount,
    duplicateMediaCount: session.duplicateMediaCount,
    fallbackQueriesProcessed,
    fallbackQueriesTotal: session.fallbackQueries.length,
  };
}
