import { getJSON } from './network.mjs';
import { projectTypeOf, projectSummary, primaryFile } from '../../core/src/content.mjs';

const API = 'https://api.modrinth.com/v2';
const ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const MAX_RESULTS = 50;
// 到 cdn/api 的连接经常在握手阶段超时（国内尤甚），读接口是幂等的，重试即可。
const TRANSIENT = /fetch failed|UND_ERR|ECONN|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|ECONNRESET/i;

async function fetchJSON(url, options, attempts = 3) {
  let last;
  for (let round = 0; round < attempts; round++) {
    try { return await getJSON(url, options); }
    catch (error) {
      last = error;
      const transient = TRANSIENT.test(String(error?.message)) || TRANSIENT.test(String(error?.cause?.code ?? ''));
      if (!transient || round === attempts - 1) throw error;
      await new Promise(resolve => setTimeout(resolve, 400 * (round + 1)));
    }
  }
  throw last;
}

function identifier(value) {
  if (typeof value !== 'string' || !ID.test(value)) throw new TypeError('Invalid project identifier');
  return value;
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isInteger(number) && number >= min && number <= max ? number : fallback;
}

/** 查询可选版本列表用的游戏版本与加载器，空字符串表示不过滤。 */
function filters({ gameVersion = '', loader = '' } = {}) {
  const version = typeof gameVersion === 'string' ? gameVersion.trim() : '';
  const modLoader = typeof loader === 'string' ? loader.trim() : '';
  if (version && !/^[a-zA-Z0-9._-]{1,32}$/.test(version)) throw new TypeError('Invalid game version');
  if (modLoader && !/^[a-z]{1,24}$/.test(modLoader)) throw new TypeError('Invalid loader');
  return { gameVersion: version, loader: modLoader };
}

export async function searchContent({ kind, query = '', gameVersion = '', loader = '',
  offset = 0, limit = 20, signal } = {}) {
  const type = projectTypeOf(kind);
  if (!type) throw new Error('该分类没有可浏览的公共目录');
  const text = typeof query === 'string' ? query.trim().slice(0, 100) : '';
  const filtersValue = filters({ gameVersion, loader });
  const params = new URLSearchParams({
    offset: String(bounded(offset, 0, 10000, 0)),
    limit: String(bounded(limit, 1, MAX_RESULTS, 20)),
    index: text ? 'relevance' : 'downloads',
  });
  if (text) params.set('query', text);
  const facets = [[`project_type:${type}`]];
  if (filtersValue.gameVersion) facets.push([`versions:${filtersValue.gameVersion}`]);
  if (filtersValue.loader) facets.push([`categories:${filtersValue.loader}`]);
  params.set('facets', JSON.stringify(facets));

  const data = await fetchJSON(`${API}/search?${params}`, { signal, limit: 16 * 1024 * 1024 });
  if (!data || !Array.isArray(data.hits) || !Number.isSafeInteger(data.total_hits)) {
    throw new Error('目录返回格式不符合预期');
  }
  return { total: data.total_hits, hits: data.hits.slice(0, MAX_RESULTS).map(projectSummary) };
}

function mapVersion(version, kind) {
  const file = primaryFile(version, kind);
  return {
    id: String(version.id ?? '').slice(0, 64),
    versionNumber: String(version.version_number ?? '').slice(0, 64),
    versionType: ['release', 'beta', 'alpha'].includes(version.version_type) ? version.version_type : 'release',
    published: typeof version.date_published === 'string' ? version.date_published.slice(0, 32) : '',
    downloads: Number.isSafeInteger(version.downloads) ? version.downloads : 0,
    fileName: String(file.filename).slice(0, 200),
    size: Number.isSafeInteger(file.size) ? file.size : 0,
    url: typeof file.url === 'string' ? file.url : '',
    sha1: typeof file.hashes?.sha1 === 'string' ? file.hashes.sha1 : '',
    sha512: typeof file.hashes?.sha512 === 'string' ? file.hashes.sha512 : '',
    gameVersions: Array.isArray(version.game_versions) ? version.game_versions.slice(0, 8) : [],
    loaders: Array.isArray(version.loaders) ? version.loaders.slice(0, 6) : [],
    dependencies: Array.isArray(version.dependencies) ? version.dependencies
      .filter(item => item && typeof item.project_id === 'string')
      .slice(0, 12).map(item => ({ projectId: item.project_id.slice(0, 64),
        type: ['required', 'optional', 'incompatible', 'embedded'].includes(item.dependency_type) ? item.dependency_type : 'required' })) : [],
  };
}

/** 服务端重新取一次版本，避免渲染层伪造文件地址或哈希。 */
export async function projectVersion({ projectId, versionId, kind, signal } = {}) {
  const id = identifier(projectId), vid = identifier(versionId);
  const version = await fetchJSON(`${API}/project/${id}/version/${vid}`, { signal, limit: 4 * 1024 * 1024 });
  if (!version || typeof version !== 'object') throw new Error('版本信息格式不符合预期');
  return mapVersion(version, kind);
}

export async function projectVersions({ projectId, kind, gameVersion = '', loader = '', signal } = {}) {
  const id = identifier(projectId);
  const filtersValue = filters({ gameVersion, loader });
  const params = new URLSearchParams();
  if (filtersValue.gameVersion) params.set('game_versions', JSON.stringify([filtersValue.gameVersion]));
  if (filtersValue.loader) params.set('loaders', JSON.stringify([filtersValue.loader]));

  const list = await fetchJSON(`${API}/project/${id}/version?${params}`, { signal, limit: 32 * 1024 * 1024 });
  if (!Array.isArray(list)) throw new Error('版本列表格式不符合预期');
  const versions = [];
  for (const version of list.slice(0, 40)) {
    try { versions.push(mapVersion(version, kind)); } catch { /* 该版本没有本类目可用的文件，跳过。 */ }
  }
  if (!versions.length) throw new Error('该版本下没有可用的文件，换个游戏版本或加载器试试');
  return versions;
}
