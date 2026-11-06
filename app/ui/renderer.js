const $ = selector => document.querySelector(selector);
const state = { books: [], current: null, dirty: false, busy: false };
function el(tag, className, text) { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; }
function notice(message, error = false) { $('#notice').hidden = !message; $('#notice').textContent = message; $('#notice').className = error ? 'error' : ''; }
function setBusy(busy) { state.busy = busy; for (const control of document.querySelectorAll('button,input')) control.disabled = busy; renderUpdate(); }
async function perform(action) {
  if (state.busy) return;
  notice(''); setBusy(true);
  try { await action(); } catch (error) { notice(error.message, true); }
  finally { setBusy(false); }
}
function dirty() { state.dirty = true; $('#save-status').textContent = '有未保存的修改'; $('#save-status').className = 'dirty'; summary(); }
function remember(book) {
  state.books = [book, ...state.books.filter(b => b.id !== book.id)]; state.current = structuredClone(book); state.dirty = false;
}
async function saveCurrent() {
  if (!state.current || !state.dirty) return;
  const book = await window.xkd.update(state.current.id, { title: state.current.title, tracks: state.current.tracks.map(({ id, oid, label }) => ({ id, oid, label })) });
  remember(book); renderShelf(); $('#save-status').textContent = '已保存'; $('#save-status').className = ''; $('#updated-at').textContent = new Date(book.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function renderShelf() {
  $('#book-count').textContent = state.books.length; $('#books').replaceChildren();
  for (const book of state.books) {
    const button = el('button', 'book-item' + (state.current?.id === book.id ? ' active' : ''));
    button.dataset.id = book.id;
    const cover = el('span', 'mini-cover', book.title.slice(0, 1));
    const text = el('div', 'book-item-text'); text.append(el('strong', '', book.title), el('small', '', `${book.tracks.length} 段音频`)); button.append(cover, text);
    button.onclick = () => perform(async () => { await saveCurrent(); stopPlayer(); state.current = structuredClone(state.books.find(b => b.id === book.id)); render(); });
    $('#books').append(button);
  }
}
function summary() {
  const tracks = state.current?.tracks || [];
  $('#track-count').textContent = tracks.length;
  $('#point-count').textContent = new Set(tracks.filter(t => t.oid).map(t => t.oid)).size;
  $('#pending-count').textContent = tracks.filter(t => !t.oid).length;
}
function renderTracks() {
  const tracks = state.current.tracks; $('#tracks').replaceChildren(); $('#table-wrap').hidden = !tracks.length; $('#audio-empty').hidden = !!tracks.length;
  tracks.forEach((track, i) => {
    const row = el('tr'); row.dataset.id = track.id;
    row.append(el('td', 'row-index', String(i + 1)));
    const codeCell = el('td'), code = el('input', 'code-input' + (!track.oid ? ' missing' : '')); code.value = track.oid; code.inputMode = 'numeric'; code.placeholder = '填写码值'; code.setAttribute('aria-label', `点读码 ${i + 1}`);
    code.oninput = () => { track.oid = code.value.trim(); code.classList.toggle('missing', !track.oid); dirty(); }; codeCell.append(code); row.append(codeCell);
    const labelCell = el('td'), label = el('input', 'label-input'); label.value = track.label; label.maxLength = 150; label.setAttribute('aria-label', `音频说明 ${i + 1}`); label.oninput = () => { track.label = label.value; dirty(); };
    labelCell.append(label, el('small', 'file-name', track.name)); row.append(labelCell);
    const actionsCell = el('td'), actions = el('div', 'row-buttons');
    const play = el('button', 'icon-button', '▷'); play.title = '试听'; play.setAttribute('aria-label', `试听音频 ${i + 1}`); play.onclick = () => playTrack(track);
    const up = el('button', 'icon-button', '↑'); up.title = '上移'; up.setAttribute('aria-label', `上移音频 ${i + 1}`); up.disabled = i === 0; up.onclick = () => { if (i > 0) { [tracks[i - 1], tracks[i]] = [tracks[i], tracks[i - 1]]; dirty(); renderTracks(); } };
    const down = el('button', 'icon-button', '↓'); down.title = '下移'; down.setAttribute('aria-label', `下移音频 ${i + 1}`); down.disabled = i === tracks.length - 1; down.onclick = () => { if (i < tracks.length - 1) { [tracks[i + 1], tracks[i]] = [tracks[i], tracks[i + 1]]; dirty(); renderTracks(); } };
    const remove = el('button', 'icon-button remove', '×'); remove.title = '移出这本书'; remove.setAttribute('aria-label', `移除音频 ${i + 1}`); remove.onclick = () => perform(async () => { await saveCurrent(); remember(await window.xkd.removeAudio(state.current.id, track.id)); stopPlayer(); render(); });
    actions.append(play, up, down, remove); actionsCell.append(actions); row.append(actionsCell); $('#tracks').append(row);
  });
}
function renderHistory() {
  const results = state.current.exports || []; $('#history-section').hidden = !results.length; $('#history').replaceChildren();
  for (const result of results) {
    const row = el('div', 'history-item'), text = el('div'), title = el('div', 'history-title');
    title.append(el('strong', '', `${result.title}.nob`), el('span', 'passed', '文件核对通过'));
    text.append(title, el('small', '', `${new Date(result.createdAt).toLocaleString('zh-CN')} · ${result.points} 个码 / ${result.audios} 段音频 · ${(result.bytes / 1024 / 1024).toFixed(2)} MB · 待实笔试读`));
    const show = el('button', 'text-button', '在 Finder 中显示 ↗'); show.onclick = () => perform(() => window.xkd.showExport(state.current.id, result.id));
    row.append(text, show); $('#history').append(row);
  }
}
function render() {
  renderShelf(); $('#welcome').hidden = !!state.current; $('#editor').hidden = !state.current;
  if (!state.current) return;
  $('#book-title').value = state.current.title; $('#book-cover').textContent = state.current.title.slice(0, 1);
  $('#save-status').textContent = state.dirty ? '有未保存的修改' : '已保存'; $('#save-status').className = state.dirty ? 'dirty' : '';
  $('#updated-at').textContent = new Date(state.current.updatedAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  summary(); renderTracks(); renderHistory();
}
async function playTrack(track) {
  $('#player-panel').hidden = false; $('#player-name').textContent = track.label || track.name;
  const player = $('#player'); player.src = track.url;
  try { await player.play(); } catch (error) { if (player.getAttribute('src') === track.url && error.name !== 'AbortError') notice('这段音频暂时无法试听，请检查 MP3 是否有效。', true); }
}
function stopPlayer() { $('#player').pause(); $('#player').removeAttribute('src'); $('#player').load(); $('#player-panel').hidden = true; }
function createDialog() { $('#new-title').value = ''; $('#create-dialog').showModal(); $('#new-title').focus(); }
$('#new-book').onclick = createDialog; $('#welcome-create').onclick = createDialog;
$('#cancel-create').onclick = () => $('#create-dialog').close();
$('#create-form').onsubmit = event => { event.preventDefault(); const title = $('#new-title').value.trim(); if (!title) return;
  perform(async () => { await saveCurrent(); remember(await window.xkd.create(title)); $('#create-dialog').close(); stopPlayer(); render(); }); };
$('#book-title').oninput = event => { state.current.title = event.target.value; dirty(); };
$('#save').onclick = () => perform(async () => { await saveCurrent(); render(); notice('书籍与点读码对应关系已保存。'); });
async function importAudio() { await saveCurrent(); const book = await window.xkd.importAudio(state.current.id); if (book) { remember(book); render(); notice('音频已复制到书籍资料库。请核对识别到的码值，补齐空白项。'); } }
$('#import').onclick = () => perform(importAudio); $('#empty-import').onclick = () => perform(importAudio);
$('#assign').onclick = () => { if (!state.current.tracks.length) return notice('请先导入音频。', true); $('#start-code').value = ''; $('#assign-dialog').showModal(); };
$('#cancel-assign').onclick = () => $('#assign-dialog').close();
$('#assign-form').onsubmit = event => { event.preventDefault(); const value = $('#start-code').value.trim();
  if (!/^[1-9]\d{0,9}$/.test(value) || Number(value) > 2147483647) return notice('请输入 1 至 2147483647 之间的起始码值。', true);
  const used = new Set(state.current.tracks.filter(t => t.oid).map(t => Number(t.oid))), updates = []; let next = Number(value);
  for (const track of state.current.tracks) { if (track.oid) continue; while (used.has(next)) next++; if (next > 2147483647) return notice('连续码值超出范围，请修改起始值。', true); updates.push([track, String(next)]); used.add(next++); }
  for (const [track, code] of updates) track.oid = code;
  $('#assign-dialog').close(); dirty(); renderTracks(); notice('空白码值已填写，请核对后保存。'); };
$('#export').onclick = () => perform(async () => {
  await saveCurrent(); stopPlayer(); const result = await window.xkd.exportNob(state.current.id);
  if (result) { remember(result.book); render(); notice(`NOB 已生成并通过文件核对：${result.result.points} 个点读码、${result.result.audios} 段音频。\n首次使用请在点读笔上安装、切书并试读。`); }
});
$('#help').onclick = () => $('#help-dialog').showModal(); $('#close-help').onclick = () => $('#help-dialog').close(); $('#close-player').onclick = stopPlayer;
$('#batch-open').onclick = () => { stopPlayer(); $('#batch-dialog').showModal(); };
$('#batch-close').onclick = () => $('#batch-dialog').close();
$('#batch-cloud').onclick = async () => {
  $('#batch-cloud-error').hidden = true;
  try { await window.xkd.openCloud(); }
  catch { $('#batch-cloud-error').textContent = '无法打开浏览器，请手动访问 https://cloud.xiaobien.com/'; $('#batch-cloud-error').hidden = false; }
};
$('#batch-dialog').addEventListener('cancel', event => { if (state.busy) event.preventDefault(); });
$('#batch-choose').onclick = () => perform(async () => {
  const files = await window.xkd.chooseBatch();
  if (!files) return;
  $('#batch-count').textContent = `已选择 ${files.length} 个音频`;
  $('#batch-files').replaceChildren(...files.map(file => el('li', '', file.name)));
  $('#batch-result').hidden = true; $('#batch-results').hidden = true; $('#batch-show').hidden = true;
});
$('#batch-start').onclick = () => perform(async () => {
  try {
    const result = await window.xkd.convertBatch();
    if (!result) return;
    $('#batch-result').hidden = false; $('#batch-result').textContent = `转换完成：成功 ${result.succeeded} 个，失败 ${result.failed} 个。源文件已保留。`;
    $('#batch-results').hidden = false;
    $('#batch-results').replaceChildren(...result.results.map(row => el('li', row.ok ? '' : 'batch-error', row.ok ? `✓ ${row.name} → ${row.outputName}` : `× ${row.name}：${row.error}`)));
    $('#batch-show').hidden = false;
  } catch (error) { $('#batch-result').hidden = false; $('#batch-result').textContent = error.message; }
});
$('#batch-show').onclick = () => perform(() => window.xkd.showBatch());
window.xkd.onProgress(message => { $('#progress').hidden = !message; $('#progress-text').textContent = message; $('#batch-progress').hidden = !message; $('#batch-progress').textContent = message; });
window.addEventListener('beforeunload', event => { if (state.dirty) { event.preventDefault(); event.returnValue = ''; } });
$('#player').onerror = () => { if ($('#player').getAttribute('src')) notice('音频读取失败；请尝试重新导入这段 MP3。', true); };
let updateState = null, updatePending = false;
function renderUpdate() {
  if (!updateState) return;
  const value = updateState, busy = state.busy || updatePending || ['checking','downloading','preparing','installing'].includes(value.status);
  $('#update-current').textContent = `当前版本 ${value.currentVersion} · ${value.arch === 'x64' ? 'Intel' : 'Apple 芯片'}`;
  $('#update-message').textContent = value.message || '可以检查 GitHub 上的新版本。';
  $('#update-check').disabled = busy || value.status === 'ready';
  $('#update-download').hidden = !value.release || !['available','error'].includes(value.status);
  $('#update-download').disabled = busy || !value.supported;
  $('#update-install').hidden = value.status !== 'ready'; $('#update-install').disabled = busy;
  $('#update-cancel').hidden = value.status !== 'downloading'; $('#update-cancel').disabled = false;
  $('#update-close').disabled = value.status === 'installing';
  $('#update-progress').hidden = !['downloading','preparing'].includes(value.status); $('#update-progress').value = value.progress;
  $('#update-release').hidden = !value.release;
  if (value.release) { $('#update-next').textContent = `新版 ${value.release.version} · ${Math.ceil(value.release.size / 1048576)} MB`; $('#update-notes').textContent = value.release.notes; }
  for (const [id,key] of [['update-auto','autoCheck'],['update-auto-download','autoDownload'],['update-candidates','includePrerelease']]) { $('#'+id).checked = value.settings[key]; $('#'+id).disabled = busy; }
}
async function updateAction(action) {
  if (updatePending) return;
  updatePending = true; renderUpdate();
  try { const next = await action(); if (next?.status) updateState = next; }
  catch (error) { if (updateState) updateState.message = error.message; }
  finally { updatePending = false; renderUpdate(); }
}
function openUpdates() { if (!$('#update-dialog').open) $('#update-dialog').showModal(); updateAction(() => window.xkd.updateState()); }
$('#update-open').onclick = openUpdates; window.xkd.onUpdateOpen(openUpdates);
$('#update-close').onclick = () => $('#update-dialog').close();
$('#update-dialog').addEventListener('cancel', event => { if (updateState?.status === 'installing') event.preventDefault(); });
$('#update-check').onclick = () => updateAction(() => window.xkd.checkUpdates());
$('#update-download').onclick = () => updateAction(() => window.xkd.downloadUpdate());
$('#update-cancel').onclick = () => window.xkd.cancelUpdate().then(next => { updateState = next; renderUpdate(); });
$('#update-install').onclick = () => perform(async () => { await saveCurrent(); stopPlayer(); await updateAction(() => window.xkd.installUpdate()); });
$('#update-releases').onclick = () => updateAction(() => window.xkd.openReleases());
for (const [id,key] of [['update-auto','autoCheck'],['update-auto-download','autoDownload'],['update-candidates','includePrerelease']]) $('#'+id).onchange = event => { const checked = event.target.checked; updateAction(() => window.xkd.configureUpdates({ [key]: checked })); };
window.xkd.onUpdateState(next => { updateState = next; renderUpdate(); });
perform(async () => { const initial = await window.xkd.list(); state.books = initial.books; state.current = state.books.length ? structuredClone(state.books[0]) : null; $('#version').textContent = `v${initial.version} · ${initial.arch === 'x64' ? 'Intel' : 'Apple'}`; render(); updateState = await window.xkd.updateState(); renderUpdate(); await window.xkd.updateStarted(); });
