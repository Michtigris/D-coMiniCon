const fs = require('fs');
const path = require('path');
const { app, BrowserWindow, Tray, Menu, Notification, clipboard, ipcMain, screen, session, nativeImage } = require('electron');

app.setName('DécoMiniCon');
app.setAppUserModelId('fr.decominicon.app');
app.setPath('userData', path.join(app.getPath('appData'), 'DécoMiniCon'));
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const W = 328;
const CHAT_H = 492;
const BAR_W = 96;
const BAR_H = 96;
const { start, stop } = require('../server/index');

let win32 = null;
try {
  win32 = require('./win32');
} catch (err) {
  console.error(err);
}

let chat = null;
let bar = null;
let tray = null;
let profile = null;
let chatVisible = true;
let openUp = true;
let chatSunk = false;
let dragging = false;
let dragTimer = null;
let quitting = false;
let stashed = false;
let angeTimer = null;
let angeIndex = 0;
let angeStarted = 0;
let angePrev = Object.create(null);
let angePhase = 'idle'; // idle | typing | confirm
let angeConfirmUntil = 0;
let angeLastNoise = 0;
let openCombo = 'ANGE';
let openKeys = [0x41, 0x4e, 0x47, 0x45];
let hostInfo = { hosting: false, urls: [], self: '', port: 0 };
let lastBadge = { connected: false, unread: 0, partner: '', call: '' };

const PRE_SILENCE_MS = 500;
const POST_SILENCE_MS = 500;
const WINDOW_BASE_MS = 500;
const WINDOW_PER_LETTER_MS = 400;

function normalizeOpenCombo(raw) {
  const text = String(raw || 'ANGE').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (text.length < 2) return 'ANGE';
  if (text.length > 16) return text.slice(0, 16);
  return text;
}

function comboToKeys(text) {
  return [...normalizeOpenCombo(text)].map((ch) => ch.charCodeAt(0));
}

function comboWindowMs(len) {
  return WINDOW_BASE_MS + WINDOW_PER_LETTER_MS * len;
}

function applyOpenCombo(raw) {
  openCombo = normalizeOpenCombo(raw);
  openKeys = comboToKeys(openCombo);
  angePhase = 'idle';
  angeIndex = 0;
  angeStarted = 0;
  angeConfirmUntil = 0;
  try {
    refreshTrayMenu();
  } catch {
    updateTrayTip();
  }
}

function openHint() {
  return `Tape ${openCombo} pour afficher`;
}

function updateTrayTip() {
  if (!tray) return;
  tray.setToolTip(stashed ? `DécoMiniCon — ${openHint()}` : `DécoMiniCon — ${openCombo} si rangée`);
}

function scanKeyVks() {
  const vks = [];
  for (let vk = 0x08; vk <= 0x5a; vk += 1) vks.push(vk);
  for (let vk = 0xba; vk <= 0xc0; vk += 1) vks.push(vk);
  for (let vk = 0xdb; vk <= 0xde; vk += 1) vks.push(vk);
  return vks;
}

const WATCH_VKS = scanKeyVks();

function dataRoot() {
  const dir = app.getPath('userData');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function profileFile() {
  return path.join(dataRoot(), 'profile.json');
}

function historyFile() {
  return path.join(dataRoot(), 'history.json');
}

function log(line) {
  try {
    fs.appendFileSync(path.join(dataRoot(), 'deco.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {
    // Le journal ne doit pas empêcher l'application de s'ouvrir.
  }
  console.log(line);
}

function defaultProfile() {
  return {
    userId: null,
    token: null,
    pseudo: '',
    serverUrl: 'http://127.0.0.1:3847',
    roomCode: '',
    hosting: false,
    x: null,
    y: null,
    chatVisible: true,
    settingsOpen: false,
    openCombo: 'ANGE',
    lastPartnerId: null,
    lastView: 'salon',
    seen: {}
  };
}

function memoryBridgePath() {
  return path.join(app.getPath('documents'), 'DécoMiniCon-memoire.txt');
}

function encodeMemory(obj) {
  const buf = Buffer.from(JSON.stringify(obj), 'utf8');
  const key = Buffer.from('DécoMiniCon-bridge-v1');
  for (let i = 0; i < buf.length; i += 1) buf[i] ^= key[i % key.length];
  return `DMC1.${buf.toString('base64')}`;
}

function decodeMemory(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('DMC1.')) return null;
  const buf = Buffer.from(raw.slice(5), 'base64');
  const key = Buffer.from('DécoMiniCon-bridge-v1');
  for (let i = 0; i < buf.length; i += 1) buf[i] ^= key[i % key.length];
  return JSON.parse(buf.toString('utf8'));
}

function exportMemoryBridge() {
  try {
    const live = profile ? { ...profile } : {};
    try {
      const pos = stackPos();
      live.x = pos.x;
      live.y = pos.y;
      live.chatVisible = chatVisible;
    } catch {
      // fenêtres pas encore prêtes
    }
    const payload = {
      v: 1,
      exportedAt: Date.now(),
      profile: { ...defaultProfile(), ...readJson(profileFile(), {}), ...live },
      history: readJson(historyFile(), {})
    };
    fs.writeFileSync(memoryBridgePath(), encodeMemory(payload), 'utf8');
    log('Mémoire exportée vers Documents');
    return true;
  } catch (err) {
    log(`memory export ${err.message}`);
    return false;
  }
}

function importMemoryBridgeIfNeeded() {
  const bridge = memoryBridgePath();
  if (!fs.existsSync(bridge)) return false;
  try {
    const data = decodeMemory(fs.readFileSync(bridge, 'utf8'));
    const existing = readJson(profileFile(), {});
    const empty = !existing.pseudo || !existing.userId || !existing.token;
    if (empty && data?.profile) {
      writeJson(profileFile(), { ...defaultProfile(), ...data.profile });
      if (data.history && typeof data.history === 'object') writeJson(historyFile(), data.history);
      log('Mémoire Documents restaurée');
    } else {
      log('Mémoire Documents ignorée (profil AppData déjà présent)');
    }
    fs.rmSync(bridge, { force: true });
    return empty;
  } catch (err) {
    log(`memory import ${err.message}`);
    try {
      fs.rmSync(bridge, { force: true });
    } catch {
      // ignore
    }
    return false;
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.copyFileSync(tmp, file);
  fs.rmSync(tmp, { force: true });
}

function backupProfile() {
  const root = dataRoot();
  const profilePath = profileFile();
  const historyPath = historyFile();
  if (fs.existsSync(profilePath)) fs.copyFileSync(profilePath, path.join(root, 'profile.backup.json'));
  if (fs.existsSync(historyPath)) fs.copyFileSync(historyPath, path.join(root, 'history.backup.json'));
}

function restoreProfile() {
  const root = dataRoot();
  const pairs = [
    [profileFile(), path.join(root, 'profile.backup.json')],
    [historyFile(), path.join(root, 'history.backup.json')]
  ];
  for (const [file, backup] of pairs) {
    if (!fs.existsSync(file) && fs.existsSync(backup)) fs.copyFileSync(backup, file);
  }
}

function loadProfile() {
  // AppData survit en général à la màj ; le .txt Documents est le filet de secours.
  importMemoryBridgeIfNeeded();
  restoreProfile();
  profile = { ...defaultProfile(), ...readJson(profileFile(), {}) };
  profile.openCombo = normalizeOpenCombo(profile.openCombo);
  chatVisible = profile.chatVisible !== false;
  applyOpenCombo(profile.openCombo);
  return profile;
}

function saveProfile(patch) {
  const next = { ...profile, ...(patch && typeof patch === 'object' ? patch : {}) };
  // Ne jamais effacer l’identité du compte (redémarrages / mises à jour).
  if (!next.userId && profile.userId) next.userId = profile.userId;
  if (!next.token && profile.token) next.token = profile.token;
  if (!next.pseudo && profile.pseudo) next.pseudo = profile.pseudo;
  if (Object.prototype.hasOwnProperty.call(next, 'openCombo') || patch?.openCombo != null) {
    next.openCombo = normalizeOpenCombo(next.openCombo);
  } else if (!next.openCombo) {
    next.openCombo = openCombo || 'ANGE';
  }
  profile = next;
  applyOpenCombo(profile.openCombo);
  writeJson(profileFile(), profile);
  backupProfile();
  return { ...profile };
}

function stackHeight() {
  return (chatVisible ? CHAT_H - 1 : 0) + BAR_H;
}

function stackWidth() {
  return chatVisible ? W : BAR_W;
}

function barBounds() {
  if (bar && !bar.isDestroyed()) return bar.getBounds();
  return { x: 0, y: 0, width: BAR_W, height: BAR_H };
}

function stackPos() {
  if (!chatVisible || !chat || chat.isDestroyed()) {
    const bounds = barBounds();
    return { x: bounds.x, y: bounds.y };
  }
  const chatB = chat.getBounds();
  const barB = barBounds();
  return { x: chatB.x, y: Math.min(chatB.y, barB.y) };
}

function decideOpenUp(barY) {
  const point = { x: barBounds().x + Math.floor(BAR_W / 2), y: Math.round(barY + BAR_H / 2) };
  const area = screen.getDisplayNearestPoint(point).workArea;
  return point.y >= area.y + area.height / 2;
}

function clamp(x, y) {
  const height = stackHeight();
  const width = stackWidth();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + width / 2), y: Math.round(y + height / 2) });
  const area = display.workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - Math.min(width, area.width))),
    y: Math.round(Math.min(Math.max(y, area.y), area.y + area.height - Math.min(height, area.height)))
  };
}

function cornerPosition() {
  let display = screen.getPrimaryDisplay();
  if (bar && !bar.isDestroyed()) {
    const bounds = bar.getBounds();
    display = screen.getDisplayNearestPoint({ x: bounds.x + 8, y: bounds.y + 8 });
  }
  const area = display.workArea;
  const width = stackWidth();
  return {
    x: area.x + area.width - width - 16,
    y: area.y + area.height - stackHeight() - 16
  };
}

function raiseChat() {
  if (!chat || chat.isDestroyed() || !chatVisible) return;
  try {
    chat.setAlwaysOnTop(false);
  } catch {
    // ignore
  }
  try {
    if (win32) win32.raise(chat);
  } catch (err) {
    log(`raise ${err.message}`);
  }
  if (!chat.isVisible()) chat.show();
  else chat.moveTop();
  chatSunk = false;
  tellBar();
}

function windowsReady() {
  return !!(chat && !chat.isDestroyed() && bar && !bar.isDestroyed());
}

function layout(x, y) {
  if (!windowsReady()) return;
  const pos = clamp(x, y);
  if (chatVisible) {
    if (openUp) {
      chat.setBounds({ x: pos.x, y: pos.y, width: W, height: CHAT_H });
      bar.setBounds({ x: pos.x, y: pos.y + CHAT_H - 1, width: BAR_W, height: BAR_H });
    } else {
      bar.setBounds({ x: pos.x, y: pos.y, width: BAR_W, height: BAR_H });
      chat.setBounds({ x: pos.x, y: pos.y + BAR_H - 1, width: W, height: CHAT_H });
    }
    if (!chat.isVisible()) chat.showInactive();
  } else {
    chat.hide();
    bar.setBounds({ x: pos.x, y: pos.y, width: BAR_W, height: BAR_H });
  }
  if (!bar.isVisible()) bar.showInactive();
  if (!dragging) bar.setAlwaysOnTop(true, 'screen-saver');
  tellBar();
}

function toggleChatWindow() {
  const anchor = barBounds();
  // Menu non lié (fermé ou enfoncé) → un clic ouvre / remonte.
  if (chatVisible && !menuIsLinked()) {
    if (!chat || chat.isDestroyed() || !chat.isVisible()) {
      openUp = decideOpenUp(anchor.y);
      if (openUp) layout(anchor.x, anchor.y - CHAT_H + 1);
      else layout(anchor.x, anchor.y);
    }
    raiseChat();
    savePosition();
    return true;
  }
  if (!chatVisible) {
    openUp = decideOpenUp(anchor.y);
    chatVisible = true;
    if (openUp) layout(anchor.x, anchor.y - CHAT_H + 1);
    else layout(anchor.x, anchor.y);
    raiseChat();
  } else {
    chatVisible = false;
    chatSunk = false;
    layout(anchor.x, anchor.y);
  }
  savePosition();
  return chatVisible;
}

function savePosition() {
  const pos = stackPos();
  saveProfile({ x: pos.x, y: pos.y, chatVisible });
}

function sinkChat() {
  if (!win32 || !chat || chat.isDestroyed() || !chat.isVisible() || dragging) return;
  try {
    win32.sink(chat);
    chatSunk = true;
    tellBar();
  } catch (err) {
    log(`sink ${err.message}`);
  }
}

function finishDrag() {
  if (dragTimer) clearInterval(dragTimer);
  dragTimer = null;
  if (!dragging) return;
  dragging = false;
  savePosition();
}

function beginDrag() {
  finishDrag();
  dragging = true;
  const start = screen.getCursorScreenPoint();
  const origin = stackPos();
  dragTimer = setInterval(() => {
    let down = true;
    try {
      down = win32 ? win32.leftButtonDown() : true;
    } catch {
      down = true;
    }
    if (!down) {
      finishDrag();
      return;
    }
    const now = screen.getCursorScreenPoint();
    layout(origin.x + (now.x - start.x), origin.y + (now.y - start.y));
  }, 16);
}

function resetAngeProgress() {
  angePhase = 'idle';
  angeIndex = 0;
  angeStarted = 0;
  angeConfirmUntil = 0;
}

function stopAngeWatch() {
  if (angeTimer) clearInterval(angeTimer);
  angeTimer = null;
  resetAngeProgress();
  angePrev = Object.create(null);
  angeLastNoise = 0;
}

function savedPosition() {
  if (Number.isFinite(profile?.x) && Number.isFinite(profile?.y)) {
    return clamp(profile.x, profile.y);
  }
  return cornerPosition();
}

function bootHidden() {
  return process.argv.includes('--hidden')
    || process.argv.includes('--ange-wait')
    || !!app.getLoginItemSettings()?.wasOpenedAsHidden;
}

function enableAutoStart() {
  try {
    // Toujours pointer explicitement vers l’exe courant (évite ANGE → une vieille install).
    if (app.isPackaged) {
      app.setLoginItemSettings({
        openAtLogin: true,
        openAsHidden: true,
        path: process.execPath,
        args: ['--hidden']
      });
      log(`autostart ${process.execPath}`);
    } else {
      app.setLoginItemSettings({ openAtLogin: false });
      log('autostart off (dev npm start)');
    }
  } catch (err) {
    log(`autostart ${err.message}`);
  }
}

function startAngeWatch() {
  if (angeTimer || !win32) return;
  angeTimer = setInterval(() => {
    if (!win32 || quitting) return;
    const now = Date.now();
    const keys = openKeys.length ? openKeys : comboToKeys('ANGE');
    const windowMs = comboWindowMs(keys.length);

    // Détection des appuis (front montant) sur un large jeu de touches.
    const edges = [];
    for (const vk of WATCH_VKS) {
      const down = win32.keyDown(vk);
      const was = !!angePrev[vk];
      angePrev[vk] = down;
      if (down && !was) edges.push(vk);
    }
    const silenceBeforePress = now - angeLastNoise >= PRE_SILENCE_MS;
    if (edges.length) angeLastNoise = now;

    if (angePhase === 'confirm') {
      if (edges.length) {
        resetAngeProgress();
        return;
      }
      if (now >= angeConfirmUntil) {
        resetAngeProgress();
        revealApp();
      }
      return;
    }

    if (angePhase === 'typing' && now - angeStarted > windowMs) {
      resetAngeProgress();
    }

    if (!edges.length) return;
    // Plusieurs touches d’un coup = bruit, on annule une saisie en cours.
    if (edges.length > 1) {
      resetAngeProgress();
      return;
    }
    const pressed = edges[0];

    if (angePhase === 'idle') {
      // 1s sans touche avant la 1re lettre du mot.
      if (pressed === keys[0] && silenceBeforePress) {
        angePhase = 'typing';
        angeIndex = 1;
        angeStarted = now;
        if (angeIndex >= keys.length) {
          angePhase = 'confirm';
          angeConfirmUntil = now + POST_SILENCE_MS;
        }
      }
      return;
    }

    // typing
    if (pressed === keys[angeIndex]) {
      angeIndex += 1;
      if (angeIndex >= keys.length) {
        angePhase = 'confirm';
        angeConfirmUntil = now + POST_SILENCE_MS;
      }
    } else if (pressed === keys[0] && silenceBeforePress) {
      angePhase = 'typing';
      angeIndex = 1;
      angeStarted = now;
    } else {
      resetAngeProgress();
    }
  }, 30);
}

function stashApp() {
  if (!stashed) {
    try {
      savePosition();
    } catch {
      // ignore
    }
  }
  stashed = true;
  finishDrag();
  if (chat && !chat.isDestroyed()) chat.hide();
  if (bar && !bar.isDestroyed()) bar.hide();
  updateTrayTip();
}

function revealApp() {
  if (!windowsReady()) return;
  if (!stashed && bar.isVisible()) {
    if (chatVisible) {
      raiseChat();
      chat.show();
      chat.focus();
    } else {
      bar.moveTop();
    }
    return;
  }
  stashed = false;
  const pos = savedPosition();
  layout(pos.x, pos.y);
  bar.show();
  bar.setAlwaysOnTop(true, 'screen-saver');
  if (chatVisible) {
    raiseChat();
    chat.show();
    chat.focus();
    chat.webContents.send('notify:click', {});
  } else {
    chat.hide();
  }
  updateTrayTip();
}

function snapToCorner() {
  stashed = false;
  chatVisible = true;
  const pos = cornerPosition();
  layout(pos.x, pos.y);
  if (bar && !bar.isDestroyed()) bar.show();
  raiseChat();
  if (chat && !chat.isDestroyed()) {
    chat.show();
    chat.focus();
  }
  savePosition();
  updateTrayTip();
}

function hideGame() {
  let game = null;
  if (win32) {
    try {
      game = win32.hideForeground([chat, bar]);
    } catch (err) {
      log(`hide ${err.message}`);
      game = { ok: false, reason: 'Impossible de masquer cette fenêtre.' };
    }
  }
  // Masquer = ferme aussi le menu. Au retour : logo seul ; clic droit rouvre la page d’avant.
  chatVisible = false;
  chatSunk = false;
  stashApp();
  const result = {
    ok: true,
    title: game && game.ok ? game.title : 'DécoMiniCon',
    stashed: true,
    openCombo,
    reason: `Tape ${openCombo} pour revenir`
  };
  if (bar && !bar.isDestroyed()) bar.webContents.send('game:result', result);
  return result;
}

function menuIsOpen() {
  return !!(chatVisible && chat && !chat.isDestroyed() && chat.isVisible() && !stashed);
}

function menuIsLinked() {
  return menuIsOpen() && !chatSunk;
}

function tellBar(extra = {}) {
  if (!bar || bar.isDestroyed()) return;
  if (chatVisible && !menuIsOpen() && !stashed) {
    chatVisible = false;
    chatSunk = false;
  }
  const open = menuIsOpen();
  const linked = menuIsLinked();
  bar.webContents.send('badge', lastBadge);
  bar.webContents.send('chat:visible', {
    ...extra,
    visible: open,
    linked,
    openUp
  });
}

function iconPath() {
  return path.join(__dirname, '..', 'assets', 'icon.png');
}

function createWindows() {
  const common = {
    width: W,
    frame: false,
    thickFrame: false,
    hasShadow: false,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    icon: iconPath(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required'
    }
  };
  // Chat opaque : les fenêtres transparentes Electron passent les clics (intouchables).
  chat = new BrowserWindow({
    ...common,
    height: CHAT_H,
    transparent: false,
    backgroundColor: '#eef3f8',
    roundedCorners: false
  });
  bar = new BrowserWindow({
    ...common,
    width: BAR_W,
    height: BAR_H,
    transparent: true,
    backgroundColor: '#00000000',
    roundedCorners: false,
    focusable: true
  });
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  const index = path.join(__dirname, '..', 'src', 'index.html');
  chat.loadFile(index, { query: { view: 'chat' } });
  bar.loadFile(index, { query: { view: 'bar' } });

  const startPos = savedPosition();
  layout(startPos.x, startPos.y);
  const hidden = bootHidden();

  chat.once('ready-to-show', () => {
    if (hidden) return;
    if (chatVisible) {
      chat.show();
      if (!profile.pseudo) chat.focus();
      else sinkChat();
    }
  });
  bar.once('ready-to-show', () => {
    if (hidden) {
      stashApp();
      return;
    }
    bar.showInactive();
  });
  bar.webContents.on('did-finish-load', () => tellBar());

  // Pas de sink au blur : défocus (clic ailleurs) ne doit pas fermer / enfoncer le panneau.
  chat.on('close', (event) => {
    if (!quitting) {
      event.preventDefault();
      const anchor = barBounds();
      chatVisible = false;
      layout(anchor.x, anchor.y);
      savePosition();
    }
  });
  bar.on('close', (event) => {
    if (!quitting) event.preventDefault();
  });
}

function appMenuTemplate() {
  const canHideChat = !!(chatVisible && menuIsLinked() && !stashed);
  return [
    {
      label: canHideChat ? 'Cacher la conversation' : `Afficher (ou tape ${openCombo})`,
      click: () => {
        if (stashed) revealApp();
        else toggleChatWindow();
      }
    },
    { label: 'Remettre en bas à droite', click: () => snapToCorner() },
    { label: 'Masquer', click: () => hideGame() },
    { type: 'separator' },
    { label: 'Quitter DécoMiniCon', click: () => app.quit() }
  ];
}

function createTray() {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 32, height: 32 }));
  updateTrayTip();
  tray.setContextMenu(Menu.buildFromTemplate(appMenuTemplate()));
  tray.on('click', () => revealApp());
}

function refreshTrayMenu() {
  if (!tray) return;
  updateTrayTip();
  tray.setContextMenu(Menu.buildFromTemplate(appMenuTemplate()));
}

function popupAppMenu() {
  if (!bar || bar.isDestroyed()) return;
  Menu.buildFromTemplate(appMenuTemplate()).popup({ window: bar });
}

function sendToChat(channel, payload) {
  if (chat && !chat.isDestroyed()) chat.webContents.send(channel, payload);
}

let updaterRef = null;
let updateReady = false;
let updateRemoteVersion = '';
let updateState = 'idle'; // idle | checking | latest | available | downloading | ready | error | dev
let updateError = '';

function updatePayload() {
  return {
    status: updateState,
    current: app.getVersion(),
    version: updateRemoteVersion || null,
    message: updateError || null
  };
}

function tellUpdateStatus() {
  if (!bar || bar.isDestroyed()) return;
  bar.webContents.send('update:status', updatePayload());
}

function setBarExpanded(on) {
  if (!bar || bar.isDestroyed()) return;
  const b = bar.getBounds();
  const width = on ? 240 : BAR_W;
  bar.setBounds({ x: b.x, y: b.y, width, height: BAR_H });
}

function applyManualUpdate() {
  if (!updaterRef || !updateReady || quitting) return false;
  try {
    try {
      const pos = stackPos();
      saveProfile({ x: pos.x, y: pos.y, chatVisible });
    } catch {
      // ignore
    }
    backupProfile();
    exportMemoryBridge();
    log('Installation màj manuelle (mémoire sauvegardée)');
    updaterRef.quitAndInstall(true, true);
    return true;
  } catch (err) {
    log(`updater install ${err.message}`);
    updateState = 'error';
    updateError = err.message || 'Installation impossible';
    tellUpdateStatus();
    return false;
  }
}

async function checkUpdateManual() {
  if (!app.isPackaged || !updaterRef) {
    updateState = 'dev';
    updateRemoteVersion = '';
    updateError = '';
    tellUpdateStatus();
    return updatePayload();
  }
  updateState = 'checking';
  updateError = '';
  tellUpdateStatus();
  try {
    const result = await updaterRef.checkForUpdates();
    if (updateState === 'checking') {
      const remote = result?.updateInfo?.version;
      if (remote && remote !== app.getVersion()) {
        updateState = 'available';
        updateRemoteVersion = remote;
      } else {
        updateState = 'latest';
        updateRemoteVersion = '';
      }
      tellUpdateStatus();
    }
  } catch (err) {
    updateState = 'error';
    updateError = err.message || 'Vérification impossible';
    tellUpdateStatus();
  }
  return updatePayload();
}

async function installUpdateManual() {
  if (!app.isPackaged || !updaterRef) {
    return { ok: false, ...updatePayload() };
  }
  if (updateReady || updateState === 'ready') {
    applyManualUpdate();
    return { ok: true, ...updatePayload() };
  }
  if (updateState !== 'available' && !updateRemoteVersion) {
    await checkUpdateManual();
  }
  if (updateState !== 'available' && updateState !== 'ready') {
    return { ok: false, ...updatePayload() };
  }
  updateState = 'downloading';
  tellUpdateStatus();
  try {
    await updaterRef.downloadUpdate();
    return { ok: true, ...updatePayload() };
  } catch (err) {
    updateState = 'error';
    updateError = err.message || 'Téléchargement impossible';
    tellUpdateStatus();
    return { ok: false, ...updatePayload() };
  }
}

function setupUpdater() {
  if (!app.isPackaged) {
    updateState = 'dev';
    log('updater off (app non packagée — npm start ne reçoit pas les màj GitHub)');
    return;
  }
  try {
    const { autoUpdater } = require('electron-updater');
    updaterRef = autoUpdater;
    autoUpdater.setFeedURL({
      provider: 'generic',
      url: 'https://github.com/Michtigris/D-coMiniCon/releases/latest/download/'
    });
    // Aucune màj auto : check / download / install seulement sur action utilisateur.
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.logger = { info: log, warn: log, error: log };
    autoUpdater.on('checking-for-update', () => {
      updateState = 'checking';
      log(`updater check v${app.getVersion()}`);
      tellUpdateStatus();
    });
    autoUpdater.on('update-available', (info) => {
      updateState = 'available';
      updateRemoteVersion = info?.version || '';
      log(`updater dispo ${updateRemoteVersion || '?'}`);
      tellUpdateStatus();
    });
    autoUpdater.on('update-not-available', () => {
      updateState = 'latest';
      updateRemoteVersion = '';
      log('updater déjà à jour');
      tellUpdateStatus();
    });
    autoUpdater.on('download-progress', () => {
      updateState = 'downloading';
      tellUpdateStatus();
    });
    autoUpdater.on('update-downloaded', (info) => {
      updateReady = true;
      updateState = 'ready';
      updateRemoteVersion = info?.version || updateRemoteVersion;
      backupProfile();
      log(`Mise à jour téléchargée ${updateRemoteVersion || ''}`);
      tellUpdateStatus();
      applyManualUpdate();
    });
    autoUpdater.on('error', (err) => {
      updateState = 'error';
      updateError = err.message || 'Erreur màj';
      log(`updater ${updateError}`);
      tellUpdateStatus();
    });
  } catch (err) {
    log(`updater ${err.message}`);
  }
}

async function startHosting(roomCode) {
  // Pas de salon.json local : le salon LAN reste en mémoire tant que l’hôte est ouvert.
  // Le compte (pseudo / id / token) vit dans le profil utilisateur, pas dans le salon.
  const info = await start({
    port: 3847,
    host: '0.0.0.0',
    roomCode: roomCode || '',
    dataFile: null
  });
  hostInfo = { hosting: true, urls: info.urls, self: info.self, port: info.port };
  log(`Salon hébergé ${info.urls.join(', ') || info.self}`);
  return { ok: true, ...hostInfo };
}

function registerIpc() {
  ipcMain.handle('profile:get', () => ({ ...profile }));
  ipcMain.handle('profile:save', (_event, patch) => saveProfile(patch && typeof patch === 'object' ? patch : {}));
  ipcMain.handle('crypto:password-hash', (_event, payload) => {
    const { passwordHash } = require('../server/password');
    return passwordHash(payload?.pseudo, payload?.password);
  });
  ipcMain.handle('history:read', (_event, pair) => {
    if (typeof pair !== 'string' || pair.length > 80) return [];
    const all = readJson(historyFile(), {});
    return Array.isArray(all[pair]) ? all[pair] : [];
  });
  ipcMain.handle('history:save', (_event, pair, messages) => {
    if (typeof pair !== 'string' || pair.length > 80 || !Array.isArray(messages)) return false;
    const all = readJson(historyFile(), {});
    all[pair] = messages.slice(-400);
    writeJson(historyFile(), all);
    return true;
  });
  ipcMain.on('drag:begin', () => beginDrag());
  ipcMain.on('menu:popup', () => popupAppMenu());
  ipcMain.on('bar:expand', (_event, on) => setBarExpanded(!!on));
  ipcMain.handle('update:check', () => checkUpdateManual());
  ipcMain.handle('update:install', () => installUpdateManual());
  ipcMain.handle('game:hide', () => hideGame());
  ipcMain.handle('chat:toggle', () => toggleChatWindow());
  ipcMain.handle('chat:show', () => {
    if (!menuIsLinked()) toggleChatWindow();
    else revealApp();
    return true;
  });
  ipcMain.handle('window:snap', () => {
    snapToCorner();
    return true;
  });
  ipcMain.on('badge', (_event, payload) => {
    lastBadge = { ...lastBadge, ...(payload || {}) };
    tellBar();
  });
  ipcMain.on('notify', (_event, payload) => {
    const title = String(payload?.title || 'DécoMiniCon');
    const body = String(payload?.body || '');
    if (!Notification.isSupported()) return;
    const notice = new Notification({ title, body, icon: iconPath(), silent: false });
    notice.on('click', () => revealApp());
    notice.show();
  });
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('host:start', async (_event, roomCode) => {
    try {
      const code = String(roomCode || '');
      if (hostInfo.hosting) await stop();
      hostInfo = { hosting: false, urls: [], self: '', port: 0 };
      return await startHosting(code);
    } catch (err) {
      hostInfo = { hosting: false, urls: [], self: '', port: 0 };
      return { ok: false, message: err.message || 'Impossible d’héberger le salon.' };
    }
  });
  ipcMain.handle('host:stop', async () => {
    await stop();
    hostInfo = { hosting: false, urls: [], self: '', port: 0 };
    saveProfile({ hosting: false });
    return { ok: true };
  });
  ipcMain.handle('host:info', () => hostInfo);
  ipcMain.handle('clipboard:write', (_event, text) => {
    clipboard.writeText(String(text || ''));
    return true;
  });
}

function allowMedia(_webContents, permission) {
  return permission === 'media' || permission === 'mediaKeySystem' || permission === 'notifications';
}

if (gotLock) {
  app.on('second-instance', () => revealApp());
  app.on('before-quit', () => {
    quitting = true;
    try {
      if (!stashed) savePosition();
    } catch {
      // ignore
    }
  });
  app.whenReady().then(async () => {
    loadProfile();
    enableAutoStart();
    session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowMedia(null, permission));
    });
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowMedia(null, permission));
    Menu.setApplicationMenu(null);
    registerIpc();
    if (profile.hosting) {
      try {
        await startHosting(profile.roomCode || '');
      } catch (err) {
        log(`host ${err.message}`);
        saveProfile({ hosting: false });
      }
    }
    createWindows();
    createTray();
    startAngeWatch();
    setupUpdater();
    if (process.argv.includes('--smoke')) {
      setTimeout(() => {
        let native = 'ok';
        try {
          if (win32 && chat) win32.sink(chat);
        } catch (err) {
          native = err.message;
        }
        log(`smoke ${native}`);
        app.quit();
      }, 1600);
    }
  });
  app.on('window-all-closed', (event) => {
    event.preventDefault();
  });
  app.on('will-quit', () => {
    finishDrag();
    stopAngeWatch();
    stop().catch(() => {});
  });
}
