const $ = (selector) => document.querySelector(selector);
const VIDEO_TOPICS = {
  all: { label: 'Todos', query: 'br video' },
  'vazados-brasil': { label: 'Vazados Brasil', query: 'vazados brasil' },
  'caiu-na-net-br': { label: 'Caiu na Net BR', query: 'caiu na net br' },
  'vazadas-do-insta': { label: 'Vazadas do Insta', query: 'vazadas do insta' },
};
const ALBUM_FILTERS = new Set(['all', 'photo', 'video', 'multi-video', 'unknown']);

const state = {
  section: 'hot',
  query: '',
  page: 1,
  filter: 'all',
  albums: [],
  currentAlbum: null,
  route: 'listing',
  profile: '',
  previousHash: '#/',
  navigationContext: null,
  albumController: null,
  albumSequenceObserver: null,
  albumSequenceController: null,
  albumSequenceLoading: false,
  pendingAlbumId: '',
  restoreListingScroll: false,
  resultMode: 'albums',
  mediaResults: [],
  mediaFilter: 'all',
  videoTopic: 'all',
  sort: 'relevance',
  activeFetch: null,
  listingRequestId: 0,
  mediaRequestId: 0,
  autoplayTtok: true,
  ttokMuted: false,
  compactCards: false,
  favorites: [],
  history: [],
  lastRequest: null,
  lastRequestError: null,
  pagesProcessed: 0,
  validMediaCount: 0,
  duplicateMediaCount: 0,
  fallbackQueriesProcessed: 0,
  fallbackQueriesTotal: 0,
  cachedPages: null,
  paginationStatus: 'inativa',
  localStorageError: '',
};

const ttokFeed = {
  kind: '',
  sessionId: '',
  items: [],
  ids: new Set(),
  hasMore: true,
  ended: false,
  loading: false,
  activeIndex: -1,
  activeToken: 0,
  userPaused: false,
  muted: false,
  observer: null,
  ratios: new Map(),
  controller: null,
  scrollHandler: null,
  resizeHandler: null,
  error: '',
};

const listingView = $('#listing-view');
const albumView = $('#album-view');
const grid = $('#album-grid');
const statusBox = $('#status');

function setStatus(message = '', kind = '') {
  statusBox.textContent = message;
  statusBox.className = `status ${kind}`;
  statusBox.hidden = !message;
}

function showListing() { listingView.hidden = false; albumView.hidden = true; }
function showAlbum() { listingView.hidden = true; albumView.hidden = false; }

function syncTopbarHeight() {
  const topbar = $('.topbar');
  document.documentElement.style.setProperty('--topbar-height', `${Math.ceil(topbar.getBoundingClientRect().height)}px`);
}

function escapeHtml(value = '') {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function getLocalStorage(key, fallback = []) {
  try {
    const value = localStorage.getItem(key);
    if (!value) return fallback;
    return JSON.parse(value);
  } catch (error) {
    state.localStorageError = error.message || 'Armazenamento local indisponível.';
    return fallback;
  }
}

function setLocalStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    state.localStorageError = error.message || 'Não foi possível salvar neste navegador.';
  }
}

function loadLocalState() {
  const favorites = getLocalStorage('midia-favorites', []);
  const recent = getLocalStorage('midia-history', []);
  const savedAutoplay = getLocalStorage('midia-autoplay', true);
  const savedMuted = getLocalStorage('midia-ttok-muted', false);
  const savedCompact = getLocalStorage('midia-compact-cards', false);
  state.favorites = Array.isArray(favorites) ? favorites : [];
  state.history = Array.isArray(recent) ? recent : [];
  state.autoplayTtok = typeof savedAutoplay === 'boolean' ? savedAutoplay : true;
  state.ttokMuted = typeof savedMuted === 'boolean' ? savedMuted : false;
  ttokFeed.muted = state.ttokMuted;
  state.compactCards = typeof savedCompact === 'boolean' ? savedCompact : false;
  document.body.classList.toggle('compact-cards', state.compactCards);
  const autoplay = $('#setting-autoplay-ttok');
  const compact = $('#setting-compact-cards');
  const sound = $('#setting-sound-ttok');
  if (autoplay) autoplay.checked = state.autoplayTtok;
  if (compact) compact.checked = state.compactCards;
  if (sound) sound.checked = !state.ttokMuted;
  renderUtilityLists();
}

function toggleUtilityPanel(section = 'settings', forceOpen) {
  const panel = $('#settings-panel');
  if (!panel) return;
  if (forceOpen !== undefined) {
    panel.hidden = !forceOpen;
    return;
  }
  if (section === 'settings') {
    panel.hidden = !panel.hidden;
    return;
  }
  panel.hidden = false;
  const target = section === 'favorites' ? $('#favorite-list') : $('#history-list');
  if (target) {
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }
}

function persistLocalState() {
  setLocalStorage('midia-favorites', state.favorites);
  setLocalStorage('midia-history', state.history);
  setLocalStorage('midia-autoplay', state.autoplayTtok);
  setLocalStorage('midia-ttok-muted', state.ttokMuted);
  setLocalStorage('midia-compact-cards', state.compactCards);
}

function isFavoriteAlbum(id) {
  return state.favorites.some((entry) => entry?.type === 'album' && entry.id === id);
}

function isFavoriteVideo(id) {
  return state.favorites.some((entry) => entry?.type === 'video' && entry.id === id);
}

function toggleFavorite(entry) {
  if (!entry || !entry.id) return;
  const next = state.favorites.filter((item) => !(item.id === entry.id && item.type === entry.type));
  if (next.length === state.favorites.length) {
    state.favorites.unshift(entry);
  } else {
    state.favorites = next;
  }
  state.favorites = state.favorites.slice(0, 24);
  persistLocalState();
  renderUtilityLists();
  renderAlbumFavoriteButtons();
}

function recordHistoryVideo(video = {}) {
  if (!video?.id && !video?.src) return;
  const entry = {
    id: video.id || video.src,
    type: 'video',
    title: video.albumTitle || video.title || 'Vídeo',
    user: video.user || '',
    albumTitle: video.albumTitle || 'Vídeo',
    src: video.src || '',
    albumId: video.albumId || '',
    poster: video.poster || video.thumbnail || '',
    time: Date.now(),
  };
  const next = [entry, ...state.history.filter((item) => !(item.type === 'video' && (item.id === entry.id || item.src === entry.src)))];
  state.history = next.slice(0, 12);
  persistLocalState();
  renderUtilityLists();
}

function recordHistoryAlbum(album = {}) {
  if (!album?.id) return;
  const entry = {
    id: album.id,
    type: 'album',
    title: album.title || 'Álbum',
    user: album.user || '',
    thumbnail: album.thumbnail || '',
    time: Date.now(),
  };
  const next = [entry, ...state.history.filter((item) => !(item.type === 'album' && item.id === entry.id))];
  state.history = next.slice(0, 12);
  persistLocalState();
  renderUtilityLists();
}

function renderUtilityLists() {
  const favoriteList = $('#favorite-list');
  const historyList = $('#history-list');
  const diagnosticList = $('#diagnostic-list');
  const renderItems = (items, collection) => items.map((item) => `
    <li><button type="button" class="mini-list-button" data-utility-collection="${collection}" data-utility-type="${escapeHtml(item.type || '')}" data-utility-id="${escapeHtml(String(item.id || ''))}">${escapeHtml(item.title || 'Item')}</button></li>
  `).join('');

  if (favoriteList) {
    const favorites = state.favorites.slice(0, 12);
    favoriteList.innerHTML = favorites.length ? renderItems(favorites, 'favorites') : '<li>Nenhum favorito salvo.</li>';
  }

  if (historyList) {
    const recent = state.history.slice(0, 12);
    historyList.innerHTML = recent.length ? renderItems(recent, 'history') : '<li>Nenhum histórico recente.</li>';
  }

  if (diagnosticList) {
    diagnosticList.innerHTML = `
      <li>Páginas: ${state.pagesProcessed}</li>
      <li>Mídias válidas: ${state.validMediaCount}</li>
      <li>Duplicados ignorados: ${state.duplicateMediaCount}</li>
      <li>Tópicos de descoberta: ${state.fallbackQueriesProcessed}/${state.fallbackQueriesTotal || '—'}</li>
      <li>Última requisição: ${escapeHtml(state.lastRequest || 'sem dados')}</li>
      <li>Páginas no cache: ${state.cachedPages ?? 'indisponível'}</li>
      <li>Paginação: ${escapeHtml(state.paginationStatus)}</li>
      <li>Armazenamento local: ${state.localStorageError ? escapeHtml(state.localStorageError) : 'ativo'}</li>
      <li>Erro recente: ${escapeHtml(state.lastRequestError || 'nenhum')}</li>
    `;
  }

  favouriteButtons();
}

function renderAlbumFavoriteButtons() {
  document.querySelectorAll('[data-album-favorite-id]').forEach((button) => {
    const id = button.dataset.albumFavoriteId;
    const isFav = isFavoriteAlbum(id);
    button.textContent = isFav ? '★ Salvo' : '☆ Favoritar';
    button.classList.toggle('active', isFav);
  });
}

function favouriteButtons() {
  document.querySelectorAll('[data-utility-collection]').forEach((button) => {
    button.addEventListener('click', () => {
      const collection = button.dataset.utilityCollection === 'favorites' ? state.favorites : state.history;
      const type = button.dataset.utilityType;
      const id = button.dataset.utilityId;
      const item = collection.find((entry) => entry.type === type && String(entry.id) === String(id));
      if (item?.type === 'album') openAlbum(String(item.id));
      if (item?.type === 'video') {
        const feedIndex = ttokFeed.items.findIndex((entry) => entry.record.id === item.id || entry.record.src === item.src);
        if (document.body.classList.contains('ttok-mode') && feedIndex >= 0) {
          scrollTtokTo(feedIndex);
        } else if (item.albumId) {
          void openAlbum(String(item.albumId));
        } else if (item.src) {
          window.open(`/api/video?url=${encodeURIComponent(item.src)}`, '_blank', 'noopener');
        }
      }
    });
  });
}

function createSuggestionChips() {
  const suggestions = [
    { label: 'Álbuns recentes', section: 'new', sort: 'new' },
    { label: 'Álbuns com vídeos', filter: 'video' },
    { label: 'Álbuns com fotos', filter: 'photo' },
    { label: 'Álbuns com vários vídeos', filter: 'multi-video' },
    { label: 'Pesquisar Brasil', query: 'brasil' },
    { label: 'Feed TTOK BR', section: 'ttok-br' },
  ];
  const container = $('#search-suggestions');
  if (!container) return;
  container.innerHTML = suggestions.map((suggestion) => `
    <button type="button" class="search-chip"
      data-query="${escapeHtml(suggestion.query || '')}"
      data-section="${escapeHtml(suggestion.section || '')}"
      data-sort="${escapeHtml(suggestion.sort || '')}"
      data-filter="${escapeHtml(suggestion.filter || 'all')}">${escapeHtml(suggestion.label)}</button>
  `).join('');
  container.querySelectorAll('.search-chip').forEach((button) => {
    button.addEventListener('click', () => {
      const q = button.dataset.query || '';
      state.query = q;
      state.profile = '';
      state.section = button.dataset.section || 'hot';
      state.sort = button.dataset.sort || (state.section === 'new' ? 'new' : 'relevance');
      state.page = 1;
      state.filter = button.dataset.filter || 'all';
      state.resultMode = 'albums';
      if (state.section === 'ttok-br') {
        state.query = '';
        state.filter = 'all';
      }
      document.querySelectorAll('#listing-view .filter').forEach((filterButton) => {
        filterButton.classList.toggle('active', filterButton.dataset.filter === state.filter);
      });
      $('#search-input').value = q;
      loadListing();
    });
  });
}

function typeLabel(album) {
  if (album.mediaType === 'mixed') return 'Fotos + vídeos';
  if (album.mediaType === 'video') return `${album.videos ?? ''} vídeo(s)`;
  if (album.mediaType === 'photo') return `${album.photos ?? ''} foto(s)`;
  return 'Álbum';
}

function filteredAlbums() {
  let albums = state.albums.filter((album) => {
    if (state.filter === 'all') return true;
    if (state.filter === 'video') return Number(album.videos) > 0 || ['video', 'mixed'].includes(album.mediaType);
    if (state.filter === 'photo') return Number(album.photos) > 0 || ['photo', 'mixed'].includes(album.mediaType);
    if (state.filter === 'multi-video') return Number.isFinite(album.videos) && album.videos >= 2;
    if (state.filter === 'unknown') return !Number.isFinite(album.videos) && !Number.isFinite(album.photos);
    return false;
  });
  if (state.sort === 'views') {
    albums = [...albums].sort((a, b) => (b.viewsCount ?? -1) - (a.viewsCount ?? -1));
  } else if (state.sort === 'new' && (state.query || state.profile) && albums.length && albums.every((album) => album.publishedAt)) {
    albums = [...albums].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
  }
  return albums;
}

function canSortByViews() {
  return state.albums.some((album) => Number.isFinite(album.viewsCount));
}

function canSortByDate() {
  const albums = filteredAlbums();
  return albums.length > 0 && albums.every((album) => album.publishedAt && Number.isFinite(Date.parse(album.publishedAt)));
}

function getNavigationDescriptor() {
  if (state.profile || ['ttok', 'ttok-br', 'videos-br'].includes(state.section)) return null;
  if (state.query) {
    return {
      source: 'search',
      section: state.section === 'new' ? 'new' : 'hot',
      query: state.query,
      sort: state.sort,
    };
  }
  return {
    source: 'explore',
    section: state.section === 'new' ? 'new' : 'hot',
    query: '',
    sort: state.sort,
  };
}

function ensureNavigationContext() {
  const descriptor = getNavigationDescriptor();
  if (!descriptor) {
    state.navigationContext = null;
    return null;
  }
  const key = [descriptor.source, descriptor.section, descriptor.query, descriptor.sort].join('|');
  if (state.navigationContext?.key !== key) {
    state.navigationContext = {
      ...descriptor,
      key,
      pages: new Map(),
      visitedListingUrls: new Set(),
      albumIds: [],
      albumsById: new Map(),
      loadedAlbumIds: new Set(),
      failedAlbumIds: new Set(),
      nextUrl: '',
      loadingPage: false,
      activeAlbumId: '',
      listingScrollY: window.scrollY,
      pageError: '',
    };
  }
  return state.navigationContext;
}

function canonicalPageUrl(value) {
  try {
    const url = new URL(value);
    url.hash = '';
    url.searchParams.sort();
    return url.href;
  } catch {
    return '';
  }
}

function recordNavigationPage(data) {
  const context = state.navigationContext;
  if (!context) return;
  if (data.sourceUrl) context.visitedListingUrls.add(canonicalPageUrl(data.sourceUrl));
  context.pageError = '';
  const page = Number(data.page) || state.page;
  context.pages.set(page, { albums: data.albums || [], next: data.next || '' });
  const uniqueIds = new Set();
  context.albumIds = [];
  context.albumsById.clear();
  [...context.pages.entries()].sort(([left], [right]) => left - right).forEach(([, record]) => {
    for (const album of record.albums) {
      if (!album?.id || uniqueIds.has(album.id)) continue;
      uniqueIds.add(album.id);
      context.albumIds.push(album.id);
      context.albumsById.set(album.id, album);
    }
  });
  const latestPage = Math.max(...context.pages.keys());
  context.nextUrl = context.pages.get(latestPage)?.next || '';
  if (context.nextUrl && context.visitedListingUrls.has(canonicalPageUrl(context.nextUrl))) {
    context.nextUrl = '';
    context.pageError = 'A origem repetiu um link de paginação já consultado; a sequência foi encerrada para evitar um loop.';
  }
  state.paginationStatus = context.pageError
    ? 'loop de paginação interrompido'
    : context.nextUrl
      ? 'próxima página verificada disponível'
      : 'fim da sequência atual';
}

function setListingMode(mode) {
  state.sort = mode;
  state.section = mode === 'new' ? 'new' : 'hot';
  state.page = 1;
  loadListing();
}

function listingHash() {
  if (['ttok', 'ttok-br'].includes(state.section)) {
    return `#/${state.section}`;
  }
  if (state.profile) {
    const hash = `#/profile/${encodeURIComponent(state.profile)}${state.section === 'new' ? '/new' : ''}${state.page > 1 ? '/page/' + state.page : ''}`;
    const params = new URLSearchParams();
    if (state.sort === 'views') params.set('sort', 'views');
    if (state.filter !== 'all') params.set('filter', state.filter);
    if (state.resultMode !== 'albums') params.set('mode', state.resultMode);
    return params.toString() ? `${hash}?${params}` : hash;
  }
  if (state.section === 'videos-br') {
    const hash = `#/videos-br/${state.videoTopic || 'all'}${state.page > 1 ? '/page/' + state.page : ''}`;
    const params = new URLSearchParams();
    if (state.filter !== 'all') params.set('filter', state.filter);
    if (state.resultMode !== 'albums') params.set('mode', state.resultMode);
    return params.toString() ? `${hash}?${params}` : hash;
  }
  if (state.query) {
    const params = new URLSearchParams({
      q: state.query,
      section: state.section,
      sort: state.sort,
      filter: state.filter,
      mode: state.resultMode,
    });
    if (state.page > 1) params.set('page', String(state.page));
    return `#/search?${params}`;
  }
  const hash = `#/${state.section}${state.page > 1 ? '/page/' + state.page : ''}`;
  const params = new URLSearchParams();
  if (state.sort === 'views') params.set('sort', 'views');
  if (state.filter !== 'all') params.set('filter', state.filter);
  if (state.resultMode !== 'albums') params.set('mode', state.resultMode);
  return params.toString() ? `${hash}?${params}` : hash;
}

function normalizeMediaResults(items = []) {
  const seen = new Set();
  return items.filter((item) => {
    const key = item?.src || item?.id || `${item?.type}:${item?.title || ''}`;
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function createAlbumCard(album) {
  const card = document.createElement('article');
  card.className = 'album-card';
  const isFav = isFavoriteAlbum(album.id);
  card.innerHTML = `
    <button class="album-open" type="button" aria-label="Abrir ${escapeHtml(album.title)}">
      <div class="thumb-wrap">
        <img loading="lazy" src="${escapeHtml(album.thumbnail || '')}" alt="${escapeHtml(album.title)}">
        <span class="type-badge">${escapeHtml(typeLabel(album))}</span>
        ${album.views ? `<span class="views-badge">◉ ${escapeHtml(album.views)}</span>` : ''}
      </div>
      <div class="card-info">
        <div class="card-title">${escapeHtml(album.title)}</div>
      </div>
    </button>
    <div class="card-actions">
      <button class="favorite-button" type="button" data-album-favorite-id="${escapeHtml(String(album.id || ''))}" aria-label="Favoritar ${escapeHtml(album.title)}">${isFav ? '★ Salvo' : '☆ Favoritar'}</button>
      <a class="card-user" href="#/profile/${encodeURIComponent(album.user || '')}">${album.user ? '@' + escapeHtml(album.user) : 'Usuário não identificado'}</a>
    </div>
  `;
  card.querySelector('img').addEventListener('error', (event) => { event.currentTarget.style.visibility = 'hidden'; });
  card.querySelector('.album-open').addEventListener('click', () => openAlbum(album.id));
  card.querySelector('[data-album-favorite-id]').addEventListener('click', (event) => {
    event.stopPropagation();
    toggleFavorite({ id: album.id, type: 'album', title: album.title, user: album.user || '', thumbnail: album.thumbnail || '' });
  });
  const userLink = card.querySelector('.card-user');
  if (!album.user) userLink.removeAttribute('href');
  renderAlbumFavoriteButtons();
  return card;
}

function renderMediaResultTiles(items = []) {
  const target = $('#album-grid');
  target.innerHTML = '';

  if (!items.length) {
    setStatus(state.albums.length ? 'Nenhuma mídia corresponde ao filtro atual.' : 'Nenhum resultado encontrado. Tente outro termo.');
    return;
  }

  setStatus('');
  items.forEach((item) => {
    const figure = document.createElement('figure');
    figure.className = 'media-item media-result';
    const videoSrc = item.type === 'video' ? `/api/video?url=${encodeURIComponent(item.src)}` : '';

    if (item.type === 'video') {
      figure.innerHTML = `<video controls preload="metadata" playsinline webkit-playsinline poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(videoSrc)}"><source src="${escapeHtml(videoSrc)}" type="video/mp4">Seu navegador não consegue reproduzir este vídeo.</video><figcaption>${escapeHtml(item.albumTitle || 'Vídeo')} · <a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer">arquivo original</a></figcaption>`;
      const video = figure.querySelector('video');
      video.addEventListener('error', () => {
        const caption = figure.querySelector('figcaption');
        caption.textContent = 'Não foi possível reproduzir no navegador. Tente abrir o arquivo original.';
      });
    } else {
      figure.innerHTML = `<a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${escapeHtml(item.src)}" alt="${escapeHtml(item.albumTitle || 'Mídia')}"></a><figcaption>${escapeHtml(item.albumTitle || 'Foto')} · abrir em tamanho original</figcaption>`;
    }

    target.append(figure);
  });
}

function renderAlbums() {
  grid.classList.remove('ttok-feed');

  if (state.resultMode === 'media') {
    const media = state.mediaResults.filter((item) => state.filter === 'all' || item.type === state.filter);
    $('#result-label').textContent = `${media.length} mídias${state.query ? ` · Pesquisa: ${state.query}` : state.profile ? ` · Perfil: ${state.profile}` : ''}`;
    renderMediaResultTiles(media);
    return;
  }

  const albums = filteredAlbums();
  grid.innerHTML = '';
  $('#result-label').textContent = `${albums.length} álbum(ns)${state.query ? ` · Pesquisa: ${state.query}` : state.profile ? ` · Perfil: ${state.profile}` : ''}${state.sort === 'views' ? ' · mais vistos nesta página' : ''}`;

  if (!albums.length) {
    setStatus(state.albums.length ? 'Nenhum álbum corresponde a esse filtro.' : 'Nenhum resultado encontrado. Tente outro termo.');
    return;
  }

  const sortNotice = state.sort === 'new' && (state.query || state.profile) && !canSortByDate()
    ? 'A origem não fornece datas confiáveis suficientes para ordenar estes resultados por data. Exibindo a ordem original da origem.'
    : state.sort === 'new' && (state.query || state.profile)
      ? 'Mais recentes nesta página, com base nas datas explícitas disponíveis; isso não altera a ordem global da origem.'
      : '';
  setStatus(sortNotice);
  albums.forEach((album) => grid.append(createAlbumCard(album)));
}

async function hydrateMediaResults(requestId = state.listingRequestId) {
  const mediaRequestId = ++state.mediaRequestId;
  const albums = state.albums || [];
  if (state.resultMode !== 'media' || requestId !== state.listingRequestId) {
    state.mediaResults = [];
    return;
  }

  const albumIds = [...new Set(albums.map((album) => album.id).filter(Boolean))].slice(0, 12);
  if (!albumIds.length) {
    state.mediaResults = [];
    renderAlbums();
    return;
  }

  const collected = [];
  for (const albumId of albumIds) {
    if (requestId !== state.listingRequestId || mediaRequestId !== state.mediaRequestId || state.resultMode !== 'media') return;
    try {
      const response = await fetch(`/api/album?id=${encodeURIComponent(albumId)}`);
      const album = await response.json();
      if (!response.ok || !album?.media) continue;
      const albumRef = albums.find((entry) => entry.id === albumId);
      for (const item of album.media) {
        collected.push({ ...item, albumTitle: album.title || albumRef?.title || 'Mídia' });
      }
    } catch {
      continue;
    }
  }

  if (requestId !== state.listingRequestId || mediaRequestId !== state.mediaRequestId || state.resultMode !== 'media') return;
  state.mediaResults = normalizeMediaResults(collected).slice(0, 60);
  renderAlbums();
}

function getVideoTopicQuery() {
  return VIDEO_TOPICS[state.videoTopic]?.query || VIDEO_TOPICS.all.query;
}

function renderTopicTabs() {
  const toolbar = $('#video-topic-toolbar');
  const shouldShow = state.section === 'videos-br';
  toolbar.hidden = !shouldShow;
  document.querySelectorAll('.video-topic').forEach((button) => button.classList.toggle('active', button.dataset.topic === state.videoTopic));
}

function renderQueryFilters() {
  const queryFilters = $('#query-filters');
  const isTTok = ['ttok', 'ttok-br'].includes(state.section);
  const hasContext = Boolean(state.query || state.profile) && state.section !== 'videos-br' && !isTTok;
  queryFilters.hidden = !hasContext;
  $('#listing-album-filters').hidden = hasContext || isTTok;
  $('.sort-control').hidden = hasContext || isTTok;
  document.querySelectorAll('.query-order').forEach((button) => {
    const activeMode = state.sort === 'new' ? 'new' : state.sort === 'views' ? 'views' : 'relevance';
    button.classList.toggle('active', button.dataset.order === activeMode);
    button.disabled = button.dataset.order === 'views' && !canSortByViews() && state.albums.length > 0;
  });
}

function formatVideoTime(value) {
  if (!Number.isFinite(value) || value < 0) return '--:--';
  const seconds = Math.floor(value);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

function updateTtokControls(entry) {
  const video = entry.element.querySelector('video');
  const playButton = entry.element.querySelector('.ttok-toggle-play');
  const audioButton = entry.element.querySelector('.ttok-toggle-audio');
  const isActive = ttokFeed.items[ttokFeed.activeIndex] === entry;
  const soundSetting = $('#setting-sound-ttok');
  if (soundSetting) soundSetting.checked = !state.ttokMuted;
  if (playButton) playButton.textContent = isActive && video && !video.paused ? 'Pausar' : 'Reproduzir';
  if (audioButton) {
    audioButton.textContent = video && !video.muted && isActive ? 'Desativar áudio' : 'Ativar áudio';
    audioButton.setAttribute('aria-label', video && !video.muted && isActive ? 'Desativar áudio' : 'Ativar áudio');
  }
}

function updateTtokProgress(entry) {
  const video = entry.element.querySelector('video');
  const progress = entry.element.querySelector('.ttok-progress');
  const current = entry.element.querySelector('.ttok-time-current');
  const duration = entry.element.querySelector('.ttok-time-duration');
  if (!video || !progress || !current || !duration) return;
  const hasDuration = Number.isFinite(video.duration) && video.duration > 0;
  progress.max = hasDuration ? String(video.duration) : '0';
  progress.value = hasDuration ? String(video.currentTime || 0) : '0';
  progress.disabled = !hasDuration;
  current.textContent = formatVideoTime(video.currentTime);
  duration.textContent = formatVideoTime(video.duration);
}

function setTtokItemLoading(entry, loading) {
  if (ttokFeed.items[ttokFeed.activeIndex] !== entry) return;
  entry.element.querySelector('.ttok-loading').hidden = !loading;
}

function setTtokItemError(entry, message = '') {
  const errorBox = entry.element.querySelector('.ttok-error');
  if (!errorBox) return;
  errorBox.hidden = !message;
  errorBox.querySelector('.ttok-error-message').textContent = message;
}

function loadTtokVideoSource(entry) {
  const video = entry.element.querySelector('video');
  if (!video.src) {
    video.src = video.dataset.feedUrl;
    video.load();
  }
}

async function playActiveTtokVideo(index, token) {
  const entry = ttokFeed.items[index];
  if (!entry || index !== ttokFeed.activeIndex) return;
  const video = entry.element.querySelector('video');
  entry.playToken = token;
  loadTtokVideoSource(entry);
  video.preload = 'auto';
  video.muted = ttokFeed.muted;
  setTtokItemError(entry);
  setTtokItemLoading(entry, true);

  try {
    await video.play();
    if (token !== ttokFeed.activeToken || index !== ttokFeed.activeIndex) {
      video.pause();
      video.muted = true;
      return;
    }
    setTtokItemLoading(entry, false);
    updateTtokControls(entry);
  } catch (error) {
    if (token !== ttokFeed.activeToken || index !== ttokFeed.activeIndex) return;
    setTtokItemLoading(entry, false);
    setTtokItemError(entry, error.name === 'NotAllowedError'
      ? 'A reprodução automática com áudio foi bloqueada. Toque em Reproduzir para iniciar com áudio.'
      : 'Não foi possível iniciar este vídeo. Você pode tentar novamente ou avançar.');
    updateTtokControls(entry);
  }
}

function updateTtokPreloadWindow(activeIndex) {
  ttokFeed.items.forEach((entry, index) => {
    const video = entry.element.querySelector('video');
    if (index === activeIndex) {
      loadTtokVideoSource(entry);
      video.preload = 'auto';
      video.muted = ttokFeed.muted;
      return;
    }
    if (index === activeIndex + 1) {
      video.preload = 'metadata';
      loadTtokVideoSource(entry);
      return;
    }
    video.pause();
    video.muted = true;
    video.preload = 'none';
    if (Math.abs(index - activeIndex) > 1 && video.src) {
      video.removeAttribute('src');
      video.load();
    }
    updateTtokControls(entry);
  });
}

function activateTtokItem(index, { forcePlay = false, reload = false } = {}) {
  const entry = ttokFeed.items[index];
  if (!entry) return;
  const isSameItem = index === ttokFeed.activeIndex;

  if (!isSameItem) {
    ttokFeed.activeToken += 1;
    ttokFeed.activeIndex = index;
    ttokFeed.userPaused = false;
    ttokFeed.muted = state.ttokMuted;
    ttokFeed.items.forEach((candidate, candidateIndex) => {
      const video = candidate.element.querySelector('video');
      if (candidateIndex !== index) {
        video.pause();
        video.muted = true;
      }
      candidate.element.classList.toggle('is-active', candidateIndex === index);
      updateTtokControls(candidate);
    });
    recordHistoryVideo(entry.record);
  } else if (!forcePlay && ttokFeed.userPaused) {
    return;
  }

  const video = entry.element.querySelector('video');
  if (reload) {
    video.pause();
    video.removeAttribute('src');
    video.load();
  }
  updateTtokPreloadWindow(index);
  const token = ++ttokFeed.activeToken;
  if (state.autoplayTtok || forcePlay) {
    ttokFeed.userPaused = false;
    void playActiveTtokVideo(index, token);
  } else {
    video.pause();
    setTtokItemLoading(entry, false);
    updateTtokControls(entry);
  }
  updateUtilityFeedStatus();
}

function chooseVisibleTtokItem() {
  const visible = [...ttokFeed.ratios.entries()]
    .filter(([, ratio]) => ratio >= 0.35)
    .sort((left, right) => right[1] - left[1]);
  const best = visible[0];
  if (!best) {
    if (ttokFeed.activeIndex >= 0 && (ttokFeed.ratios.get(ttokFeed.activeIndex) || 0) < 0.1) {
      ttokFeed.activeToken += 1;
      ttokFeed.activeIndex = -1;
      ttokFeed.items.forEach((entry) => {
        const video = entry.element.querySelector('video');
        video.pause();
        video.muted = ttokFeed.muted;
        updateTtokControls(entry);
      });
    }
    return;
  }

  const [bestIndex, bestRatio] = best;
  const currentRatio = ttokFeed.ratios.get(ttokFeed.activeIndex) || 0;
  if (bestIndex !== ttokFeed.activeIndex && (currentRatio < 0.35 || bestRatio > currentRatio + 0.08)) {
    activateTtokItem(bestIndex);
  }
}

function initializeTtokObserver() {
  if ('IntersectionObserver' in window) {
    ttokFeed.observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        const index = Number(entry.target.dataset.feedIndex);
        if (Number.isInteger(index)) ttokFeed.ratios.set(index, entry.isIntersecting ? entry.intersectionRatio : 0);
      });
      chooseVisibleTtokItem();
    }, { root: grid, threshold: [0, 0.2, 0.35, 0.6, 0.85, 1] });
  }

  ttokFeed.scrollHandler = () => {
    if (!ttokFeed.observer) {
      let bestIndex = -1;
      let bestRatio = 0;
      ttokFeed.items.forEach((entry, index) => {
        const rect = entry.element.getBoundingClientRect();
        const height = Math.max(1, rect.height);
        const overlap = Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
        const ratio = overlap / height;
        ttokFeed.ratios.set(index, ratio);
        if (ratio > bestRatio) {
          bestIndex = index;
          bestRatio = ratio;
        }
      });
      if (bestIndex >= 0) activateTtokItem(bestIndex);
    }

    if (ttokFeed.hasMore && grid.scrollTop + grid.clientHeight >= grid.scrollHeight - grid.clientHeight * 1.5) {
      void fetchNextTtokBatch({ keepLoading: true });
    }
  };
  grid.addEventListener('scroll', ttokFeed.scrollHandler, { passive: true });

  ttokFeed.resizeHandler = chooseVisibleTtokItem;
  window.addEventListener('resize', ttokFeed.resizeHandler);
}

function createTtokItem(record, index) {
  const item = document.createElement('article');
  const id = String(record.id || record.src);
  const albumId = record.albumId || (record.albumUrl || '').split('/').filter(Boolean).pop() || '';
  const audioLabel = ttokFeed.muted ? 'Ativar áudio' : 'Desativar áudio';
  item.className = 'ttok-item';
  item.dataset.feedIndex = String(index);
  item.dataset.ttokId = id;
  item.dataset.ttokTitle = record.title || record.albumTitle || 'Vídeo';
  item.dataset.ttokAlbum = record.albumTitle || 'Vídeo';
  item.dataset.ttokUser = record.user || '';
  item.dataset.ttokSource = record.src;
  item.innerHTML = `
    <video playsinline webkit-playsinline loop preload="none" poster="${escapeHtml(record.poster || '')}" data-feed-url="/api/video?url=${encodeURIComponent(record.src)}" aria-label="${escapeHtml(record.albumTitle || 'Vídeo')}"></video>
    <div class="ttok-loading" role="status" aria-live="polite" hidden><span class="loading-spinner" aria-hidden="true"></span><span>Carregando vídeo…</span></div>
    <div class="ttok-error" role="alert" hidden><span class="ttok-error-message"></span><button type="button" class="ttok-retry-video">Tentar novamente</button></div>
    <div class="ttok-meta">
      <div class="ttok-meta-row">
        <div class="ttok-title-block">
          <h3>${escapeHtml(record.albumTitle || 'Vídeo')}</h3>
          <p>${record.user ? `@${escapeHtml(record.user)}` : 'Usuário não identificado'}</p>
        </div>
        <div class="ttok-controls">
          <button type="button" class="ttok-toggle-play" aria-label="Reproduzir vídeo">Reproduzir</button>
          <button type="button" class="ttok-toggle-audio" aria-label="${audioLabel}">${audioLabel}</button>
          <button type="button" class="ttok-toggle-favorite" data-favorite-id="${escapeHtml(id)}">${isFavoriteVideo(id) ? '★ Salvo' : '☆ Favoritar'}</button>
        </div>
      </div>
      <div class="ttok-progress-row">
        <span class="ttok-time-current">0:00</span>
        <input class="ttok-progress" type="range" min="0" max="0" value="0" step="0.1" aria-label="Progresso do vídeo" disabled>
        <span class="ttok-time-duration">--:--</span>
      </div>
      <div class="ttok-actions">
        ${albumId ? `<a class="ttok-open-album" href="#/album/${encodeURIComponent(albumId)}" data-album-id="${escapeHtml(albumId)}">Abrir álbum</a>` : ''}
        <span class="ttok-key-hint">↑ / ↓ navegar · Espaço pausar · M áudio</span>
      </div>
    </div>
  `;

  const video = item.querySelector('video');
  video.muted = ttokFeed.muted;
  video.addEventListener('loadeddata', () => setTtokItemLoading(ttokFeed.items[index], false));
  video.addEventListener('waiting', () => setTtokItemLoading(ttokFeed.items[index], true));
  video.addEventListener('playing', () => {
    const entry = ttokFeed.items[index];
    if (ttokFeed.activeIndex === index && entry?.playToken === ttokFeed.activeToken) {
      setTtokItemLoading(entry, false);
      updateTtokControls(entry);
    } else {
      video.pause();
      video.muted = true;
    }
  });
  video.addEventListener('pause', () => {
    const entry = ttokFeed.items[index];
    if (entry) updateTtokControls(entry);
  });
  video.addEventListener('error', () => {
    const entry = ttokFeed.items[index];
    if (entry && ttokFeed.activeIndex === index) {
      setTtokItemLoading(entry, false);
      setTtokItemError(entry, 'Falha ao carregar este vídeo. Você pode tentar novamente ou avançar.');
    }
  });
  video.addEventListener('timeupdate', () => updateTtokProgress(ttokFeed.items[index]));
  video.addEventListener('durationchange', () => updateTtokProgress(ttokFeed.items[index]));

  item.querySelector('.ttok-toggle-play').addEventListener('click', () => {
    if (ttokFeed.activeIndex !== index) {
      activateTtokItem(index, { forcePlay: true });
      return;
    }
    if (video.paused) {
      ttokFeed.userPaused = false;
      activateTtokItem(index, { forcePlay: true });
    } else {
      ttokFeed.userPaused = true;
      video.pause();
      updateTtokControls(ttokFeed.items[index]);
    }
  });
  item.querySelector('.ttok-toggle-audio').addEventListener('click', () => {
    if (ttokFeed.activeIndex !== index) {
      ttokFeed.muted = state.ttokMuted;
      activateTtokItem(index, { forcePlay: true });
    }
    ttokFeed.muted = !video.muted;
    state.ttokMuted = ttokFeed.muted;
    video.muted = ttokFeed.muted;
    persistLocalState();
    updateTtokControls(ttokFeed.items[index]);
  });
  item.querySelector('.ttok-toggle-favorite').addEventListener('click', () => {
    toggleFavorite({
      id,
      type: 'video',
      title: record.albumTitle || record.title || 'Vídeo',
      albumTitle: record.albumTitle || 'Vídeo',
      user: record.user || '',
      src: record.src,
      albumId,
    });
    item.querySelector('.ttok-toggle-favorite').textContent = isFavoriteVideo(id) ? '★ Salvo' : '☆ Favoritar';
  });

  const retryButton = item.querySelector('.ttok-retry-video');
  retryButton.addEventListener('click', () => activateTtokItem(index, { forcePlay: true, reload: true }));
  const albumLink = item.querySelector('.ttok-open-album');
  albumLink?.addEventListener('click', (event) => {
    event.preventDefault();
    if (albumId) void openAlbum(albumId);
  });
  item.querySelector('.ttok-progress').addEventListener('input', (event) => {
    if (Number.isFinite(video.duration)) video.currentTime = Number(event.currentTarget.value);
  });
  return item;
}

function appendTtokVideos(videos) {
  const shuffled = [...videos];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [shuffled[index], shuffled[swapIndex]] = [shuffled[swapIndex], shuffled[index]];
  }

  let appended = 0;
  grid.querySelector('.ttok-end')?.remove();
  for (const record of shuffled) {
    const id = String(record.id || record.src || '');
    if (!record.src || !id || ttokFeed.ids.has(id)) {
      state.duplicateMediaCount += 1;
      continue;
    }
    ttokFeed.ids.add(id);
    const index = ttokFeed.items.length;
    const entry = { record, element: createTtokItem(record, index) };
    ttokFeed.items.push(entry);
    grid.append(entry.element);
    ttokFeed.observer?.observe(entry.element);
    appended += 1;
  }
  if (ttokFeed.activeIndex >= 0) updateTtokPreloadWindow(ttokFeed.activeIndex);
  return appended;
}

function appendTtokEndMessage() {
  if (grid.querySelector('.ttok-end')) return;
  const end = document.createElement('div');
  end.className = 'ttok-end';
  end.textContent = ttokFeed.items.length
    ? 'Você chegou ao fim das páginas públicas disponíveis neste feed.'
    : 'Nenhum vídeo elegível foi encontrado nas páginas públicas disponíveis.';
  grid.append(end);
}

function updateUtilityFeedStatus() {
  $('#result-label').textContent = `${ttokFeed.items.length} vídeo(s) únicos · ${state.pagesProcessed} página(s)${ttokFeed.ended ? ' · fim do feed' : ''}`;
  renderUtilityLists();
}

function resetTtokFeed(kind) {
  ttokFeed.controller?.abort();
  ttokFeed.observer?.disconnect();
  ttokFeed.items.forEach((entry) => {
    const video = entry.element.querySelector('video');
    video.pause();
    video.muted = true;
  });
  if (ttokFeed.scrollHandler) grid.removeEventListener('scroll', ttokFeed.scrollHandler);
  if (ttokFeed.resizeHandler) window.removeEventListener('resize', ttokFeed.resizeHandler);
  ttokFeed.kind = kind;
  ttokFeed.sessionId = '';
  ttokFeed.items = [];
  ttokFeed.ids = new Set();
  ttokFeed.hasMore = true;
  ttokFeed.ended = false;
  ttokFeed.loading = false;
  ttokFeed.activeIndex = -1;
  ttokFeed.activeToken += 1;
  ttokFeed.userPaused = false;
  ttokFeed.muted = state.ttokMuted;
  ttokFeed.ratios = new Map();
  ttokFeed.controller = null;
  ttokFeed.scrollHandler = null;
  ttokFeed.resizeHandler = null;
  ttokFeed.error = '';
  state.pagesProcessed = 0;
  state.validMediaCount = 0;
  state.duplicateMediaCount = 0;
  state.fallbackQueriesProcessed = 0;
  state.fallbackQueriesTotal = 0;
  state.paginationStatus = 'iniciando';
  ttokFeed.observer = null;
}

async function fetchNextTtokBatch({ keepLoading = true } = {}) {
  if (ttokFeed.loading || !ttokFeed.hasMore || !ttokFeed.kind) return;
  ttokFeed.loading = true;
  ttokFeed.error = '';
  state.paginationStatus = 'buscando páginas';
  $('#feed-retry').hidden = true;
  setStatus(ttokFeed.items.length ? 'Buscando mais vídeos em segundo plano…' : 'Buscando o primeiro vídeo válido…');
  updateUtilityFeedStatus();

  try {
    do {
      if (!document.body.classList.contains('ttok-mode')) return;
      const controller = new AbortController();
      ttokFeed.controller = controller;
      const params = new URLSearchParams({ kind: ttokFeed.kind });
      if (ttokFeed.sessionId) params.set('session', ttokFeed.sessionId);
      const response = await fetch(`/api/feed?${params}`, { signal: controller.signal });
      const data = await response.json();
      if (data.sessionId) ttokFeed.sessionId = data.sessionId;

      if (!response.ok) {
        if (response.status === 410) ttokFeed.sessionId = '';
        throw new Error(data.error || 'Falha ao carregar novos vídeos.');
      }

      state.pagesProcessed = Number(data.pagesProcessed || 0);
      state.validMediaCount = Number(data.validMediaCount || 0);
      state.duplicateMediaCount = Number(data.duplicateMediaCount || 0);
      state.fallbackQueriesProcessed = Number(data.fallbackQueriesProcessed || 0);
      state.fallbackQueriesTotal = Number(data.fallbackQueriesTotal || 0);
      state.paginationStatus = data.ended
        ? 'fim das páginas e tópicos acessíveis'
        : state.fallbackQueriesProcessed
          ? `tópico de descoberta ${state.fallbackQueriesProcessed}/${state.fallbackQueriesTotal}`
          : 'há mais páginas verificadas';
      const appended = appendTtokVideos(Array.isArray(data.videos) ? data.videos : []);
      ttokFeed.hasMore = Boolean(data.hasMore);
      ttokFeed.ended = Boolean(data.ended);
      updateUtilityFeedStatus();

      if (ttokFeed.activeIndex < 0 && ttokFeed.items.length) activateTtokItem(0);
      if (ttokFeed.ended) appendTtokEndMessage();
      if (appended) {
        setStatus('');
        return;
      }
      if (!ttokFeed.hasMore) {
        state.paginationStatus = 'fim das páginas';
        setStatus(ttokFeed.items.length
          ? 'Fim das páginas acessíveis; os vídeos anteriores continuam disponíveis para voltar.'
          : 'Nenhum vídeo elegível foi encontrado nas páginas públicas disponíveis.');
        return;
      }

      state.paginationStatus = `varredura em andamento · ${state.pagesProcessed} página(s)`;
      setStatus(`Procurando vídeos elegíveis… ${state.pagesProcessed} página(s) verificadas.`);
      updateUtilityFeedStatus();
      if (!keepLoading) return;
      await new Promise((resolve) => setTimeout(resolve, 180));
    } while (ttokFeed.hasMore);
  } catch (error) {
    if (error.name === 'AbortError') return;
    ttokFeed.error = error.message || 'Falha ao carregar novos vídeos.';
    state.lastRequestError = ttokFeed.error;
    state.paginationStatus = 'falha; nova tentativa disponível';
    setStatus(ttokFeed.error, 'error');
    $('#feed-retry').hidden = false;
    updateUtilityFeedStatus();
  } finally {
    ttokFeed.loading = false;
    ttokFeed.controller = null;
    if (ttokFeed.hasMore && !ttokFeed.error) {
      const remaining = ttokFeed.items.length - Math.max(0, ttokFeed.activeIndex);
      if (remaining <= 2) window.setTimeout(() => void fetchNextTtokBatch({ keepLoading: true }), 200);
    }
    updateUtilityFeedStatus();
  }
}

async function loadTTokFeed() {
  const kind = state.section === 'ttok-br' ? 'ttok-br' : 'ttok';
  resetTtokFeed(kind);
  document.body.classList.add('ttok-mode');
  syncTopbarHeight();
  grid.classList.add('ttok-feed');
  grid.innerHTML = '';
  $('#pagination').hidden = true;
  $('#result-label').textContent = kind === 'ttok-br' ? 'Feed TTOK BR' : 'Feed TTOK';
  $('#feed-retry').hidden = true;
  initializeTtokObserver();
  await fetchNextTtokBatch({ keepLoading: true });
}

function scrollTtokTo(index) {
  const entry = ttokFeed.items[index];
  if (entry) entry.element.scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function handleTtokKeyboard(event) {
  if (!document.body.classList.contains('ttok-mode') || !ttokFeed.items.length) return;
  const target = event.target;
  const tag = target?.tagName;
  if (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A'].includes(tag) || target?.isContentEditable) return;

  const active = Math.max(0, ttokFeed.activeIndex);
  if (event.key === 'ArrowDown' || event.key === 'PageDown') {
    event.preventDefault();
    if (active + 1 < ttokFeed.items.length) scrollTtokTo(active + 1);
    else if (ttokFeed.hasMore) {
      void fetchNextTtokBatch({ keepLoading: true }).then(() => scrollTtokTo(active + 1));
    }
    return;
  }
  if (event.key === 'ArrowUp' || event.key === 'PageUp') {
    event.preventDefault();
    if (active > 0) scrollTtokTo(active - 1);
    return;
  }
  if (event.code === 'Space' || event.key === ' ') {
    event.preventDefault();
    const entry = ttokFeed.items[active];
    const video = entry?.element.querySelector('video');
    if (!video) return;
    if (video.paused) {
      ttokFeed.userPaused = false;
      activateTtokItem(active, { forcePlay: true });
    } else {
      ttokFeed.userPaused = true;
      video.pause();
      updateTtokControls(entry);
    }
    return;
  }
  if (event.key.toLowerCase() === 'm') {
    const entry = ttokFeed.items[active];
    const video = entry?.element.querySelector('video');
    if (!video) return;
    ttokFeed.muted = !video.muted;
    state.ttokMuted = ttokFeed.muted;
    video.muted = ttokFeed.muted;
    persistLocalState();
    updateTtokControls(entry);
  }
}

async function loadListing({ push = true } = {}) {
  if (state.route === 'album') {
    state.albumController?.abort();
    stopAlbumSequence();
  }
  state.route = state.profile ? 'profile' : 'listing';
  showListing();
  state.lastRequest = `${state.section} / ${state.query || 'explore'}`;
  state.lastRequestError = null;

  const isVideosBr = state.section === 'videos-br';
  const isTTok = ['ttok', 'ttok-br'].includes(state.section);
  if (isTTok) {
    state.navigationContext = null;
    state.restoreListingScroll = false;
  } else {
    ensureNavigationContext();
    resetTtokFeed('');
    document.body.classList.remove('ttok-mode');
    syncTopbarHeight();
    grid.classList.remove('ttok-feed');
    $('#feed-retry').hidden = true;
  }
  $('#page-title').textContent = state.profile ? `Perfil: ${state.profile}` : state.query ? `Pesquisa: ${state.query}` : isVideosBr ? 'Vídeos BR' : isTTok ? (state.section === 'ttok-br' ? 'TTOK BR' : 'TTOK') : state.section === 'new' ? 'Novos álbuns' : 'Explore';
  $('#page-subtitle').textContent = state.profile ? 'Álbuns e mídias publicados por este perfil.' : state.query ? state.sort === 'new' ? 'Pesquisa atual; resultados recentes somente quando há datas explícitas disponíveis.' : state.sort === 'views' ? 'Pesquisa atual; popularidade ordenada pelos contadores de visualizações disponíveis.' : 'Resultados da pesquisa na ordem fornecida pela origem.' : isVideosBr ? 'Resultados por tópico brasileiro.' : isTTok ? 'Feed vertical de vídeos válidos coletados do fluxo de álbuns compartilhado.' : state.section === 'new' ? 'Os álbuns mais recentes disponíveis no Explorar.' : 'Explore álbuns disponíveis na origem.';

  renderTopicTabs();
  renderQueryFilters();
  document.querySelectorAll('[data-section]').forEach((button) => button.classList.toggle('active', button.dataset.section === state.section));
  document.querySelectorAll('.mode-toggle').forEach((button) => button.classList.toggle('active', button.dataset.mode === state.resultMode));
  $('#search-input').value = state.query;
  state.albums = [];
  state.mediaResults = [];
  state.mediaRequestId += 1;
  grid.innerHTML = '';
  setStatus('Carregando…');
  $('#pagination').hidden = true;

  if (isTTok) {
    if (push) history.pushState({ route: 'listing' }, '', listingHash());
    await loadTTokFeed();
    return;
  }

  const params = new URLSearchParams({ page: String(state.page) });
  let endpoint = '/api/listing';

  if (state.profile) {
    endpoint = '/api/profile';
    params.set('username', state.profile);
  } else {
    params.set('section', state.section);
    if (isVideosBr) {
      params.set('kind', 'videos-br');
      params.set('topic', state.videoTopic || 'all');
      params.set('q', getVideoTopicQuery());
    } else if (state.query) {
      params.set('kind', 'search');
      params.set('q', state.query);
    }
  }
  params.set('sort', state.sort);

  if (state.activeFetch) state.activeFetch.abort();
  const controller = new AbortController();
  state.activeFetch = controller;
  const requestId = ++state.listingRequestId;
  if (push) {
    history.pushState({ route: state.profile ? 'profile' : 'listing' }, '', listingHash());
  }

  try {
    const response = await fetch(`${endpoint}?${params}`, { signal: controller.signal });
    const data = await response.json();
    if (requestId !== state.listingRequestId) return;
    if (!response.ok) throw new Error(data.error || 'Falha ao carregar álbuns.');

    state.albums = data.albums || [];
    state.pagesProcessed += 1;
    recordNavigationPage(data);
    renderQueryFilters();
    if (state.resultMode === 'media') {
      await hydrateMediaResults(requestId);
    } else {
      renderAlbums();
    }

    const pagination = $('#pagination');
    pagination.hidden = !(data.next || data.prev);
    $('#prev-page').disabled = !data.prev;
    $('#next-page').disabled = !data.next;
    $('#page-number').textContent = `Página ${state.page}`;
    $('#prev-page').dataset.url = data.prev || '';
    $('#next-page').dataset.url = data.next || '';

    if (state.restoreListingScroll) {
      const scrollY = state.navigationContext?.listingScrollY || 0;
      requestAnimationFrame(() => window.scrollTo({ top: scrollY, behavior: 'auto' }));
      state.restoreListingScroll = false;
    }

  } catch (error) {
    if (error.name === 'AbortError') return;
    if (requestId !== state.listingRequestId) return;
    state.lastRequestError = error.message || 'Falha de requisição';
    setStatus(error.message, 'error');
    $('#result-label').textContent = 'Não foi possível carregar';
  } finally {
    if (state.activeFetch === controller) state.activeFetch = null;
  }
  renderUtilityLists();
}

async function openProfile(username) {
  if (!username) return;
  state.profile = username;
  state.query = '';
  state.page = 1;
  state.filter = 'all';
  state.sort = 'relevance';
  state.resultMode = 'albums';
  state.section = 'hot';
  state.videoTopic = 'all';
  document.querySelectorAll('#listing-view .filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'all'));
  $('#sort-select').value = 'relevance';
  await loadListing();
}

function renderComments(comments = []) {
  const section = $('#comments-section');
  const list = $('#comments-list');
  if (!Array.isArray(comments) || !comments.length) {
    section.hidden = false;
    list.innerHTML = '<p class="empty-state">Comentários indisponíveis nesta página pública.</p>';
    return;
  }

  section.hidden = false;
  list.innerHTML = '';
  comments.slice(0, 20).forEach((comment) => {
    const item = document.createElement('article');
    item.className = 'comment-item';
    item.innerHTML = `
      <header>
        <strong>${comment.authorUrl ? `<a href="${escapeHtml(comment.authorUrl)}" target="_blank" rel="noreferrer">${escapeHtml(comment.author || 'Usuário')}</a>` : escapeHtml(comment.author || 'Usuário')}</strong>
        ${comment.date ? `<time>${escapeHtml(comment.date)}</time>` : ''}
      </header>
      <p>${escapeHtml(comment.text || 'Comentário indisponível.')}</p>
      ${comment.url ? `<a class="comment-permalink" href="${escapeHtml(comment.url)}" target="_blank" rel="noreferrer">Link do comentário</a>` : ''}
    `;
    list.append(item);
  });
}

function renderAlbumTags(tags = [], target = $('#album-tags')) {
  if (!target) return;
  const validTags = (Array.isArray(tags) ? tags : []).filter((tag) => tag?.name);
  target.innerHTML = validTags.map((tag) => (
    tag.url
      ? `<a class="album-tag" href="${escapeHtml(tag.url)}" target="_blank" rel="noreferrer">${escapeHtml(tag.name)}</a>`
      : `<span class="album-tag">${escapeHtml(tag.name)}</span>`
  )).join('');
  target.hidden = !validTags.length;
}

function createAlbumSequenceSection(album) {
  const section = document.createElement('article');
  section.className = 'album-sequence-item';
  section.dataset.albumId = album.albumId || album.sourceUrl?.split('/').filter(Boolean).pop() || '';
  const mediaItems = Array.isArray(album.media) ? album.media : [];
  const gallery = mediaItems.map((item) => {
    if (item.type === 'video') {
      const playable = `/api/video?url=${encodeURIComponent(item.src)}`;
      return `<figure class="media-item"><video controls preload="metadata" playsinline webkit-playsinline poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(playable)}">Seu navegador não consegue reproduzir este vídeo.</video><figcaption>Vídeo · <a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer">abrir arquivo original</a></figcaption></figure>`;
    }
    return `<figure class="media-item"><a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${escapeHtml(item.thumbnail || item.src)}" alt="${escapeHtml(album.title || 'Mídia do álbum')}"></a><figcaption>Foto · <a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer">abrir tamanho original</a></figcaption></figure>`;
  }).join('');
  const comments = (album.comments || []).slice(0, 20).map((comment) => `
    <article class="comment-item">
      <header><strong>${comment.authorUrl ? `<a href="${escapeHtml(comment.authorUrl)}" target="_blank" rel="noreferrer">${escapeHtml(comment.author || 'Usuário')}</a>` : escapeHtml(comment.author || 'Usuário')}</strong>${comment.date ? `<time>${escapeHtml(comment.date)}</time>` : ''}</header>
      <p>${escapeHtml(comment.text || '')}</p>
      ${comment.url ? `<a class="comment-permalink" href="${escapeHtml(comment.url)}" target="_blank" rel="noreferrer">Link do comentário</a>` : ''}
    </article>
  `).join('');
  const user = album.user
    ? `<a href="#/profile/${encodeURIComponent(album.user)}">@${escapeHtml(album.user)}</a>`
    : 'Usuário não identificado';

  section.innerHTML = `
    <header class="sequence-album-heading">
      <div><p class="eyebrow">PRÓXIMO ÁLBUM</p><h2>${escapeHtml(album.title || 'Álbum')}</h2><p>Publicado por ${user}</p></div>
      <a class="source-link" href="${escapeHtml(album.sourceUrl || '')}" target="_blank" rel="noreferrer">Abrir na origem ↗</a>
    </header>
    ${album.description ? `<p class="sequence-description">${escapeHtml(album.description)}</p>` : ''}
    <div class="album-tags sequence-tags"></div>
    <div class="media-grid">${gallery || '<p class="empty-state">Nenhuma mídia identificada neste álbum.</p>'}</div>
    <section class="comments-section"><div class="related-heading"><p class="eyebrow">COMENTÁRIOS</p><h3>Discussão pública</h3></div>${comments || '<p class="empty-state">Comentários indisponíveis nesta página pública.</p>'}</section>
  `;
  renderAlbumTags(album.tags, section.querySelector('.sequence-tags'));
  return section;
}

function setAlbumSequenceStatus(message = '', kind = '') {
  const status = $('#album-sequence-status');
  status.textContent = message;
  status.className = `status ${kind}`;
  status.hidden = !message;
}

function albumRouteHash(id) {
  const returnHash = state.previousHash && !state.previousHash.startsWith('#/album/')
    ? `?return=${encodeURIComponent(state.previousHash)}`
    : '';
  return `#/album/${encodeURIComponent(id)}${returnHash}`;
}

function stopAlbumSequence() {
  state.albumSequenceObserver?.disconnect();
  state.albumSequenceController?.abort();
  state.albumSequenceObserver = null;
  state.albumSequenceController = null;
  state.albumSequenceLoading = false;
}

function observeAlbumSequence() {
  state.albumSequenceObserver?.disconnect();
  if (!('IntersectionObserver' in window)) return;
  const rootMargin = '800px 0px';
  state.albumSequenceObserver = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (entry.target.id === 'album-sequence-sentinel' && entry.isIntersecting) {
        void loadNextAlbumInSequence();
        continue;
      }
      if (!entry.isIntersecting || entry.intersectionRatio < 0.45) continue;
      const id = entry.target.dataset.albumId;
      if (!id || !state.navigationContext) continue;
      state.navigationContext.activeAlbumId = id;
      const hash = albumRouteHash(id);
      history.replaceState({ ...(history.state || {}), route: 'album', id }, '', hash);
    }
  }, { rootMargin, threshold: [0.45, 0.65] });
  document.querySelectorAll('.album-sequence-item').forEach((item) => state.albumSequenceObserver.observe(item));
  state.albumSequenceObserver.observe($('#album-sequence-sentinel'));
}

async function loadNextListingPage(context) {
  if (!context?.nextUrl || context.loadingPage) return false;
  if (context.visitedListingUrls.has(canonicalPageUrl(context.nextUrl))) {
    context.nextUrl = '';
    throw new Error('A origem repetiu um link de paginação já consultado; a sequência foi encerrada para evitar um loop.');
  }
  context.loadingPage = true;
  context.pageError = '';
  state.paginationStatus = 'carregando próxima página verificada';
  renderUtilityLists();
  try {
    const params = new URLSearchParams({
      section: context.section,
      sort: context.sort,
      next: context.nextUrl,
    });
    if (context.source === 'search') {
      params.set('kind', 'search');
      params.set('q', context.query);
    }
    const response = await fetch(`/api/listing?${params}`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar a próxima página.');
    state.pagesProcessed += 1;
    recordNavigationPage(data);
    renderUtilityLists();
    return true;
  } catch (error) {
    context.pageError = error.message || 'Falha ao carregar a próxima página.';
    state.lastRequestError = context.pageError;
    state.paginationStatus = 'erro ao carregar próxima página';
    throw error;
  } finally {
    context.loadingPage = false;
  }
}

async function loadNextAlbumInSequence() {
  const context = state.navigationContext;
  if (state.route !== 'album' || state.albumSequenceLoading || !context || !context.activeAlbumId) return;
  const currentIndex = context.albumIds.indexOf(context.activeAlbumId);
  if (currentIndex < 0) {
    setAlbumSequenceStatus('Este álbum não pertence a uma sequência Explore/Pesquisa ativa.');
    return;
  }

  state.albumSequenceLoading = true;
  $('#album-sequence-retry').hidden = true;
  let nextId = '';
  try {
    let pageAttempts = 0;
    while (!nextId && pageAttempts < 3) {
      for (let index = currentIndex + 1; index < context.albumIds.length; index += 1) {
        const candidate = context.albumIds[index];
        if (!context.loadedAlbumIds.has(candidate)) {
          nextId = candidate;
          break;
        }
      }
      if (nextId || !context.nextUrl) break;
      pageAttempts += 1;
      await loadNextListingPage(context);
    }

    if (!nextId) {
      const newerIndex = context.albumIds.indexOf(context.activeAlbumId);
      for (let index = newerIndex + 1; index < context.albumIds.length; index += 1) {
        const candidate = context.albumIds[index];
        if (!context.loadedAlbumIds.has(candidate)) {
          nextId = candidate;
          break;
        }
      }
    }

    if (!nextId) {
      if (context.nextUrl) {
        setAlbumSequenceStatus(context.pageError || 'A sequência continua; role um pouco mais ou tente novamente.');
        $('#album-sequence-retry').hidden = false;
      } else {
        setAlbumSequenceStatus('Fim das páginas disponíveis nesta sequência.');
      }
      return;
    }

    setAlbumSequenceStatus('Carregando o próximo álbum…');
    const controller = new AbortController();
    state.albumSequenceController = controller;
    const response = await fetch(`/api/album?id=${encodeURIComponent(nextId)}`, { signal: controller.signal });
    const album = await response.json();
    if (!response.ok) throw new Error(album.error || 'Não foi possível abrir o próximo álbum.');
    if (state.navigationContext !== context || state.route !== 'album') return;

    context.loadedAlbumIds.add(nextId);
    context.failedAlbumIds.delete(nextId);
    $('#album-sequence').append(createAlbumSequenceSection(album));
    observeAlbumSequence();
    setAlbumSequenceStatus('');
  } catch (error) {
    if (error.name === 'AbortError') return;
    context.pageError = error.message || 'Falha ao carregar o próximo álbum.';
    setAlbumSequenceStatus(`${context.pageError} A sequência pode ser retomada.`);
    $('#album-sequence-retry').hidden = false;
  } finally {
    state.albumSequenceLoading = false;
    state.albumSequenceController = null;
  }
}

async function restoreNavigationContext(returnHash) {
  if (!returnHash || !returnHash.startsWith('#/')) return;
  const [path, queryString = ''] = returnHash.slice(1).split('?');
  const parts = path.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });
  if (!['search', 'hot', 'new'].includes(parts[0])) return;
  const params = new URLSearchParams(queryString);
  state.profile = '';
  state.query = parts[0] === 'search' ? params.get('q') || '' : '';
  state.section = parts[0] === 'new' || params.get('section') === 'new' ? 'new' : 'hot';
  state.sort = ['new', 'views'].includes(params.get('sort')) ? params.get('sort') : state.section === 'new' ? 'new' : 'relevance';
  state.page = Number(params.get('page')) || (parts.includes('page') ? Number(parts[parts.indexOf('page') + 1]) || 1 : 1);
  ensureNavigationContext();
  const request = new URLSearchParams({ section: state.section, sort: state.sort, page: String(state.page) });
  if (state.query) {
    request.set('kind', 'search');
    request.set('q', state.query);
  }
  const response = await fetch(`/api/listing?${request}`);
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Não foi possível restaurar a sequência de navegação.');
  recordNavigationPage(data);
}

async function openAlbum(id, { returnHash = '', push = true } = {}) {
  const sourceAlbum = state.albums.find((entry) => entry.id === id)
    || state.navigationContext?.albumsById.get(id)
    || { id, title: 'Álbum' };
  if (!returnHash && state.route !== 'album') {
    returnHash = location.hash && !location.hash.startsWith('#/album/')
      ? location.hash
      : listingHash();
  }
  if (returnHash && !state.navigationContext) {
    try { await restoreNavigationContext(returnHash); } catch (error) {
      state.lastRequestError = error.message || 'Não foi possível restaurar a sequência.';
    }
  }

  resetTtokFeed('');
  stopAlbumSequence();
  state.albumController?.abort();
  const albumController = new AbortController();
  state.albumController = albumController;
  document.body.classList.remove('ttok-mode');
  syncTopbarHeight();
  grid.classList.remove('ttok-feed');
  recordHistoryAlbum(sourceAlbum);
  if (returnHash) state.previousHash = returnHash;
  if (state.route === 'listing' || state.route === 'profile') {
    if (state.navigationContext) state.navigationContext.listingScrollY = window.scrollY;
  }
  state.route = 'album';
  state.pendingAlbumId = id;
  state.currentAlbum = null;
  showAlbum();
  $('#media-grid').innerHTML = '';
  $('#album-tags').innerHTML = '';
  $('#album-title').textContent = 'Carregando álbum…';
  $('#album-user').textContent = '';
  $('#album-description').textContent = '';
  $('#media-count').textContent = '';
  $('#album-sequence').innerHTML = '';
  $('#album-sequence-retry').hidden = true;
  setAlbumSequenceStatus('');
  $('#comments-section').hidden = true;
  if (state.navigationContext?.albumIds.includes(id)) {
    state.navigationContext.activeAlbumId = id;
    state.navigationContext.loadedAlbumIds = new Set([id]);
  } else if (state.navigationContext) {
    state.navigationContext.activeAlbumId = '';
    state.navigationContext.loadedAlbumIds = new Set();
  }
  if (push) history.pushState({ route: 'album', id, returnHash: state.previousHash }, '', albumRouteHash(id));

  try {
    const response = await fetch(`/api/album?id=${encodeURIComponent(id)}`, { signal: albumController.signal });
    const albumData = await response.json();
    if (!response.ok) throw new Error(albumData.error || 'Falha ao abrir álbum.');
    if (state.albumController !== albumController || state.route !== 'album') return;

    state.currentAlbum = albumData;
    state.pendingAlbumId = '';
    $('#album-title').textContent = albumData.title;
    $('#album-user').innerHTML = albumData.user ? `Publicado por <a href="#/profile/${encodeURIComponent(albumData.user)}">@${escapeHtml(albumData.user)}</a>` : '';
    $('#album-description').textContent = albumData.description || '';
    $('#album-source').href = albumData.sourceUrl;
    renderAlbumTags(albumData.tags || []);
    renderMedia('all');
    renderComments(albumData.comments || []);
    const context = state.navigationContext;
    if (context?.activeAlbumId === id) context.loadedAlbumIds.add(id);
    observeAlbumSequence();
    void loadNextAlbumInSequence();
  } catch (error) {
    if (error.name === 'AbortError') return;
    $('#album-title').textContent = 'Não foi possível abrir o álbum';
    $('#media-count').textContent = error.message;
    setAlbumSequenceStatus('A falha não impede a navegação; tente carregar o álbum novamente.');
    $('#album-sequence-retry').hidden = false;
  } finally {
    if (state.albumController === albumController) state.albumController = null;
  }
}

function renderMedia(filter) {
  if (!state.currentAlbum) return;
  state.mediaFilter = filter;
  document.querySelectorAll('.media-filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === filter));

  const items = state.currentAlbum.media.filter((m) => filter === 'all' || m.type === filter);
  $('#media-count').textContent = `${items.length} mídia(s)`;
  const target = $('#media-grid');
  target.innerHTML = '';

  if (!items.length) {
    target.innerHTML = '<div class="status">Não há mídias identificadas para este filtro.</div>';
    return;
  }

  for (const item of items) {
    const figure = document.createElement('figure');
    figure.className = 'media-item';

    if (item.type === 'video') {
      const playableSrc = `/api/video?url=${encodeURIComponent(item.src)}`;
      figure.innerHTML = `<video controls preload="metadata" playsinline webkit-playsinline poster="${escapeHtml(item.poster || '')}" src="${escapeHtml(playableSrc)}"><source src="${escapeHtml(playableSrc)}" type="video/mp4">Seu navegador não consegue reproduzir este vídeo.</video><figcaption>Vídeo · <a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer">abrir arquivo original</a></figcaption>`;
      const video = figure.querySelector('video');
      video.addEventListener('error', () => {
        const caption = figure.querySelector('figcaption');
        caption.textContent = 'Não foi possível reproduzir neste navegador. Tente abrir o arquivo original; a origem pode restringir o acesso direto.';
      });
    } else {
      figure.innerHTML = `<a href="${escapeHtml(item.src)}" target="_blank" rel="noreferrer"><img loading="lazy" src="${escapeHtml(item.src)}" alt="Mídia do álbum"></a><figcaption>Foto · abrir em tamanho original</figcaption>`;
    }

    target.append(figure);
  }
}

$('#search-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;

  state.query = query;
  state.profile = '';
  state.page = 1;
  state.section = 'hot';
  state.filter = 'all';
  state.sort = 'relevance';
  state.resultMode = 'albums';
  state.videoTopic = 'all';
  document.querySelectorAll('#listing-view .filter').forEach((button) => button.classList.toggle('active', button.dataset.filter === 'all'));
  loadListing();
});

document.querySelectorAll('[data-section]').forEach((button) => button.addEventListener('click', () => {
  state.section = button.dataset.section;
  if (state.section === 'videos-br' || state.section === 'ttok' || state.section === 'ttok-br') {
    state.query = '';
    state.profile = '';
    state.sort = 'relevance';
  } else {
    state.sort = state.section === 'new' ? 'new' : 'relevance';
  }
  state.page = 1;
  state.filter = 'all';
  state.resultMode = 'albums';
  state.videoTopic = 'all';
  document.querySelectorAll('#listing-view .filter').forEach((node) => node.classList.toggle('active', node.dataset.filter === 'all'));
  loadListing();
}));

document.querySelectorAll('.query-order').forEach((button) => button.addEventListener('click', () => {
  const order = button.dataset.order;
  if (order === 'views' && !canSortByViews()) {
    setStatus('A origem não fornece contagens de visualizações confiáveis para ordenar estes resultados.', 'error');
    return;
  }
  state.filter = 'all';
  state.resultMode = 'albums';
  document.querySelectorAll('#query-filters .filter, #listing-album-filters .filter').forEach((filterButton) => {
    filterButton.classList.toggle('active', filterButton.dataset.filter === 'all');
  });
  setListingMode(order);
}));

document.querySelectorAll('.video-topic').forEach((button) => button.addEventListener('click', () => {
  state.videoTopic = button.dataset.topic || 'all';
  state.page = 1;
  state.resultMode = 'albums';
  renderTopicTabs();
  loadListing();
}));

document.querySelectorAll('#listing-view .filter').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  const group = button.closest('.filters');
  group.querySelectorAll('.filter').forEach((node) => node.classList.toggle('active', node === button));
  renderAlbums();
  history.pushState({ route: 'listing' }, '', listingHash());
}));

document.querySelectorAll('.mode-toggle').forEach((button) => button.addEventListener('click', () => {
  state.resultMode = button.dataset.mode;
  document.querySelectorAll('.mode-toggle').forEach((node) => node.classList.toggle('active', node === button));
  if (state.resultMode === 'media') {
    hydrateMediaResults(state.listingRequestId);
  } else {
    renderAlbums();
  }
  history.pushState({ route: 'listing' }, '', listingHash());
}));

$('.media-filters').querySelectorAll('.media-filter').forEach((button) => button.addEventListener('click', () => renderMedia(button.dataset.filter)));

$('#sort-select').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderAlbums();
  history.pushState({ route: 'listing' }, '', listingHash());
});

$('#prev-page').addEventListener('click', () => movePage('prev'));
$('#next-page').addEventListener('click', () => movePage('next'));

async function movePage(direction) {
  const href = $(`#${direction}-page`).dataset.url;
  if (!href) return;

  try {
    const url = new URL(href);
    state.page = Number(url.searchParams.get('page') || 1);
    await loadListing();
  } catch {
    setStatus('O link de paginação recebido não é válido.', 'error');
  }
}

$('#back-button').addEventListener('click', () => {
  if (history.state?.route === 'album') {
    history.back();
    return;
  }
  if (state.previousHash && location.hash !== state.previousHash) {
    location.hash = state.previousHash;
    return;
  }
  history.back();
});

$('#album-sequence-retry').addEventListener('click', () => {
  if (!state.currentAlbum && state.pendingAlbumId) {
    void openAlbum(state.pendingAlbumId, { returnHash: state.previousHash, push: false });
    return;
  }
  if (state.navigationContext) state.navigationContext.pageError = '';
  void loadNextAlbumInSequence();
});

$('#clear-history').addEventListener('click', () => {
  state.history = [];
  persistLocalState();
  renderUtilityLists();
  setStatus('Histórico local apagado.');
});

$('#feed-retry').addEventListener('click', () => {
  if (!ttokFeed.sessionId) {
    ttokFeed.hasMore = true;
    ttokFeed.ended = false;
  }
  void fetchNextTtokBatch({ keepLoading: true });
});

document.querySelectorAll('.utility-tab').forEach((button) => {
  button.addEventListener('click', () => {
    const section = button.dataset.section;
    if (section === 'settings') {
      toggleUtilityPanel('settings');
      return;
    }
    renderUtilityLists();
    toggleUtilityPanel(section, true);
    const label = section === 'favorites' ? 'Favoritos locais ativos.' : 'Histórico recente até 12 itens.';
    setStatus(label, '');
  });
});

document.querySelectorAll('[data-close-panel]').forEach((button) => {
  button.addEventListener('click', () => {
    toggleUtilityPanel('settings', false);
  });
});

$('#setting-autoplay-ttok').addEventListener('change', (event) => {
  state.autoplayTtok = event.target.checked;
  persistLocalState();
  if (document.body.classList.contains('ttok-mode') && ttokFeed.activeIndex >= 0) {
    const active = ttokFeed.items[ttokFeed.activeIndex];
    const video = active.element.querySelector('video');
    if (state.autoplayTtok && !ttokFeed.userPaused) activateTtokItem(ttokFeed.activeIndex, { forcePlay: true });
    else {
      video.pause();
      updateTtokControls(active);
    }
  }
});

$('#setting-sound-ttok').addEventListener('change', (event) => {
  state.ttokMuted = !event.target.checked;
  ttokFeed.muted = state.ttokMuted;
  persistLocalState();
  const active = ttokFeed.items[ttokFeed.activeIndex];
  if (active) {
    const video = active.element.querySelector('video');
    video.muted = state.ttokMuted;
    updateTtokControls(active);
  }
});

$('#setting-compact-cards').addEventListener('change', (event) => {
  state.compactCards = event.target.checked;
  document.body.classList.toggle('compact-cards', state.compactCards);
  persistLocalState();
});

async function refreshDiagnostics() {
  try {
    const response = await fetch('/api/health');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Não foi possível carregar o diagnóstico.');
    state.cachedPages = Number.isFinite(data.cachedPages) ? data.cachedPages : null;
    renderUtilityLists();
  } catch (error) {
    state.cachedPages = null;
    state.lastRequestError = error.message || 'Falha ao carregar o diagnóstico.';
    renderUtilityLists();
  }
}

function routeFromHash() {
  const hash = location.hash.slice(1);
  const [path, queryString = ''] = hash.split('?');
  const parts = path.split('/').filter(Boolean).map((part) => {
    try { return decodeURIComponent(part); } catch { return part; }
  });

  if (parts[0] === 'album' && parts[1]) {
    const returnHash = new URLSearchParams(queryString).get('return') || '';
    const section = [...document.querySelectorAll('.album-sequence-item')]
      .find((item) => item.dataset.albumId === parts[1]);
    if (section) {
      showAlbum();
      section.scrollIntoView({ behavior: 'smooth', block: 'start' });
      if (state.navigationContext) state.navigationContext.activeAlbumId = parts[1];
      return;
    }
    if (state.currentAlbum?.sourceUrl?.endsWith('/' + parts[1])) {
      showAlbum();
      return;
    }
    void openAlbum(parts[1], { returnHash, push: false });
    return;
  }

  if (state.route === 'album') state.restoreListingScroll = true;

  if (parts[0] === 'profile' && parts[1]) {
    const params = new URLSearchParams(queryString);
    state.profile = parts[1];
    state.query = '';
    state.section = parts[2] === 'new' ? 'new' : 'hot';
    state.sort = params.get('sort') === 'views' ? 'views' : state.section === 'new' ? 'new' : 'relevance';
    state.filter = ALBUM_FILTERS.has(params.get('filter')) ? params.get('filter') : 'all';
    state.page = parts.includes('page') ? Number(parts[parts.indexOf('page') + 1]) || 1 : 1;
    state.resultMode = params.get('mode') === 'media' ? 'media' : 'albums';
    state.videoTopic = 'all';
    loadListing({ push: false });
    return;
  }

  if (parts[0] === 'videos-br') {
    const params = new URLSearchParams(queryString);
    state.profile = '';
    state.query = '';
    state.section = 'videos-br';
    state.videoTopic = VIDEO_TOPICS[parts[1]] ? parts[1] : 'all';
    state.page = parts.includes('page') ? Number(parts[parts.indexOf('page') + 1]) || 1 : 1;
    state.filter = ALBUM_FILTERS.has(params.get('filter')) ? params.get('filter') : 'all';
    state.resultMode = params.get('mode') === 'media' ? 'media' : 'albums';
    state.sort = 'relevance';
    loadListing({ push: false });
    return;
  }

  if (parts[0] === 'ttok' || parts[0] === 'ttok-br') {
    state.profile = '';
    state.query = '';
    state.section = parts[0] === 'ttok-br' ? 'ttok-br' : 'ttok';
    state.page = 1;
    state.filter = 'all';
    state.resultMode = 'albums';
    state.sort = 'relevance';
    state.videoTopic = 'all';
    loadListing({ push: false });
    return;
  }

  if (parts[0] === 'search') {
    const params = new URLSearchParams(queryString);
    state.profile = '';
    state.query = params.get('q') || parts[1] || '';
    state.section = params.get('section') === 'new' || parts[2] === 'new' ? 'new' : 'hot';
    state.sort = ['new', 'views'].includes(params.get('sort')) ? params.get('sort') : state.section === 'new' ? 'new' : 'relevance';
    state.filter = ALBUM_FILTERS.has(params.get('filter')) ? params.get('filter') : 'all';
    state.page = Number(params.get('page')) || (parts.includes('page') ? Number(parts[parts.indexOf('page') + 1]) || 1 : 1);
    state.resultMode = params.get('mode') === 'media' ? 'media' : 'albums';
    state.videoTopic = 'all';
    loadListing({ push: false });
    return;
  }

  state.profile = '';
  state.query = '';
  state.section = parts[0] === 'new' ? 'new' : 'hot';
  const params = new URLSearchParams(queryString);
  state.sort = params.get('sort') === 'views' ? 'views' : state.section === 'new' ? 'new' : 'relevance';
  state.filter = ALBUM_FILTERS.has(params.get('filter')) ? params.get('filter') : 'all';
  state.page = parts.includes('page') ? Number(parts[parts.indexOf('page') + 1]) || 1 : 1;
  state.resultMode = params.get('mode') === 'media' ? 'media' : 'albums';
  state.videoTopic = 'all';
  loadListing({ push: false });
}

window.addEventListener('hashchange', routeFromHash);
document.addEventListener('keydown', handleTtokKeyboard);
window.addEventListener('resize', syncTopbarHeight);

loadLocalState();
createSuggestionChips();
renderUtilityLists();
refreshDiagnostics();
syncTopbarHeight();

if (location.hash) routeFromHash();
else loadListing({ push: false });
