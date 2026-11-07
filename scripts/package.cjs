const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { createGunzip } = require('node:zlib');
const { createReadStream, createWriteStream } = require('node:fs');
const { pipeline } = require('node:stream/promises');

const root = path.resolve(__dirname, '..');
const cache = path.join(root, 'build-cache');
const version = require('../package.json').version;
const product = '小蝌蚪点读制作';
const checksums = {
  'ffmpeg-darwin-x64.gz': '929b375c1182d956c51f7ac25e0b2b0411fb01f6f407aa15c9758efeb4242106',
  'darwin-x64.LICENSE': '2e1d16c72fd74e12063776371da757322f8b77589386532f4fd8634bde7de1af',
  'darwin-x64.README': 'e88a0325f8e5b75210355e37341824f074d3cd82def2125be54c914b62848a36'
};
async function checkedFile(name, url, expected) {
  const target = path.join(cache, name);
  try { await fs.access(target); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    const temporary = target + '.partial';
    execFileSync('/usr/bin/curl', ['--location', '--fail', '--silent', '--show-error', '--retry', '2', '--max-time', '240', url, '--output', temporary], { stdio: 'inherit' });
    await fs.rename(temporary, target);
  }
  const actual = crypto.createHash('sha256').update(await fs.readFile(target)).digest('hex');
  if (actual !== expected) throw new Error(`下载文件校验失败：${name}`);
  return target;
}
async function build() {
  if (process.platform !== 'darwin') throw new Error('本脚本在 macOS 上构建 Intel 版');
  await fs.mkdir(cache, { recursive: true });
  const runtime = path.join(root, 'runtime'); await fs.mkdir(runtime, { recursive: true });
  const electronVersion = require('../package.json').devDependencies.electron;
  const electronName = `electron-v${electronVersion}-darwin-x64.zip`;
  await checkedFile(electronName, `https://github.com/electron/electron/releases/download/v${electronVersion}/${electronName}`, require('../node_modules/electron/checksums.json')[electronName]);
  for (const [name, sha] of Object.entries(checksums)) await checkedFile(name, `https://github.com/eugeneware/ffmpeg-static/releases/download/b6.1.1/${name}`, sha);
  await checkedFile('COPYING.GPLv3', 'https://www.gnu.org/licenses/gpl-3.0.txt', '8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903');
  const decoder = path.join(runtime, 'ffmpeg');
  await pipeline(createReadStream(path.join(cache, 'ffmpeg-darwin-x64.gz')), createGunzip(), createWriteStream(decoder));
  await fs.chmod(decoder, 0o755);
  for (const name of ['darwin-x64.LICENSE', 'darwin-x64.README', 'COPYING.GPLv3']) await fs.copyFile(path.join(cache, name), path.join(runtime, name));
  const info = execFileSync('/usr/bin/file', [decoder], { encoding: 'utf8' });
  if (!info.includes('x86_64')) throw new Error('FFmpeg 必须为 Intel x86_64 架构');
  execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', decoder]);
  if (process.argv.includes('--development')) {
    const dist = path.join(root, 'node_modules', 'electron', 'dist');
    await fs.rm(dist, { recursive: true, force: true });
    await fs.mkdir(dist, { recursive: true });
    execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(cache, electronName), dist]);
    await fs.writeFile(path.join(root, 'node_modules', 'electron', 'path.txt'), 'Electron.app/Contents/MacOS/Electron');
    console.log('Intel Electron 和音频工具已准备好');
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputRoot = path.join(root, 'dist', `v${version}-${stamp}`);
  // 主程序、辅助进程、bundle 元数据和外层 App 同步更名，最后进行本地签名。
  const stageRoot = path.join(root, 'build', `app-${stamp}`); await fs.mkdir(stageRoot, { recursive: true });
  execFileSync('/usr/bin/ditto', ['-x', '-k', path.join(cache, electronName), stageRoot]);
  const staged = path.join(stageRoot, 'Electron.app'), resources = path.join(staged, 'Contents', 'Resources');
  const application = path.join(resources, 'app'); await fs.mkdir(application);
  await fs.cp(path.join(root, 'app'), path.join(application, 'app'), { recursive: true });
  await fs.copyFile(path.join(root, 'package.json'), path.join(application, 'package.json'));
  // 更新包检查器及纯 JS 依赖随 App 分发；运行时不安装 npm 包。
  for (const name of ['yauzl', 'buffer-crc32', 'pend']) await fs.cp(path.join(root, 'node_modules', name), path.join(application, 'node_modules', name), { recursive: true });
  await fs.cp(runtime, path.join(resources, 'runtime'), { recursive: true });
  await fs.copyFile(path.join(root, 'app', 'icon.icns'), path.join(resources, 'electron.icns'));
  const plist = path.join(staged, 'Contents', 'Info.plist');
  for (const [key, value] of Object.entries({ CFBundleDisplayName: product, CFBundleName: product, CFBundleExecutable: product, CFBundleIdentifier: 'local.xkd.nob.mac', CFBundleShortVersionString: version, CFBundleVersion: version, LSMinimumSystemVersion: '13.0', LSApplicationCategoryType: 'public.app-category.education' })) {
    try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], { stdio: 'pipe' }); }
    catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist], { stdio: 'pipe' }); }
  }
  await fs.rename(path.join(staged, 'Contents/MacOS/Electron'), path.join(staged, 'Contents/MacOS', product));
  for (const [suffix, identifier] of [['', 'helper'], [' (GPU)', 'helper.gpu'], [' (Plugin)', 'helper.plugin'], [' (Renderer)', 'helper.renderer']]) {
    const previous = 'Electron Helper' + suffix, next = product + ' Helper' + suffix;
    const helper = path.join(staged, 'Contents/Frameworks', previous + '.app');
    const helperPlist = path.join(helper, 'Contents/Info.plist');
    for (const [key, value] of Object.entries({ CFBundleExecutable: next, CFBundleDisplayName: next, CFBundleName: next, CFBundleIdentifier: 'local.xkd.nob.mac.' + identifier })) {
      try { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, helperPlist], { stdio: 'pipe' }); }
      catch { execFileSync('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, helperPlist], { stdio: 'pipe' }); }
    }
    await fs.rename(path.join(helper, 'Contents/MacOS', previous), path.join(helper, 'Contents/MacOS', next));
    await fs.rename(helper, path.join(staged, 'Contents/Frameworks', next + '.app'));
  }
  // 本地 ad-hoc 签名保证更名后 bundle 一致；不代表 Developer ID 签名或 Apple 公证。
  execFileSync('/usr/bin/codesign', ['--force', '--deep', '--sign', '-', staged]);
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', staged]);
  await fs.mkdir(outputRoot, { recursive: true });
  const published = path.join(outputRoot, product + '.app');
  execFileSync('/usr/bin/ditto', [staged, published]);
  // 直接比对交付副本与官方解压的主程序、Framework；这里没有重写可执行代码。
  for (const relative of ['Contents/MacOS/' + product, 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework']) {
    const before = crypto.createHash('sha256').update(await fs.readFile(path.join(staged, relative))).digest('hex');
    const after = crypto.createHash('sha256').update(await fs.readFile(path.join(published, relative))).digest('hex');
    if (before !== after) throw new Error('交付副本二进制不一致');
  }
  const zip = path.join(outputRoot, `reading-pen-maker-${version}-macos-x64.zip`);
  execFileSync('/usr/bin/ditto', ['-c', '-k', '--norsrc', '--keepParent', published, zip]);
  await fs.writeFile(path.join(root, 'build', 'latest.json'), JSON.stringify({ app: published, zip, arch: 'x64', version }, null, 2));
  await fs.rm(stageRoot, { recursive: true, force: true });
  console.log(JSON.stringify({ app: published, zip, arch: 'x64', version }, null, 2));
}
build().catch(error => { console.error(error); process.exitCode = 1; });
