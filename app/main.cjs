const { app, BrowserWindow, ipcMain, dialog, protocol, net, shell, session, Menu } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { randomUUID } = require('node:crypto');
const { Library } = require('./library.cjs');
const { buildNob, verifyNob, oidValue } = require('./nob.cjs');
const { validateMp3, convertBatch } = require('./audio.cjs');
const { Updater, createSessionRequest, RELEASES_URL } = require('./updater.cjs');
protocol.registerSchemesAsPrivileged([{ scheme: 'xkd-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }]);
app.setName('小蝌蚪点读制作');
let window, library, updater, operations = 0, queue = Promise.resolve();
const pageUrl = pathToFileURL(path.join(__dirname, 'ui', 'index.html')).href;
const pub = book => library.publicBook(book);
function handle(name, action, serial = true) {
  ipcMain.handle(name, (event, ...args) => {
    if (event.senderFrame?.url !== pageUrl) return { ok: false, error: '无效的应用页面' };
    if (serial) operations++;
    const execute = async () => {
      try {
        if (serial && updater?.snapshot().status === 'installing') throw new Error('正在安装更新，请等待应用重启');
        return { ok: true, data: await action(...args) };
      }
      catch (error) { return { ok: false, error: error.message || '操作失败' }; }
      finally { if (serial) operations--; }
    };
    if (!serial) return execute();
    const operation = queue.then(execute);
    queue = operation.then(() => {}, () => {});
    return operation;
  });
}
function progress(message) { if (window && !window.isDestroyed()) window.webContents.send('progress', message); }
async function audioTool() {
  for (const target of [path.join(process.resourcesPath, 'runtime', 'ffmpeg'), path.join(__dirname, '..', 'runtime', 'ffmpeg')]) {
    try { await fs.access(target); return target; } catch {}
  }
  throw new Error('应用缺少内置音频工具，请重新解压完整的 Mac 应用');
}
async function exportBook(id) {
  const book = await library.get(id);
  if (!book.tracks.length) throw new Error('请先导入音频');
  for (const track of book.tracks) {
    if (!track.oid) throw new Error(`请填写「${track.name}」的点读码`);
    oidValue(track.oid);
  }
  const selected = await dialog.showOpenDialog(window, { title: '选择 NOB 保存文件夹', properties: ['openDirectory', 'createDirectory'] });
  if (selected.canceled) return null;
  // 文件夹由系统对话框授权；书名仅用作文件名片段，不允许路径成分。
  const folder = await fs.realpath(selected.filePaths[0]);
  const name = book.title.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80).replace(/^\.+/, '_') || '点读书';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '_').slice(0, 15);
  const output = path.join(folder, `${name}_${timestamp}_${randomUUID().slice(0, 4)}.nob`);
  let written = false;
  try {
    const ffmpeg = await audioTool();
    const tracks = [];
    for (let i = 0; i < book.tracks.length; i++) {
      const track = book.tracks[i], source = await library.mediaPath(id, track.id);
      progress(`正在核对音频并保留原声 ${i + 1} / ${book.tracks.length}：${track.name}`);
      try {
        await validateMp3(ffmpeg, source);
      } catch { throw new Error(`「${track.name}」无法完整解码为 MP3，请检查原文件；其他格式可使用独立的批量转 MP3 功能`); }
      tracks.push({ oid: track.oid, audio: await fs.readFile(source) });
    }
    progress('正在合成 NOB…');
    const built = buildNob(book.title, tracks);
    // @CfSecAICode 遵循消费金融安全编码 BE-FILE-002 规范: 输出仅写入对话框授权的真实文件夹，随机新文件名且禁止覆盖。
    await fs.writeFile(output, built.bytes, { flag: 'wx' }); written = true;
    progress('正在重新读取并核对成品…');
    const verification = verifyNob(await fs.readFile(output), tracks);
    const result = { id: randomUUID(), output, title: book.title, createdAt: new Date().toISOString(), ...verification, ranges: built.ranges, audioRecompressed: false, penTest: 'not_performed' };
    book.exports = [result, ...(book.exports || [])].slice(0, 30);
    await library.save(book);
    return { book: await pub(book), result };
  } catch (error) {
    if (written) await fs.unlink(output).catch(() => {});
    throw error;
  } finally { progress(''); }
}
let batchFiles = [], batchResult = null;
async function ready() {
  library = new Library(path.join(app.getPath('userData'), 'library')); await library.init();
  protocol.handle('xkd-media', async request => {
    try {
      const url = new URL(request.url), parts = url.pathname.split('/').filter(Boolean);
      if (url.hostname !== 'audio' || parts.length !== 2) return new Response('', { status: 404 });
      return net.fetch(pathToFileURL(await library.mediaPath(parts[0], parts[1])).href, { headers: request.headers });
    } catch { return new Response('', { status: 404 }); }
  });
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  const updateSession = session.fromPartition('reading-pen-maker-updates');
  updateSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  updater = new Updater({ app, request: createSessionRequest(updateSession, net), isBusy: () => exporting || operations > 0,
    onState: state => { if (window && !window.isDestroyed()) window.webContents.send('updates:state', state); } });
  await updater.init();
  handle('updates:state', () => updater.snapshot(), false);
  handle('updates:check', () => updater.check(), false);
  handle('updates:configure', settings => updater.configure(settings), false);
  handle('updates:download', () => updater.download(), false);
  handle('updates:cancel', () => updater.cancel(), false);
  handle('updates:started', () => updater.acknowledgeStart(), false);
  handle('updates:releases', () => shell.openExternal(RELEASES_URL), false);
  handle('updates:install', async () => {
    if (updater.snapshot().status !== 'ready') throw new Error('请先下载并校验新版');
    const choice = await dialog.showMessageBox(window, { type: 'question', message: `安装 ${updater.snapshot().release.version} 并重启？`,
      detail: '应用会退出并替换；书籍和音频保留。新版启动失败时会恢复旧版。', buttons: ['安装并重启', '稍后'], defaultId: 0, cancelId: 1 });
    return choice.response === 0 ? updater.install() : updater.snapshot();
  }, false);
  handle('books:list', async () => ({ books: await Promise.all((await library.list()).map(pub)), version: app.getVersion(), arch: process.arch }));
  handle('books:create', async title => pub(await library.create(title)));
  handle('books:update', async (id, draft) => pub(await library.update(id, draft)));
  handle('audio:import', async id => {
    await library.get(id);
    const choice = await dialog.showOpenDialog(window, { title: '导入点读音频', properties: ['openFile', 'multiSelections'], filters: [{ name: 'MP3 音频', extensions: ['mp3'] }] });
    return choice.canceled ? null : pub(await library.importAudio(id, choice.filePaths));
  });
  handle('audio:remove', async (id, trackId) => pub(await library.removeTrack(id, trackId)));
  handle('batch:choose', async () => {
    const choice = await dialog.showOpenDialog(window, { title: '选择批量转 MP3 的音频', properties: ['openFile', 'multiSelections'], filters: [{ name: '音频文件', extensions: ['mp3', 'wma', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'aiff'] }] });
    if (choice.canceled) return null;
    batchFiles = choice.filePaths;
    return batchFiles.map(file => ({ name: path.basename(file) }));
  });
  handle('batch:convert', async () => {
    if (!batchFiles.length) throw new Error('请先选择需要转换的音频');
    const choice = await dialog.showOpenDialog(window, { title: '选择批量转换保存位置', properties: ['openDirectory', 'createDirectory'] });
    if (choice.canceled) return null;
    exporting = true;
    try { batchResult = await convertBatch(await audioTool(), batchFiles, choice.filePaths[0], progress); return batchResult; }
    finally { exporting = false; progress(''); }
  });
  handle('batch:cloud', () => shell.openExternal('https://cloud.xiaobien.com/'), false);
  handle('batch:show', async () => {
    if (!batchResult) throw new Error('还没有转换结果');
    await fs.access(batchResult.folder); shell.showItemInFolder(path.join(batchResult.folder, '转换记录.json'));
  });
  handle('books:export', async id => {
    exporting = true;
    try { return await exportBook(id); } finally { exporting = false; }
  });
  handle('exports:show', async (id, exportId) => {
    const book = await library.get(id), result = (book.exports || []).find(row => row.id === exportId);
    if (!result) throw new Error('生成记录不存在');
    await fs.access(result.output); shell.showItemInFolder(result.output);
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: app.name, submenu: [{ role: 'about' }, { label: '检查更新…', click: () => window?.webContents.send('updates:open') }, { type: 'separator' }, { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '窗口', submenu: [{ role: 'minimize' }, { role: 'zoom' }, { role: 'front' }] }
  ]));
  makeWindow();
  const check = () => { if (updater.settings.autoCheck && updater.snapshot().supported) updater.check(); };
  const first = setTimeout(check, 5000), periodic = setInterval(check, 6 * 60 * 60 * 1000);
  first.unref(); periodic.unref();
  app.once('will-quit', () => { clearTimeout(first); clearInterval(periodic); });
}
function makeWindow() {
  window = new BrowserWindow({ width: 1260, height: 830, minWidth: 1000, minHeight: 680, title: '小蝌蚪点读制作', backgroundColor: '#f7f8f5', titleBarStyle: 'hiddenInset', webPreferences: { preload: path.join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
  window.webContents.on('will-prevent-unload', event => {
    const choice = dialog.showMessageBoxSync(window, { type: 'question', buttons: ['继续编辑', '放弃修改并关闭'], defaultId: 0, cancelId: 0, message: '这本书还有未保存的修改', detail: '点击「保存修改」可保留本次编辑。' });
    if (choice === 1) event.preventDefault();
  });
  window.on('close', event => { if (exporting) { event.preventDefault(); dialog.showMessageBox(window, { type: 'info', message: '正在处理音频或生成点读包，请完成后再关闭。' }); } });
  window.loadFile(path.join(__dirname, 'ui', 'index.html'));
}
let exporting = false;
if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.whenReady().then(ready).catch(error => { dialog.showErrorBox('无法打开小蝌蚪点读制作', error.message); app.quit(); });
  app.on('window-all-closed', () => app.quit());
  app.on('second-instance', () => { if (window) { window.show(); window.focus(); } });
}
module.exports = { getUpdater: () => updater };
