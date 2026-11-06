const fs = require('node:fs/promises');
const { constants } = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { inferCode, oidValue } = require('./nob.cjs');

const ID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireId(id) { if (typeof id !== 'string' || !ID.test(id)) throw new Error('无效的书籍或音频编号'); return id; }
function titleText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 150) throw new Error('书名请填写 1 至 150 个字符');
  return value.trim();
}
class Library {
  constructor(root) { this.root = path.resolve(root); }
  async init() { await fs.mkdir(this.root, { recursive: true }); this.root = await fs.realpath(this.root); }
  async inside(relative, mustExist = true) {
    // @CfSecAICode 遵循消费金融安全编码 BE-FILE-002 规范: 内部相对路径须位于资料库内，解析真实路径后再次检查，拒绝符号链接逃逸。
    const target = path.resolve(this.root, relative);
    const contained = p => { const r = path.relative(this.root, p); return r !== '..' && !r.startsWith('..' + path.sep) && !path.isAbsolute(r); };
    if (!contained(target)) throw new Error('文件路径超出资料库');
    const real = await fs.realpath(mustExist ? target : path.dirname(target));
    if (!contained(real)) throw new Error('文件路径超出资料库');
    return mustExist ? real : path.join(real, path.basename(target));
  }
  async get(id) {
    requireId(id);
    const book = JSON.parse(await fs.readFile(await this.inside(`${id}/book.json`), 'utf8'));
    if (book.id !== id || !Array.isArray(book.tracks)) throw new Error('书籍记录损坏');
    return book;
  }
  async save(book) {
    requireId(book.id);
    book.updatedAt = new Date().toISOString();
    const target = await this.inside(`${book.id}/book.json`, false);
    const temporary = await this.inside(`${book.id}/${randomUUID()}.tmp`, false);
    await fs.writeFile(temporary, JSON.stringify(book, null, 2) + '\n', { flag: 'wx' });
    await fs.rename(temporary, target);
    return book;
  }
  async list() {
    const books = [];
    for (const entry of await fs.readdir(this.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !ID.test(entry.name)) continue;
      books.push(await this.get(entry.name));
    }
    return books.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  async create(title) {
    const id = randomUUID();
    await fs.mkdir(await this.inside(id, false));
    return this.save({ id, title: titleText(title), createdAt: new Date().toISOString(), tracks: [], exports: [] });
  }
  async importAudio(id, files) {
    const book = await this.get(id);
    // 外部输入由主进程系统文件选择框授权。复制到独立 UUID 文件名，源文件仅只读。
    const imported = [];
    try {
      for (const file of [...files].sort((a, b) => path.basename(a).localeCompare(path.basename(b), 'zh-CN', { numeric: true }))) {
        const real = await fs.realpath(file), stat = await fs.stat(real);
        if (!stat.isFile() || !/\.mp3$/i.test(real) || !stat.size) throw new Error('请导入非空的 MP3 文件');
        const trackId = randomUUID();
        const target = await this.inside(`${id}/${trackId}.mp3`, false);
        await fs.copyFile(real, target, constants.COPYFILE_EXCL); imported.push(target);
        book.tracks.push({ id: trackId, name: path.basename(file), label: path.basename(file, path.extname(file)), oid: inferCode(path.basename(file)), size: stat.size });
      }
      return await this.save(book);
    } catch (error) { for (const file of imported) await fs.unlink(file).catch(() => {}); throw error; }
  }
  async update(id, draft) {
    const book = await this.get(id);
    if (!draft || !Array.isArray(draft.tracks) || draft.tracks.length !== book.tracks.length) throw new Error('音频列表已变化，请重新打开书籍');
    const byId = new Map(book.tracks.map(t => [t.id, t])), seen = new Set();
    const tracks = draft.tracks.map(row => {
      if (!byId.has(row.id) || seen.has(row.id)) throw new Error('音频列表有重复或无效编号');
      seen.add(row.id);
      const oid = String(row.oid ?? '').trim();
      if (oid) oidValue(oid);
      return { ...byId.get(row.id), oid: oid ? String(oidValue(oid)) : '', label: String(row.label ?? '').slice(0, 150) };
    });
    book.title = titleText(draft.title); book.tracks = tracks;
    return this.save(book);
  }
  async removeTrack(id, trackId) {
    const book = await this.get(id); requireId(trackId);
    if (!book.tracks.some(t => t.id === trackId)) throw new Error('音频不存在');
    book.tracks = book.tracks.filter(t => t.id !== trackId);
    // 先持久化引用移除，文件清理失败也不会破坏其余书籍。
    await this.save(book);
    await fs.unlink(await this.inside(`${id}/${trackId}.mp3`));
    return book;
  }
  async mediaPath(id, trackId) {
    const book = await this.get(id); requireId(trackId);
    if (!book.tracks.some(t => t.id === trackId)) throw new Error('音频不存在');
    return this.inside(`${id}/${trackId}.mp3`);
  }
  async publicBook(book) {
    const result = structuredClone(book);
    for (const track of result.tracks) track.url = `xkd-media://audio/${book.id}/${track.id}`;
    return result;
  }
}
module.exports = { Library, requireId, titleText };
