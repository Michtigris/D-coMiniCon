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
const BAR_H = 68;
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
let hostInfo = { hosting: false, urls: [], self: '', port: 0 };
let lastBadge = { connected: false, unread: 0, partner: '', call: '' };

const ANGE_KEYS = [0x41, 0x4e, 0x47, 0x45]; // A N G E
const ANGE_MS = 4000;

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
    seen: {}
  };
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
  restoreProfile();
  profile = { ...defaultProfile(), ...readJson(profileFile(), {}) };
  chatVisible = profile.chatVisible !== false;
  return profile;
}

function saveProfile(patch) {
  const next = { ...profile, ...(patch && typeof patch === 'object' ? patch : {}) };
  // Ne jamais effacer l’identité du compte (redémarrages / mises à jour).
  if (!next.userId && profile.userId) next.userId = profile.userId;
  if (!next.token && profile.token) next.token = profile.token;
  if (!next.pseudo && profile.pseudo) next.pseudo = profile.pseudo;
  profile = next;
  writeJson(profileFile(), profile);
  backupProfile();
  return { ...profile };
}

function stackHeight() {
  return (chatVisible ? CHAT_H - 1 : 0) + BAR_H;
}

function barBounds() {
  if (bar && !bar.isDestroyed()) return bar.getBounds();
  return { x: 0, y: 0, width: W, height: BAR_H };
}

function stackPos() {
  if (!chatVisible || !chat || chat.isDestroyed()) {
    const bounds = barBounds();
    return { x: bounds.x, y: bounds.y };
  }
  const chatB = chat.getBounds();
  const barB = barBounds();
  return { x: barB.x, y: Math.min(chatB.y, barB.y) };
}

function decideOpenUp(barY) {
  const point = { x: barBounds().x + Math.floor(W / 2), y: Math.round(barY + BAR_H / 2) };
  const area = screen.getDisplayNearestPoint(point).workArea;
  return point.y >= area.y + area.height / 2;
}

function clamp(x, y) {
  const height = stackHeight();
  const display = screen.getDisplayNearestPoint({ x: Math.round(x + W / 2), y: Math.round(y + height / 2) });
  const area = display.workArea;
  return {
    x: Math.round(Math.min(Math.max(x, area.x), area.x + area.width - Math.min(W, area.width))),
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
  return {
    x: area.x + area.width - W - 16,
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

function layout(x, y) {
  const pos = clamp(x, y);
  if (chatVisible) {
    if (openUp) {
      chat.setBounds({ x: pos.x, y: pos.y, width: W, height: CHAT_H });
      bar.setBounds({ x: pos.x, y: pos.y + CHAT_H - 1, width: W, height: BAR_H });
    } else {
      bar.setBounds({ x: pos.x, y: pos.y, width: W, height: BAR_H });
      chat.setBounds({ x: pos.x, y: pos.y + BAR_H - 1, width: W, height: CHAT_H });
    }
    if (!chat.isVisible()) chat.showInactive();
  } else {
    if (chat && !chat.isDestroyed()) chat.hide();
    bar.setBounds({ x: pos.x, y: pos.y, width: W, height: BAR_H });
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

function stopAngeWatch() {
  if (angeTimer) clearInterval(angeTimer);
  angeTimer = null;
  angeIndex = 0;
  angeStarted = 0;
  angePrev = Object.create(null);
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
    if (app.isPackaged) {
      app.setLoginItemSettings({ openAtLogin: true, openAsHidden: true, args: ['--hidden'] });
    } else {
      app.setLoginItemSettings({
        openAtLogin: true,
        path: process.execPath,
        args: [path.join(__dirname, '..'), '--hidden']
      });
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
    if (angeIndex > 0 && now - angeStarted > ANGE_MS) {
      angeIndex = 0;
      angeStarted = 0;
    }

    let pressed = null;
    for (let vk = 0x41; vk <= 0x5a; vk += 1) {
      const down = win32.keyDown(vk);
      const was = !!angePrev[vk];
      angePrev[vk] = down;
      if (down && !was) pressed = vk;
    }
    const extras = [0x08, 0x09, 0x0d, 0x20, 0x30, 0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39];
    for (const vk of extras) {
      const down = win32.keyDown(vk);
      const was = !!angePrev[vk];
      angePrev[vk] = down;
      if (down && !was && angeIndex > 0) {
        angeIndex = 0;
        angeStarted = 0;
        pressed = null;
      }
    }
    if (pressed == null) return;

    if (pressed === ANGE_KEYS[angeIndex]) {
      if (angeIndex === 0) angeStarted = now;
      angeIndex += 1;
      if (angeIndex >= ANGE_KEYS.length) {
        angeIndex = 0;
        angeStarted = 0;
        revealApp();
      }
    } else if (pressed === ANGE_KEYS[0]) {
      angeIndex = 1;
      angeStarted = now;
    } else {
      angeIndex = 0;
      angeStarted = 0;
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
  if (tray) tray.setToolTip('DécoMiniCon — tape ANGE pour afficher');
}

function revealApp() {
  if (!stashed && bar && !bar.isDestroyed() && bar.isVisible()) {
    if (chatVisible && chat && !chat.isDestroyed()) {
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
  if (bar && !bar.isDestroyed()) {
    bar.show();
    bar.setAlwaysOnTop(true, 'screen-saver');
  }
  if (chatVisible && chat && !chat.isDestroyed()) {
    raiseChat();
    chat.show();
    chat.focus();
    chat.webContents.send('notify:click', {});
  } else if (chat && !chat.isDestroyed()) {
    chat.hide();
  }
  if (tray) tray.setToolTip('DécoMiniCon — ANGE pour afficher si rangée');
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
  if (tray) tray.setToolTip('DécoMiniCon — ANGE pour afficher si rangée');
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
  stashApp();
  return {
    ok: true,
    title: game && game.ok ? game.title : 'DécoMiniCon',
    stashed: true,
    reason: 'Tape ANGE pour revenir'
  };
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
    backgroundColor: '#0a0a0f',
    roundedCorners: false
  });
  bar = new BrowserWindow({
    ...common,
    height: BAR_H,
    transparent: false,
    backgroundColor: '#12121a',
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

  chat.on('blur', () => {
    if (profile.pseudo && !dragging) sinkChat();
  });
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

function createTray() {
  const image = nativeImage.createFromPath(iconPath());
  tray = new Tray(image.isEmpty() ? nativeImage.createEmpty() : image.resize({ width: 32, height: 32 }));
  tray.setToolTip('DécoMiniCon — ANGE pour afficher si rangée');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Afficher (ou tape ANGE)', click: () => revealApp() },
    { label: 'Remettre en bas à droite', click: () => snapToCorner() },
    { label: 'Ranger complètement', click: () => hideGame() },
    { type: 'separator' },
    { label: 'Quitter DécoMiniCon', click: () => app.quit() }
  ]));
  tray.on('click', () => revealApp());
}

function sendToChat(channel, payload) {
  if (chat && !chat.isDestroyed()) chat.webContents.send(channel, payload);
}

const UPDATE_EVERY_MS = 7 * 60 * 1000;

function setupUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    // Télécharge en silence, installe seulement à la fermeture — pas de relance forcée
    // (évite que l’antivirus bloque un Setup.exe lancé automatiquement).
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = { info: log, warn: log, error: log };
    autoUpdater.on('update-downloaded', () => {
      backupProfile();
      log('Mise à jour téléchargée — sera appliquée à la prochaine fermeture');
    });
    autoUpdater.on('error', (err) => log(`updater ${err.message}`));
    const tick = () => {
      autoUpdater.checkForUpdates().catch((err) => log(`updater check ${err.message}`));
    };
    setTimeout(tick, 8000);
    setInterval(tick, UPDATE_EVERY_MS);
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
