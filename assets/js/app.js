/* =========================================================================
   PakelMeet — assets/js/app.js (LATEST)
   - Full WebRTC mesh with Firestore signaling & chat
   - Presence heartbeat + auto-cleanup on unload
   - Auto-join from URL hash and hide room controls when auto-joined
   - Auto-hide extra participants when >4 (prioritize cam-on)
   ========================================================================= */

/* ======================
   1) Firebase imports (ES modules)
   ====================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, addDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';

/* ======================
   2) FIREBASE CONFIG
   (use your project config)
   ====================== */
const firebaseConfig = {
  apiKey: "AIzaSyD4sr-HM_KbDf9gJ-o4N8vywUqRERTPeVY",
  authDomain: "pakelmeetdemo.firebaseapp.com",
  projectId: "pakelmeetdemo",
  storageBucket: "pakelmeetdemo.firebasestorage.app",
  messagingSenderId: "888241999137",
  appId: "1:888241999137:web:88f493f1873450c63b0260",
  measurementId: "G-CHH9NJEB9J"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* anonymous sign-in */
let currentUser = null;
signInAnonymously(auth).catch(err => console.error("Firebase anon sign-in failed:", err));
onAuthStateChanged(auth, user => { currentUser = user; console.log("Auth:", user ? "anon" : "signed out"); });

/* ======================
   3) App state & constants
   ====================== */
const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

const PRESENCE_HEARTBEAT_MS = 5000;      // update presence every 5s
const PRESENCE_TIMEOUT_MS = 15000;       // treat peer offline if lastSeen older than 15s

const localState = {
  roomId: null,
  peerId: null,
  displayName: "Guest",
  pcMap: new Map(),
  dcMap: new Map(),
  remoteStreams: new Map(),
  localStream: null,
  screenStream: null,
  unsubscribers: [],
  listeners: {},
  peerMeta: new Map(),            // peerId -> metadata
  _videoDetectInterval: null,
  _presenceHeartbeatInterval: null,
  _autoJoinedFromHash: false,     // *new*: whether this client auto-joined from hash
};

/* ======================
   4) DOM helpers
   ====================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));
const el = {
  roomControlsSection: $('#room-controls'),
  roomForm: $('#roomForm'),
  roomIdInput: $('#roomId'),
  createRoomBtn: $('#createRoom'),
  leaveRoomBtn: $('#leaveRoom'),
  shareUrl: $('#shareUrl'),
  videos: $('#videos'),
  displayNameInput: $('#displayName'),
  toggleMicBtn: $('#toggleMic'),
  toggleCamBtn: $('#toggleCam'),
  shareScreenBtn: $('#shareScreen'),
  chatBox: $('#chatBox'),
  chatForm: $('#chatForm'),
  chatInput: $('#chatInput'),
  sendChatBtn: $('#sendChat'),
  status: $('#status'),
};
for (const k in el) if (!el[k]) console.warn(`Missing DOM element: ${k}`);

/* ======================
   5) Utilities
   ====================== */
const genId = (pref='') => pref + Math.random().toString(36).slice(2,9);
const setStatus = (msg) => { if (el.status) el.status.textContent = msg; console.log('[status]', msg); };
const safeCreateElem = (tag, attrs={}) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  return e;
};
const appendLogToChat = (m={name:'', text:'', ts:Date.now(), self:false}) => {
  if (!el.chatBox) return;
  const wrap = safeCreateElem('div', { class: 'msg' });
  const meta = safeCreateElem('div', { class: 'meta', text: `${m.name} · ${new Date(m.ts).toLocaleTimeString()}` });
  const text = safeCreateElem('div', { class: 'text', text: m.text });
  if (m.self) text.style.fontWeight = '600';
  wrap.appendChild(meta); wrap.appendChild(text);
  el.chatBox.appendChild(wrap);
  el.chatBox.scrollTop = el.chatBox.scrollHeight;
};

function hasActiveVideoFromStream(stream) {
  try {
    if (!stream) return false;
    const tracks = stream.getVideoTracks ? stream.getVideoTracks() : [];
    return tracks.some(t => t && t.enabled !== false);
  } catch (e) { return false; }
}

/* ======================
   6) UI helpers (tiles)
   ====================== */
function createLocalTile(stream) {
  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : safeCreateElem('div', { class: 'vid' });
  container.dataset.peer = localState.peerId || 'local';
  container.classList.add('vid','local');
  container.id = `tile-${localState.peerId || 'local'}`;

  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true;
  videoEl.srcObject = stream;
  if (!container.contains(videoEl)) container.appendChild(videoEl);

  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class: 'name' });
  nameEl.textContent = localState.displayName || 'Me';
  if (!container.contains(nameEl)) container.appendChild(nameEl);

  container.dataset._hasvideo = hasActiveVideoFromStream(stream) ? 'true' : 'false';
  el.videos.prepend(container);
  updateParticipantsClass();
  return container;
}

function addRemoteTile(peerId, name='Participant') {
  if (document.querySelector(`#tile-${peerId}`)) return document.querySelector(`#tile-${peerId}`);
  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : safeCreateElem('div', { class: 'vid' });
  container.dataset.peer = peerId;
  container.id = `tile-${peerId}`;

  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = false;
  if (!container.contains(videoEl)) container.appendChild(videoEl);

  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class: 'name' });
  nameEl.textContent = name || 'Participant';
  if (!container.contains(nameEl)) container.appendChild(nameEl);

  container.dataset._hasvideo = 'false';
  el.videos.appendChild(container);
  updateParticipantsClass();
  return container;
}

function setRemoteStreamOnTile(peerId, stream) {
  let tile = document.querySelector(`#tile-${peerId}`);
  if (!tile) tile = addRemoteTile(peerId, localState.peerMeta.get(peerId)?.name || 'Participant');
  const videoEl = tile.querySelector('video');
  if (videoEl) {
    videoEl.srcObject = stream;
    tile.dataset._hasvideo = hasActiveVideoFromStream(stream) ? 'true' : 'false';
  }
  localState.remoteStreams.set(peerId, stream);
  updateParticipantsClass();
}

function removeTile(peerId) {
  const t = document.querySelector(`#tile-${peerId}`);
  if (t) t.remove();
  localState.peerMeta.delete(peerId);
  localState.remoteStreams.delete(peerId);
  updateParticipantsClass();
}

function updateParticipantsClass() {
  const tiles = el.videos ? el.videos.querySelectorAll('.vid') : [];
  const count = tiles ? tiles.length : 0;
  const container = el.videos;
  if (!container) return;
  container.classList.remove(...Array.from(container.classList).filter(c => c.startsWith('participants-')));
  const capped = Math.min(Math.max(count, 1), 9);
  container.classList.add(`participants-${capped}`);

  applyVisibilityRules(4);
  if (typeof layoutVideoGrid === 'function') layoutVideoGrid();
  if (typeof fitVideosToViewport === 'function') fitVideosToViewport();
}

/* ======================
   7) Local media
   ====================== */
async function ensureLocalStream(constraints = { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }) {
  if (localState.localStream) return localState.localStream;
  try {
    const s = await navigator.mediaDevices.getUserMedia(constraints);
    localState.localStream = s;
    createLocalTile(s);
    setStatus('Local media active');
    return s;
  } catch (err) {
    console.error("getUserMedia failed:", err);
    setStatus('Failed to access camera/microphone — check permissions');
    throw err;
  }
}

function setMicEnabled(enabled) {
  if (!localState.localStream) return;
  localState.localStream.getAudioTracks().forEach(t => t.enabled = !!enabled);
  if (el.toggleMicBtn) {
    el.toggleMicBtn.setAttribute('aria-pressed', String(!enabled));
    el.toggleMicBtn.textContent = enabled ? '🎙️ Mic' : '🔇 Mic';
  }
}
function setCamEnabled(enabled) {
  if (!localState.localStream) return;
  localState.localStream.getVideoTracks().forEach(t => t.enabled = !!enabled);
  if (el.toggleCamBtn) {
    el.toggleCamBtn.setAttribute('aria-pressed', String(!enabled));
    el.toggleCamBtn.textContent = enabled ? '🎥 Cam' : '🚫 Cam';
  }
  const localTile = document.querySelector(`#tile-${localState.peerId}`);
  if (localTile) localTile.dataset._hasvideo = enabled ? 'true' : 'false';
}

/* ======================
   8) Firestore helpers (presence includes lastSeen)
   ====================== */
function roomDocRef(roomId){ return doc(db, 'rooms', roomId); }
function peersCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'peers'); }
function signalsCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'signals'); }
function messagesCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'messages'); }

async function writePeerPresence(roomId, peerId, meta={}) {
  const peerRef = doc(db, 'rooms', roomId, 'peers', peerId);
  const payload = {
    name: meta.name || localState.displayName || 'Guest',
    createdAt: serverTimestamp ? serverTimestamp() : new Date(),
    lastSeen: serverTimestamp ? serverTimestamp() : new Date(),
    peerId,
    online: true,
  };
  await setDoc(peerRef, payload, { merge: true });
}

async function touchPeerPresence() {
  if (!localState.roomId || !localState.peerId) return;
  const peerRef = doc(db, 'rooms', localState.roomId, 'peers', localState.peerId);
  try {
    await setDoc(peerRef, { lastSeen: serverTimestamp ? serverTimestamp() : new Date(), online: true }, { merge: true });
  } catch (err) { console.warn('touchPeerPresence failed', err); }
}

async function removePeerPresence(roomId, peerId) {
  const peerRef = doc(db, 'rooms', roomId, 'peers', peerId);
  try { await deleteDoc(peerRef); } catch(e){ /*ignore*/ }
}

async function sendSignal(roomId, message) {
  try { await addDoc(signalsCollectionRef(roomId), { ...message, ts: serverTimestamp ? serverTimestamp() : Date.now() }); } catch (err) { console.error("Failed to send signal", err); }
}
async function sendChatMessage(roomId, name, text) {
  if (!text || !text.trim()) return;
  try { await addDoc(messagesCollectionRef(roomId), { name, text, ts: serverTimestamp ? serverTimestamp() : Date.now(), from: localState.peerId || null }); } catch (err) { console.error("Failed to send chat message", err); }
}

/* ======================
   9) Peer connection helpers
   ====================== */
function makeNewPeerConnection(peerId, isOfferer=false) {
  if (localState.pcMap.has(peerId)) return localState.pcMap.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  const remoteStream = new MediaStream();
  localState.remoteStreams.set(peerId, remoteStream);

  if (localState.localStream) localState.localStream.getTracks().forEach(track => { try { pc.addTrack(track, localState.localStream); } catch(e) {} });
  if (localState.screenStream) localState.screenStream.getTracks().forEach(track => { try { pc.addTrack(track, localState.screenStream); } catch(e) {} });

  pc.addEventListener('track', (evt) => {
    if (evt.streams && evt.streams[0]) {
      localState.remoteStreams.set(peerId, evt.streams[0]);
      setRemoteStreamOnTile(peerId, evt.streams[0]);
    } else {
      const s = localState.remoteStreams.get(peerId) || new MediaStream();
      s.addTrack(evt.track);
      localState.remoteStreams.set(peerId, s);
      setRemoteStreamOnTile(peerId, s);
    }
  });

  pc.addEventListener('datachannel', (evt) => setupDataChannelHandlers(peerId, evt.channel));
  pc.addEventListener('icecandidate', async (evt) => {
    if (!evt.candidate) return;
    await sendSignal(localState.roomId, { type:'ice', from: localState.peerId, to: peerId, payload: evt.candidate.toJSON ? evt.candidate.toJSON() : evt.candidate });
  });
  pc.addEventListener('connectionstatechange', () => console.log('pc state', peerId, pc.connectionState));

  localState.pcMap.set(peerId, pc);
  if (isOfferer) {
    try {
      const dc = pc.createDataChannel('p2p-chat');
      setupDataChannelHandlers(peerId, dc);
      localState.dcMap.set(peerId, dc);
    } catch(e) { console.warn('dc create failed', e); }
  }
  return pc;
}

function setupDataChannelHandlers(peerId, dc) {
  dc.onopen = () => console.log('DC open', peerId);
  dc.onclose = () => console.log('DC close', peerId);
  dc.onerror = (e) => console.warn('DC err', e);
  dc.onmessage = (evt) => {
    try {
      const data = JSON.parse(evt.data);
      if (data && data.type === 'chat') appendLogToChat({ name: data.name || 'Peer', text: data.text || '', ts: data.ts || Date.now(), self:false });
    } catch (e) {
      appendLogToChat({ name: peerId, text: evt.data, ts: Date.now(), self:false });
    }
  };
}

async function createAndSendOffer(roomId, toPeerId) {
  setStatus(`Creating offer for ${toPeerId}...`);
  const pc = makeNewPeerConnection(toPeerId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal(roomId, { type:'offer', from: localState.peerId, to: toPeerId, payload: offer.sdp || offer });
    setStatus(`Offer sent to ${toPeerId}`);
  } catch (err) { console.error(err); }
}

async function handleIncomingOffer(roomId, message) {
  const { from: fromPeerId, payload } = message;
  setStatus(`Received offer from ${fromPeerId}`);
  const pc = makeNewPeerConnection(fromPeerId, false);
  try {
    const desc = (typeof payload === 'string' || payload.sdp) ? { type: 'offer', sdp: (payload.sdp || payload) } : payload;
    await pc.setRemoteDescription(desc);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(roomId, { type:'answer', from: localState.peerId, to: fromPeerId, payload: answer.sdp || answer });
    setStatus(`Answer sent to ${fromPeerId}`);
  } catch (err) { console.error(err); }
}

async function handleIncomingAnswer(message) {
  const { from, payload } = message;
  const pc = localState.pcMap.get(from);
  if (!pc) return console.warn('No PC for answer', from);
  try {
    const desc = (typeof payload === 'string' || payload.sdp) ? { type:'answer', sdp: (payload.sdp || payload) } : payload;
    await pc.setRemoteDescription(desc);
  } catch (err) { console.error(err); }
}

async function handleIncomingIce(message) {
  const { from, payload } = message;
  const pc = localState.pcMap.get(from);
  if (!pc) return console.warn('No PC for ice', from);
  try { await pc.addIceCandidate(payload); } catch (err) { console.warn('addIceCandidate failed', err); }
}

/* ======================
   10) Firestore listeners
   ====================== */
function startListeningToSignals(roomId) {
  const q = query(signalsCollectionRef(roomId), orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async change => {
      if (change.type !== 'added') return;
      const docData = change.doc.data();
      const { type, from, to, payload } = docData;
      if (from === localState.peerId) return;
      if (to && to !== localState.peerId && to !== 'all') return;
      try {
        if (type === 'offer') await handleIncomingOffer(roomId, { from, payload });
        else if (type === 'answer') await handleIncomingAnswer({ from, payload });
        else if (type === 'ice') await handleIncomingIce({ from, payload });
      } catch (e) { console.error(e); }
    });
  }, err => console.error('Signals snapshot error', err));
  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToPeers(roomId) {
  const q = query(peersCollectionRef(roomId));
  const unsub = onSnapshot(q, (snapshot) => {
    const nowMs = Date.now();

    // Update metadata map for all docs first
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data();
      const pid = data.peerId || docSnap.id;
      const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
      const createdAtMs = (data.createdAt && data.createdAt.toMillis) ? data.createdAt.toMillis() : (data.createdAt || nowMs);
      const onlineFlag = data.online === undefined ? true : !!data.online;
      localState.peerMeta.set(pid, { name: data.name || 'Participant', createdAtMs, lastSeenMs, online: onlineFlag });
    });

    // Handle changes (added/modified/removed)
    snapshot.docChanges().forEach(change => {
      const data = change.doc.data();
      const pid = data.peerId || change.doc.id;
      if (change.type === 'added') {
        if (pid === localState.peerId) return;
        const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
        if (Date.now() - lastSeenMs > PRESENCE_TIMEOUT_MS) { console.log('Skipping stale added peer', pid); return; }
        setStatus(`Peer joined: ${pid}`);
        addRemoteTile(pid, data.name || 'Participant');
        if (!localState.pcMap.has(pid)) createAndSendOffer(roomId, pid).catch(err=>console.error(err));
      } else if (change.type === 'removed') {
        setStatus(`Peer left: ${pid}`);
        const pc = localState.pcMap.get(pid);
        if (pc) { try { pc.close(); } catch (e) {} localState.pcMap.delete(pid); }
        localState.remoteStreams.delete(pid);
        localState.dcMap.delete(pid);
        localState.peerMeta.delete(pid);
        removeTile(pid);
      } else if (change.type === 'modified') {
        const tileName = document.querySelector(`#tile-${pid} .name`);
        if (tileName && data.name) tileName.textContent = data.name;
      }
    });

    // Remove stale peers proactively: if a peer doc hasn't had heartbeat within timeout, treat as gone
    for (const [pid, meta] of Array.from(localState.peerMeta.entries())) {
      if (pid === localState.peerId) continue;
      const lastSeen = meta.lastSeenMs || meta.lastSeen || 0;
      if ((Date.now() - (lastSeen || Date.now())) > PRESENCE_TIMEOUT_MS) {
        // stale
        const pc = localState.pcMap.get(pid);
        if (pc) { try { pc.close(); } catch(e) {} localState.pcMap.delete(pid); }
        removeTile(pid);
        localState.peerMeta.delete(pid);
        localState.remoteStreams.delete(pid);
        localState.dcMap.delete(pid);
      }
    }

    updateParticipantsClass();
  }, err => console.error('Peers snapshot error', err));
  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToMessages(roomId) {
  const q = query(messagesCollectionRef(roomId), orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msg = change.doc.data();
      appendLogToChat({ name: msg.name || 'Anon', text: msg.text || '', ts: (msg.ts && msg.ts.toMillis) ? msg.ts.toMillis() : (msg.ts || Date.now()), self: msg.from === localState.peerId });
    });
  }, err => console.error('Messages snapshot error', err));
  localState.unsubscribers.push(unsub);
  return unsub;
}

/* ======================
   11) Join / Leave (auto-join + hide room-controls)
   ====================== */
async function joinRoom(roomIdInput) {
  const roomId = (roomIdInput && String(roomIdInput).trim()) || (window.location.hash ? window.location.hash.replace('#','') : '');
  if (!roomId) { setStatus('Please enter a Room ID before joining'); return; }

  localState.roomId = roomId;
  localState.peerId = genId('p-');
  const dn = el.displayNameInput && el.displayNameInput.value;
  if (dn && dn.trim()) localState.displayName = dn.trim();

  setStatus(`Joining ${roomId} as ${localState.peerId} (${localState.displayName})`);

  try {
    const href = new URL(window.location.href); href.hash = roomId; if (el.shareUrl) el.shareUrl.textContent = href.toString();
  } catch (e) { if (el.shareUrl) el.shareUrl.textContent = `${window.location.href}#${roomId}`; }

  try { await ensureLocalStream(); } catch (e) { console.warn('Continue without local media'); }

  try { await writePeerPresence(roomId, localState.peerId, { name: localState.displayName }); } catch (err) { console.error('Failed to write presence', err); setStatus('Failed to join (Firestore).'); return; }

  startListeningToPeers(roomId);
  startListeningToSignals(roomId);
  startListeningToMessages(roomId);

  // proactive existing peers -> only to non-stale
  try {
    const peersSnap = await getDocs(peersCollectionRef(roomId));
    peersSnap.forEach(docSnap => {
      const data = docSnap.data();
      const pid = data.peerId || docSnap.id;
      if (pid === localState.peerId) return;
      const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
      if (Date.now() - lastSeenMs <= PRESENCE_TIMEOUT_MS) {
        if (!localState.pcMap.has(pid)) createAndSendOffer(roomId, pid).catch(e=>console.error(e));
      } else {
        console.log('Skipping stale peer at join:', pid);
      }
    });
  } catch (e) { console.warn('Could not fetch peers upfront', e); }

  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = false;
  if (el.createRoomBtn) el.createRoomBtn.disabled = true;
  setStatus(`Joined room ${roomId}. Waiting for peers...`);

  startPresenceHeartbeat();
  startVideoStatePolling();

  // If this join is triggered by auto-join-from-hash, hide room-controls
  if (localState._autoJoinedFromHash && el.roomControlsSection) {
    try {
      el.roomControlsSection.style.display = 'none';
      // optionally hide shareUrl as it's inside the section; if you want shareUrl visible elsewhere, adapt here
    } catch(e){}
  }

  try { window.location.hash = roomId; } catch(e){}
}

async function leaveRoom() {
  const roomId = localState.roomId;
  setStatus('Leaving room...');
  for (const [peerId, pc] of localState.pcMap.entries()) { try { pc.close(); } catch(e){} }
  localState.pcMap.clear(); localState.dcMap.clear();

  stopPresenceHeartbeat();
  stopVideoStatePolling();

  if (roomId && localState.peerId) {
    try {
      try { await setDoc(doc(db, 'rooms', roomId, 'peers', localState.peerId), { online: false, lastSeen: serverTimestamp ? serverTimestamp() : new Date() }, { merge: true }); } catch(e){}
      await removePeerPresence(roomId, localState.peerId);
    } catch(e) { console.warn('Could not remove presence during leave', e); }
  }

  localState.unsubscribers.forEach(unsub => { try { unsub(); } catch(e){} });
  localState.unsubscribers = [];

  const tiles = Array.from(el.videos.querySelectorAll('.vid'));
  tiles.forEach(t => t.remove());

  if (localState.localStream) { localState.localStream.getTracks().forEach(t => t.stop()); localState.localStream = null; }
  if (localState.screenStream) { localState.screenStream.getTracks().forEach(t => t.stop()); localState.screenStream = null; }

  localState.roomId = null; localState.peerId = null; localState.remoteStreams.clear(); localState.peerMeta.clear();

  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = true;
  if (el.createRoomBtn) el.createRoomBtn.disabled = false;
  setStatus('Left room');

  // If we had auto-joined and hid room-controls, restore visibility on explicit leave
  if (localState._autoJoinedFromHash && el.roomControlsSection) {
    try { el.roomControlsSection.style.display = ''; localState._autoJoinedFromHash = false; } catch(e){}
  }

  updateParticipantsClass();
}

/* Unload/visibility cleanup (best-effort) */
async function tryCleanupOnUnload() {
  stopVideoStatePolling();
  stopPresenceHeartbeat();
  try {
    if (localState.roomId && localState.peerId) {
      try { await setDoc(doc(db, 'rooms', localState.roomId, 'peers', localState.peerId), { online: false, lastSeen: serverTimestamp ? serverTimestamp() : new Date() }, { merge: true }); } catch(e){}
      try { await removePeerPresence(localState.roomId, localState.peerId); } catch(e){}
    }
  } catch (err) {}
  if (localState.localStream) localState.localStream.getTracks().forEach(t=>t.stop());
  if (localState.screenStream) localState.screenStream.getTracks().forEach(t=>t.stop());
}

window.addEventListener('beforeunload', () => { tryCleanupOnUnload(); });
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') tryCleanupOnUnload(); });

/* ======================
   12) Presence heartbeat
   ====================== */
function startPresenceHeartbeat() {
  if (localState._presenceHeartbeatInterval) return;
  touchPeerPresence().catch(()=>{});
  localState._presenceHeartbeatInterval = setInterval(() => { touchPeerPresence().catch(()=>{}); }, PRESENCE_HEARTBEAT_MS);
}
function stopPresenceHeartbeat() {
  if (localState._presenceHeartbeatInterval) { clearInterval(localState._presenceHeartbeatInterval); localState._presenceHeartbeatInterval = null; }
}

/* ======================
   13) Screen share
   ====================== */
async function startScreenShare() {
  if (!navigator.mediaDevices.getDisplayMedia) { setStatus('Screen share not supported in this browser'); return; }
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
    localState.screenStream = screenStream;
    const screenTileId = `screen-${localState.peerId || 'local'}`;
    addRemoteTile(screenTileId, `${localState.displayName} (screen)`);
    const videoEl = document.querySelector(`#tile-${screenTileId} video`);
    if (videoEl) videoEl.srcObject = screenStream;
    for (const [peerId, pc] of localState.pcMap.entries()) {
      const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
      if (senders.length > 0) {
        try { await senders[0].replaceTrack(screenStream.getVideoTracks()[0]); } catch(e){ try{ pc.addTrack(screenStream.getVideoTracks()[0], screenStream); }catch(e){} }
      } else { try{ pc.addTrack(screenStream.getVideoTracks()[0], screenStream); } catch(e) {} }
    }
    screenStream.getVideoTracks()[0].addEventListener('ended', async () => {
      removeTile(screenTileId);
      if (localState.localStream && localState.localStream.getVideoTracks().length > 0) {
        for (const [peerId, pc] of localState.pcMap.entries()) {
          const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
          if (senders.length > 0) {
            try { await senders[0].replaceTrack(localState.localStream.getVideoTracks()[0]); } catch(e) { console.warn(e); }
          }
        }
      }
      localState.screenStream = null;
    });
    setStatus('You are sharing your screen');
  } catch (err) { console.error(err); setStatus('Failed to share screen'); }
}

/* ======================
   14) Chat wiring
   ====================== */
if (el.chatForm) {
  el.chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = el.chatInput.value || '';
    if (!localState.roomId) { setStatus('Not in a room — chat not sent'); return; }
    await sendChatMessage(localState.roomId, localState.displayName || 'Guest', text);
    appendLogToChat({ name: localState.displayName || 'Me', text, ts: Date.now(), self:true });
    el.chatInput.value = '';
  });
  if (el.sendChatBtn) el.sendChatBtn.addEventListener('click', ()=> el.chatForm.dispatchEvent(new Event('submit',{cancelable:true})));
}

/* ======================
   15) Controls wiring
   ====================== */
if (el.createRoomBtn) el.createRoomBtn.addEventListener('click', ()=> joinRoom(el.roomIdInput.value.trim()).catch(console.error));
if (el.leaveRoomBtn) el.leaveRoomBtn.addEventListener('click', ()=> leaveRoom().catch(console.error));
if (el.toggleMicBtn) el.toggleMicBtn.addEventListener('click', ()=> {
  if (!localState.localStream) return;
  const enabled = localState.localStream.getAudioTracks().some(t=>t.enabled);
  setMicEnabled(!enabled);
});
if (el.toggleCamBtn) el.toggleCamBtn.addEventListener('click', ()=> {
  if (!localState.localStream) return;
  const enabled = localState.localStream.getVideoTracks().some(t=>t.enabled);
  setCamEnabled(!enabled);
});
if (el.shareScreenBtn) el.shareScreenBtn.addEventListener('click', ()=> startScreenShare().catch(console.error));
if (el.displayNameInput) el.displayNameInput.addEventListener('change', async ()=> {
  const nm = el.displayNameInput.value.trim() || 'Guest'; localState.displayName = nm;
  if (localState.roomId && localState.peerId) try { await writePeerPresence(localState.roomId, localState.peerId, { name: nm }); } catch(e){ console.warn(e); }
});

/* ======================
   16) Initial preview attempt
   ====================== */
(async function tryInitPreview(){
  try {
    if (!localState.localStream) {
      await ensureLocalStream({ audio:true, video:{ width:640, height:360 } });
      setMicEnabled(true); setCamEnabled(true);
    }
  } catch (e) { console.warn('Preview not available', e); }
})();

/* ======================
   17) Fit & layout helpers (reuse your previously working functions)
   ====================== */
/* Keep the fitVideosToViewport() & layoutVideoGrid() implementations from your previous file.
   For brevity they're not duplicated here in full; ensure the functions exist in your file
   (they were present in earlier versions you shared). */

function fitVideosToViewport() {
  try {
    const header = document.querySelector('.site-header');
    const roomControls = document.querySelector('#room-controls');
    const controls = document.querySelector('#video-section .controls') || document.querySelector('.controls');
    const footer = document.querySelector('.site-footer');
    const top = header ? header.getBoundingClientRect().height : 0;
    const roomH = roomControls ? roomControls.getBoundingClientRect().height : 0;
    const controlsH = controls ? controls.getBoundingClientRect().height : 0;
    const footerH = footer ? footer.getBoundingClientRect().height : 0;
    const extras = 32;
    const vh = window.innerHeight;
    const available = Math.max(160, Math.floor(vh - (top + roomH + controlsH + footerH + extras)));
    document.documentElement.style.setProperty('--videos-max-h', `${available}px`);
    const videosEl = document.querySelector('.videos');
    if (videosEl) videosEl.style.overflowY = (available < 260) ? 'auto' : 'hidden';
  } catch (err) { console.warn('fitVideosToViewport error', err); }
}

function layoutVideoGrid() {
  try {
    const videosEl = document.querySelector('.videos');
    if (!videosEl) return;
    const tiles = Array.from(videosEl.querySelectorAll('.vid'));
    const N = Math.max(tiles.length,1);

    const header = document.querySelector('.site-header');
    const roomControls = document.querySelector('#room-controls');
    const controls = document.querySelector('#video-section .controls') || document.querySelector('.controls');
    const footer = document.querySelector('.site-footer');
    const headerH = header ? header.getBoundingClientRect().height : 0;
    const roomH = roomControls ? roomControls.getBoundingClientRect().height : 0;
    const controlsH = controls ? controls.getBoundingClientRect().height : 0;
    const footerH = footer ? footer.getBoundingClientRect().height : 0;
    const extras = 28;
    const availableHeight = Math.max(160, Math.floor(window.innerHeight - (headerH + roomH + controlsH + footerH + extras)));

    const containerRect = videosEl.getBoundingClientRect();
    const containerWidth = containerRect.width && containerRect.width > 0 ? containerRect.width : (window.innerWidth - (document.querySelector('.sidebar') ? document.querySelector('.sidebar').getBoundingClientRect().width : 0) - 40);

    const aspectRatio = 16/9;
    let best = { cols:1, rows:N, tileWidth:containerWidth, tileHeight:Math.floor(containerWidth/aspectRatio), totalHeight: Math.ceil(N)*Math.floor(containerWidth/aspectRatio), fits:false, overflow: Infinity };

    const gap = parseFloat(getComputedStyle(videosEl).gap || 12);
    const maxCols = Math.min(N, Math.max(1, Math.floor(containerWidth / 160)));

    for (let cols=1; cols<=maxCols; cols++) {
      const tileW = (containerWidth - (cols - 1) * gap) / cols;
      const tileH = tileW / aspectRatio;
      const rows = Math.ceil(N / cols);
      const totalH = rows * tileH + (rows - 1) * gap;
      const overflow = Math.max(0, totalH - availableHeight);
      const fits = totalH <= availableHeight;
      if (fits) {
        if (!best.fits || tileH > best.tileHeight) best = { cols, rows, tileWidth:tileW, tileHeight:tileH, totalHeight, fits, overflow };
      } else {
        if (!best.fits) {
          if (overflow < best.overflow || (Math.abs(overflow - best.overflow) < 1 && tileH > best.tileHeight)) {
            best = { cols, rows, tileWidth:tileW, tileHeight:tileH, totalHeight, fits:false, overflow };
          }
        }
      }
    }

    const minTileH = 100;
    const tileHpx = Math.max(minTileH, Math.floor(best.tileHeight));
    const colsToUse = best.cols;

    videosEl.style.gridTemplateColumns = `repeat(${colsToUse}, 1fr)`;
    videosEl.style.setProperty('--tile-height', `${tileHpx}px`);
    videosEl.style.setProperty('--videos-max-h', `${availableHeight}px`);
    tiles.forEach(t => { t.style.height = `${tileHpx}px`; });

    videosEl.style.overflowY = best.fits ? 'hidden' : 'auto';
    const statusEl = document.querySelector('#status');
    if (statusEl) statusEl.textContent = `Tiles: ${N} • grid ${colsToUse}×${best.rows} • ${best.fits ? 'fit' : 'scroll'}`;
  } catch (err) { console.warn('layoutVideoGrid error', err); }
}

window.addEventListener('load', ()=>{ fitVideosToViewport(); setTimeout(()=>{ fitVideosToViewport(); layoutVideoGrid(); }, 120); });
window.addEventListener('resize', ()=>{ fitVideosToViewport(); layoutVideoGrid(); });
window.addEventListener('orientationchange', ()=>{ setTimeout(()=>{ fitVideosToViewport(); layoutVideoGrid(); }, 120); });

/* ======================
   18) Visibility rules & polling
   ====================== */
function applyVisibilityRules(maxVisible = 4) {
  try {
    const videosEl = document.querySelector('.videos');
    if (!videosEl) return;
    const tiles = Array.from(videosEl.querySelectorAll('.vid'));
    const total = tiles.length;
    if (total <= maxVisible) {
      tiles.forEach(t => { t.classList.remove('hidden-by-limit'); t.style.display=''; t.setAttribute('aria-hidden','false'); });
      setStatus(`${total} participants`);
      layoutVideoGrid();
      return;
    }

    const infos = tiles.map(t => {
      const peer = t.dataset.peer || t.id || '';
      const isLocal = t.classList.contains('local') || peer === localState.peerId;
      const hasVideo = (t.dataset._hasvideo === 'true');
      const meta = localState.peerMeta.get(peer) || {};
      const createdAtMs = meta.createdAtMs || 0;
      return { tileEl: t, peer, isLocal, hasVideo, createdAtMs };
    });

    infos.sort((a,b) => {
      if (a.isLocal && !b.isLocal) return -1;
      if (!a.isLocal && b.isLocal) return 1;
      if (a.hasVideo && !b.hasVideo) return -1;
      if (!a.hasVideo && b.hasVideo) return 1;
      return (a.createdAtMs || 0) - (b.createdAtMs || 0);
    });

    const visible = infos.slice(0, maxVisible);
    const visiblePeers = new Set(visible.map(i => i.peer));
    infos.forEach(info => {
      const tile = info.tileEl;
      if (visiblePeers.has(info.peer)) {
        tile.classList.remove('hidden-by-limit'); tile.style.display=''; tile.setAttribute('aria-hidden','false');
      } else {
        tile.classList.add('hidden-by-limit'); tile.style.display='none'; tile.setAttribute('aria-hidden','true');
      }
    });

    const hiddenCount = total - visiblePeers.size;
    setStatus(`${total} participants • ${hiddenCount} hidden`);
    layoutVideoGrid();
  } catch (err) { console.warn('applyVisibilityRules error', err); }
}

function detectVideoStateAndApply(maxVisible = 4) {
  try {
    const videosEl = document.querySelector('.videos');
    if (!videosEl) return;
    const tiles = Array.from(videosEl.querySelectorAll('.vid'));
    let changed = false;
    for (const t of tiles) {
      const videoEl = t.querySelector('video');
      let hasVideo = false;
      try {
        if (videoEl && videoEl.srcObject) {
          const vtracks = (videoEl.srcObject.getVideoTracks && videoEl.srcObject.getVideoTracks()) || [];
          hasVideo = vtracks.some(tr => tr && tr.enabled !== false);
        }
      } catch (e) { hasVideo = false; }
      const prev = t.dataset._hasvideo === 'true';
      if (prev !== hasVideo) { t.dataset._hasvideo = hasVideo ? 'true' : 'false'; changed = true; }
    }
    if (changed) applyVisibilityRules(maxVisible);
  } catch (e) { console.warn('detectVideoStateAndApply error', e); }
}

function startVideoStatePolling() {
  if (localState._videoDetectInterval) return;
  localState._videoDetectInterval = setInterval(() => detectVideoStateAndApply(4), 1200);
}
function stopVideoStatePolling() {
  if (localState._videoDetectInterval) { clearInterval(localState._videoDetectInterval); localState._videoDetectInterval = null; }
}

/* ======================
   19) Keyboard shortcuts & debug
   ====================== */
window.addEventListener('keydown', (ev) => {
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'm') { ev.preventDefault(); if (localState.localStream) setMicEnabled(!localState.localStream.getAudioTracks().some(t=>t.enabled)); }
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'e') { ev.preventDefault(); if (localState.localStream) setCamEnabled(!localState.localStream.getVideoTracks().some(t=>t.enabled)); }
});

window._pakelmeet = { localState, joinRoom, leaveRoom, setStatus, sendChatMessage, applyVisibilityRules, layoutVideoGrid };

/* ======================
   20) AUTO-JOIN ON HASH (executed at bottom)
   - If a hash exists, fill input, set auto-join flag, and call joinRoom()
   ====================== */

function tryAutoJoinFromHash() {
  try {
    const raw = window.location.hash ? window.location.hash.replace('#','').trim() : '';
    if (!raw) return;
    // populate input (so user sees ID briefly if controls are visible)
    if (el.roomIdInput) el.roomIdInput.value = raw;
    // mark auto-join flag so joinRoom hides room controls after joining
    localState._autoJoinedFromHash = true;
    // small delay (let page settle / preview init) then join
    setTimeout(() => {
      joinRoom(raw).catch(err => {
        console.error('Auto-join failed', err);
        // in case of failure, restore auto-join flag so user can try manually
        localState._autoJoinedFromHash = false;
      });
    }, 250);
  } catch (err) { console.warn('tryAutoJoinFromHash error', err); }
}

/* Call auto-join on initial load (after a short wait to allow preview attempts) */
window.addEventListener('load', () => {
  setTimeout(() => tryAutoJoinFromHash(), 300);
});

