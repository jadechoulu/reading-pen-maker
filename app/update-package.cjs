// 参考点读包工坊更新包校验流程；只使用 App 自带 Node 模块和 macOS 系统工具。
const fs = require('node:fs/promises');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const yauzl = require('yauzl');
const run = promisify(execFile);
const APP_NAME = 'Electron.app', BUNDLE_ID = 'local.xkd.nob.mac';
const inside = (root, value) => { const relative = path.relative(root, value); return relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative); };

function checkArchive(filename) {
  return new Promise((resolve, reject) => {
    yauzl.open(filename, { lazyEntries: true, strictFileNames: true, validateEntrySizes: true }, (error, zip) => {
      if (error) return reject(error);
      const entries = new Map(); let size = 0, ended = false;
      const fail = error => { if (!ended) { ended = true; zip.close(); reject(error); } };
      zip.on('error', fail);
      zip.on('entry', entry => {
        try {
          const name = entry.fileName.replace(/\/$/, ''), parts = name.split('/');
          // @CfSecAICode 遵循消费金融安全编码 BE-FILE-002 规范: 解压前验证每个条目，拒绝穿越、重复、特殊文件和 App 外路径。
          if (!name || /[\\\x00-\x1f]/.test(name) || parts[0] !== APP_NAME || parts.some(p => !p || p === '.' || p === '..') || entries.has(name)) throw new Error('更新包包含无效或重复路径');
          const kind = (entry.externalFileAttributes >>> 16) & 0xf000;
          if (![0, 0x8000, 0x4000, 0xa000].includes(kind)) throw new Error('更新包包含特殊文件');
          size += entry.uncompressedSize;
          if (size > 4 * 1024 ** 3 || entries.size >= 100000) throw new Error('更新包展开后过大');
          const item = { kind: entry.fileName.endsWith('/') ? 0x4000 : kind, link: null };
          entries.set(name, item);
          if (kind !== 0xa000) return zip.readEntry();
          if (entry.uncompressedSize > 4096) throw new Error('更新包的符号链接无效');
          zip.openReadStream(entry, (error, stream) => {
            if (error) return fail(error);
            const chunks = []; stream.on('error', fail); stream.on('data', b => chunks.push(b));
            stream.on('end', () => {
              try {
                const target = Buffer.concat(chunks).toString('utf8');
                const resolved = path.posix.resolve('/', path.posix.dirname(name), target);
                if (!target || target.startsWith('/') || /[\\\x00-\x1f]/.test(target) || !resolved.startsWith('/' + APP_NAME + '/')) throw new Error('更新包的符号链接越出 App');
                item.link = target; zip.readEntry();
              } catch (error) { fail(error); }
            });
          });
        } catch (error) { fail(error); }
      });
      zip.on('end', () => {
        try {
          for (const name of entries.keys()) {
            for (let parent = path.posix.dirname(name); parent !== '.'; parent = path.posix.dirname(parent)) {
              const ancestor = entries.get(parent);
              if (ancestor && ancestor.kind !== 0x4000) throw new Error('更新包试图通过链接或文件写入子路径');
            }
          }
          if (!entries.has(`${APP_NAME}/Contents/Info.plist`)) throw new Error('更新包缺少应用信息');
          if (!ended) { ended = true; resolve(); }
        } catch (error) { fail(error); }
      });
      zip.readEntry();
    });
  });
}

async function validateApp(folder, version, arch) {
  const root = await fs.realpath(folder);
  async function walk(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (!inside(root, await fs.realpath(target))) throw new Error('App 文件越出安装目录');
      if (entry.isDirectory()) await walk(target);
    }
  }
  await walk(root);
  const { stdout } = await run('/usr/bin/plutil', ['-convert', 'json', '-o', '-', path.join(root, 'Contents/Info.plist')]);
  const info = JSON.parse(stdout);
  if (info.CFBundleIdentifier !== BUNDLE_ID || info.CFBundleExecutable !== 'Electron' || info.CFBundleShortVersionString !== version) throw new Error('更新包的应用身份或版本不一致');
  const system = (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim().split('.').map(Number);
  const minimum = (info.LSMinimumSystemVersion || '13.0').split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((system[i] || 0) > (minimum[i] || 0)) break;
    if ((system[i] || 0) < (minimum[i] || 0)) throw new Error(`新版需要 macOS ${info.LSMinimumSystemVersion} 或以上`);
  }
  if (!['x64', 'arm64'].includes(arch)) throw new Error('不支持此芯片架构');
  const machine = arch === 'x64' ? 'x86_64' : 'arm64';
  for (const relative of ['Contents/MacOS/Electron', 'Contents/Resources/runtime/ffmpeg', 'Contents/Frameworks/Electron Framework.framework/Versions/A/Electron Framework']) {
    await run('/usr/bin/lipo', [path.join(root, relative), '-verify_arch', machine], { timeout: 30000 });
  }
  const metadata = JSON.parse(await fs.readFile(path.join(root, 'Contents/Resources/app/package.json'), 'utf8'));
  if (metadata.version !== version) throw new Error('应用资源版本不一致');
  for (const relative of ['app/main.cjs', 'app/updater.cjs', 'app/update-install.sh', 'node_modules/yauzl/index.js']) await fs.access(path.join(root, 'Contents/Resources/app', relative));
  // 首版 Electron 未签名；若后续包携带签名则必须验证，不以 SHA256 冒充 Apple 签名。
  try { await fs.access(path.join(root, 'Contents/_CodeSignature/CodeResources')); }
  catch (error) { if (error.code === 'ENOENT') return root; throw error; }
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', root], { timeout: 120000 });
  return root;
}

async function prepareArchive(archive, output, version, arch) {
  await checkArchive(archive);
  await fs.mkdir(output, { mode: 0o700 });
  await run('/usr/bin/ditto', ['-x', '-k', archive, output], { timeout: 180000 });
  const app = path.join(output, APP_NAME);
  await validateApp(app, version, arch);
  return app;
}
module.exports = { APP_NAME, BUNDLE_ID, checkArchive, validateApp, prepareArchive };
