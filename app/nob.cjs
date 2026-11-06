const crypto = require('node:crypto');

// 沿用点读包工坊已核对的 T6 NOB V3 本地零 ID 格式。这里不实现 NOD/NOS。
const BODY_START = 0xc44;
const VERIFY = Buffer.from('abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ=-');
const PARAMETERS = Buffer.from('121b2a170d176d062f3c10506e19280a'.repeat(2), 'hex');
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const check = (value, message) => { if (!value) throw new Error(message); };
function oidValue(value) {
  const text = String(value).trim();
  check(/^[1-9]\d{0,9}$/.test(text), '点读码必须是大于零的整数');
  const oid = Number(text);
  check(Number.isSafeInteger(oid) && oid <= 0x7fffffff, '点读码不能超过 2147483647');
  return oid;
}
function inferCode(name) {
  const match = /^(\d+)(?:[-_](\d+))?\.mp3$/i.exec(name);
  if (!match) return '';
  try { return String(oidValue(match[1])); } catch { return ''; }
}
function crc(data) {
  const table = Array.from({ length: 256 }, (_, value) => {
    for (let i = 0; i < 8; i++) value = (value >>> 1) ^ ((value & 1) ? 0xedb88320 : 0);
    return value >>> 0;
  });
  table[150] = 0x256c3671;
  let value = 0;
  for (const byte of data) value = ((value >> 8) ^ table[(value ^ byte) & 255]) >>> 0;
  return value;
}
function digest(data) {
  const result = Buffer.alloc(128);
  for (let i = 0; i < data.length; i++) result[i % 128] ^= data[i];
  return result;
}
function xor(data, key) {
  const result = Buffer.allocUnsafe(data.length);
  for (let i = 0; i < data.length; i++) result[i] = data[i] ^ key[i % 32];
  return result;
}
function terms(shift) {
  const result = Buffer.alloc(32);
  for (let i = 0; i < 4; i++) {
    const count = (shift + 8 * i) % 32;
    result.writeUInt32LE(((54 << count) | (54 >>> ((32 - count) % 32))) >>> 0, 8 * i);
  }
  return result;
}
function buildNob(title, tracks) {
  check(typeof title === 'string' && title.trim(), '请先填写书名');
  check(Array.isArray(tracks) && tracks.length > 0, '请先导入音频');
  const groups = new Map();
  for (const track of tracks) {
    const oid = oidValue(track.oid);
    check(Buffer.isBuffer(track.audio) && track.audio.length > 0, '存在空音频');
    if (!groups.has(oid)) groups.set(oid, []);
    groups.get(oid).push(track.audio);
  }
  const codes = [...groups.keys()].sort((a, b) => a - b);
  // 只声明真实使用的连续范围，不把整段空码占用为本书。
  const ranges = [];
  for (const code of codes) {
    const last = ranges.at(-1);
    if (last && code === last[1] + 1) last[1] = code;
    else ranges.push([code, code]);
  }
  check(ranges.length <= 32, '本书的点读码分成了超过 32 段，请使用更连续的码段或分成多本书');
  const header = Buffer.alloc(BODY_START);
  header.write('NOB\0', 0, 'ascii'); header.write('V3', 8, 'ascii');
  header.writeUInt32LE(0xb0, 0x10); header.write('20220905', 0x14, 'ascii');
  header.write('20000101000000', 0x24, 'ascii');
  header.writeUInt32LE(54, 0x34); header.writeUInt16LE(2, 0x40); header[0x43] = 1;
  const meta = Buffer.from(JSON.stringify({ name: title.trim(), author: '', press: '', toolVer: `reading-pen-maker/${require('../package.json').version}`, jiaocai: {} }));
  check(meta.length < 2048, '书名过长'); meta.copy(header, 0x440);
  ranges.forEach(([start, end], i) => { header.writeUInt32LE(start, 0x200 + i * 8); header.writeUInt32LE(end, 0x204 + i * 8); });
  const seedHash = crypto.createHash('sha256').update(title.trim());
  for (const [oid, audios] of [...groups].sort((a, b) => a[0] - b[0])) {
    seedHash.update(String(oid)); for (const audio of audios) seedHash.update(audio);
  }
  const seed = Buffer.from(seedHash.digest('hex').slice(0, 32));
  const t1 = terms(1), t2 = terms(2), equivalent = Buffer.concat([Buffer.alloc(16), PARAMETERS.subarray(0, 16)]);
  const headKey = Buffer.from(seed.map((v, i) => v ^ t2[i] ^ equivalent[i]));
  headKey.copy(header, 0x70);
  const key = Buffer.from(headKey.map((v, i) => v ^ t1[i] ^ t2[i] ^ PARAMETERS[i]));
  xor(VERIFY, key).copy(header, 0x300);
  const records = [], indices = [], media = [];
  let recordOffset = BODY_START, mediaOffset = 0;
  for (const oid of codes) {
    const audios = groups.get(oid);
    const record = Buffer.alloc(20 + audios.length * 8);
    record.writeUInt32LE(12, 0); record.writeUInt32LE(audios.length === 1 ? 258 : 257, 4);
    record.writeUInt32LE(recordOffset + 20, 12); record.writeUInt32LE(audios.length, 16);
    audios.forEach((audio, i) => {
      record.writeUInt32LE(mediaOffset, 20 + i * 8); record.writeUInt32LE(audio.length, 24 + i * 8);
      media.push(xor(audio, key)); mediaOffset += audio.length;
    });
    const index = Buffer.alloc(12); index.writeUInt32LE(oid); index.writeUInt16LE(1, 4);
    index.writeUInt16LE(12, 6); index.writeUInt32LE(recordOffset, 8);
    records.push(record); indices.push(index); recordOffset += record.length;
  }
  const padding = Buffer.alloc((512 - recordOffset % 512) % 512);
  const indexStart = recordOffset + padding.length, indexBytes = indices.length * 12;
  const audioStart = indexStart + indexBytes;
  check(audioStart + mediaOffset + 128 <= 0xffffffff, '资源包超出 NOB 格式容量');
  header.writeUInt32LE(audioStart, 0x44); header.writeUInt32LE(indexStart, 0x4c);
  header.writeUInt32LE(indexBytes, 0x50); header.writeUInt32LE(audioStart + mediaOffset + 128, 0x6c);
  header.writeUInt32LE(crc(header.subarray(0, 0xc40)), 0xc40);
  const body = Buffer.concat([...records, padding, ...indices, ...media]);
  return { bytes: Buffer.concat([header, body, digest(body)]), codes, ranges, audioCount: tracks.length };
}
function verifyNob(bytes, expectedTracks) {
  check(bytes.length >= BODY_START + 128 && bytes.subarray(0, 4).equals(Buffer.from('NOB\0')), '生成文件不是 NOB');
  check(bytes.readUInt32LE(0x6c) === bytes.length, 'NOB 长度校验失败');
  check(crc(bytes.subarray(0, 0xc40)) === bytes.readUInt32LE(0xc40), 'NOB 头部校验失败');
  check(digest(bytes.subarray(BODY_START, -128)).equals(bytes.subarray(-128)), 'NOB 正文校验失败');
  const key = Buffer.from(VERIFY.subarray(0, 32).map((v, i) => v ^ bytes[0x300 + i]));
  check(xor(bytes.subarray(0x300, 0x340), key).equals(VERIFY), 'NOB 音频参数校验失败');
  const expected = new Map();
  for (const t of expectedTracks) { const code = oidValue(t.oid); if (!expected.has(code)) expected.set(code, []); expected.get(code).push(t.audio); }
  const seen = new Set(), start = bytes.readUInt32LE(0x4c), length = bytes.readUInt32LE(0x50), audioStart = bytes.readUInt32LE(0x44);
  check(length === expected.size * 12 && start + length === audioStart, 'NOB 点位目录校验失败');
  for (let i = start; i < start + length; i += 12) {
    const code = bytes.readUInt32LE(i), record = bytes.readUInt32LE(i + 8), audios = expected.get(code);
    check(audios && !seen.has(code) && record >= BODY_START && record + 20 <= start, 'NOB 点位记录异常');
    seen.add(code);
    const count = bytes.readUInt32LE(record + 16), refs = bytes.readUInt32LE(record + 12);
    check(count === audios.length && refs + count * 8 <= start, 'NOB 播放列表校验失败');
    for (let j = 0; j < count; j++) {
      const offset = bytes.readUInt32LE(refs + j * 8), size = bytes.readUInt32LE(refs + j * 8 + 4);
      check(audioStart + offset + size <= bytes.length - 128, 'NOB 音频越界');
      check(xor(bytes.subarray(audioStart + offset, audioStart + offset + size), key).equals(audios[j]), 'NOB 重新读取的音频与输入不一致');
    }
  }
  return { sha256: hash(bytes), points: seen.size, audios: expectedTracks.length, bytes: bytes.length };
}
module.exports = { buildNob, verifyNob, inferCode, oidValue, hash };
