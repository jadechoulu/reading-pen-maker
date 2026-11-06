const fs = require('node:fs/promises');
const { createWriteStream, constants } = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { Transform, Readable, PassThrough } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const run = promisify(execFile);
const REPOSITORY = 'jadechoulu/reading-pen-maker';
const RELEASES_URL = `https://github.com/${REPOSITORY}/releases`;
const API_URL = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`;
const APP_NAME = 'Electron.app';
const hosts = new Set(['api.github.com', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com']);

function compareVersions(left, right) {
  const parse = value => {
    const match = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(value);
    if (!match) throw new Error('发布版本号无效。');
    return match.slice(1).map(Number);
  };
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i] ? 1 : -1;
  return 0;
}

function selectRelease(releases, version, arch, includePrerelease) {
  if (!Array.isArray(releases)) throw new Error('更新服务返回格式无效。');
  const candidates = releases.filter(item => !item.draft && (includePrerelease || !item.prerelease)
    && /^v\d+\.\d+\.\d+$/.test(item.tag_name) && compareVersions(item.tag_name, version) > 0)
    .sort((a, b) => compareVersions(b.tag_name, a.tag_name));
  for (const release of candidates) {
    const next = release.tag_name.slice(1);
    // 只选择发布完成、具有 GitHub SHA256 的当前架构成品；绝不把源码 ZIP 当作安装包。
    const name = `reading-pen-maker-${next}-macos-${arch}.zip`;
    const asset = release.assets?.find(item => item.name === name && item.state === 'uploaded');
    if (!asset || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '') || !Number.isSafeInteger(asset.size) || asset.size <= 0) continue;
    const expectedUrl = `https://github.com/${REPOSITORY}/releases/download/${release.tag_name}/${name}`;
    const assetUrl = `https://api.github.com/repos/${REPOSITORY}/releases/assets/${asset.id}`;
    if (asset.browser_download_url !== expectedUrl || !Number.isSafeInteger(asset.id) || asset.id <= 0 || asset.url !== assetUrl) continue;
    return { version: next, prerelease: !!release.prerelease, notes: release.body || '',
      url: `${RELEASES_URL}/tag/${release.tag_name}`, downloadUrl: expectedUrl, assetUrl,
      sha256: asset.digest.slice(7), size: asset.size, name };
  }
  return null;
}

function sessionResponse({ session, net }, url, headers, signal) {
  return new Promise((resolve, reject) => {
    // @CfSecAICode 遵循消费金融安全编码 BE-SECRET-001 规范: 不使用会话 Cookie，手动跳转后由调用方重新校验地址和授权头。
    const request = net.request({ session, url: url.href, headers, redirect: 'manual', credentials: 'omit' });
    let response, timer, finished = false, redirected = false, failing = false;
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
    const fail = error => {
      if (finished || redirected || failing) return;
      failing = true; cleanup();
      if (response) response.destroy(error); else reject(error);
      request.abort();
    };
    const abort = () => fail(signal.reason);
    const resetTimeout = () => { clearTimeout(timer); timer = setTimeout(() => fail(new Error('连接更新服务超时，请稍后重试。')), 30000); };
    request.on('error', fail);
    // 本版 Electron 实测 close 可能早于 response；响应以 end/aborted/error 和超时为准。
    request.once('redirect', (statusCode, _method, location) => {
      redirected = true; cleanup();
      const redirect = Readable.from([]);
      redirect.statusCode = statusCode; redirect.headers = { location };
      resolve(redirect);
      // 每次跳转重新校验主机；公开仓库请求不使用 Cookie 或令牌。
      request.abort();
    });
    request.once('response', incoming => {
      response = new PassThrough();
      response.statusCode = incoming.statusCode; response.headers = incoming.headers;
      response.on('error', () => {});
      response.once('close', () => { if (!finished) request.abort(); cleanup(); });
      // Electron IncomingMessage 要求先注册 end 再注册 data。
      incoming.once('end', () => { finished = true; cleanup(); response.end(); });
      incoming.on('error', fail);
      incoming.once('aborted', () => fail(new Error('更新下载已中断，请重试。')));
      incoming.on('data', chunk => { resetTimeout(); response.write(chunk); });
      resolve(response);
    });
    resetTimeout();
    if (signal?.aborted) abort();
    else { signal?.addEventListener('abort', abort, { once: true }); request.end(); }
  });
}

function createSessionRequest(session, net) {
  return (address, signal, options) => requestResponse(address, signal, options, 0, { session, net });
}

async function requestResponse(address, signal, options = {}, redirects = 0, network) {
  const url = new URL(address);
  // 更新网络仅连接 GitHub 官方 API、下载和 CDN；不接受渲染器指定的 URL。
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.has(url.hostname) || (url.port && url.port !== '443')) throw new Error('更新下载地址无效。');
  if (redirects > 5) throw new Error('更新服务重定向次数过多。');
  const headers = { 'User-Agent': 'reading-pen-maker-updater', Accept: options.asset ? 'application/octet-stream' : 'application/vnd.github+json' };
  // @CfSecAICode 遵循消费金融安全编码 BE-SSRF-001 规范: 固定 GitHub 主机和公开仓库，无用户提供的 URL 或授权令牌。

  const response = network ? await sessionResponse(network, url, headers, signal) : await new Promise((resolve, reject) => {
    const request = https.get(url, { signal, headers }, resolve);
    request.setTimeout(30000, () => request.destroy(new Error('连接更新服务超时，请稍后重试。')));
    request.on('error', reject);
  });
  if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
    response.resume();
    return requestResponse(new URL(response.headers.location, url).href, signal, options, redirects + 1, network);
  }
  if (response.statusCode !== 200) {
    response.resume();
    if (response.statusCode === 401 || response.statusCode === 404) throw new Error('公开更新仓库暂不可访问，请稍后重试或查看 GitHub 发布页。');
    throw new Error(response.statusCode === 403 || response.statusCode === 429 ? 'GitHub 检查次数受限，请稍后重试。' : `更新服务暂不可用（${response.statusCode}）。`);
  }
  return response;
}

async function readJson(response) {
  const chunks = [];
  let size = 0;
  for await (const chunk of response) {
    size += chunk.length;
    if (size > 8 * 1024 * 1024) throw new Error('更新信息过大。');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function downloadVerified(response, filename, release, onProgress, signal) {
  const digest = crypto.createHash('sha256');
  let received = 0;
  const inspect = new Transform({ transform(chunk, _encoding, callback) {
    received += chunk.length;
    if (received > release.size) return callback(new Error('更新包大小与发布信息不符。'));
    digest.update(chunk); onProgress(received);
    callback(null, chunk);
  } });
  try {
    await pipeline(response, inspect, createWriteStream(filename, { flags: 'wx', mode: 0o600 }), { signal });
    if (received !== release.size || digest.digest('hex') !== release.sha256) throw new Error('更新包 SHA256 或大小校验失败，本次不会安装。');
  } catch (error) {
    await fs.rm(filename, { force: true });
    throw error;
  }
}

const { prepareArchive, validateApp } = require('./update-package.cjs');
class Updater {
  constructor({ app, onState = () => {}, isBusy = () => false, request = requestResponse,
    resourcesPath = process.resourcesPath, execPath = process.execPath, startTimeout = 120 }) {
    this.app = app; this.onState = onState; this.isBusy = isBusy; this.request = request;
    this.resourcesPath = resourcesPath; this.execPath = execPath; this.startTimeout = startTimeout;
    this.root = path.join(app.getPath('userData'), 'updates');
    this.settingsPath = path.join(app.getPath('userData'), 'update-settings.json');
    this.settings = { autoCheck: true, autoDownload: false, includePrerelease: false };
    // 官方 Electron 保留原文件名时 app.isPackaged 可能为 false，以实际资源目录识别安装版。
    this.value = { status: 'idle', currentVersion: app.getVersion(), arch: process.arch,
      supported: process.platform === 'darwin' && path.resolve(app.getAppPath()) === path.join(resourcesPath, 'app'),
      message: '', release: null, progress: 0, lastChecked: null, repository: REPOSITORY };
    this.controller = null; this.prepared = null;
  }
  snapshot() { return { ...this.value, settings: { ...this.settings } }; }
  set(values) { Object.assign(this.value, values); this.onState(this.snapshot()); }
  async init() {
    try {
      const settings = JSON.parse(await fs.readFile(this.settingsPath, 'utf8'));
      for (const key of Object.keys(this.settings)) if (typeof settings[key] === 'boolean') this.settings[key] = settings[key];
    } catch (error) { if (error.code !== 'ENOENT') this.set({ message: '更新设置读取失败，使用默认设置。' }); }
    try {
      const token = (await fs.readFile(path.join(this.root, 'last-job.txt'), 'utf8')).trim();
      if (/^[a-f0-9-]{36}$/.test(token)) {
        const result = (await fs.readFile(path.join(this.root, token, 'result.txt'), 'utf8')).trim();
        this.set({ message: result.startsWith('installed:') ? `已更新至 ${result.slice(10)}。` : result.replace(/^failed:/, '上次更新：') });
      }
    } catch {}
    this.onState(this.snapshot());
  }
  async configure(settings) {
    if (!settings || typeof settings !== 'object' || Object.entries(settings).some(([k,v]) => !Object.hasOwn(this.settings, k) || typeof v !== 'boolean')) throw new Error('更新设置无效');
    if (['checking','downloading','preparing','installing'].includes(this.value.status)) throw new Error('请等待当前更新操作结束');
    Object.assign(this.settings, settings);
    await fs.mkdir(path.dirname(this.settingsPath), { recursive: true });
    await fs.writeFile(this.settingsPath, JSON.stringify(this.settings, null, 2));
    this.onState(this.snapshot()); return this.snapshot();
  }
  async check() {
    if (['checking','downloading','preparing','ready','installing'].includes(this.value.status)) return this.snapshot();
    this.controller = new AbortController();
    this.set({ status: 'checking', message: '正在检查 GitHub 新版本…', release: null, progress: 0 });
    try {
      const releases = await readJson(await this.request(API_URL, this.controller.signal));
      const release = selectRelease(releases, this.app.getVersion(), process.arch, this.settings.includePrerelease);
      this.set({ status: release ? 'available' : 'current', release, lastChecked: new Date().toISOString(),
        message: release ? `发现 ${release.version}${release.prerelease ? '（候选版）' : ''}。` : '暂无可用更新，当前版本可继续使用。' });
    } catch (error) { this.set({ status: 'error', message: `检查更新失败：${error.message}` }); }
    finally { this.controller = null; }
    if (this.value.status === 'available' && this.settings.autoDownload && this.value.supported) return this.download();
    return this.snapshot();
  }
  async download() {
    if (!['available','error'].includes(this.value.status) || !this.value.release) throw new Error('请先检查可用的新版本');
    if (!this.value.supported) throw new Error('源码运行请通过 Git 更新；安装版支持下载和安装');
    const release = this.value.release;
    this.controller = new AbortController(); let job;
    try {
      await fs.mkdir(this.root, { recursive: true });
      const token = crypto.randomUUID(); job = path.join(this.root, token); await fs.mkdir(job, { mode: 0o700 });
      const archive = path.join(job, 'update.zip');
      this.set({ status: 'downloading', progress: 0, message: '正在下载更新，音频制作可继续使用。' });
      let last = 0;
      await downloadVerified(await this.request(release.assetUrl, this.controller.signal, { asset: true }), archive, release, received => {
        if (Date.now() - last > 200) { last = Date.now(); this.set({ progress: Math.floor(received * 100 / release.size) }); }
      }, this.controller.signal);
      this.set({ status: 'preparing', progress: 100, message: '正在核对应用身份、版本和芯片架构…' });
      const staged = await prepareArchive(archive, path.join(job, 'extracted'), release.version, process.arch);
      this.prepared = { token, job, staged, version: release.version };
      this.set({ status: 'ready', message: '新版已下载并通过校验，可以安装并重启。' });
    } catch (error) {
      if (job) await fs.rm(job, { recursive: true, force: true }).catch(() => {});
      this.prepared = null;
      this.set({ status: this.controller.signal.aborted ? 'available' : 'error', progress: 0,
        message: this.controller.signal.aborted ? '下载已取消，当前版本可继续使用。' : `准备更新失败：${error.message}` });
    } finally { this.controller = null; }
    return this.snapshot();
  }
  cancel() { if (this.value.status === 'downloading') this.controller?.abort(); return this.snapshot(); }
  async install() {
    if (this.value.status !== 'ready' || !this.prepared) throw new Error('请先下载并校验新版');
    if (this.isBusy()) throw new Error('请先完成当前音频处理或保存操作');
    const p = this.prepared;
    this.set({ status: 'installing', message: '正在准备安装，随后会重启…' });
    let staged;
    try {
      const target = path.resolve(this.execPath, '../../..');
      if (path.basename(target) !== APP_NAME || target.includes('/AppTranslocation/') || target.startsWith('/Volumes/') || (await fs.lstat(target)).isSymbolicLink()) throw new Error('请从应用程序或其他可写文件夹打开 Electron.app 后更新');
      await fs.access(target, constants.W_OK); await fs.access(path.dirname(target), constants.W_OK);
      await validateApp(target, this.app.getVersion(), process.arch);
      const parent = path.dirname(target);
      staged = path.join(parent, `.rpm-update-${p.token}.app`);
      const backup = path.join(parent, `.rpm-backup-${p.token}.app`);
      await fs.mkdir(staged); await run('/usr/bin/ditto', [p.staged, staged], { timeout: 180000 });
      await validateApp(staged, p.version, process.arch);
      const helper = path.join(p.job, 'update-install.sh');
      await fs.copyFile(path.join(__dirname, 'update-install.sh'), helper);
      await fs.writeFile(path.join(p.job, 'install.json'), JSON.stringify({ target, staged, backup, version: p.version, token: p.token }));
      await fs.writeFile(path.join(this.root, 'last-job.txt'), p.token);
      // @CfSecAICode 遵循消费金融安全编码 BE-EXEC-001 规范: 固定脚本和位置参数，不拼接 shell 命令，不需要用户安装 Python/Node。
      const child = spawn('/bin/sh', [helper, target, staged, backup, String(process.pid), p.version, p.token, p.job,
        this.app.getPath('userData'), this.app.getVersion(), String(this.startTimeout)], { detached: true, stdio: 'ignore', cwd: p.job });
      await new Promise((resolve,reject) => { child.once('spawn',resolve); child.once('error',reject); });
      child.unref(); this.app.quit();
    } catch (error) {
      if (staged) await fs.rm(staged, { recursive: true, force: true }).catch(() => {});
      this.set({ status: 'ready', message: `安装未开始：${error.message}。当前版本和书籍保留。` });
    }
    return this.snapshot();
  }
  async acknowledgeStart() {
    const token = process.argv.find(v => v.startsWith('--rpm-update-token='))?.slice('--rpm-update-token='.length);
    const job = process.argv.find(v => v.startsWith('--rpm-update-job='))?.slice('--rpm-update-job='.length);
    if (!token || !/^[a-f0-9-]{36}$/.test(token) || job !== path.join(this.root, token)) return;
    const request = JSON.parse(await fs.readFile(path.join(job, 'install.json'), 'utf8'));
    if (request.version !== this.app.getVersion() || request.target !== path.resolve(this.execPath, '../../..')) return;
    await fs.writeFile(path.join(job, 'started.partial'), `${this.app.getVersion()}:${process.pid}:${token}\n`, { mode: 0o600 });
    await fs.rename(path.join(job, 'started.partial'), path.join(job, 'started.txt'));
    this.set({ message: `已更新至 ${this.app.getVersion()}。` });
  }
}
module.exports = { Updater, compareVersions, selectRelease, downloadVerified, requestResponse, createSessionRequest, RELEASES_URL };
