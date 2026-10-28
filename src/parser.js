import * as cheerio from 'cheerio';

const ORIGIN = 'https://www.erome.com';

const absolute = (value, base = ORIGIN) => {
  if (!value) return '';
  try {
    const url = new URL(value, base);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
};

const absoluteMedia = (value, base = ORIGIN) => {
  const resolved = absolute(value, base);
  if (!resolved) return '';
  try {
    const url = new URL(resolved);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
  } catch {
    return '';
  }
};

const text = (value) => (value || '').replace(/\s+/g, ' ').trim();

const isAdLikeUrl = (value = '') => {
  const url = String(value).toLowerCase();
  return !url || /(?:^|\/)(?:ads?|advert|banner|pixel|tracking|promo|sponsor|vast|doubleclick|googlesyndication|googleads|redirect|click)(?:[/?#]|$)/i.test(url)
    || /(?:utm_|_ga=|fbclid=|gclid=|mc_eid=)/i.test(url);
};

const isLikelyAlbumImageUrl = (value = '', context = '') => {
  const url = String(value).toLowerCase();
  if (!url || isAdLikeUrl(url)) return false;
  const normalizedContext = context.toLowerCase();
  if (/(?:avatar|logo|badge|profile|icon|banner|ad|promo|sponsor)/i.test(normalizedContext)) return false;
  return /\.(?:jpe?g|png|gif|webp|avif|bmp)(?:$|[?#])/i.test(url) || /(?:album|media|photo|image|thumb|thumbnail)/i.test(normalizedContext);
};

const isLikelyVideoUrl = (value = '', context = '') => {
  const url = String(value).toLowerCase();
  if (!url || isAdLikeUrl(url)) return false;
  const normalizedContext = context.toLowerCase();
  if (/(?:avatar|logo|badge|profile|icon|banner|ad|promo|sponsor)/i.test(normalizedContext)) return false;
  return /\.(?:mp4|webm|mov|m3u8)(?:$|[?#])/i.test(url) || /(?:video|media|stream|clip|player)/i.test(normalizedContext);
};

const mediaContext = (element = null) => {
  if (!element) return '';
  const parts = [];
  let current = element;
  for (let depth = 0; current && depth < 4; depth += 1, current = current.parent) {
    const attributes = current.attribs || {};
    if (attributes.class) parts.push(attributes.class);
    if (attributes.id) parts.push(attributes.id);
  }
  return parts.join(' ');
};

export const parseCount = (value) => {
  if (value === null || value === undefined || value === '') return null;
  const cleaned = text(String(value)).replace(/,/g, '').replace(/\s+/g, '');
  const match = cleaned.match(/-?\d+(?:\.\d+)?(?:[kmb])?/i);
  if (!match) return null;

  const amountText = match[0];
  const numericMatch = amountText.match(/-?\d+(?:\.\d+)?/);
  if (!numericMatch) return null;

  const amount = Number.parseFloat(numericMatch[0]);
  if (!Number.isFinite(amount)) return null;

  const suffix = amountText.slice(numericMatch[0].length).toLowerCase();
  const multiplier = suffix === 'k' ? 1_000 : suffix === 'm' ? 1_000_000 : suffix === 'b' ? 1_000_000_000 : 1;
  return amount * multiplier;
};

export function dedupeMedia(items = []) {
  const seen = new Set();
  return (items || []).filter((item) => {
    const key = item?.src || item?.id || `${item?.type}:${item?.title || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function parseComments(html, requestedUrl) {
  const $ = cheerio.load(html);
  const comments = [];
  const blocks = $('.comments .comment, .comment-list .comment, .comment-item, [data-comment-id], div.comment');
  const seen = new Set();

  blocks.each((_, node) => {
    const el = $(node);
    if (el.parents('.comment-item, .comment, [data-comment-id]').length) return;
    const author = text(
      el.find('.comment-author, .author, .username, .user-name, [itemprop="author"]').first().text() ||
      el.find('a[href]').first().text() ||
      el.find('.comment-user').first().text() ||
      ''
    );
    const authorLink = el.find('.comment-author a[href], .author a[href], .username a[href], .user-name a[href], [itemprop="author"] a[href], a[href]').first();
    const textContent = text(
      el.find('.comment-text, .text, .body, .content, [itemprop="text"]').first().text() ||
      el.find('p').first().text() ||
      el.find('.comment-body').first().text() ||
      ''
    );
    const date = text(el.find('.comment-date, time, [datetime]').first().text() || el.find('[datetime]').first().attr('datetime') || '');
    if (!textContent) return;
    const id = el.attr('data-comment-id') || el.attr('id') || '';
    const signature = id || `${author.toLowerCase()}|${textContent.toLowerCase()}|${date.toLowerCase()}`;
    if (seen.has(signature)) return;
    seen.add(signature);
    const commentLink = el.find('a.comment-link[href], a.permalink[href], a[href^="#comment"], a[href*="#comment"]').first();
    comments.push({
      id: id || `comment-${comments.length + 1}`,
      author: author || 'Usuário',
      authorUrl: absolute(authorLink.attr('href') || '', requestedUrl),
      text: textContent,
      date: date || null,
      url: absolute(commentLink.attr('href') || (id ? `#${id}` : ''), requestedUrl) || requestedUrl,
    });
  });

  return comments.slice(0, 50);
}

export function parseListing(html, requestedUrl) {
  const $ = cheerio.load(html);
  const albums = [];
  $('div.album, .album, .album-card, .album-item, [data-album-id]').each((_, node) => {
    const card = $(node);
    const link = card.find('a.album-link, a.album-title, a[href*="/a/"]').first();
    const titleLink = card.find('a.album-title, a[href*="/a/"]').first();
    const href = link.attr('href') || titleLink.attr('href') || card.attr('data-url') || '';
    const albumUrl = absolute(href, requestedUrl);
    if (!albumUrl || !/\/a\/[^/\s?]+/i.test(new URL(albumUrl).pathname)) return;

    const image = card.find('.album-thumbnail, .album-thumb, img').filter((__, el) => {
      const candidate = $(el);
      const src = candidate.attr('data-rotate-src') || candidate.attr('data-src') || candidate.attr('src') || '';
      const context = mediaContext(el);
      return isLikelyAlbumImageUrl(src, context);
    }).first();

    const thumbnail = absoluteMedia((image && (image.attr('data-rotate-src') || image.attr('data-src') || image.attr('src'))) || '', requestedUrl);
    const videoText = text(card.find('.album-videos').first().text() || card.find('[data-video-count]').first().text() || '');
    const imageText = text(card.find('.album-images').first().text() || card.find('[data-photo-count]').first().text() || '');
    const viewsText = text(card.find('.album-bottom-views').first().text() || card.find('.views').first().text() || '');
    const title = text(titleLink.text() || image.attr('alt') || card.find('.album-title').first().text() || 'Álbum sem título');
    const userText = card.find('.album-user').first().text();
    const altUser = card.find('a[href]').filter((__, el) => /^\/[A-Za-z0-9_.-]+$/.test($(el).attr('href') || '')).last().text();
    const user = text(userText || altUser || '');
    const albumId = new URL(albumUrl).pathname.split('/').filter(Boolean).pop();
    const publishedAtValue = card.find('time[datetime]').first().attr('datetime')
      || card.find('[data-published-at]').first().attr('data-published-at')
      || card.find('[data-created-at]').first().attr('data-created-at')
      || '';
    const publishedAt = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(publishedAtValue)
      && Number.isFinite(Date.parse(publishedAtValue))
      ? new Date(publishedAtValue).toISOString()
      : null;

    albums.push({
      id: albumId,
      title,
      user,
      url: albumUrl,
      thumbnail,
      videos: videoText ? parseCount(videoText) : null,
      photos: imageText ? parseCount(imageText) : null,
      views: viewsText || null,
      viewsCount: parseCount(viewsText),
      publishedAt,
      mediaType: videoText && imageText ? 'mixed' : videoText ? 'video' : imageText ? 'photo' : 'unknown',
    });
  });

  const unique = [];
  const seen = new Set();
  for (const album of albums) {
    const key = album.url || album.id;
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(album);
  }

  const next = $('link[rel="next"]').attr('href') || $('a[rel="next"]').attr('href') || '';
  const prev = $('link[rel="prev"]').attr('href') || $('a[rel="prev"]').attr('href') || '';
  const title = text($('h1').first().text() || $('title').text());
  const noResults = unique.length === 0 && /no results|no albums|nothing found|nenhum resultado/i.test($.text());

  return {
    albums: unique,
    next: absolute(next, requestedUrl),
    prev: absolute(prev, requestedUrl),
    title,
    noResults,
  };
}

export function parseProfile(html, requestedUrl) {
  const $ = cheerio.load(html);
  const profileName = text($('#user .username').first().text() || $('meta[property="og:title"]').attr('content')?.replace(/\s*-\s*Profile page.*$/i, '') || new URL(requestedUrl).pathname.split('/').filter(Boolean)[0]);
  const avatar = absolute($('#user img.avatar').first().attr('src') || '', requestedUrl);
  const listing = parseListing(html, requestedUrl);
  const bio = text($('#user .bio').first().text() || $('#user .about').first().text() || '');
  const stats = text($('#user .user-info').first().text() || $('#profile-stats').first().text() || '');
  return { ...listing, profile: { name: profileName, avatar, bio, stats, url: requestedUrl } };
}

export function parseAlbum(html, requestedUrl) {
  const $ = cheerio.load(html);
  const albumId = new URL(requestedUrl).pathname.split('/').filter(Boolean).pop() || 'album';
  const title = text($('.album-title-page').first().text() || $('h1').first().text() || $('title').text() || 'Álbum');
  const description = text($('.album-description, .album-desc, [itemprop="description"]').first().text()
    || $('meta[name="description"]').attr('content')
    || $('meta[property="og:description"]').attr('content')
    || '');
  const tagMap = new Map();
  $('.album-tag, .album-tags a, .tags a, a[rel="tag"]').each((_, node) => {
    const el = $(node);
    const name = text(el.text() || el.attr('data-tag') || '');
    if (!name) return;
    const url = absolute(el.attr('href') || '', requestedUrl);
    const key = `${name.toLowerCase()}|${url}`;
    if (!tagMap.has(key)) tagMap.set(key, { name, url });
  });
  const tags = [...tagMap.values()];
  const userLink = $('#user_name a, a.album-user, .album-user a, .album-author a, a[href*="/user/"]').first();
  const user = text($('#user_name').first().text() || $('.album-user').first().text() || $('.album-author').first().text() || userLink.text());
  const userUrl = absolute(userLink.attr('href') || (user ? `/${encodeURIComponent(user)}` : ''), requestedUrl);
  const media = [];
  const seen = new Set();

  const addImage = (candidate, fallbackId = '') => {
    const src = absoluteMedia(candidate?.src || candidate?.url || '', requestedUrl);
    const context = candidate?.context || '';
    if (!src || seen.has(src) || !isLikelyAlbumImageUrl(src, context) || isAdLikeUrl(src)) return;
    seen.add(src);
    media.push({
      id: candidate?.id || fallbackId || String(media.length + 1),
      type: 'photo',
      src,
      thumbnail: absoluteMedia(candidate?.thumbnail || candidate?.poster || src, requestedUrl),
      poster: absoluteMedia(candidate?.poster || candidate?.thumbnail || src, requestedUrl),
      title: title || 'Foto',
      albumId,
      albumUrl: requestedUrl,
      user,
      userUrl,
      sourceUrl: requestedUrl,
    });
  };

  const addVideo = (candidate, fallbackId = '') => {
    const src = absoluteMedia(candidate?.src || candidate?.url || '', requestedUrl);
    const context = candidate?.context || '';
    if (!src || seen.has(src) || !isLikelyVideoUrl(src, context) || isAdLikeUrl(src)) return;
    seen.add(src);
    media.push({
      id: candidate?.id || fallbackId || String(media.length + 1),
      type: 'video',
      src,
      thumbnail: absoluteMedia(candidate?.thumbnail || candidate?.poster || '', requestedUrl),
      poster: absoluteMedia(candidate?.poster || candidate?.thumbnail || '', requestedUrl),
      title: title || 'Vídeo',
      albumId,
      albumUrl: requestedUrl,
      user,
      userUrl,
      sourceUrl: requestedUrl,
    });
  };

  const readMediaAttribute = (el, names) => {
    for (const name of names) {
      const value = el.attr(name);
      if (value) return value;
    }
    return '';
  };
  const videoAttributes = ['src', 'data-src', 'data-video-src', 'data-original', 'data-url', 'data-file', 'data-source'];
  const posterAttributes = ['poster', 'data-poster', 'data-thumbnail', 'data-thumb'];

  $('video, .media-group .player, .player').each((index, node) => {
    const el = $(node);
    const source = el.find('source[src], source[data-src], source[data-video-src], source[data-original]').first();
    const src = readMediaAttribute(source, videoAttributes) || readMediaAttribute(el, videoAttributes);
    const poster = readMediaAttribute(el, posterAttributes)
      || readMediaAttribute(el.find('[data-poster], [poster]').first(), posterAttributes);
    const context = mediaContext(node);
    const id = readMediaAttribute(el, ['data-media-id', 'data-video-id', 'id']);
    addVideo({ src, poster, thumbnail: poster, context, id }, id || `video-${index + 1}`);
  });

  $('.media-group img, .media-item img, .album-content img, img').each((index, node) => {
    const el = $(node);
    const context = mediaContext(node);
    if (/(?:^|\s)player(?:\s|$)/i.test(context) || el.parents('video, .player').length) return;
    const src = readMediaAttribute(el, ['data-original', 'data-full-src', 'data-rotate-src', 'data-src', 'src'])
      || el.closest('a[href]').attr('href')
      || '';
    const thumbnail = readMediaAttribute(el, ['data-rotate-src', 'data-src', 'src']);
    if (!src || !isLikelyAlbumImageUrl(src, context)) return;
    const id = readMediaAttribute(el, ['data-media-id', 'data-photo-id', 'id']);
    addImage({ src, thumbnail, context, id }, id || `photo-${index + 1}`);
  });

  $('source[src], source[data-src], source[data-video-src], source[data-original]').each((index, node) => {
    const el = $(node);
    const src = readMediaAttribute(el, videoAttributes);
    const context = mediaContext(node);
    if (!isLikelyVideoUrl(src, context)) return;
    const id = readMediaAttribute(el, ['data-media-id', 'data-video-id', 'id']);
    const poster = readMediaAttribute(el.closest('video, .player'), posterAttributes);
    addVideo({ src, poster, context, id }, id || `source-${index + 1}`);
  });

  return {
    title,
    description,
    tags,
    user,
    userUrl,
    media: dedupeMedia(media),
    comments: parseComments(html, requestedUrl),
    sourceUrl: requestedUrl,
    albumId,
  };
}

export function looksBlocked(html) {
  return /captcha|verify you are human|access denied|cloudflare ray id/i.test(html || '');
}
