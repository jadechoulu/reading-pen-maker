const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { validateMp3, convertBatch } = require('../app/audio.cjs');
const ffmpeg = path.resolve(__dirname, '../runtime/ffmpeg');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('MP3 只解码验证；WMA 独立按 ABR128 转换，重名及坏文件不覆盖或修改原件', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xkd-audio-')); t.after(() => fs.rm(root, { recursive: true, force: true }));
  const mp3 = path.join(root, '同名.mp3'), wma = path.join(root, '同名.wma'), bad = path.join(root, '坏文件.wma');
  for (const [file, codec, sampleRate] of [[mp3, 'libmp3lame', '48000'], [wma, 'wmav2', '44100']]) {
    execFileSync(ffmpeg, ['-nostdin', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1.1', '-ar', sampleRate, '-ac', '2', '-c:a', codec, '-b:a', '192k', file]);
  }
  await fs.writeFile(bad, 'not audio');
  const files = [mp3, wma, bad], before = await Promise.all(files.map(async p => hash(await fs.readFile(p))));
  assert.ok(await validateMp3(ffmpeg, mp3) > 1);
  assert.equal(hash(await fs.readFile(mp3)), before[0]);
  await assert.rejects(() => validateMp3(ffmpeg, wma));
  await assert.rejects(() => validateMp3(ffmpeg, bad));
  const result = await convertBatch(ffmpeg, files, root);
  assert.equal(result.succeeded, 2); assert.equal(result.failed, 1); assert.equal(result.targetKbps, 128); assert.equal(result.mode, 'ABR');
  assert.deepEqual(result.results.filter(r => r.ok).map(r => r.outputName), ['同名.mp3', '同名_2.mp3']);
  for (const row of result.results.filter(r => r.ok)) {
    const file = path.join(result.folder, row.outputName), bytes = await fs.readFile(file);
    assert.equal(hash(bytes), row.sha256); assert.ok(await validateMp3(ffmpeg, file) > 1);
    assert.ok(Math.abs(row.inputDuration - row.outputDuration) < 0.15);
    // FFmpeg 6 的 Xing/Lavc 标记不填写 ABR 目标字段，不能把这些零字节误当 CBR。
    // 这里只验证实际变码率文件和解码结果；ABR 目标由实际调用的编码选项确定。
    assert.ok(bytes.indexOf(Buffer.from('Xing')) >= 0);
    const info = execFileSync('/usr/bin/afinfo', [file], { encoding: 'utf8' });
    assert.match(info, /2 ch/); assert.match(info, row.name.endsWith('.wma') ? /44100 Hz/ : /48000 Hz/);
  }
  assert.equal((await fs.readdir(result.folder)).some(n => n.endsWith('.part')), false);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.folder, '转换记录.json'))).failed, 1);
  const firstFiles = await fs.readdir(result.folder);
  const repeated = await convertBatch(ffmpeg, [mp3], root); assert.notEqual(repeated.folder, result.folder);
  assert.deepEqual(await fs.readdir(result.folder), firstFiles);
  assert.deepEqual(await Promise.all(files.map(async p => hash(await fs.readFile(p)))), before);
});
