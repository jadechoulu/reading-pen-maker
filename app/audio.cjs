const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { randomUUID, createHash } = require('node:crypto');
const run = promisify(execFile);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

async function decodeAudio(ffmpeg, source, mp3Only = false) {
  // @CfSecAICode 遵循消费金融安全编码 BE-SQL-001 规范: 系统选择的文件路径只作为 argv 传入，不通过 shell。
  const result = await run(ffmpeg, ['-nostdin', '-hide_banner', '-v', 'info', '-xerror', '-err_detect', 'explode',
    ...(mp3Only ? ['-f', 'mp3'] : []), '-i', source, '-map', '0:a:0', '-vn', '-progress', 'pipe:1', '-f', 'null', '-'],
  { timeout: 180000, maxBuffer: 2 * 1024 * 1024 });
  if (mp3Only && !/Audio: mp3(?:float)?(?:,|\s)/.test(result.stderr)) throw new Error('文件内容不是 MP3 音频');
  const times = [...result.stdout.matchAll(/^out_time_us=(\d+)$/gm)].map(m => Number(m[1]));
  const duration = Math.max(0, ...times) / 1000000;
  if (!duration) throw new Error('没有可解码的音频内容');
  return duration;
}
async function validateMp3(ffmpeg, source) { return decodeAudio(ffmpeg, source, true); }

async function convertBatch(ffmpeg, files, parentFolder, progress = () => {}) {
  if (!files.length) throw new Error('请先选择需要转换的音频');
  const parent = await fs.realpath(parentFolder);
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const folder = path.join(parent, `毛毛虫云盘_MP3_ABR128_${stamp}_${randomUUID().slice(0, 8)}`);
  // @CfSecAICode 遵循消费金融安全编码 BE-FILE-002 规范: 只在系统授权的真实目录中新建独占子目录，文件名不含路径成分。
  await fs.mkdir(folder);
  const used = new Set(), results = [];
  for (let i = 0; i < files.length; i++) {
    const name = path.basename(files[i]);
    const stem = path.basename(name, path.extname(name)).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 70).replace(/^\.+/, '_') || '音频';
    let outputName = `${stem}.mp3`, sequence = 2;
    while (used.has(outputName.toLocaleLowerCase('en-US'))) outputName = `${stem}_${sequence++}.mp3`;
    used.add(outputName.toLocaleLowerCase('en-US'));
    const target = path.join(folder, outputName), partial = target + '.part';
    progress(`正在批量转换 ${i + 1} / ${files.length}：${name}`);
    try {
      const source = await fs.realpath(files[i]);
      const sourceHash = hash(await fs.readFile(source));
      const inputDuration = await decodeAudio(ffmpeg, source);
      await run(ffmpeg, ['-nostdin', '-v', 'error', '-xerror', '-n', '-i', source, '-map', '0:a:0', '-vn',
        '-af', 'asetpts=N/SR/TB', '-codec:a', 'libmp3lame', '-abr', '1', '-b:a', '128k', '-map_metadata', '-1', '-f', 'mp3', partial],
      { timeout: 180000, maxBuffer: 1024 * 1024 });
      const outputDuration = await validateMp3(ffmpeg, partial);
      if (Math.abs(inputDuration - outputDuration) > 0.15) throw new Error('转换前后时长差超过 0.15 秒');
      if (hash(await fs.readFile(source)) !== sourceHash) throw new Error('源文件在转换期间发生变化');
      const bytes = await fs.readFile(partial);
      await fs.rename(partial, target);
      results.push({ name, outputName, ok: true, bytes: bytes.length, sourceSha256: sourceHash, sha256: hash(bytes), inputDuration, outputDuration });
    } catch (error) {
      await fs.unlink(partial).catch(() => {});
      results.push({ name, ok: false, error: error.code === 'ENOENT' ? '找不到音频文件或内置工具' : '无法完整解码或转换校验未通过，请检查音频文件' });
    }
  }
  const result = { folder, preset: '毛毛虫云盘上传预设（用户配置）', codec: 'MP3', mode: 'ABR', targetKbps: 128,
    createdAt: new Date().toISOString(), succeeded: results.filter(r => r.ok).length, failed: results.filter(r => !r.ok).length, results };
  await fs.writeFile(path.join(folder, '转换记录.json'), JSON.stringify(result, null, 2), { flag: 'wx' });
  progress('');
  return result;
}
module.exports = { validateMp3, convertBatch };
