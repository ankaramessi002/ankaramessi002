import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:net';
import { readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseAlbum, parseListing } from '../src/parser.js';
import {
  classifyBrazilian,
  collectVideoFeedBatch,
  createVideoFeedSession,
  normalizeFeedPageUrl,
} from '../src/mediaService.js';

const root = fileURLToPath(new URL('../', import.meta.url));

test('parser ignores ad and tracking media while keeping real album content', () => {
  const listingHtml = `
    <html><body>
      <div class="ad-banner"><img src="https://cdn.example.com/ad-banner.jpg?campaign=ads"></div>
      <div class="album">
        <a class="album-link" href="/a/album-123">Album real</a>
        <img class="album-thumbnail" src="https://cdn.example.com/media/thumb.jpg">
        <span class="album-images">12 fotos</span>
        <span class="album-bottom-views">1.2K views</span>
        <span class="album-user">alice</span>
      </div>
      <div class="album">
        <a class="album-link" href="/a/album-999">Album real 2</a>
        <img class="album-thumbnail" src="https://cdn.example.com/album2.jpg">
        <span class="album-videos">2 vídeos</span>
        <span class="album-user">bob</span>
      </div>
    </body></html>
  `;

  const listing = parseListing(listingHtml, 'https://www.erome.com/explore');
  assert.equal(listing.albums.length, 2);
  assert.equal(listing.albums.every((album) => !album.thumbnail.includes('ad-banner')), true);

  const albumHtml = `
    <html><body>
      <div class="album-page">
        <img class="album-media" src="https://cdn.example.com/real-photo.jpg">
        <img class="ad" src="https://ads.example.com/banner.jpg">
        <img class="avatar" src="https://cdn.example.com/avatar.jpg">
        <video><source src="https://cdn.example.com/clip.mp4"></video>
        <div class="media-group">
          <div class="player" data-src="https://cdn.example.com/stream?id=9" data-poster="https://cdn.example.com/stream-poster.jpg"></div>
          <img data-original="https://cdn.example.com/full-size.jpg" data-src="https://cdn.example.com/thumb.jpg">
        </div>
        <a class="album-tag" href="/search?q=teresina">Teresina</a>
        <div class="comments">
          <article class="comment-item" data-comment-id="comment-1">
            <a class="comment-author" href="/public-user">Public user</a>
            <p class="comment-text">Comentário público</p>
            <a class="comment-link" href="#comment-1">Permalink</a>
          </article>
        </div>
      </div>
    </body></html>
  `;

  const album = parseAlbum(albumHtml, 'https://www.erome.com/a/album-123');
  assert.equal(album.media.length, 4);
  assert.equal(album.media.some((item) => item.src.includes('clip.mp4')), true);
  assert.equal(album.media.some((item) => item.src.includes('/stream?id=9') && item.type === 'video'), true);
  assert.equal(album.media.some((item) => item.src.includes('full-size.jpg') && item.thumbnail.includes('thumb.jpg')), true);
  assert.deepEqual(album.tags, [{ name: 'Teresina', url: 'https://www.erome.com/search?q=teresina' }]);
  assert.equal(album.comments.length, 1);
  assert.equal(album.comments[0].authorUrl, 'https://www.erome.com/public-user');
  assert.equal(album.comments[0].url, 'https://www.erome.com/a/album-123#comment-1');
  assert.equal(album.media.some((item) => item.src.includes('banner.jpg')), false);
  assert.equal(album.media.some((item) => item.src.includes('avatar.jpg')), false);
  assert.equal(classifyBrazilian({ tags: [{ name: 'Brasileiras' }] }), true);
  assert.equal(classifyBrazilian({ title: 'Vídeos Brasil e vazados', user: 'brasilia' }), true);
  assert.equal(classifyBrazilian({ title: 'Random content', user: 'alice' }), false);
});

test('shared TTOK feed follows verified next links and emits batches progressively', async () => {
  const firstListing = `
    <html><body>
      <div class="album"><a class="album-link" href="/a/album-br-1">Vazados Brasil</a></div>
      <div class="album"><a class="album-link" href="/a/album-unknown-1">Conteúdo</a></div>
      <a rel="next" href="/explore?page=2">Próxima</a>
    </body></html>
  `;
  const nextListing = `
    <html><body>
      <div class="album"><a class="album-link" href="/a/album-br-2">Vídeos brasileiros</a></div>
    </body></html>
  `;
  const albumHtml = (src) => `<html><body><video><source src="${src}"></video></body></html>`;
  const lookup = new Map([
    ['https://www.erome.com/explore', firstListing],
    ['https://www.erome.com/explore?page=2', nextListing],
    ['https://www.erome.com/a/album-br-1', albumHtml('https://www.erome.com/media/one.mp4')],
    ['https://www.erome.com/a/album-unknown-1', albumHtml('https://www.erome.com/media/unknown.mp4')],
    ['https://www.erome.com/a/album-br-2', albumHtml('https://www.erome.com/media/two.mp4')],
  ]);
  const requested = [];
  const fetchHtml = async (url) => {
    requested.push(String(url));
    return lookup.get(String(url)) || '';
  };
  const session = createVideoFeedSession({
    kind: 'ttok-br',
    startUrls: ['https://www.erome.com/explore'],
    fallbackQueries: [],
  });

  const firstBatch = await collectVideoFeedBatch({ fetchHtml, session, limit: 1 });
  assert.equal(firstBatch.videos.length, 1);
  assert.equal(firstBatch.videos[0].albumTitle, 'Vazados Brasil');
  assert.equal(firstBatch.videos[0].isBrazilian, true);
  assert.equal(firstBatch.hasMore, true);
  assert.equal(requested.includes('https://www.erome.com/explore?page=2'), false);

  const secondBatch = await collectVideoFeedBatch({ fetchHtml, session, limit: 1 });
  assert.equal(secondBatch.videos.length, 1);
  assert.equal(secondBatch.videos[0].albumTitle, 'Vídeos brasileiros');
  assert.equal(requested.includes('https://www.erome.com/explore?page=2'), true);

  const finishedBatch = await collectVideoFeedBatch({ fetchHtml, session, limit: 1 });
  assert.equal(finishedBatch.videos.length, 0);
  assert.equal(finishedBatch.ended, true);
  assert.equal(classifyBrazilian({ title: 'Vazados Brasil' }), true);
  assert.equal(classifyBrazilian({ title: 'Brasil' }), false);
  assert.equal(classifyBrazilian({ title: 'Conteúdo aleatório', user: 'brasil' }), false);
  assert.equal(classifyBrazilian({ title: 'Random mainstream', albumTitle: 'Only stories' }), false);
});

test('feed page URLs accept only validated same-origin discovery links', () => {
  assert.equal(normalizeFeedPageUrl('/explore?page=2'), 'https://www.erome.com/explore?page=2');
  assert.equal(normalizeFeedPageUrl('/search?q=sample&page=2'), 'https://www.erome.com/search?q=sample&page=2');
  assert.equal(normalizeFeedPageUrl('/search?q=sample&page=2&other=x'), '');
  assert.equal(normalizeFeedPageUrl('/search?q=different&page=2', 'https://www.erome.com/search?q=sample'), 'https://www.erome.com/search?q=different&page=2');
  assert.equal(normalizeFeedPageUrl('https://www.erome.com/a/album-123'), '');
  assert.equal(normalizeFeedPageUrl('https://other.example/explore?page=2'), '');
  assert.equal(normalizeFeedPageUrl('https://www.erome.com/explore?page=2#fragment'), 'https://www.erome.com/explore?page=2');
});

test('TTOK layout uses one full-screen snap item and contains the complete video', async () => {
  const css = await readFile(path.join(root, 'public', 'styles.css'), 'utf8');
  const itemRule = css.match(/\.ttok-item\s*\{([^}]*)\}/s)?.[1] || '';
  const videoRule = css.match(/\.ttok-item video\s*\{([^}]*)\}/s)?.[1] || '';
  const feedRule = css.match(/body\.ttok-mode #album-grid\.ttok-feed\s*\{([^}]*)\}/s)?.[1] || '';

  assert.match(itemRule, /height:\s*100%/);
  assert.match(itemRule, /scroll-snap-align:\s*start/);
  assert.match(feedRule, /scroll-snap-type:\s*y mandatory/);
  assert.match(videoRule, /object-fit:\s*contain/);
  assert.match(videoRule, /background:\s*#000/);
  assert.doesNotMatch(videoRule, /object-fit:\s*cover/);
});

test('feed rejects a verified-looking next link that changes the search query', async () => {
  const requested = [];
  const session = createVideoFeedSession({
    startUrls: ['https://www.erome.com/search?q=desired'],
    fallbackQueries: [],
  });
  const result = await collectVideoFeedBatch({
    fetchHtml: async (url) => {
      requested.push(String(url));
      return '<html><body><a rel="next" href="/search?q=other&page=2">Next</a></body></html>';
    },
    session,
    limit: 1,
  });

  assert.equal(result.ended, true);
  assert.deepEqual(requested, ['https://www.erome.com/search?q=desired']);
});

test('shared feed tries each configured fallback query once after verified pages end', async () => {
  const requested = [];
  const listings = new Map([
    ['https://www.erome.com/explore', '<html><body></body></html>'],
    ['https://www.erome.com/search?q=first', '<html><body></body></html>'],
    ['https://www.erome.com/search?q=second', '<html><body><div class="album"><a class="album-link" href="/a/fallback-1">Vídeos brasileiros</a></div></body></html>'],
    ['https://www.erome.com/a/fallback-1', '<html><body><video><source src="https://www.erome.com/media/fallback.mp4"></video></body></html>'],
  ]);
  const session = createVideoFeedSession({
    kind: 'ttok',
    startUrls: ['https://www.erome.com/explore'],
    fallbackQueries: ['first', 'second'],
  });
  let result;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    result = await collectVideoFeedBatch({
      fetchHtml: async (url) => {
        requested.push(String(url));
        return listings.get(String(url)) || '';
      },
      session,
      limit: 1,
    });
    if (result.videos.length) break;
  }

  assert.equal(result.videos.length, 1);
  assert.equal(result.videos[0].albumTitle, 'Vídeos brasileiros');
  assert.equal(requested.filter((url) => url === 'https://www.erome.com/search?q=first').length, 1);
  assert.equal(requested.filter((url) => url === 'https://www.erome.com/search?q=second').length, 1);
  assert.equal(result.fallbackQueriesProcessed, 2);
});

test('feed deduplicates canonical media URLs without changing the playback URL', async () => {
  const listingHtml = `<html><body>
    <div class="album"><a class="album-link" href="/a/album-one">One</a></div>
    <div class="album"><a class="album-link" href="/a/album-two">Two</a></div>
  </body></html>`;
  const lookup = new Map([
    ['https://www.erome.com/explore', listingHtml],
    ['https://www.erome.com/a/album-one', '<video><source src="https://www.erome.com/media/shared.mp4#one"></video>'],
    ['https://www.erome.com/a/album-two', '<video><source src="https://www.erome.com/media/shared.mp4#two"></video>'],
  ]);
  const session = createVideoFeedSession({ fallbackQueries: [] });
  const batch = await collectVideoFeedBatch({
    fetchHtml: async (url) => lookup.get(String(url)) || '',
    session,
    limit: 6,
  });

  assert.equal(batch.videos.length, 1);
  assert.match(batch.videos[0].src, /#(?:one|two)$/);
  assert.equal(batch.duplicateMediaCount, 1);
  assert.equal(session.seenMedia.size, 1);
});

test('listing requests preserve search, sort, page, and separate cache contexts', async (t) => {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));

  const logPath = path.join(os.tmpdir(), `media-browser-upstream-${process.pid}.log`);
  const child = spawn(process.execPath, [
    '--import',
    pathToFileURL(path.join(root, 'tests', 'mock-upstream.js')).href,
    path.join(root, 'server.js'),
  ], {
    cwd: root,
    env: { ...process.env, PORT: String(port), TEST_UPSTREAM_LOG: logPath },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let childError = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { childError += chunk; });

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child, 'exit');
      child.kill();
      await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    }
    await rm(logPath, { force: true });
  });

  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Test server exited with ${child.exitCode}: ${childError}`);
    try {
      const response = await fetch(`${base}/api/health`);
      ready = response.ok;
      if (ready) break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  assert.equal(ready, true, 'server should start and expose its health endpoint');

  const listing = async (query) => {
    const response = await fetch(`${base}/api/listing?${new URLSearchParams(query)}`);
    return { status: response.status, data: await response.json() };
  };

  const exploreNew = await listing({ section: 'new', sort: 'new', page: '1' });
  assert.equal(exploreNew.status, 200);
  assert.equal(exploreNew.data.albums.length, 0);

  const catsNew = await listing({ section: 'new', kind: 'search', q: 'gatos', sort: 'new', page: '1' });
  const beachNew = await listing({ section: 'new', kind: 'search', q: 'praia', sort: 'new', page: '1' });
  const catsRelevance = await listing({ section: 'hot', kind: 'search', q: 'gatos', sort: 'relevance', page: '1' });
  const catsNewCached = await listing({ section: 'new', kind: 'search', q: 'gatos', sort: 'new', page: '1' });
  const catsPageTwo = await listing({ section: 'new', kind: 'search', q: 'gatos', sort: 'new', page: '2' });

  assert.equal(catsNew.data.query, 'gatos');
  assert.equal(beachNew.data.query, 'praia');
  assert.equal(catsRelevance.data.query, 'gatos');
  assert.equal(catsNewCached.data.query, 'gatos');
  assert.equal(catsPageTwo.data.page, 2);

  const invalidSort = await listing({ kind: 'search', q: 'gatos', sort: 'unsupported', page: '1' });
  assert.equal(invalidSort.status, 400);
  const invalidExploreNext = await listing({ section: 'hot', next: 'https://other.example/explore?page=2' });
  assert.equal(invalidExploreNext.status, 400);
  const mismatchedSearchNext = await listing({
    kind: 'search',
    q: 'gatos',
    next: 'https://www.erome.com/search?q=praia&page=2',
  });
  assert.equal(mismatchedSearchNext.status, 400);

  const upstreamRequests = (await readFile(logPath, 'utf8')).trim().split(/\r?\n/).map((value) => new URL(value));
  assert.equal(upstreamRequests.filter((url) => url.pathname === '/explore/new').length, 1);
  assert.equal(upstreamRequests.filter((url) => url.pathname === '/search' && url.searchParams.get('q') === 'gatos').length, 3);
  assert.equal(upstreamRequests.filter((url) => url.pathname === '/search' && url.searchParams.get('q') === 'praia').length, 1);
  assert.equal(upstreamRequests.some((url) => url.pathname === '/search' && url.searchParams.get('q') === 'gatos' && url.searchParams.get('page') === '2'), true);

  const home = await fetch(base);
  const html = await home.text();
  assert.equal(home.ok, true);
  assert.match(html, /id="query-filters"/);
  assert.match(html, /id="album-sequence"/);
  assert.match(html, /id="setting-sound-ttok" type="checkbox" checked/);
  const app = await fetch(`${base}/app.js`);
  assert.equal(app.ok, true);
});
