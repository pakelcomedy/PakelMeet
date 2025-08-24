/* =========================================================================
   PakelMeet — assets/js/app.js
   - WebRTC mesh (3-4 peers) with Firestore signaling & chat
   - Features:
     * Create / Join room (roomId)
     * Firestore collections:
         rooms/{roomId}/peers/{peerId}  -> peer presence/metadata
         rooms/{roomId}/signals         -> offer/answer/ice messages
         rooms/{roomId}/messages        -> chat messages
     * Local media (mic/cam), screen share
     * DataChannel for optional peer-to-peer features (not required for chat)
     * Robust cleanup on leave/unload
   - Requirements: Provide your Firebase config below. Enable Firestore + Auth (anonymous recommended).
   - Notes: This implementation favors clarity and robustness over maximal brevity.
   ========================================================================= */

/* ======================
   1) Firebase imports (ES modules)
   * Using Firebase modular v9+ style via CDN imports (works in browser)
   * If you prefer bundler + npm, change imports accordingly.
   ====================== */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-app.js';
import {
  getFirestore, collection, doc, setDoc, addDoc, deleteDoc, getDocs,
  onSnapshot, query, orderBy, serverTimestamp, where
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-firestore.js';
import {
  getAuth, signInAnonymously, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/9.22.2/firebase-auth.js';

/* ======================
   2) FIREBASE CONFIG - FILL THIS with your project values
   Go to Firebase Console → Project settings → Add web app → copy config
   Example:
   const firebaseConfig = {
     apiKey: "...",
     authDomain: "project-id.firebaseapp.com",
     projectId: "project-id",
     appId: "1:123:web:abc"
   };
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

if (!firebaseConfig || !firebaseConfig.apiKey) {
  console.warn("Firebase config is empty. Please fill firebaseConfig in assets/js/app.js");
}

/* ======================
   3) Initialize Firebase & services
   ====================== */
const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const auth = getAuth(app);

/* anonymous sign-in so Firestore rules that require auth work */
let currentUser = null;
signInAnonymously(auth)
  .catch(err => {
    console.error("Firebase anon sign-in failed:", err);
    // continue without auth but Firestore rules might block actions
  });

onAuthStateChanged(auth, user => {
  currentUser = user;
  console.log("Auth state:", user ? "signed in (anon)" : "signed out");
});

/* ======================
   4) App state / structures
   ====================== */
const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  // If you have TURN, add here. Example:
  // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' }
];

const localState = {
  roomId: null,
  peerId: null,
  displayName: "Guest",
  pcMap: new Map(),        // peerId -> RTCPeerConnection
  dcMap: new Map(),        // peerId -> DataChannel (for p2p messages if needed)
  remoteStreams: new Map(),// peerId -> MediaStream
  localStream: null,
  screenStream: null,
  unsubscribers: [],       // list of Firestore snapshot unsubscribe functions
  listeners: {},           // custom event listeners if needed
};

/* ======================
   5) DOM ELEMENTS (match your index.html IDs/classes)
   ====================== */
const $ = (s) => document.querySelector(s);
const $$ = (s) => Array.from(document.querySelectorAll(s));

const el = {
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

/* Small safety: ensure required elements exist */
for (const k in el) {
  if (!el[k]) console.warn(`Missing DOM element: ${k}`);
}

/* ======================
   6) Utilities
   ====================== */
const genId = (prefix = '') =>
  prefix + Math.random().toString(36).slice(2, 9);

const setStatus = (msg) => {
  if (el.status) el.status.textContent = msg;
  console.log(`[status] ${msg}`);
};

const safeCreateElem = (tag, attrs = {}) => {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else e.setAttribute(k, attrs[k]);
  }
  return e;
};

const appendLogToChat = (meta = { name:'', text:'', ts:Date.now(), self:false }) => {
  if (!el.chatBox) return;
  const wrap = safeCreateElem('div', { class: 'msg' });
  const nameEl = safeCreateElem('div', { class: 'meta', text: `${meta.name} · ${new Date(meta.ts).toLocaleTimeString()}` });
  const textEl = safeCreateElem('div', { class: 'text', text: meta.text });
  if (meta.self) textEl.style.fontWeight = '600';
  wrap.appendChild(nameEl);
  wrap.appendChild(textEl);
  el.chatBox.appendChild(wrap);
  // auto-scroll
  el.chatBox.scrollTop = el.chatBox.scrollHeight;
};

/* ======================
   7) UI helpers (video tiles)
   - createLocalTile()
   - addRemoteTile(peerId)
   - removeTile(peerId)
   - updateParticipantsClass()
   ====================== */

function createLocalTile(stream) {
  // create tile with muted local video (preview)
  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : document.createElement('div');
  container.dataset.peer = localState.peerId || 'local';
  container.classList.add('vid', 'local');
  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = true; // local preview muted
  videoEl.srcObject = stream;
  if (!container.contains(videoEl)) container.appendChild(videoEl);

  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class: 'name' });
  nameEl.textContent = localState.displayName || 'Me';
  if (!container.contains(nameEl)) container.appendChild(nameEl);

  container.id = `tile-${localState.peerId || 'local'}`;

  // Prepend local tile to emphasize it
  el.videos.prepend(container);
  updateParticipantsClass();
  return container;
}

function addRemoteTile(peerId, name = 'Participant') {
  // Avoid duplicates
  if (document.querySelector(`#tile-${peerId}`)) return document.querySelector(`#tile-${peerId}`);

  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : safeCreateElem('div', { class: 'vid' });
  container.dataset.peer = peerId;
  container.id = `tile-${peerId}`;

  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true;
  videoEl.playsInline = true;
  videoEl.muted = false;
  if (!container.contains(videoEl)) container.appendChild(videoEl);

  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class: 'name' });
  nameEl.textContent = name || 'Participant';
  if (!container.contains(nameEl)) container.appendChild(nameEl);

  el.videos.appendChild(container);
  updateParticipantsClass();
  return container;
}

function setRemoteStreamOnTile(peerId, stream) {
  const tile = document.querySelector(`#tile-${peerId}`);
  if (!tile) {
    // If tile doesn't exist yet, create it using unknown name
    addRemoteTile(peerId, 'Participant');
  }
  const videoEl = document.querySelector(`#tile-${peerId} video`);
  if (videoEl) {
    videoEl.srcObject = stream;
  }
  updateParticipantsClass();
}

function removeTile(peerId) {
  const tile = document.querySelector(`#tile-${peerId}`);
  if (tile) tile.remove();
  updateParticipantsClass();
}

function updateParticipantsClass() {
  // count of tiles excluding local preview optional - include local for layout
  const tiles = el.videos ? el.videos.querySelectorAll('.vid') : [];
  const count = tiles ? tiles.length : 0;
  const container = el.videos;
  if (!container) return;
  container.classList.remove(...Array.from(container.classList).filter(c => c.startsWith('participants-')));
  const capped = Math.min(Math.max(count, 1), 9);
  container.classList.add(`participants-${capped}`);
}

/* ======================
   8) Local media (getUserMedia) with graceful fallback
   ====================== */
async function ensureLocalStream(constraints = { audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }) {
  if (localState.localStream) return localState.localStream;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localState.localStream = stream;
    createLocalTile(stream);
    setStatus('Local media active');
    return stream;
  } catch (err) {
    console.error("getUserMedia failed:", err);
    setStatus('Gagal mengambil media — cek izin kamera/mikrofon');
    throw err;
  }
}

/* Toggle mic/cam helpers */
function setMicEnabled(enabled) {
  if (!localState.localStream) return;
  localState.localStream.getAudioTracks().forEach(t => t.enabled = !!enabled);
  el.toggleMicBtn && el.toggleMicBtn.setAttribute('aria-pressed', String(!enabled ? 'true' : 'false'));
  el.toggleMicBtn && (el.toggleMicBtn.textContent = enabled ? '🎙️ Mic' : '🔇 Mic');
}
function setCamEnabled(enabled) {
  if (!localState.localStream) return;
  localState.localStream.getVideoTracks().forEach(t => t.enabled = !!enabled);
  el.toggleCamBtn && el.toggleCamBtn.setAttribute('aria-pressed', String(!enabled ? 'true' : 'false'));
  el.toggleCamBtn && (el.toggleCamBtn.textContent = enabled ? '🎥 Cam' : '🚫 Cam');
}

/* ======================
   9) Firestore helpers: collections & convenience wrappers
   ====================== */
function roomDocRef(roomId) {
  return doc(db, 'rooms', roomId);
}
function peersCollectionRef(roomId) {
  return collection(db, 'rooms', roomId, 'peers');
}
function signalsCollectionRef(roomId) {
  return collection(db, 'rooms', roomId, 'signals');
}
function messagesCollectionRef(roomId) {
  return collection(db, 'rooms', roomId, 'messages');
}

/* write presence (peer doc) */
async function writePeerPresence(roomId, peerId, meta = {}) {
  const peerRef = doc(db, 'rooms', roomId, 'peers', peerId);
  const payload = {
    name: meta.name || localState.displayName || 'Guest',
    createdAt: serverTimestamp ? serverTimestamp() : new Date(),
    peerId,
    online: true,
  };
  try {
    await setDoc(peerRef, payload);
  } catch (err) {
    console.error("Failed to write peer presence:", err);
    throw err;
  }
}

/* delete presence */
async function removePeerPresence(roomId, peerId) {
  const peerRef = doc(db, 'rooms', roomId, 'peers', peerId);
  try {
    await deleteDoc(peerRef);
  } catch (err) {
    console.warn("Failed to remove presence doc (it might be already removed):", err);
  }
}

/* send signal (offer/answer/ice) */
async function sendSignal(roomId, message) {
  // message: { type: 'offer'|'answer'|'ice', from, to, payload }
  try {
    await addDoc(signalsCollectionRef(roomId), {
      ...message,
      ts: serverTimestamp ? serverTimestamp() : Date.now()
    });
  } catch (err) {
    console.error("Failed to send signal:", err, message);
  }
}

/* send chat message to Firestore (global chat) */
async function sendChatMessage(roomId, name, text) {
  if (!text || !text.trim()) return;
  try {
    await addDoc(messagesCollectionRef(roomId), {
      name,
      text,
      ts: serverTimestamp ? serverTimestamp() : Date.now(),
      from: localState.peerId || null,
    });
  } catch (err) {
    console.error("Failed to send chat message:", err);
  }
}

/* ======================
   10) Peer connection creation and management
   - createPeerConnectionFor(peerId, polite) -> sets up pc + data channel
   - handleOffer/Answer/ICE
   ====================== */

function makeNewPeerConnection(peerId, isOfferer = false) {
  // If exists, return
  if (localState.pcMap.has(peerId)) return localState.pcMap.get(peerId);

  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  // Ensure remote stream placeholder
  const remoteStream = new MediaStream();
  localState.remoteStreams.set(peerId, remoteStream);

  // Add local tracks to PC
  if (localState.localStream) {
    localState.localStream.getTracks().forEach(track => {
      try {
        pc.addTrack(track, localState.localStream);
      } catch (err) {
        console.warn("addTrack failed:", err);
      }
    });
  }

  // If screen sharing active, add its track too (but keep track/replacement logic elsewhere)
  if (localState.screenStream) {
    localState.screenStream.getTracks().forEach(track => {
      try { pc.addTrack(track, localState.screenStream); } catch (e) {}
    });
  }

  // ontrack -> attach to remote stream
  pc.addEventListener('track', (evt) => {
    // Some browsers give a MediaStream or track; add to remote stream
    if (evt.streams && evt.streams[0]) {
      // uses stream provided
      const s = evt.streams[0];
      localState.remoteStreams.set(peerId, s);
      setRemoteStreamOnTile(peerId, s);
    } else {
      // fallback: add track to existing remote stream
      const s = localState.remoteStreams.get(peerId) || new MediaStream();
      s.addTrack(evt.track);
      localState.remoteStreams.set(peerId, s);
      setRemoteStreamOnTile(peerId, s);
    }
  });

  // When new datachannel arrives (answerer side)
  pc.addEventListener('datachannel', (evt) => {
    const ch = evt.channel;
    console.log('DataChannel received from', peerId, ch.label);
    setupDataChannelHandlers(peerId, ch);
  });

  // ICE candidate -> forward to Firestore to 'to' peerId
  pc.addEventListener('icecandidate', async (evt) => {
    if (!evt.candidate) return;
    // send candidate to the other peer
    await sendSignal(localState.roomId, {
      type: 'ice',
      from: localState.peerId,
      to: peerId,
      payload: evt.candidate.toJSON ? evt.candidate.toJSON() : evt.candidate,
    });
  });

  pc.addEventListener('connectionstatechange', () => {
    console.log(`Connection state with ${peerId}:`, pc.connectionState);
    if (pc.connectionState === 'failed' || pc.connectionState === 'disconnected' || pc.connectionState === 'closed') {
      // consider cleanup
      // don't immediately remove; wait for peer presence removal
    }
  });

  // Save
  localState.pcMap.set(peerId, pc);

  // If we are the offerer, create a data channel proactively
  if (isOfferer) {
    try {
      const dc = pc.createDataChannel('p2p-chat');
      setupDataChannelHandlers(peerId, dc);
      localState.dcMap.set(peerId, dc);
    } catch (err) {
      console.warn("Failed to create data channel:", err);
    }
  }

  return pc;
}

function setupDataChannelHandlers(peerId, dc) {
  dc.onopen = () => {
    console.log("DataChannel open with", peerId);
  };
  dc.onclose = () => {
    console.log("DataChannel closed", peerId);
  };
  dc.onerror = (e) => console.warn("DC error", e);
  dc.onmessage = (evt) => {
    // Expect chat messages; parse if JSON
    try {
      const data = JSON.parse(evt.data);
      if (data && data.type === 'chat') {
        appendLogToChat({ name: data.name || 'Peer', text: data.text || '', ts: data.ts || Date.now(), self: false });
      }
    } catch (err) {
      // plain text fallback
      appendLogToChat({ name: peerId, text: evt.data, ts: Date.now(), self: false });
    }
  };
}

/* ======================
   11) Offer / Answer flow
   - When joining: for each existing peer, create pc (offerer) -> createOffer -> setLocalDesc -> send offer to that peer
   - When receiving offer: create pc (answerer) if needed -> setRemoteDesc -> createAnswer -> setLocalDesc -> send answer
   - Both exchange ICE via 'ice' messages
   ====================== */

async function createAndSendOffer(roomId, toPeerId) {
  setStatus(`Creating offer for ${toPeerId}...`);
  const pc = makeNewPeerConnection(toPeerId, true);
  try {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    // Send offer via Firestore signals collection (targeted to 'toPeerId')
    await sendSignal(roomId, {
      type: 'offer',
      from: localState.peerId,
      to: toPeerId,
      payload: offer.sdp || offer, // include sdp object/string (for different browsers)
    });
    setStatus(`Offer sent to ${toPeerId}`);
  } catch (err) {
    console.error("createAndSendOffer failed:", err);
  }
}

async function handleIncomingOffer(roomId, message) {
  const { from: fromPeerId, payload } = message;
  setStatus(`Received offer from ${fromPeerId}`);

  // Create PC (answerer)
  const pc = makeNewPeerConnection(fromPeerId, false);

  try {
    // Some Firestore clients may send the SDP string directly; create RTCSessionDescription if needed
    const desc = (typeof payload === 'string' || payload.sdp) ? { type: 'offer', sdp: (payload.sdp || payload) } : payload;
    await pc.setRemoteDescription(desc);

    // create datachannel handlers will be set by 'datachannel' event for pc (we didn't create a DC here)
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    // send answer back
    await sendSignal(roomId, {
      type: 'answer',
      from: localState.peerId,
      to: fromPeerId,
      payload: answer.sdp || answer,
    });
    setStatus(`Answer sent to ${fromPeerId}`);
  } catch (err) {
    console.error("handleIncomingOffer failed:", err);
  }
}

async function handleIncomingAnswer(message) {
  const { from: fromPeerId, payload } = message;
  setStatus(`Received answer from ${fromPeerId}`);
  const pc = localState.pcMap.get(fromPeerId);
  if (!pc) {
    console.warn("No RTCPeerConnection for this answer (peerId)", fromPeerId);
    return;
  }
  try {
    const desc = (typeof payload === 'string' || payload.sdp) ? { type: 'answer', sdp: (payload.sdp || payload) } : payload;
    await pc.setRemoteDescription(desc);
  } catch (err) {
    console.error("Failed to set remote description for answer:", err);
  }
}

async function handleIncomingIce(message) {
  const { from: fromPeerId, payload } = message;
  const pc = localState.pcMap.get(fromPeerId);
  if (!pc) {
    console.warn('No PC to add ICE candidate for', fromPeerId);
    return;
  }
  try {
    const cand = payload;
    await pc.addIceCandidate(cand);
  } catch (err) {
    console.warn('addIceCandidate failed:', err);
  }
}

/* ======================
   12) Firestore listeners: peers, signals, messages
   - listenForPeers() : watches peers collection to detect joins/leaves
   - listenForSignals(): watches signals collection for offer/answer/ice targeted to me
   - listenForMessages(): watches chat messages
   ====================== */

function startListeningToSignals(roomId) {
  const signalsRef = signalsCollectionRef(roomId);
  // We only need messages targeted to us (to == our peerId) or broadcast (to == 'all')
  const q = query(signalsRef, orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async change => {
      if (change.type !== 'added') return; // ignoring modifies/removes for simplicity
      const docData = change.doc.data();
      const { type, from, to, payload } = docData;
      // ignore messages from self
      if (from === localState.peerId) return;
      // message addressed to someone else -> ignore
      if (to && to !== localState.peerId && to !== 'all') return;

      // Process by type
      try {
        if (type === 'offer') {
          await handleIncomingOffer(roomId, { from, payload });
        } else if (type === 'answer') {
          await handleIncomingAnswer({ from, payload });
        } else if (type === 'ice') {
          await handleIncomingIce({ from, payload });
        } else {
          console.warn('Unknown signal type', type);
        }
      } catch (err) {
        console.error('Error processing signal', err);
      }
    });
  }, err => {
    console.error("Signals snapshot error:", err);
  });

  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToPeers(roomId) {
  const peersRef = peersCollectionRef(roomId);
  const q = query(peersRef);
  const unsub = onSnapshot(q, async (snapshot) => {
    // When snapshot initially loads, we will get all existing peers
    snapshot.docChanges().forEach(async change => {
      const data = change.doc.data();
      const pid = data.peerId || change.doc.id;
      if (change.type === 'added') {
        // A new peer joined. If it's not us, we should create an offer to them (newcomer vs existing)
        if (pid === localState.peerId) return;
        setStatus(`Peer joined: ${pid}`);
        addRemoteTile(pid, data.name || 'Participant');

        // If we joined earlier than this peer, we should create an offer to them.
        // Simple approach: create offer whenever we see an added peer that is not us,
        // but avoid creating duplicate offers by checking if a PC exists.
        if (!localState.pcMap.has(pid)) {
          // start outgoing offer to the new peer
          await createAndSendOffer(roomId, pid);
        }
      } else if (change.type === 'removed') {
        // Peer left; cleanup sockets + UI
        setStatus(`Peer left: ${pid}`);
        const pc = localState.pcMap.get(pid);
        if (pc) {
          try { pc.close(); } catch(e) {}
          localState.pcMap.delete(pid);
        }
        localState.remoteStreams.delete(pid);
        localState.dcMap.delete(pid);
        removeTile(pid);
      } else if (change.type === 'modified') {
        // metadata updated (e.g., displayName)
        const tileName = document.querySelector(`#tile-${pid} .name`);
        if (tileName && data.name) tileName.textContent = data.name;
      }
    });
    updateParticipantsClass();
  }, err => console.error("Peers snapshot error:", err));

  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToMessages(roomId) {
  const messagesRef = messagesCollectionRef(roomId);
  const q = query(messagesRef, orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const msg = change.doc.data();
      appendLogToChat({
        name: msg.name || 'Anon',
        text: msg.text || '',
        ts: (msg.ts && msg.ts.toMillis) ? msg.ts.toMillis() : (msg.ts || Date.now()),
        self: msg.from === localState.peerId,
      });
    });
  }, err => console.error("Messages snapshot error:", err));

  localState.unsubscribers.push(unsub);
  return unsub;
}

/* ======================
   13) High-level join / leave flows
   ====================== */

async function joinRoom(roomIdInput) {
  const roomId = (roomIdInput && String(roomIdInput).trim()) || (window.location.hash ? window.location.hash.replace('#', '') : '');
  if (!roomId) {
    setStatus('Masukkan Room ID sebelum join');
    return;
  }
  localState.roomId = roomId;
  // create unique peerId
  localState.peerId = genId('p-');
  // display name from input
  const dn = el.displayNameInput && el.displayNameInput.value;
  if (dn && dn.trim()) localState.displayName = dn.trim();

  setStatus(`Joining ${roomId} as ${localState.peerId} (${localState.displayName})`);

  // show share URL (use current href with hash)
  try {
    const href = new URL(window.location.href);
    href.hash = roomId;
    if (el.shareUrl) el.shareUrl.textContent = href.toString();
  } catch (e) {
    if (el.shareUrl) el.shareUrl.textContent = `${window.location.href}#${roomId}`;
  }

  // 1) Ensure we have local media
  try {
    await ensureLocalStream();
  } catch (err) {
    // user denied camera/mic -> still allow join but without tracks
    console.warn('Continuing without local media');
  }

  // 2) write presence doc
  try {
    await writePeerPresence(roomId, localState.peerId, { name: localState.displayName });
  } catch (err) {
    console.error('Failed to write presence to Firestore:', err);
    setStatus('Gagal bergabung (Firestore). Cek koneksi / aturan keamanan.');
    return;
  }

  // 3) listen for peers (to create offers to existing peers)
  startListeningToPeers(roomId);

  // 4) listen for signals (offer/answer/ice)
  startListeningToSignals(roomId);

  // 5) listen for chat messages
  startListeningToMessages(roomId);

  // 6) fetch existing peers to create offers proactively
  try {
    const peersSnap = await getDocs(peersCollectionRef(roomId));
    peersSnap.forEach(docSnap => {
      const data = docSnap.data();
      const pid = data.peerId || docSnap.id;
      // avoid making an offer to ourselves and to duplicates
      if (pid !== localState.peerId && !localState.pcMap.has(pid)) {
        // Create outgoing offer to existing peer
        createAndSendOffer(roomId, pid).catch(err => console.error(err));
      }
    });
  } catch (err) {
    console.warn('Could not fetch peers list upfront:', err);
  }

  // UI: enable/disable buttons
  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = false;
  if (el.createRoomBtn) el.createRoomBtn.disabled = true;
  setStatus(`Joined room ${roomId}. Waiting for peers...`);

  // update URL hash for sharing
  try { window.location.hash = roomId; } catch (e) {}
}

async function leaveRoom() {
  const roomId = localState.roomId;
  setStatus('Leaving room...');
  // Close all peer connections
  for (const [peerId, pc] of localState.pcMap.entries()) {
    try { pc.close(); } catch (e) {}
  }
  localState.pcMap.clear();
  localState.dcMap.clear();

  // Remove presence doc
  if (roomId && localState.peerId) {
    try {
      await removePeerPresence(roomId, localState.peerId);
    } catch (err) {
      console.warn('Could not remove presence doc during leave', err);
    }
  }

  // Unsubscribe from Firestore listeners
  localState.unsubscribers.forEach(unsub => {
    try { unsub(); } catch (e) {}
  });
  localState.unsubscribers = [];

  // UI cleanup
  // remove remote tiles
  const tiles = Array.from(el.videos.querySelectorAll('.vid'));
  tiles.forEach(t => t.remove());
  // also local preview stream remains; if you prefer remove, you can stop tracks
  // stop local media and screen
  if (localState.localStream) {
    localState.localStream.getTracks().forEach(t => t.stop());
    localState.localStream = null;
  }
  if (localState.screenStream) {
    localState.screenStream.getTracks().forEach(t => t.stop());
    localState.screenStream = null;
  }

  // Reset state
  localState.roomId = null;
  localState.peerId = null;
  localState.remoteStreams.clear();

  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = true;
  if (el.createRoomBtn) el.createRoomBtn.disabled = false;
  setStatus('Left room');
  updateParticipantsClass();
}

/* Cleanup on page unload */
window.addEventListener('beforeunload', async (ev) => {
  try {
    if (localState.roomId && localState.peerId) {
      await removePeerPresence(localState.roomId, localState.peerId);
    }
  } catch (err) {
    // ignore
  }
  // stop tracks
  if (localState.localStream) localState.localStream.getTracks().forEach(t => t.stop());
  if (localState.screenStream) localState.screenStream.getTracks().forEach(t => t.stop());
});

/* ======================
   14) Signal message ingestion (helper)
   - To avoid concurrency pitfalls, we listen to all signals but ignore messages not for us
   - Clean up old signals can be done via backend or periodic cleanup (not implemented here)
   ====================== */
/* Note: startListeningToSignals created above handles message processing */

/* ======================
   15) Screen sharing (replace or add track to each RTCPeerConnection)
   ====================== */
async function startScreenShare() {
  if (!navigator.mediaDevices.getDisplayMedia) {
    setStatus('Screen share tidak didukung di browser ini');
    return;
  }
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
    localState.screenStream = screenStream;

    // Add a visible screen tile for local user (optional)
    const screenTileId = `screen-${localState.peerId || 'local'}`;
    // create special tile to show screen preview
    const tile = addRemoteTile(screenTileId, `${localState.displayName} (screen)`);
    const videoEl = document.querySelector(`#tile-${screenTileId} video`);
    if (videoEl) videoEl.srcObject = screenStream;

    // Replace video sender track on each pc if possible (replaceTrack)
    for (const [peerId, pc] of localState.pcMap.entries()) {
      const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
      if (senders.length > 0) {
        try {
          await senders[0].replaceTrack(screenStream.getVideoTracks()[0]);
        } catch (err) {
          // fallback: addTrack (may create duplicate)
          try {
            pc.addTrack(screenStream.getVideoTracks()[0], screenStream);
          } catch (e) { console.warn('Failed to add screen track to pc', e); }
        }
      } else {
        // no existing sender -> addTrack
        try { pc.addTrack(screenStream.getVideoTracks()[0], screenStream); } catch (e) {}
      }
    }

    // When screen sharing stops, restore original camera video to senders
    screenStream.getVideoTracks()[0].addEventListener('ended', async () => {
      // remove screen tile
      removeTile(screenTileId);
      // restore camera track if available
      if (localState.localStream && localState.localStream.getVideoTracks().length > 0) {
        for (const [peerId, pc] of localState.pcMap.entries()) {
          const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
          if (senders.length > 0) {
            try {
              await senders[0].replaceTrack(localState.localStream.getVideoTracks()[0]);
            } catch (err) {
              console.warn('Failed to restore camera track to sender', err);
            }
          }
        }
      }
      localState.screenStream = null;
    });

    setStatus('You are sharing your screen');
  } catch (err) {
    console.error('Screen share failed', err);
    setStatus('Gagal membagikan layar');
  }
}

/* ======================
   16) Chat UI wiring (Firestore chat)
   ====================== */
if (el.chatForm) {
  el.chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = el.chatInput.value || '';
    if (!localState.roomId) {
      setStatus('Belum join room — chat tidak terkirim');
      return;
    }
    await sendChatMessage(localState.roomId, localState.displayName || 'Guest', text);
    // append locally immediately for responsiveness
    appendLogToChat({ name: localState.displayName || 'Me', text, ts: Date.now(), self: true });
    el.chatInput.value = '';
  });
  // also handle button click if present
  if (el.sendChatBtn) {
    el.sendChatBtn.addEventListener('click', (ev) => {
      el.chatForm.dispatchEvent(new Event('submit', { cancelable: true }));
    });
  }
}

/* ======================
   17) Controls wiring: room join/leave, mic/cam, share screen
   ====================== */
if (el.createRoomBtn) {
  el.createRoomBtn.addEventListener('click', (ev) => {
    const rid = el.roomIdInput.value.trim();
    joinRoom(rid).catch(err => console.error('JoinRoom error', err));
  });
}

if (el.leaveRoomBtn) {
  el.leaveRoomBtn.addEventListener('click', (ev) => {
    leaveRoom().catch(err => console.error('LeaveRoom error', err));
  });
}

if (el.toggleMicBtn) {
  el.toggleMicBtn.addEventListener('click', (ev) => {
    if (!localState.localStream) return;
    const enabled = localState.localStream.getAudioTracks().some(t => t.enabled);
    setMicEnabled(!enabled);
  });
}

if (el.toggleCamBtn) {
  el.toggleCamBtn.addEventListener('click', (ev) => {
    if (!localState.localStream) return;
    const enabled = localState.localStream.getVideoTracks().some(t => t.enabled);
    setCamEnabled(!enabled);
  });
}

if (el.shareScreenBtn) {
  el.shareScreenBtn.addEventListener('click', (ev) => {
    startScreenShare().catch(err => console.error(err));
  });
}

/* Display name input updates the localState and presence doc (if joined) */
if (el.displayNameInput) {
  el.displayNameInput.addEventListener('change', async (ev) => {
    const nm = el.displayNameInput.value.trim() || 'Guest';
    localState.displayName = nm;
    // update presence doc if already joined
    if (localState.roomId && localState.peerId) {
      try {
        await writePeerPresence(localState.roomId, localState.peerId, { name: nm });
      } catch (err) {
        console.warn('Failed to update displayName in presence doc', err);
      }
    }
  });
}

/* ======================
   18) Utility: show initial local preview even before join
   ====================== */
(async function tryInitPreview() {
  // Try to get a small local stream preview to show user, but don't fail if denied.
  try {
    if (!localState.localStream) {
      await ensureLocalStream({ audio: true, video: { width: 640, height: 360 } });
      // default mic/cam on
      setMicEnabled(true);
      setCamEnabled(true);
    }
  } catch (err) {
    console.warn('Preview unavailable (user may have denied permissions).', err);
  }
})();

/* ======================
   19) Small UX improvements: keyboard shortcuts, helpful hints
   ====================== */
window.addEventListener('keydown', (ev) => {
  // simple shortcuts:
  if ((ev.ctrlKey || ev.metaKey) && ev.key === 'm') {
    // Ctrl/Cmd + M toggles mic
    ev.preventDefault();
    if (localState.localStream) {
      const enabled = localState.localStream.getAudioTracks().some(t => t.enabled);
      setMicEnabled(!enabled);
    }
  } else if ((ev.ctrlKey || ev.metaKey) && ev.key === 'e') {
    // Ctrl/Cmd + E toggles cam
    ev.preventDefault();
    if (localState.localStream) {
      const enabled = localState.localStream.getVideoTracks().some(t => t.enabled);
      setCamEnabled(!enabled);
    }
  }
});

/* ======================
   20) Expose some debug functions to window for convenience (optional)
   ====================== */
window._pakelmeet = {
  localState,
  joinRoom,
  leaveRoom,
  setStatus,
  sendChatMessage,
};

/* End of app.js */
