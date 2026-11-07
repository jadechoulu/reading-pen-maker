const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const crc32 = require('buffer-crc32');
const { compareVersions, selectRelease, downloadVerified, requestResponse } = require('../app/updater.cjs');
const { checkArchive } = require('../app/update-package.cjs');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
function release(version, arch = 'x64', prerelease = false) {
  const name = `reading-pen-maker-${version}-macos-${arch}.zip`;
  return { tag_name: `v${version}`, prerelease, assets: [{ id: 1, name, state: 'uploaded', size: 20, digest: 'sha256:'+'a'.repeat(64),
    url: 'https://api.github.com/repos/jadechoulu/reading-pen-maker/releases/assets/1', browser_download_url: `https://github.com/jadechoulu/reading-pen-maker/releases/download/v${version}/${name}` }] };
}
test('公开更新只选择较新的匹配架构成品和有效摘要，区分候选版，拒绝外部地址', async () => {
  assert.equal(compareVersions('0.10.0','0.9.9'),1);
  assert.equal(selectRelease([release('0.4.0','arm64'),release('0.5.0','x64',true),release('0.3.1')],'0.3.0','x64',false).version,'0.3.1');
  assert.equal(selectRelease([release('0.5.0','x64',true)],'0.3.0','x64',true).version,'0.5.0');
  const bad=release('0.6.0');bad.assets[0].digest='';assert.equal(selectRelease([bad],'0.3.0','x64',true),null);
  bad.assets[0].digest='sha256:'+'a'.repeat(64);bad.assets[0].browser_download_url='https://evil.example/app.zip';assert.equal(selectRelease([bad],'0.3.0','x64',true),null);
  assert.equal(selectRelease([release('0.2.0')],'0.3.0','x64',true),null);
  for(const url of ['http://github.com/a','https://github.com.evil.example/a','https://user@github.com/a','https://github.com:8443/a']) await assert.rejects(()=>requestResponse(url),/地址无效/);
});
test('下载真实流核对大小和 SHA256，损坏或取消时删除半成品', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rpm-download-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const bytes=Buffer.from('update bytes'),meta={size:bytes.length,sha256:sha(bytes)},file=path.join(root,'app.zip');
  await downloadVerified(Readable.from([bytes]),file,meta,()=>{},new AbortController().signal);assert.deepEqual(await fs.readFile(file),bytes);
  for(const [name,info]of [['bad',{...meta,sha256:'0'.repeat(64)}],['short',{...meta,size:bytes.length+1}]]){
    const target=path.join(root,name);await assert.rejects(()=>downloadVerified(Readable.from([bytes]),target,info,()=>{},new AbortController().signal));await assert.rejects(()=>fs.access(target));
  }
  const controller=new AbortController(),target=path.join(root,'cancel');
  await assert.rejects(()=>downloadVerified(Readable.from([bytes]),target,meta,()=>controller.abort(),controller.signal));await assert.rejects(()=>fs.access(target));
});
function zip(entries, utf8 = true) {
  const files=[],central=[];let offset=0;
  for(const [filename,contents='',kind=0x8000]of entries){
    const name=Buffer.from(filename),data=Buffer.from(contents),crc=crc32.unsigned(data),local=Buffer.alloc(30),header=Buffer.alloc(46);
    local.writeUInt32LE(0x04034b50);local.writeUInt16LE(20,4);local.writeUInt16LE(utf8 ? 0x800 : 0,6);local.writeUInt32LE(crc,14);local.writeUInt32LE(data.length,18);local.writeUInt32LE(data.length,22);local.writeUInt16LE(name.length,26);
    header.writeUInt32LE(0x02014b50);header.writeUInt16LE(0x314,4);header.writeUInt16LE(20,6);header.writeUInt16LE(utf8 ? 0x800 : 0,8);header.writeUInt32LE(crc,16);header.writeUInt32LE(data.length,20);header.writeUInt32LE(data.length,24);header.writeUInt16LE(name.length,28);header.writeUInt32LE((kind*65536)>>>0,38);header.writeUInt32LE(offset,42);
    files.push(local,name,data);central.push(header,name);offset+=local.length+name.length+data.length;
  }
  const directory=Buffer.concat(central),end=Buffer.alloc(22);end.writeUInt32LE(0x06054b50);end.writeUInt16LE(entries.length,8);end.writeUInt16LE(entries.length,10);end.writeUInt32LE(directory.length,12);end.writeUInt32LE(offset,16);
  return Buffer.concat([...files,directory,end]);
}
test('解压前拒绝路径穿越、重复条目、越界链接和链接下写入，允许 App 内部正常链接', async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'rpm-zip-'));t.after(()=>fs.rm(root,{recursive:true,force:true}));
  const base=[['Electron.app/','',0x4000],['Electron.app/Contents/','',0x4000],['Electron.app/Contents/Info.plist','test']];
  const good=path.join(root,'good.zip');await fs.writeFile(good,zip([...base,['Electron.app/link','Contents',0xa000]]));await checkArchive(good);
  const renamed=path.join(root,'renamed.zip');await fs.writeFile(renamed,zip(base.map(([name,...rest])=>[name.replace('Electron.app','小蝌蚪点读制作.app'),...rest])));assert.equal(await checkArchive(renamed),'小蝌蚪点读制作.app');
  const macZip=path.join(root,'mac-utf8.zip');await fs.writeFile(macZip,zip(base.map(([name,...rest])=>[name.replace('Electron.app','小蝌蚪点读制作.app'),...rest]),false));assert.equal(await checkArchive(macZip),'小蝌蚪点读制作.app');
  const mixed=path.join(root,'mixed.zip');await fs.writeFile(mixed,zip([...base,['小蝌蚪点读制作.app/Contents/Info.plist','other']]));await assert.rejects(()=>checkArchive(mixed),/无效/);
  const cases=[['Electron.app/../outside','x'],['/absolute','x'],['Electron.app/Contents/Info.plist','duplicate'],['Electron.app/link','../../outside',0xa000]];
  for(let i=0;i<cases.length;i++){const file=path.join(root,`${i}.zip`);await fs.writeFile(file,zip([...base,cases[i]]));await assert.rejects(()=>checkArchive(file));}
  const file=path.join(root,'link-child.zip');await fs.writeFile(file,zip([...base,['Electron.app/link','Contents',0xa000],['Electron.app/link/payload','x']]));await assert.rejects(()=>checkArchive(file),/链接或文件/);
});
