const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { passwordHash } = require('./password');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/i;

function cleanPseudo(input) {
  const pseudo = String(input || '').trim().replace(/\s+/g, ' ');
  if (pseudo.length < 2 || pseudo.length > 16) {
    throw new Error('Le pseudo doit faire entre 2 et 16 caractères.');
  }
  if (!/^[\p{L}\p{N} _-]+$/u.test(pseudo)) {
    throw new Error('Le pseudo ne peut contenir que des lettres, des chiffres, des espaces, - et _.');
  }
  return pseudo;
}

function cleanText(input) {
  const text = String(input || '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim();
  if (!text) throw new Error('Message vide.');
  if (text.length > 2000) throw new Error('Message trop long.');
  return text;
}

function cleanGroupName(input) {
  const name = String(input || '').trim().replace(/\s+/g, ' ');
  if (name.length < 2 || name.length > 32) {
    throw new Error('Le nom du groupe doit faire entre 2 et 32 caractères.');
  }
  return name;
}

function pairKey(a, b) {
  return [a, b].sort().join(':');
}

function openStore(file) {
  const data = file ? load(file) : emptyData();

  function persist() {
    if (!file) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.copyFileSync(tmp, file);
    fs.rmSync(tmp, { force: true });
  }

  function pseudoTaken(pseudo, exceptId) {
    const key = pseudo.toLowerCase();
    return Object.values(data.users).some((user) => user.id !== exceptId && user.pseudo.toLowerCase() === key);
  }

  function findByPseudo(pseudo) {
    const key = String(pseudo || '').trim().toLowerCase();
    return Object.values(data.users).find((user) => user.pseudo.toLowerCase() === key) || null;
  }

  function publicUser(id, online) {
    const user = data.users[id];
    if (!user) return null;
    return { id: user.id, pseudo: user.pseudo, online: !!online };
  }

  function isFriend(a, b) {
    return data.requests.some((request) => request.status === 'accepted'
      && ((request.from === a && request.to === b) || (request.from === b && request.to === a)));
  }

  function friendsOf(id, onlineOf) {
    const ids = data.requests
      .filter((request) => request.status === 'accepted' && (request.from === id || request.to === id))
      .map((request) => (request.from === id ? request.to : request.from));
    return ids.map((friendId) => publicUser(friendId, onlineOf(friendId))).filter(Boolean);
  }

  function requestsFor(id, direction) {
    return data.requests
      .filter((request) => request.status === 'pending' && (direction === 'in' ? request.to === id : request.from === id))
      .map((request) => {
        const otherId = direction === 'in' ? request.from : request.to;
        return {
          id: request.id,
          from: request.from,
          to: request.to,
          pseudo: data.users[otherId]?.pseudo || 'Quelqu’un'
        };
      });
  }

  function publicGroup(group, onlineOf) {
    return {
      id: group.id,
      name: group.name,
      ownerId: group.ownerId,
      members: group.members.map((id) => publicUser(id, onlineOf(id))).filter(Boolean)
    };
  }

  function groupsOf(userId, onlineOf) {
    return Object.values(data.groups)
      .filter((group) => group.members.includes(userId))
      .map((group) => publicGroup(group, onlineOf))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
  }

  return {
    pairKey,
    auth({ userId, token, pseudo, password }) {
      const name = cleanPseudo(pseudo);
      let hash = String(token || '');
      if (password) hash = passwordHash(name, password);
      if (!HASH.test(hash) && !/^[a-f0-9]{32,64}$/i.test(hash)) {
        throw new Error('Mot de passe ou identité invalide.');
      }

      const byPseudo = findByPseudo(name);
      if (byPseudo) {
        if (byPseudo.token !== hash) throw new Error('Mot de passe incorrect.');
        existingLastSeen(byPseudo);
        persist();
        return { id: byPseudo.id, pseudo: byPseudo.pseudo };
      }

      if (pseudoTaken(name, null)) throw new Error('Ce pseudo est déjà pris.');
      const id = UUID.test(String(userId || '')) ? String(userId) : crypto.randomUUID();
      if (data.users[id]) throw new Error('Identifiants refusés.');
      data.users[id] = { id, token: hash, pseudo: name, createdAt: Date.now() };
      existingLastSeen(data.users[id]);
      persist();
      return { id, pseudo: name };
    },
    users(onlineOf) {
      return Object.values(data.users)
        .map((user) => publicUser(user.id, onlineOf(user.id)))
        .sort((a, b) => Number(b.online) - Number(a.online) || a.pseudo.localeCompare(b.pseudo, 'fr'));
    },
    friendsOf,
    incoming(id) {
      return requestsFor(id, 'in');
    },
    outgoing(id) {
      return requestsFor(id, 'out');
    },
    requestFriend(from, to) {
      if (from === to) throw new Error('Tu ne peux pas te demander en ami.');
      if (!data.users[to]) throw new Error('Cette personne n’est pas encore inscrite sur ce serveur.');
      if (isFriend(from, to)) throw new Error('Vous êtes déjà amis.');
      const pending = data.requests.find((request) => request.status === 'pending'
        && ((request.from === from && request.to === to) || (request.from === to && request.to === from)));
      if (pending) throw new Error('Une demande est déjà en cours.');
      const request = { id: crypto.randomUUID(), from, to, status: 'pending', createdAt: Date.now() };
      data.requests.push(request);
      persist();
      return request;
    },
    requestFriendByPseudo(from, pseudo) {
      const target = findByPseudo(pseudo);
      if (!target) throw new Error('Aucun compte avec ce pseudo sur ce serveur.');
      return this.requestFriend(from, target.id);
    },
    accept(requestId, userId) {
      const request = data.requests.find((item) => item.id === requestId);
      if (!request || request.status !== 'pending' || request.to !== userId) {
        throw new Error('Demande introuvable.');
      }
      request.status = 'accepted';
      persist();
      return request;
    },
    decline(requestId, userId) {
      const request = data.requests.find((item) => item.id === requestId);
      if (!request || request.status !== 'pending' || request.to !== userId) {
        throw new Error('Demande introuvable.');
      }
      request.status = 'declined';
      persist();
      return request;
    },
    getLink(userId) {
      return data.links[userId] || null;
    },
    setLink(userId, friendId) {
      if (friendId) {
        if (!data.users[friendId]) throw new Error('Cette personne n’est pas inscrite.');
        if (!isFriend(userId, friendId)) throw new Error('Vous devez être amis avant de vous lier.');
      }
      const previous = new Set([userId, data.links[userId], friendId, friendId ? data.links[friendId] : null].filter(Boolean));
      for (const id of Object.keys(data.links)) {
        if (previous.has(id) || previous.has(data.links[id])) delete data.links[id];
      }
      if (friendId) {
        data.links[userId] = friendId;
        data.links[friendId] = userId;
      }
      persist();
      return [...previous];
    },
    addMessage(from, to, text) {
      if (data.links[from] !== to) throw new Error('Lie-toi d’abord à cette personne.');
      const message = {
        id: crypto.randomUUID(),
        pair: pairKey(from, to),
        from,
        text: cleanText(text),
        ts: Date.now()
      };
      data.messages.push(message);
      const pair = message.pair;
      const kept = data.messages.filter((item) => item.pair === pair);
      if (kept.length > 400) {
        const drop = new Set(kept.slice(0, kept.length - 400).map((item) => item.id));
        data.messages = data.messages.filter((item) => !drop.has(item.id));
      }
      persist();
      return message;
    },
    messagesFor(a, b) {
      const pair = pairKey(a, b);
      return data.messages.filter((item) => item.pair === pair).slice(-400);
    },
    groupsOf,
    createGroup(ownerId, name, memberIds) {
      const friends = new Set(friendsOf(ownerId, () => false).map((user) => user.id));
      const members = [ownerId];
      for (const raw of memberIds || []) {
        const id = String(raw || '');
        if (!id || members.includes(id)) continue;
        if (!friends.has(id)) throw new Error('Tu ne peux inviter que des amis.');
        members.push(id);
      }
      const group = {
        id: crypto.randomUUID(),
        name: cleanGroupName(name),
        ownerId,
        members,
        createdAt: Date.now()
      };
      data.groups[group.id] = group;
      persist();
      return group;
    },
    inviteToGroup(groupId, byUserId, friendId) {
      const group = data.groups[groupId];
      if (!group || !group.members.includes(byUserId)) throw new Error('Groupe introuvable.');
      if (!isFriend(byUserId, friendId)) throw new Error('Cette personne n’est pas ton ami.');
      if (group.members.includes(friendId)) throw new Error('Déjà dans le groupe.');
      group.members.push(friendId);
      persist();
      return group;
    },
    leaveGroup(groupId, userId) {
      const group = data.groups[groupId];
      if (!group || !group.members.includes(userId)) throw new Error('Groupe introuvable.');
      group.members = group.members.filter((id) => id !== userId);
      if (!group.members.length) delete data.groups[groupId];
      else if (group.ownerId === userId) group.ownerId = group.members[0];
      persist();
      return group || null;
    },
    addGroupMessage(groupId, from, text) {
      const group = data.groups[groupId];
      if (!group || !group.members.includes(from)) throw new Error('Groupe introuvable.');
      const message = {
        id: crypto.randomUUID(),
        groupId,
        from,
        text: cleanText(text),
        ts: Date.now()
      };
      data.groupMessages.push(message);
      const kept = data.groupMessages.filter((item) => item.groupId === groupId);
      if (kept.length > 400) {
        const drop = new Set(kept.slice(0, kept.length - 400).map((item) => item.id));
        data.groupMessages = data.groupMessages.filter((item) => !drop.has(item.id));
      }
      persist();
      return message;
    },
    groupMessages(groupId, userId) {
      const group = data.groups[groupId];
      if (!group || !group.members.includes(userId)) throw new Error('Groupe introuvable.');
      return data.groupMessages.filter((item) => item.groupId === groupId).slice(-400);
    },
    group(id) {
      return data.groups[id] || null;
    },
    user(id) {
      return data.users[id] || null;
    }
  };
}

function existingLastSeen(user) {
  user.lastSeen = Date.now();
}

function emptyData() {
  return {
    users: {},
    requests: [],
    links: {},
    messages: [],
    groups: {},
    groupMessages: []
  };
}

function load(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      users: parsed.users || {},
      requests: Array.isArray(parsed.requests) ? parsed.requests : [],
      links: parsed.links || {},
      messages: Array.isArray(parsed.messages) ? parsed.messages : [],
      groups: parsed.groups && typeof parsed.groups === 'object' ? parsed.groups : {},
      groupMessages: Array.isArray(parsed.groupMessages) ? parsed.groupMessages : []
    };
  } catch {
    return emptyData();
  }
}

module.exports = { openStore, cleanPseudo, pairKey };
