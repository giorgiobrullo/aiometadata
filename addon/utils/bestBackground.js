/**
 * Background art from whichever provider has the best one.
 *
 * An art provider setting names one source, and one source's best is not always the best
 * there is: TMDB keeps originals up to 3840x2160 for most titles, but a new anime can have
 * nothing there but an upscaled 1709px backdrop while TheTVDB holds a clean 1920x1080 one.
 * With the background provider set to 'best', every source that knows the title is asked,
 * only text-free images are kept (a background sits under the client's own logo and
 * title), and the widest wins; between two of the same width the better rated one does.
 * When no source has a text-free background the caller's own pick stands.
 */
const consola = require('consola');
const tmdb = require('../lib/getTmdb');
const tvdb = require('../lib/tvdb');
const fanart = require('./fanart');
const { resolveAllIds } = require('../lib/id-resolver');
const { tmdbImageUrl, tmdbBackdropSize } = require('./tmdbImageSize');

const logger = consola.withTag('BestBackground');

// Fanart.tv only accepts backgrounds of exactly 1920x1080 and does not report a size.
const FANART_BACKGROUND_WIDTH = 1920;

// TheTVDB artwork types for a background.
const TVDB_SERIES_BACKGROUND = 3;
const TVDB_MOVIE_BACKGROUND = 15;

// The order a tie in width and rating is broken in.
const PROVIDER_RANK = { tmdb: 0, tvdb: 1, fanart: 2 };

/**
 * Whether an image's language marks it as carrying no text: TMDB uses null or 'xx',
 * TheTVDB null, Fanart.tv '' or '00'.
 */
function isTextless(language) {
  return language === null || language === undefined || language === '' || language === 'xx' || language === '00' || language === 'zxx';
}

async function tmdbCandidates(kind, tmdbId, config) {
  if (!tmdbId) return [];
  const params = { id: tmdbId, include_image_language: 'xx,null' };
  const res = kind === 'movie' ? await tmdb.movieImages(params, config) : await tmdb.tvImages(params, config);
  return (res?.backdrops || [])
    .filter(b => b.file_path && isTextless(b.iso_639_1))
    .map(b => ({
      provider: 'tmdb',
      url: tmdbImageUrl(tmdbBackdropSize(b.width), b.file_path),
      width: b.width || 0,
      rating: b.vote_average || 0,
    }));
}

async function tvdbCandidates(kind, tvdbId, config) {
  if (!tvdbId) return [];
  const data = kind === 'movie' ? await tvdb.getMovieExtended(tvdbId, config) : await tvdb.getSeriesExtended(tvdbId, config);
  const type = kind === 'movie' ? TVDB_MOVIE_BACKGROUND : TVDB_SERIES_BACKGROUND;
  return (data?.artworks || [])
    .filter(a => a.type === type && a.image && isTextless(a.language))
    .map(a => ({ provider: 'tvdb', url: a.image, width: a.width || 0, rating: a.score || 0 }));
}

async function fanartCandidates(kind, ids, config) {
  if (!config?.apiKeys?.fanart) return [];
  const images = kind === 'movie' ? await fanart.getMovieImages(ids.tmdbId, config) : await fanart.getShowImages(ids.tvdbId, config);
  const list = kind === 'movie' ? images?.moviebackground : images?.showbackground;
  return (list || [])
    .filter(i => typeof i.url === 'string' && i.url.startsWith('http') && isTextless(i.lang))
    .map(i => ({ provider: 'fanart', url: i.url, width: FANART_BACKGROUND_WIDTH, rating: Number(i.likes) || 0 }));
}

/**
 * Orders candidates best first: widest, then better rated, then by provider.
 */
function rankCandidates(candidates) {
  return [...candidates].sort((a, b) =>
    (b.width - a.width)
    || (b.rating - a.rating)
    || ((PROVIDER_RANK[a.provider] ?? 9) - (PROVIDER_RANK[b.provider] ?? 9)));
}

/**
 * The widest text-free background any provider has for a title, or null.
 *
 * @param {{ kind: 'movie' | 'series', tmdbId?: string, tvdbId?: string }} ids
 */
async function getBestBackground({ kind, tmdbId, tvdbId }, config) {
  const ids = { tmdbId: tmdbId ? String(tmdbId) : undefined, tvdbId: tvdbId ? String(tvdbId) : undefined };
  const type = kind === 'movie' ? 'movie' : 'series';

  // Each source is keyed by its own id, so fill in the one the caller did not have.
  try {
    if (!ids.tvdbId && ids.tmdbId) {
      ids.tvdbId = (await resolveAllIds(`tmdb:${ids.tmdbId}`, type, config, null, ['tvdb']))?.tvdbId?.toString();
    } else if (!ids.tmdbId && ids.tvdbId) {
      ids.tmdbId = (await resolveAllIds(`tvdb:${ids.tvdbId}`, type, config, null, ['tmdb']))?.tmdbId?.toString();
    }
  } catch (error) {
    logger.debug(`could not map ids for ${type} tmdb=${ids.tmdbId} tvdb=${ids.tvdbId}: ${error.message}`);
  }

  const results = await Promise.allSettled([
    tmdbCandidates(kind, ids.tmdbId, config),
    tvdbCandidates(kind, ids.tvdbId, config),
    fanartCandidates(kind, ids, config),
  ]);
  const candidates = results.flatMap(r => (r.status === 'fulfilled' ? r.value : []));
  const best = rankCandidates(candidates)[0];
  if (best) {
    logger.debug(`${type} tmdb=${ids.tmdbId} tvdb=${ids.tvdbId}: ${best.provider} ${best.width}px of ${candidates.length} text-free candidates`);
  }
  return best?.url || null;
}

module.exports = { getBestBackground, rankCandidates, isTextless };
