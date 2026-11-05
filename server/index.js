const http = require('http');
const os = require('os');
const path = require('path');
const { WebSocketServer } = require('ws');
const { openStore } = require('./store');

function lanAddresses(port) {
  const urls = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const net of list || []) {
      const v4 = net.family === 'IPv4' || net.family === 4;
      if (v4 && !net.internal) urls.push(`http://${net.address}:${port}`);
    }
  }
  return urls;
}

function send(socket, type, payload) {
  if (socket && socket.readyState === 1) {
    socket.send(JSON.stringify({ type, payload }));
  }
}

let active = null;

async function start(options = {}) {
  if (active) return active.publicInfo();
  const port = Number(options.port ?? process.env.PORT ?? 3847);
  const host = options.host || '0.0.0.0';
  const roomCode = String(options.roomCode ?? process.env.DECO_CODE ?? '').trim().toUpperCase();
  const roomName = String(options.roomName || '').trim().slice(0, 32);
  const maxMembers = Math.max(1, Number(options.maxMembers) || 2);
  // null = mémoire seule ; sinon fichier (évite d’écrire dans asar → ENOTDIR)
  const dataFile = Object.prototype.hasOwnProperty.call(options, 'dataFile')
    ? options.dataFile
    : (process.env.DECO_DATA || path.join(__dirname, 'data', 'store.json'));
  const store = openStore(dataFile);
  // Plusieurs sockets par compte (même pseudo sur plusieurs PC).
  const sessions = new Map();
  const cams = new Map();
  const calls = new Map();

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        roomCode,
        roomName,
        members: sessions.size,
        maxMembers
      }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  const wss = new WebSocketServer({ server, path: '/ws' });

  function socketsOf(id) {
    return sessions.get(id) || new Set();
  }

  function addSession(id, socket) {
    let set = sessions.get(id);
    if (!set) {
      set = new Set();
      sessions.set(id, set);
    }
    set.add(socket);
  }

  function removeSession(id, socket) {
    const set = sessions.get(id);
    if (!set) return false;
    set.delete(socket);
    if (!set.size) {
      sessions.delete(id);
      return true;
    }
    return false;
  }

  function sendToUser(id, type, payload) {
    for (const socket of socketsOf(id)) send(socket, type, payload);
  }

  function online(id) {
    return socketsOf(id).size > 0;
  }

  function publicUser(id) {
    const user = store.user(id);
    if (!user) return null;
    return { id: user.id, pseudo: user.pseudo, online: online(id) };
  }

  function broadcastLobby() {
    const users = store.users(online);
    for (const set of sessions.values()) {
      for (const socket of set) send(socket, 'lobby', { users });
    }
  }

  function pushSocial(userId) {
    sendToUser(userId, 'social', {
      friends: store.friendsOf(userId, online),
      incoming: store.incoming(userId),
      outgoing: store.outgoing(userId),
      groups: store.groupsOf(userId, online)
    });
  }

  function pushGroup(groupId) {
    const group = store.group(groupId);
    if (!group) return;
    for (const memberId of group.members) {
      sendToUser(memberId, 'group:state', {
        group: store.groupsOf(memberId, online).find((item) => item.id === groupId) || null,
        messages: store.groupMessages(groupId, memberId)
      });
      pushSocial(memberId);
    }
  }

  function pushLink(userId, by) {
    const partnerId = store.getLink(userId);
    sendToUser(userId, 'link:state', {
      partner: partnerId ? publicUser(partnerId) : null,
      messages: partnerId ? store.messagesFor(userId, partnerId) : [],
      by: by || null,
      partnerCam: partnerId ? !!cams.get(partnerId) : false
    });
  }

  function pushCam(userId) {
    const partnerId = store.getLink(userId);
    if (!partnerId) return;
    sendToUser(partnerId, 'cam:state', { userId, on: !!cams.get(userId) });
  }

  function endCall(call, reason) {
    if (!call) return;
    clearTimeout(call.timer);
    for (const [id, current] of calls) {
      if (current === call) calls.delete(id);
    }
    for (const id of [call.from, call.to]) {
      sendToUser(id, 'call:closed', { reason, id: call.id });
    }
  }

  function busy(id) {
    for (const call of calls.values()) {
      if (call.from === id || call.to === id) return true;
    }
    return false;
  }

  wss.on('connection', (socket) => {
    socket.userId = null;
    socket.msgTimes = [];
    socket.isAlive = true;
    socket.on('pong', () => {
      socket.isAlive = true;
    });

    socket.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== 'string') return;
      try {
        handle(socket, msg);
      } catch (err) {
        send(socket, msg.type === 'auth' ? 'auth:error' : 'error', { message: err.message || 'Erreur.' });
      }
    });

    socket.on('close', () => {
      const userId = socket.userId;
      if (!userId) return;
      const wentOffline = removeSession(userId, socket);
      if (!wentOffline) return;
      if (cams.get(userId)) {
        cams.set(userId, false);
        pushCam(userId);
      }
      for (const call of [...calls.values()]) {
        if (call.from === userId || call.to === userId) endCall(call, 'offline');
      }
      broadcastLobby();
    });
  });

  function handle(socket, msg) {
    if (msg.type === 'auth') {
      const code = String(msg.payload?.roomCode || '').trim().toUpperCase();
      if (roomCode && code !== roomCode) throw new Error('Code du salon incorrect.');
      const user = store.auth(msg.payload || {});
      if (socket.userId && socket.userId !== user.id) removeSession(socket.userId, socket);
      const alreadyIn = socketsOf(user.id).size > 0;
      if (!alreadyIn && sessions.size >= maxMembers) {
        throw new Error(`Salon complet (${maxMembers}/${maxMembers}).`);
      }
      socket.userId = user.id;
      addSession(user.id, socket);
      const partnerId = store.getLink(user.id);
      send(socket, 'auth:ok', {
        user,
        users: store.users(online),
        friends: store.friendsOf(user.id, online),
        incoming: store.incoming(user.id),
        outgoing: store.outgoing(user.id),
        groups: store.groupsOf(user.id, online),
        link: partnerId ? {
          partner: publicUser(partnerId),
          messages: store.messagesFor(user.id, partnerId),
          by: null,
          partnerCam: !!cams.get(partnerId)
        } : null
      });
      broadcastLobby();
      return;
    }

    const userId = socket.userId;
    if (!userId) throw new Error('Entre d’abord dans le salon.');

    if (msg.type === 'friend:request') {
      const toId = msg.payload?.toId ? String(msg.payload.toId) : '';
      const pseudo = msg.payload?.pseudo ? String(msg.payload.pseudo) : '';
      const request = toId
        ? store.requestFriend(userId, toId)
        : store.requestFriendByPseudo(userId, pseudo);
      pushSocial(request.from);
      pushSocial(request.to);
      return;
    }

    if (msg.type === 'friend:accept' || msg.type === 'friend:decline') {
      const requestId = String(msg.payload?.requestId || '');
      const request = msg.type === 'friend:accept'
        ? store.accept(requestId, userId)
        : store.decline(requestId, userId);
      pushSocial(request.from);
      pushSocial(request.to);
      return;
    }

    if (msg.type === 'group:create') {
      const memberIds = Array.isArray(msg.payload?.memberIds) ? msg.payload.memberIds : [];
      const group = store.createGroup(userId, msg.payload?.name, memberIds);
      pushGroup(group.id);
      return;
    }

    if (msg.type === 'group:invite') {
      const group = store.inviteToGroup(String(msg.payload?.groupId || ''), userId, String(msg.payload?.userId || ''));
      pushGroup(group.id);
      return;
    }

    if (msg.type === 'group:leave') {
      const groupId = String(msg.payload?.groupId || '');
      const before = store.group(groupId);
      const members = before ? [...before.members] : [];
      store.leaveGroup(groupId, userId);
      for (const id of members) pushSocial(id);
      if (store.group(groupId)) pushGroup(groupId);
      return;
    }

    if (msg.type === 'group:open') {
      const groupId = String(msg.payload?.groupId || '');
      send(socket, 'group:state', {
        group: store.groupsOf(userId, online).find((item) => item.id === groupId) || null,
        messages: store.groupMessages(groupId, userId)
      });
      return;
    }

    if (msg.type === 'group:message') {
      const now = Date.now();
      socket.msgTimes = socket.msgTimes.filter((stamp) => now - stamp < 10000);
      if (socket.msgTimes.length >= 20) throw new Error('Trop de messages, ralentis un peu.');
      socket.msgTimes.push(now);
      const groupId = String(msg.payload?.groupId || '');
      const message = store.addGroupMessage(groupId, userId, msg.payload?.text);
      const group = store.group(groupId);
      for (const memberId of group.members) {
        sendToUser(memberId, 'group:message', { message });
      }
      return;
    }

    if (msg.type === 'link') {
      const friendId = msg.payload?.friendId ? String(msg.payload.friendId) : null;
      const touched = store.setLink(userId, friendId);
      for (const id of touched) {
        if (!store.getLink(id)) cams.set(id, false);
        pushLink(id, userId);
      }
      return;
    }

    if (msg.type === 'message') {
      const now = Date.now();
      socket.msgTimes = socket.msgTimes.filter((stamp) => now - stamp < 10000);
      if (socket.msgTimes.length >= 20) throw new Error('Trop de messages, ralentis un peu.');
      socket.msgTimes.push(now);
      const partnerId = store.getLink(userId);
      if (!partnerId) throw new Error('Lie-toi d’abord à quelqu’un.');
      const message = store.addMessage(userId, partnerId, msg.payload?.text);
      sendToUser(userId, 'message:new', { message });
      sendToUser(partnerId, 'message:new', { message });
      return;
    }

    if (msg.type === 'call') {
      const partnerId = store.getLink(userId);
      if (!partnerId) throw new Error('Lie-toi d’abord à quelqu’un.');
      if (!online(partnerId)) {
        send(socket, 'call:closed', { reason: 'offline' });
        return;
      }
      if (busy(userId) || busy(partnerId)) throw new Error('Déjà en appel.');
      const call = {
        id: `${userId}:${Date.now()}`,
        from: userId,
        to: partnerId,
        timer: setTimeout(() => endCall(call, 'timeout'), 30000)
      };
      calls.set(call.id, call);
      sendToUser(partnerId, 'call:incoming', { from: publicUser(userId), id: call.id });
      send(socket, 'call:ringing', { to: publicUser(partnerId), id: call.id });
      return;
    }

    if (msg.type === 'call:answer') {
      const call = [...calls.values()].find((item) => item.to === userId);
      if (!call) return;
      const accept = !!msg.payload?.accept;
      if (!accept) {
        endCall(call, 'decline');
        return;
      }
      clearTimeout(call.timer);
      calls.delete(call.id);
      if (store.getLink(call.from) !== call.to) {
        const touched = store.setLink(call.from, call.to);
        for (const id of touched) pushLink(id, call.from);
      }
      sendToUser(call.from, 'call:result', { accept: true, id: call.id });
      sendToUser(call.to, 'call:result', { accept: true, id: call.id });
      return;
    }

    if (msg.type === 'call:cancel') {
      const call = [...calls.values()].find((item) => item.from === userId);
      if (call) endCall(call, 'cancel');
      return;
    }

    if (msg.type === 'cam') {
      const on = !!msg.payload?.on;
      cams.set(userId, on);
      pushCam(userId);
      return;
    }

    if (msg.type === 'signal') {
      const partnerId = store.getLink(userId);
      if (!partnerId) return;
      sendToUser(partnerId, 'signal', { from: userId, data: msg.payload?.data || null });
    }
  }

  const beat = setInterval(() => {
    for (const socket of wss.clients) {
      if (!socket.isAlive) {
        socket.terminate();
        continue;
      }
      socket.isAlive = false;
      socket.ping();
    }
  }, 15000);

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  const info = {
    port: actualPort,
    urls: lanAddresses(actualPort),
    self: `http://127.0.0.1:${actualPort}`
  };

  function close() {
    clearInterval(beat);
    for (const call of [...calls.values()]) endCall(call, 'offline');
    for (const socket of wss.clients) socket.close();
    return new Promise((resolve) => {
      wss.close(() => server.close(() => resolve()));
    });
  }

  active = {
    publicInfo: () => info,
    close
  };
  return info;
}

async function stop() {
  if (!active) return;
  const closing = active;
  active = null;
  await closing.close();
}

if (require.main === module) {
  start().then((info) => {
    console.log(`DécoMiniCon salon sur le port ${info.port}`);
    console.log(`Sur ce PC : ${info.self}`);
    if (info.urls.length) {
      console.log('À donner à ton ami :');
      for (const url of info.urls) console.log(`  ${url}`);
    }
    console.log('Si Windows demande l’accès au réseau, autorise les réseaux privés.');
  }).catch((err) => {
    console.error(err.message || err);
    process.exit(1);
  });
}

module.exports = { start, stop, lanAddresses };
