const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { Library } = require('../app/library.cjs');
const { buildNob, verifyNob, inferCode, hash } = require('../app/nob.cjs');

test('码值来自明确的文件名，不把普通书名误认为码值', () => {
  assert.equal(inferCode('10001-2.mp3'), '10001'); assert.equal(inferCode('10001_2.MP3'), '10001');
  assert.equal(inferCode('第10001页.mp3'), ''); assert.equal(inferCode('0.mp3'), '');
  assert.equal(inferCode('2147483648.mp3'), '');
});
test('同一码保留多段播放顺序，不占用未使用的中间码段，损坏成品会失败', () => {
  const tracks = [{ oid: '10002', audio: Buffer.from('音频丙') }, { oid: '10000', audio: Buffer.from('音频乙') }, { oid: '10000', audio: Buffer.from('音频甲') }];
  const built = buildNob('小狗的声音', tracks), verified = verifyNob(built.bytes, tracks);
  assert.deepEqual(built.ranges, [[10000, 10000], [10002, 10002]]);
  assert.equal(verified.points, 2); assert.equal(verified.audios, 3);
  assert.throws(() => verifyNob(built.bytes, [tracks[0], tracks[2], tracks[1]]), /音频与输入不一致/);
  const damaged = Buffer.from(built.bytes); damaged[damaged.length - 140] ^= 1;
  assert.throws(() => verifyNob(damaged, tracks), /正文校验失败/);
  assert.throws(() => buildNob('书', [{ oid: '', audio: Buffer.from('音频') }]), /点读码/);
  assert.throws(() => buildNob('书', Array.from({ length: 33 }, (_, i) => ({ oid: String(10000 + i * 2), audio: Buffer.from('音频') }))), /32 段/);
});
test('导入同名音频互不覆盖，修改和重启保留数据，移除不改原件，越界路径拒绝', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xkd-test-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'a')); await fs.mkdir(path.join(root, 'b'));
  const a = path.join(root, 'a', '10000.mp3'), b = path.join(root, 'b', '10000.mp3');
  await fs.writeFile(a, '音频甲'); await fs.writeFile(b, '音频乙');
  const before = hash(await fs.readFile(a)); const library = new Library(path.join(root, 'library')); await library.init();
  let book = await library.create('第一本书'); book = await library.importAudio(book.id, [a, b]);
  assert.equal(book.tracks.length, 2); assert.notEqual(book.tracks[0].id, book.tracks[1].id);
  assert.notEqual(hash(await fs.readFile(await library.mediaPath(book.id, book.tracks[0].id))), hash(await fs.readFile(await library.mediaPath(book.id, book.tracks[1].id))));
  await assert.rejects(() => library.update(book.id, { title: '书', tracks: book.tracks.map(row => ({ ...row, oid: 'abc' })) }), /点读码/);
  assert.equal((await library.get(book.id)).title, '第一本书');
  book = await library.update(book.id, { title: '重命名的书', tracks: [...book.tracks].reverse() });
  const reopened = new Library(path.join(root, 'library')); await reopened.init();
  assert.equal((await reopened.list())[0].title, '重命名的书');
  assert.deepEqual((await reopened.get(book.id)).tracks.map(row => row.id), book.tracks.map(row => row.id));
  await library.removeTrack(book.id, book.tracks[0].id); assert.equal((await library.get(book.id)).tracks.length, 1);
  assert.equal(hash(await fs.readFile(a)), before);
  await assert.rejects(() => library.get('../a'), /无效/);
  await assert.rejects(() => library.inside('../a'), /超出/);
  await fs.symlink(path.join(root, 'a'), path.join(library.root, 'outside'));
  await assert.rejects(() => library.inside('outside/10000.mp3'), /超出/);
});
