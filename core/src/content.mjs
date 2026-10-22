// Content catalogue rules: which kinds exist, where they install, and which
// file names are acceptable. No network or disk access happens here.
import { portablePath } from './sync-plan.mjs';

export const CONTENT_KINDS = ['mod', 'modpack', 'resourcepack', 'shader', 'schematic'];

// 安装目录遵循原版约定：模组进 mods，光影进 shaderpacks，投影进 schematics。
const DIRECTORY = { mod: 'mods', resourcepack: 'resourcepacks', shader: 'shaderpacks', schematic: 'schematics' };
// Modrinth 的类目名。投影原理图没有对应类目，只能走链接或本地导入。
const PROJECT_TYPE = { mod: 'mod', modpack: 'modpack', resourcepack: 'resourcepack', shader: 'shader' };
const EXTENSIONS = {
  mod: ['.jar'],
  modpack: ['.mrpack', '.zip'],
  resourcepack: ['.zip'],
  shader: ['.zip'],
  schematic: ['.litematic', '.schem', '.nbt'],
};

export function contentKind(value) {
  if (typeof value !== 'string' || !CONTENT_KINDS.includes(value)) throw new TypeError('Unknown content kind');
  return value;
}

export function projectTypeOf(kind) {
  contentKind(kind);
  return PROJECT_TYPE[kind] ?? null;
}

export function directoryOf(kind) {
  contentKind(kind);
  return DIRECTORY[kind] ?? null;
}

/** 整合包按实例安装，其余按文件落进对应子目录。 */
export function installsAsInstance(kind) {
  return contentKind(kind) === 'modpack';
}

export function hasCatalogue(kind) {
  return projectTypeOf(kind) !== null;
}

/** 校验下载文件名，返回可直接拼接的安全名字。 */
export function contentFileName(value, kind) {
  contentKind(kind);
  const name = portablePath(value);
  if (name.includes('/')) throw new TypeError('Content files must sit at the archive root');
  const lower = name.toLowerCase();
  if (!EXTENSIONS[kind].some(extension => lower.endsWith(extension))) {
    throw new TypeError(`Unsupported ${kind} file: ${name}`);
  }
  return name;
}

/** 相对实例根目录的落盘路径，例如 mods/example.jar。 */
export function contentPath(kind, fileName) {
  const directory = directoryOf(kind);
  if (!directory) throw new TypeError('Modpacks are installed as instances, not files');
  return `${directory}/${contentFileName(fileName, kind)}`;
}

/** 搜索结果只保留能安全展示的字段，避免把上游对象直接透给界面。 */
export function projectSummary(hit) {
  if (!hit || typeof hit !== 'object') throw new TypeError('Invalid project');
  const text = (value, limit) => (typeof value === 'string' ? value.slice(0, limit) : '');
  return {
    id: text(hit.project_id, 64),
    slug: text(hit.slug, 128),
    title: text(hit.title, 200),
    description: text(hit.description, 400),
    author: text(hit.author, 100),
    downloads: Number.isSafeInteger(hit.downloads) ? hit.downloads : 0,
    follows: Number.isSafeInteger(hit.follows) ? hit.follows : 0,
    iconUrl: /^https:\/\/cdn\.modrinth\.com\//.test(hit.icon_url ?? '') ? hit.icon_url : '',
    categories: Array.isArray(hit.categories) ? hit.categories.filter(x => typeof x === 'string').slice(0, 8) : [],
  };
}

/** 从版本对象里挑出主文件，并校验扩展名是否匹配类目。 */
export function primaryFile(version, kind) {
  if (!version || !Array.isArray(version.files) || !version.files.length) throw new TypeError('Version has no files');
  const usable = version.files.filter(file => {
    try { contentFileName(file.filename, kind); return true; } catch { return false; }
  });
  if (!usable.length) throw new TypeError(`No ${kind} file in this version`);
  return usable.find(file => file.primary) ?? usable[0];
}
