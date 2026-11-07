// 隔离安装副本，实际执行退出、App 替换、新版启动确认和失败回退；仅替代 GitHub 网络响应与原生确认。
const fs = require('node:fs/promises');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const { _electron } = require('playwright-core');
const { Library } = require('../app/library.cjs');
const { APP_NAME, validateApp } = require('../app/update-package.cjs');
const source = process.env.APP_PATH, output = process.env.UPDATE_VALIDATION_DIR;
if (!source || !output || !path.isAbsolute(output)) throw new Error('请指定 APP_PATH 和新的 UPDATE_VALIDATION_DIR');
const version = require('../package.json').version, parts = version.split('.').map(Number);parts[2]++;
const next = parts.join('.');
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const pause = ms => new Promise(resolve => setTimeout(resolve,ms));
async function until(read, timeout = 180000) { const start=Date.now();while(Date.now()-start<timeout){const value=await read();if(value)return value;await pause(200);}throw new Error('等待安装结果超时'); }
async function treeHashes(root) {
  const entries={};async function walk(folder){for(const item of await fs.readdir(folder,{withFileTypes:true})){const file=path.join(folder,item.name);if(item.isDirectory())await walk(file);else entries[path.relative(root,file)]=sha(await fs.readFile(file));}}await walk(root);return entries;
}
let desktop;
const children = new Set(), report={version,next,arch:'x64',hardware:'Apple Silicon + Rosetta',cases:[],allPassed:false};
async function runCase(name, failStart) {
  const root=path.join(output,name),parent=path.join(root,'安装 位置'),candidateParent=path.join(root,'新版'),profile=path.join(root,'资料库');
  await fs.mkdir(parent,{recursive:true});await fs.mkdir(candidateParent);
  const target=path.join(parent,APP_NAME),candidate=path.join(candidateParent,APP_NAME);
  execFileSync('/usr/bin/ditto',[source,target]);execFileSync('/usr/bin/ditto',[source,candidate]);
  for(const key of ['CFBundleShortVersionString','CFBundleVersion'])execFileSync('/usr/libexec/PlistBuddy',['-c',`Set :${key} ${next}`,path.join(candidate,'Contents/Info.plist')]);
  const metadataPath=path.join(candidate,'Contents/Resources/app/package.json'),metadata=JSON.parse(await fs.readFile(metadataPath));metadata.version=next;await fs.writeFile(metadataPath,JSON.stringify(metadata));
  if(failStart)await fs.writeFile(path.join(candidate,'Contents/Resources/app/app/main.cjs'),'process.exit(7);\n');
  execFileSync('/usr/bin/codesign',['--force','--deep','--sign','-',candidate]);
  await validateApp(candidate,next,'x64');
  await assert.rejects(()=>validateApp(candidate,'99.0.0','x64'),/版本不一致/);
  await assert.rejects(()=>validateApp(candidate,next,'arm64'));
  const archive=path.join(root,'candidate.zip');execFileSync('/usr/bin/ditto',['-c','-k','--norsrc','--keepParent',candidate,archive]);
  const archiveBytes=await fs.readFile(archive),library=new Library(path.join(profile,'library'));await library.init();
  const audio=path.join(root,'10000.mp3');execFileSync(path.join(source,'Contents/Resources/runtime/ffmpeg'),['-nostdin','-v','error','-f','lavfi','-i','sine=duration=0.7','-c:a','libmp3lame',audio]);
  let book=await library.create('升级前的书');book=await library.importAudio(book.id,[audio]);
  await fs.writeFile(path.join(profile,'update-settings.json'),JSON.stringify({autoCheck:false,autoDownload:failStart,includePrerelease:false}));
  const before=await treeHashes(library.root);
  desktop=await _electron.launch({executablePath:path.join(target,'Contents/MacOS/小蝌蚪点读制作'),args:[`--user-data-dir=${profile}`],timeout:60000});
  const page=await desktop.firstWindow({timeout:60000});await page.locator('#editor').waitFor();
  assert.equal(await page.locator('#book-title').inputValue(),'升级前的书');
  await desktop.evaluate(({app,dialog},data)=>{
    const updater=process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json')('./app/main.cjs').getUpdater();
    const {Readable}=process.getBuiltinModule('stream'),fs=process.getBuiltinModule('fs');
    const assetName=`reading-pen-maker-${data.next}-macos-x64.zip`;
    const releases=[{tag_name:'v'+data.next,body:'隔离验证：保留书籍并更新应用',assets:[{id:1,name:assetName,state:'uploaded',size:data.size,digest:'sha256:'+data.sha,
      browser_download_url:`https://github.com/jadechoulu/reading-pen-maker/releases/download/v${data.next}/${assetName}`,url:'https://api.github.com/repos/jadechoulu/reading-pen-maker/releases/assets/1'}]}];
    updater.request=async address=>address.includes('/assets/')?fs.createReadStream(data.archive):Readable.from([Buffer.from(JSON.stringify(releases))]);
    updater.startTimeout=60;dialog.showMessageBox=async()=>({response:0});
  },{next,archive,size:archiveBytes.length,sha:sha(archiveBytes)});
  await page.locator('#update-open').click();await page.locator('#update-check').click();
  if(!failStart)await page.waitForFunction(()=>!document.querySelector('#update-download').hidden && !document.querySelector('#update-download').disabled);
  assert.match(await page.locator('#update-next').textContent(),new RegExp(next.replaceAll('.','\\.')));
  if(!failStart)await page.locator('#update-download').click();
  await page.waitForFunction(()=>{const message=document.querySelector('#update-message').textContent;if(message.startsWith('准备更新失败'))throw new Error(message);return !document.querySelector('#update-install').hidden && !document.querySelector('#update-install').disabled;},{},{timeout:180000});
  await page.screenshot({path:path.join(root,'下载校验完成.png'),fullPage:true});
  const prepared=await desktop.evaluate(({app})=>process.getBuiltinModule('module').createRequire(app.getAppPath()+'/package.json')('./app/main.cjs').getUpdater().prepared);
  assert.ok(prepared.job.startsWith(profile));
  console.log(name+': 下载与解压校验通过，开始实际替换');
  const exited=new Promise(resolve=>desktop.process().once('exit',resolve));
  await page.locator('#update-install').click().catch(error=>{if(!/closed|Target/i.test(error.message))throw error;});
  await exited;desktop=null;
  const result=await until(async()=>{try{return(await fs.readFile(path.join(prepared.job,'result.txt'),'utf8')).trim();}catch{return null;}});
  if(failStart){
    assert.match(result,/^failed:.*已恢复旧版/);
    const pid=await until(async()=>{try{return Number(await fs.readFile(path.join(prepared.job,'rollback-pid.txt'),'utf8'));}catch{return null;}});children.add(pid);
    const installed=JSON.parse(execFileSync('/usr/bin/plutil',['-convert','json','-o','-',path.join(target,'Contents/Info.plist')],{encoding:'utf8'}));assert.equal(installed.CFBundleShortVersionString,version);
  }else{
    assert.equal(result,'installed:'+next);
    const ack=(await fs.readFile(path.join(prepared.job,'started.txt'),'utf8')).trim().split(':');assert.equal(ack[0],next);children.add(Number(ack[1]));
    process.kill(Number(ack[1]),0);
  }
  assert.deepEqual(await treeHashes(library.root),before);
  report.cases.push({name,failStart,result,libraryUnchanged:true,job:prepared.job,target});
  console.log(name+': '+result+'，资料库逐文件 SHA256 不变');
  for(const pid of children){try{process.kill(pid,'SIGTERM');}catch{}}children.clear();
  await pause(500);
}
(async()=>{await fs.mkdir(output);await runCase('正常升级',false);await runCase('新版启动失败回退',true);report.allPassed=true;})()
.catch(error=>{report.error=error.stack;process.exitCode=1;console.error(error);})
.finally(async()=>{if(desktop)await desktop.close().catch(()=>{});for(const pid of children){try{process.kill(pid,'SIGTERM');}catch{}}await fs.writeFile(path.join(output,'更新验收结果.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));});
