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
const NORMAL_FLIP_MS = 340;
const NORMAL_DUR = 0.2;
const SLOW_DUR = 0.9;
const RAMP_MS = 500;
const DRAG_PX = 6;
const CLICK_DELAY_MS = 350;
let nextSide = 'right';
let flipTimer = 0;
let closeTimer = 0;
let clickTimer = 0;
let hideStatusTimer = 0;
let rampRaf = 0;
let talkDur = NORMAL_DUR;
let hovering = false;
let pressing = false;
let stoppedForGrab = false;
let press = null;
let didDrag = false;
let updateInfo = { status: 'idle', current: '', version: null, message: null };

function setTalkDur(sec) {
  talkDur = sec;
  logo.style.setProperty('--talk-dur', `${sec}s`);
}

function clearRamp() {
  if (rampRaf) cancelAnimationFrame(rampRaf);
  rampRaf = 0;
}

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

function flipIntervalFor(dur) {
  return Math.max(280, Math.round(dur * 1700));
}

function startFlipLoop(intervalMs) {
  clearFlip();
  flipSide();
  flipTimer = setInterval(() => {
    if (hovering || pressing) flipSide();
  }, intervalMs);
}

function easeInOut(t) {
  return t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2;
}

function rampDur(from, to, ms, onFrame, onDone) {
  clearRamp();
  const t0 = performance.now();
  const step = (now) => {
    const t = Math.min(1, (now - t0) / ms);
    const v = from + (to - from) * easeInOut(t);
    setTalkDur(v);
    onFrame?.(v, t);
    if (t < 1) {
      rampRaf = requestAnimationFrame(step);
    } else {
      rampRaf = 0;
      onDone?.(to);
    }
  };
  rampRaf = requestAnimationFrame(step);
}

function startHoverTalk(normal = true) {
  hovering = true;
  clearTimeout(closeTimer);
  closeTimer = 0;
  if (pressing || stoppedForGrab) return;
  clearRamp();
  if (normal) setTalkDur(NORMAL_DUR);
  if (!logo.classList.contains('talking') || !flipTimer) {
    startFlipLoop(flipIntervalFor(talkDur));
  }
}

function slowToStopForGrab() {
  stoppedForGrab = false;
  clearTimeout(closeTimer);
  closeTimer = 0;
  if (!logo.classList.contains('talking')) {
    setTalkDur(NORMAL_DUR);
    startFlipLoop(NORMAL_FLIP_MS);
  }
  const from = talkDur;
  rampDur(from, SLOW_DUR, RAMP_MS, (dur) => {
    // Ralentit le rythme des claps pendant le grab
    if (flipTimer) {
      clearFlip();
      flipTimer = setInterval(() => {
        if (pressing) flipSide();
      }, flipIntervalFor(dur));
    }
  }, () => {
    if (!pressing) return;
    stopAnim();
    stoppedForGrab = true;
  });
}

function resumeAfterGrab() {
  stoppedForGrab = false;
  if (!hovering) {
    stopAnim();
    setTalkDur(NORMAL_DUR);
    return;
  }
  setTalkDur(SLOW_DUR);
  startFlipLoop(flipIntervalFor(SLOW_DUR));
  rampDur(SLOW_DUR, NORMAL_DUR, RAMP_MS, (dur) => {
    if (!hovering) return;
    clearFlip();
    flipTimer = setInterval(() => {
      if (hovering && !pressing) flipSide();
    }, flipIntervalFor(dur));
  }, () => {
    if (!hovering || pressing) return;
    setTalkDur(NORMAL_DUR);
    startFlipLoop(NORMAL_FLIP_MS);
  });
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

setTalkDur(NORMAL_DUR);

logo.addEventListener('pointerenter', () => startHoverTalk(true));

logo.addEventListener('pointerleave', () => {
  hovering = false;
  if (pressing) return;
  clearRamp();
  clearFlip();
  closeTimer = setTimeout(() => {
    stopAnim();
    setTalkDur(NORMAL_DUR);
  }, 160);
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
  pressing = true;
  press = { x: event.screenX, y: event.screenY };
  logo.setPointerCapture(event.pointerId);
  // Maintien clic gauche : ralentit puis s’arrête
  slowToStopForGrab();
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
  const wasStopped = stoppedForGrab;
  press = null;
  didDrag = false;
  pressing = false;

  if (wasStopped) {
    // Relâche après arrêt : reprend doucement si toujours dessus
    resumeAfterGrab();
  } else {
    // Clic court : annule le ralentissement, reprend normal
    clearRamp();
    if (hovering) {
      setTalkDur(NORMAL_DUR);
      startFlipLoop(NORMAL_FLIP_MS);
    } else {
      stopAnim();
      setTalkDur(NORMAL_DUR);
    }
  }

  if (wasDrag) return;
  armSingleClick();
});

logo.addEventListener('pointercancel', () => {
  press = null;
  didDrag = false;
  pressing = false;
  cancelSingleClick();
  if (stoppedForGrab && hovering) resumeAfterGrab();
  else if (!hovering) {
    clearRamp();
    stopAnim();
    setTalkDur(NORMAL_DUR);
  }
});

logo.addEventListener('dblclick', (event) => {
  if (event.button !== 0) return;
  event.preventDefault();
  cancelSingleClick();
  pressing = false;
  stoppedForGrab = false;
  hovering = false;
  clearRamp();
  stopAnim();
  setTalkDur(NORMAL_DUR);
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
