const app = document.getElementById('app');

app.innerHTML = `
  <div class="bar-root" id="root">
    <button type="button" class="buddy bar-logo" id="logo" title="DécoMiniCon" aria-label="DécoMiniCon">
      <span class="buddy-stage">
        <span class="buddy-top">
          <i class="eye eye-l" aria-hidden="true"></i>
          <i class="eye eye-r" aria-hidden="true"></i>
        </span>
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
const TALK_DUR = 0.2;
const DRAG_PX = 6;
const CLICK_DELAY_MS = 350;
let nextSide = 'right';
let flipTimer = 0;
let closeTimer = 0;
let clickTimer = 0;
let hideStatusTimer = 0;
let hovering = false;
let pressing = false;
let pausedForGrab = false;
let press = null;
let didDrag = false;
let updateInfo = { status: 'idle', current: '', version: null, message: null };

logo.style.setProperty('--talk-dur', `${TALK_DUR}s`);

function clearFlip() {
  clearInterval(flipTimer);
  flipTimer = 0;
}

function stopAnim() {
  clearFlip();
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

function startFlipLoop() {
  clearFlip();
  clearTimeout(closeTimer);
  closeTimer = 0;
  pausedForGrab = false;
  flipSide();
  flipTimer = setInterval(() => {
    if (hovering && !pressing && !pausedForGrab) flipSide();
  }, FLIP_MS);
}

function startHoverTalk() {
  hovering = true;
  clearTimeout(closeTimer);
  closeTimer = 0;
  // Pas de relance tant que clic maintenu / pause grab
  if (pressing || pausedForGrab) return;
  if (!flipTimer) startFlipLoop();
}

/** Grab : pas de ralentissement — finit le cycle en cours, revient au repos, ne relance pas. */
function finishAnimForGrab() {
  pausedForGrab = true;
  clearFlip();
  clearTimeout(closeTimer);
  // Laisse finir l’anim CSS en cours, puis bouche fermée
  closeTimer = setTimeout(() => {
    logo.classList.remove('talking', 'talk-left', 'talk-right');
    closeTimer = 0;
  }, Math.round(TALK_DUR * 1000));
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
      return 'Erreur màj';
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
  if (pressing) return;
  clearFlip();
  closeTimer = setTimeout(stopAnim, 160);
});

let rightClickAt = 0;
function onRightClick(event) {
  if (event) {
    event.preventDefault();
    event.stopPropagation();
  }
  const now = Date.now();
  // pointerdown + auxclick + contextmenu peuvent tous partir → un seul toggle
  if (now - rightClickAt < 400) return;
  rightClickAt = now;
  cancelSingleClick();
  hideStatus();
  pressing = false;
  press = null;
  didDrag = false;
  window.deco.toggleChat();
}

logo.addEventListener('pointerdown', (event) => {
  try {
    logo.blur();
  } catch {
    // ignore
  }
  if (event.button === 2) {
    onRightClick(event);
    return;
  }
  if (event.button !== 0) return;
  // Évite le focus orange sans bloquer les autres boutons souris
  event.preventDefault();
  didDrag = false;
  pressing = true;
  press = { x: event.screenX, y: event.screenY };
  try {
    logo.setPointerCapture(event.pointerId);
  } catch {
    // ignore
  }
  finishAnimForGrab();
});

logo.addEventListener('auxclick', (event) => {
  if (event.button === 2) onRightClick(event);
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
  pressing = false;

  // Relance seulement après lâcher + toujours sur le logo
  if (hovering) startFlipLoop();
  else {
    pausedForGrab = false;
    stopAnim();
  }

  if (wasDrag) return;
  armSingleClick();
});

logo.addEventListener('pointercancel', () => {
  press = null;
  didDrag = false;
  pressing = false;
  cancelSingleClick();
  if (hovering) startFlipLoop();
  else {
    pausedForGrab = false;
    stopAnim();
  }
});

logo.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  cancelSingleClick();
  pressing = false;
  pausedForGrab = false;
  hovering = false;
  stopAnim();
  hideStatus();
  window.deco.hideGame();
});

logo.addEventListener('contextmenu', (event) => {
  onRightClick(event);
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

window.deco.on('bar:status-side', (side) => {
  const root = document.getElementById('root');
  const left = side === 'left';
  if (root) root.classList.toggle('status-left', left);
  document.body.classList.toggle('status-left', left);
});

window.deco.on('badge', (info) => {
  const unread = Number(info?.unread) || 0;
  const call = !!info?.call;
  const show = call || unread > 0;
  badge.hidden = !show;
  badge.textContent = call ? '!' : (unread > 9 ? '9+' : String(unread));
  logo.classList.toggle('ringing', call);
  logo.classList.toggle('off', info && info.connected === false);
  // Yeux vert/rouge uniquement sur ce logo flottant, si serveur connecté
  const onServer = !!info?.connected;
  logo.classList.toggle('eyes-on', onServer);
  logo.classList.toggle('eyes-online', onServer && !!info?.partnerOnline);
  logo.classList.toggle('eyes-offline', onServer && !info?.partnerOnline);
});
