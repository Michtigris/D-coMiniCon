const app = document.getElementById('app');

app.innerHTML = `
  <div class="bar-root" id="root">
    <button type="button" class="buddy bar-logo" id="logo" title="Glisser · clic = màj · clic droit = conversation · double-clic = Masquer" aria-label="DécoMiniCon">
      <span class="buddy-stage">
        <span class="buddy-top"></span>
        <span class="buddy-bottom"></span>
      </span>
      <span class="bar-badge" id="badge" hidden>0</span>
    </button>
    <button type="button" class="bar-status" id="status" hidden></button>
  </div>
`;

const logo = document.getElementById('logo');
const badge = document.getElementById('badge');
const statusBtn = document.getElementById('status');
const FLIP_MS = 340;
const DRAG_PX = 6;
const CLICK_DELAY_MS = 350;
let nextSide = 'right';
let flipTimer = 0;
let closeTimer = 0;
let clickTimer = 0;
let hideStatusTimer = 0;
let hovering = false;
let press = null;
let didDrag = false;
let updateInfo = { status: 'idle', current: '', version: null, message: null };

function stopAnim() {
  clearInterval(flipTimer);
  flipTimer = 0;
  clearTimeout(closeTimer);
  closeTimer = 0;
  logo.classList.remove('talking', 'talk-left', 'talk-right');
}

function flipSide() {
  logo.classList.remove('talk-left', 'talk-right');
  void logo.offsetWidth;
  logo.classList.add('talking', nextSide === 'right' ? 'talk-right' : 'talk-left');
  nextSide = nextSide === 'right' ? 'left' : 'right';
}

function startHoverTalk() {
  hovering = true;
  clearTimeout(closeTimer);
  closeTimer = 0;
  if (!flipTimer) {
    flipSide();
    flipTimer = setInterval(() => {
      if (hovering) flipSide();
    }, FLIP_MS);
  }
}

function statusLabel(info) {
  switch (info.status) {
    case 'checking':
      return 'Vérification…';
    case 'latest':
      return `À jour · v${info.current || '?'}`;
    case 'available':
      return `Mettre à jour · v${info.version || '?'}`;
    case 'downloading':
      return 'Téléchargement…';
    case 'ready':
      return 'Installation…';
    case 'dev':
      return `Dev · v${info.current || '?'}`;
    case 'error':
      return info.message ? `Erreur màj` : 'Erreur màj';
    default:
      return 'Vérifier les màj';
  }
}

function renderStatus(info) {
  updateInfo = { ...updateInfo, ...(info || {}) };
  const clickable = updateInfo.status === 'available' || updateInfo.status === 'ready';
  statusBtn.hidden = false;
  statusBtn.textContent = statusLabel(updateInfo);
  statusBtn.classList.toggle('can-update', clickable);
  statusBtn.classList.toggle('is-ok', updateInfo.status === 'latest' || updateInfo.status === 'dev');
  statusBtn.classList.toggle('is-busy', updateInfo.status === 'checking' || updateInfo.status === 'downloading' || updateInfo.status === 'ready');
  statusBtn.classList.toggle('is-err', updateInfo.status === 'error');
  statusBtn.title = clickable
    ? 'Cliquer pour installer la mise à jour'
    : (updateInfo.message || statusLabel(updateInfo));
  window.deco.expandBar(true);
  clearTimeout(hideStatusTimer);
  if (updateInfo.status === 'latest' || updateInfo.status === 'dev') {
    hideStatusTimer = setTimeout(hideStatus, 3200);
  } else if (updateInfo.status === 'error') {
    hideStatusTimer = setTimeout(hideStatus, 4200);
  }
}

function hideStatus() {
  clearTimeout(hideStatusTimer);
  hideStatusTimer = 0;
  statusBtn.hidden = true;
  statusBtn.classList.remove('can-update', 'is-ok', 'is-busy', 'is-err');
  window.deco.expandBar(false);
}

async function runUpdateCheck() {
  renderStatus({ status: 'checking', current: updateInfo.current });
  try {
    const info = await window.deco.checkUpdate();
    renderStatus(info);
  } catch (err) {
    renderStatus({ status: 'error', message: err?.message || 'Vérification impossible' });
  }
}

function armSingleClick() {
  clearTimeout(clickTimer);
  clickTimer = setTimeout(() => {
    clickTimer = 0;
    runUpdateCheck();
  }, CLICK_DELAY_MS);
}

function cancelSingleClick() {
  clearTimeout(clickTimer);
  clickTimer = 0;
}

logo.addEventListener('pointerenter', startHoverTalk);

logo.addEventListener('pointerleave', () => {
  hovering = false;
  clearInterval(flipTimer);
  flipTimer = 0;
  closeTimer = setTimeout(stopAnim, 160);
});

logo.addEventListener('pointerdown', (event) => {
  if (event.button === 2) {
    event.preventDefault();
    cancelSingleClick();
    window.deco.toggleChat();
    return;
  }
  if (event.button !== 0) return;
  didDrag = false;
  press = { x: event.screenX, y: event.screenY };
  logo.setPointerCapture(event.pointerId);
});

logo.addEventListener('pointermove', (event) => {
  if (!press || didDrag) return;
  const dx = event.screenX - press.x;
  const dy = event.screenY - press.y;
  if ((dx * dx) + (dy * dy) < DRAG_PX * DRAG_PX) return;
  didDrag = true;
  cancelSingleClick();
  hideStatus();
  window.deco.beginDrag();
});

logo.addEventListener('pointerup', (event) => {
  if (event.button !== 0) return;
  try {
    logo.releasePointerCapture(event.pointerId);
  } catch {
    // ignore
  }
  const wasDrag = didDrag;
  press = null;
  didDrag = false;
  if (wasDrag) return;
  armSingleClick();
});

logo.addEventListener('pointercancel', () => {
  press = null;
  didDrag = false;
  cancelSingleClick();
});

logo.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  cancelSingleClick();
  hovering = false;
  stopAnim();
  hideStatus();
  window.deco.hideGame();
});

logo.addEventListener('contextmenu', (event) => {
  event.preventDefault();
});

statusBtn.addEventListener('click', async (event) => {
  event.preventDefault();
  if (updateInfo.status !== 'available' && updateInfo.status !== 'ready') return;
  renderStatus({ ...updateInfo, status: updateInfo.status === 'ready' ? 'ready' : 'downloading' });
  try {
    await window.deco.installUpdate();
  } catch (err) {
    renderStatus({ status: 'error', message: err?.message || 'Installation impossible' });
  }
});

window.deco.on('update:status', renderStatus);

window.deco.on('badge', (info) => {
  const unread = Number(info?.unread) || 0;
  const call = !!info?.call;
  const show = call || unread > 0;
  badge.hidden = !show;
  badge.textContent = call ? '!' : (unread > 9 ? '9+' : String(unread));
  logo.classList.toggle('ringing', call);
  logo.classList.toggle('off', info && info.connected === false);
});
