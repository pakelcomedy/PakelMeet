/* ==========================================================
  PakelMeet  assets/js/app.js
  Fixed: stronger de-dup for chat (Firestore + DataChannel + local), idempotent message listener
  Replace your current app.js with this file.
  ========================================================== */

/* ======================
   Firebase imports
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
   CONFIG (update as needed)
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

let app, db, auth;
try {
  app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  console.log('Firebase initialized');
} catch (e) {
  console.error('Firebase init error (check config/hosting):', e);
}

/* Try anonymous sign-in */
signInAnonymously(auth).catch(err => {
  console.warn('Firebase anon sign-in failed (check Authorized domains in Firebase Console):', err);
  try { setStatus('Firebase auth warning: add your domain to Firebase Authorized domains (Console -> Authentication -> Settings).'); } catch(e){}
});
onAuthStateChanged(auth, user => {
  console.log('Auth state changed => user?', !!user);
});

/* ======================
   App constants & state
   ====================== */
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // add TURN servers in production
];

const PRESENCE_HEARTBEAT_MS = 5000;
const PRESENCE_TIMEOUT_MS = 15000;
const MAX_VISIBLE_TILES = 4;
const VIDEO_POLL_INTERVAL_MS = 1200;

const localState = {
  roomId: null,
  peerId: null,
  displayName: 'Guest',
  pcMap: new Map(),
  dcMap: new Map(),
  remoteStreams: new Map(),
  localStream: null,
  screenStream: null,
  unsubscribers: [],
  peerMeta: new Map(),
  candidateQueue: new Map(),
  processedSignalIds: new Set(),
  processedMessageIds: new Set(),
  _videoDetectInterval: null,
  _presenceHeartbeatInterval: null,
  _joined: false,
  _autoJoinedFromHash: false,
  _removeHashAfterAutoJoin: false,
  _messagesListening: false,
  _messagesUnsub: null,
};

/* ======================
   DOM helpers
   ====================== */
const $ = s => document.querySelector(s);
const $$ = s => Array.from(document.querySelectorAll(s));
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
function setStatus(msg){ if (el.status) el.status.textContent = msg; console.log('[status]', msg); }
function safeCreateElem(tag, attrs={}){ const e=document.createElement(tag); for(const k in attrs){ if(k==='class') e.className=attrs[k]; else if(k==='text') e.textContent=attrs[k]; else e.setAttribute(k, attrs[k]); } return e; }

/* stable deterministic id generator for messages (simple djb2 hash -> base36)
   ensures same (from,ts,name,text) produces same id for dedupe when Firestore id absent */
function stableMsgId(from, name, text, ts){
  const s = `${from||''}|${String(ts||'') }|${name||''}|${text||''}`;
  let h = 5381;
  for (let i = 0; i < s.length; i++) { h = ((h << 5) + h) + s.charCodeAt(i); h = h & 0xffffffff; }
  return 'm' + (h >>> 0).toString(36);
}

/* appendLogToChat: prevents DOM duplicates by data-msg-id and near-duplicate content check */
function appendLogToChat({ id=null, name='', text='', ts=Date.now(), self=false }) {
  if (!el.chatBox) return;

  // normalize ts to number
  const tsNum = (typeof ts === 'number') ? ts : (ts && ts.toMillis ? ts.toMillis() : Date.now());

  // compute id if not provided (stable)
  let msgId = id ? String(id) : stableMsgId(null, name, text, tsNum);

  // DOM-level dedupe: if element with same data-msg-id exists, skip
  try {
    if (el.chatBox.querySelector(`[data-msg-id="${msgId}"]`)) {
      console.debug('appendLogToChat: skipping duplicate DOM element for id', msgId);
      return;
    }
  } catch (e) {
    // selector could throw on weird chars; fallback to content-based check below
  }

  // content-based near-duplicate guard: check last few messages for same name+text within ~1.2s
  try {
    const recent = Array.from(el.chatBox.querySelectorAll('.msg')).slice(-6);
    for (const r of recent.reverse()) {
      const metaEl = r.querySelector('.meta');
      const textEl = r.querySelector('.text');
      if (!metaEl || !textEl) continue;
      const metaText = metaEl.textContent || '';
      const contentText = (textEl.textContent || '').trim();
      // meta format: "Name · TIME"  we'll compare name substring and text
      if (metaText.indexOf(name) !== -1 && contentText === (text || '')) {
        // try to compare timestamps if element has data-msg-ts
        const existingTs = parseInt(r.getAttribute('data-msg-ts') || '0', 10);
        if (existingTs && Math.abs(existingTs - tsNum) <= 1200) {
          console.debug('appendLogToChat: skipping near-duplicate content', name, text, tsNum);
          return;
        } else if (!existingTs) {
          // no ts attr, still skip to be safe
          console.debug('appendLogToChat: skipping duplicate (no ts) for', name, text);
          return;
        }
      }
    }
  } catch (e) { /* ignore */ }

  const wrap = safeCreateElem('div', { class:'msg' });
  try { wrap.setAttribute('data-msg-id', msgId); } catch(e){}
  try { wrap.setAttribute('data-msg-ts', String(tsNum)); } catch(e){}
  const meta = safeCreateElem('div', { class:'meta', text:`${name} · ${new Date(tsNum).toLocaleTimeString()}` });
  const txt = safeCreateElem('div', { class:'text', text });
  if (self) txt.style.fontWeight='600';
  wrap.appendChild(meta); wrap.appendChild(txt);
  el.chatBox.appendChild(wrap);
  el.chatBox.scrollTop = el.chatBox.scrollHeight;
}

/* ======================
   Video helpers (unchanged)
   ====================== */
function hasActiveVideoFromStream(stream){
  try { if(!stream) return false; const t = stream.getVideoTracks ? stream.getVideoTracks() : []; return t.some(tt=> tt && tt.enabled !== false && (tt.readyState !== 'ended')); } catch(e){ return false; }
}
function removeLocalTileIfExists(){ try{ const e=document.querySelector('.vid.local'); if(e) e.remove(); }catch(e){} }
async function ensureVideoPlays(videoEl){ if(!videoEl) return; try{ if(typeof videoEl.play==='function') await videoEl.play(); } catch(e){ console.debug('video.play() blocked', e); } }

/* createLocalTile / addRemoteTile / setRemoteStreamOnTile / removeTile same as before but keep stable */
function createLocalTile(stream){
  removeLocalTileIfExists();
  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : safeCreateElem('div', { class:'vid' });
  container.dataset.peer = localState.peerId || 'local';
  container.classList.add('vid','local');
  container.id = `tile-${localState.peerId||'local'}`;
  container.setAttribute('tabindex', '0');

  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = true;
  try{ videoEl.srcObject = stream; } catch(e){ console.warn('set srcObject local failed', e); }
  if(!container.contains(videoEl)) container.appendChild(videoEl);
  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class:'name' });
  nameEl.textContent = localState.displayName || 'Me';
  if(!container.contains(nameEl)) container.appendChild(nameEl);
  container.dataset._hasvideo = hasActiveVideoFromStream(stream) ? 'true' : 'false';
  if (el.videos) el.videos.prepend(container);

  try {
    if (window._pakelmeet && typeof window._pakelmeet.attachFullscreenHandlers === 'function') {
      window._pakelmeet.attachFullscreenHandlers(container);
    } else {
      window._pakelmeet = window._pakelmeet || {};
      window._pakelmeet._pendingAttach = window._pakelmeet._pendingAttach || [];
      window._pakelmeet._pendingAttach.push(container);
    }
  } catch(e){
    console.debug('attachFullscreenHandlers not ready yet, queued', e);
  }

  const tryPlay = async ()=>{ await ensureVideoPlays(videoEl).catch(()=>{}); setTimeout(()=> { try { videoEl.play && videoEl.play().catch(()=>{}); } catch(e){} scheduleLayout(); }, 120); };
  if (videoEl.readyState >= 2) tryPlay(); else videoEl.addEventListener('loadedmetadata', tryPlay, { once:true });
  updateParticipantsClass();
  return container;
}

function addRemoteTile(peerId, name='Participant'){
  if (document.querySelector(`#tile-${peerId}`)) return document.querySelector(`#tile-${peerId}`);
  const tpl = document.querySelector('#video-tile-template');
  const container = (tpl && tpl.content) ? tpl.content.firstElementChild.cloneNode(true) : safeCreateElem('div', { class:'vid' });
  container.dataset.peer = peerId; container.id = `tile-${peerId}`;
  container.setAttribute('tabindex', '0');

  const videoEl = container.querySelector('video') || safeCreateElem('video');
  videoEl.autoplay = true; videoEl.playsInline = true; videoEl.muted = false;
  if(!container.contains(videoEl)) container.appendChild(videoEl);
  const nameEl = container.querySelector('[data-hook="video-name"]') || safeCreateElem('div', { class:'name' });
  nameEl.textContent = name || 'Participant';
  if(!container.contains(nameEl)) container.appendChild(nameEl);
  container.dataset._hasvideo = 'false';
  if (el.videos) el.videos.appendChild(container);

  try {
    if (window._pakelmeet && typeof window._pakelmeet.attachFullscreenHandlers === 'function') {
      window._pakelmeet.attachFullscreenHandlers(container);
    } else {
      window._pakelmeet = window._pakelmeet || {};
      window._pakelmeet._pendingAttach = window._pakelmeet._pendingAttach || [];
      window._pakelmeet._pendingAttach.push(container);
    }
  } catch(e){
    console.debug('attachFullscreenHandlers not ready yet, queued', e);
  }

  updateParticipantsClass();
  return container;
}

async function setRemoteStreamOnTile(peerId, stream){
  let tile = document.querySelector(`#tile-${peerId}`);
  if(!tile) tile = addRemoteTile(peerId, localState.peerMeta.get(peerId)?.name || 'Participant');
  const videoEl = tile.querySelector('video');
  if(videoEl){
    try { videoEl.srcObject = stream; } catch(e){ console.warn('setRemoteStream srcObject fail', e); }
    tile.dataset._hasvideo = hasActiveVideoFromStream(stream) ? 'true' : 'false';
    try { await ensureVideoPlays(videoEl).catch(()=>{}); } catch(e){}
    videoEl.addEventListener('loadedmetadata', ()=> ensureVideoPlays(videoEl).catch(()=>{}), { once:true });
  }
  localState.remoteStreams.set(peerId, stream);
  scheduleLayout();
}
function removeTile(peerId){ const t=document.querySelector(`#tile-${peerId}`); if(t) t.remove(); localState.peerMeta.delete(peerId); localState.remoteStreams.delete(peerId); scheduleLayout(); }

/* layout scheduling */
let _layoutRaf = null;
function scheduleLayout(){ if(_layoutRaf) cancelAnimationFrame(_layoutRaf); _layoutRaf = requestAnimationFrame(()=>{ try{ updateParticipantsClass(); } catch(e){ console.warn('scheduleLayout err', e); } _layoutRaf=null; }); }
function updateParticipantsClass(){
  if(!el.videos) return;
  const tiles = el.videos.querySelectorAll('.vid'); const count = tiles.length;
  el.videos.classList.remove(...Array.from(el.videos.classList).filter(c=>c.startsWith('participants-')));
  const capped = Math.min(Math.max(count,1),9);
  el.videos.classList.add(`participants-${capped}`);
  applyVisibilityRules(MAX_VISIBLE_TILES);
  layoutVideoGrid();
  fitVideosToViewport();
}

/* ======================
   Local media (same as original robust implementation)
   ====================== */
async function ensureLocalStream(constraints = { audio:true, video:{ width:{ ideal:1280 }, height:{ ideal:720 } } }){
  try {
    if (localState.localStream) {
      const vtracks = localState.localStream.getVideoTracks();
      if (vtracks && vtracks.length > 0 && vtracks.some(t => t && t.readyState !== 'ended')) return localState.localStream;
    }
  } catch (e) { console.warn('localStream check failed', e); }

  const audioWanted = !!(constraints && constraints.audio);
  const baseVideo = (constraints && typeof constraints.video === 'object') ? { ...constraints.video } : {};

  async function listVideoInputs() {
    try { const devices = await navigator.mediaDevices.enumerateDevices(); return devices.filter(d => d.kind === 'videoinput'); } catch (e) { return []; }
  }

  function findFrontCandidate(devices) {
    if (!devices || devices.length === 0) return null;
    const labeled = devices.filter(d => d.label && d.label.trim().length > 0);
    const re = /front|face|user|selfie|facetime|front camera|facing front|front-facing/i;
    const byLabel = labeled.find(d => re.test(d.label));
    if (byLabel) return byLabel;
    if (labeled.length > 0) return labeled[0];
    return devices[0] || null;
  }

  async function tryByDeviceId(deviceId) { if (!deviceId) return null; try { return await navigator.mediaDevices.getUserMedia({ audio: audioWanted, video: { deviceId: { exact: deviceId }, ...baseVideo } }); } catch (e) { return null; } }
  async function tryByFacingMode(mode, useExact=false) { try { const fm = useExact ? { exact: mode } : { ideal: mode }; return await navigator.mediaDevices.getUserMedia({ audio: audioWanted, video: { ...baseVideo, facingMode: fm } }); } catch (e) { return null; } }

  let stream = null;
  stream = await tryByFacingMode('user', true);
  if (!stream) stream = await tryByFacingMode('user', false);

  try {
    if (stream) {
      const vtracks = stream.getVideoTracks();
      if (vtracks && vtracks.length > 0) {
        const settings = vtracks[0].getSettings ? vtracks[0].getSettings() : {};
        const facing = settings.facingMode || '';
        if (String(facing).toLowerCase() === 'user') {
          localState.localStream = stream; createLocalTile(stream); setStatus('Local media active (front camera)'); return stream;
        }
      }
    }

    const devices = await listVideoInputs();
    const hasLabels = devices.some(d => d.label && d.label.trim().length > 0);
    if (hasLabels) {
      const candidate = findFrontCandidate(devices);
      if (candidate && candidate.deviceId) {
        const byId = await tryByDeviceId(candidate.deviceId);
        if (byId) {
          if (stream) stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} });
          localState.localStream = byId; createLocalTile(byId); setStatus('Local media active (front camera by deviceId)'); return byId;
        }
      }
    }
  } catch (e) { console.warn('Explicit front-device attempt failed', e); }

  if (!stream) {
    try { stream = await navigator.mediaDevices.getUserMedia({ audio: audioWanted, video: (Object.keys(baseVideo).length ? baseVideo : true) }); } catch (e) { console.error('getUserMedia fallback failed', e); throw e; }
  }

  try {
    const vtracks = stream.getVideoTracks();
    if (!vtracks || vtracks.length === 0) { localState.localStream = stream; createLocalTile(stream); setStatus('Local media active (no video tracks)'); return stream; }
    const settings = vtracks[0].getSettings ? vtracks[0].getSettings() : {};
    const facing = (settings && settings.facingMode) ? String(settings.facingMode).toLowerCase() : '';
    if (facing === 'user') { localState.localStream = stream; createLocalTile(stream); setStatus('Local media active (front camera)'); return stream; }

    try {
      const devices2 = await listVideoInputs(); const labeled2 = devices2.filter(d => d.label && d.label.trim().length > 0);
      if (labeled2.length > 0) {
        const candidate2 = findFrontCandidate(devices2);
        if (candidate2 && candidate2.deviceId) {
          const frontStream = await tryByDeviceId(candidate2.deviceId);
          if (frontStream) { stream.getTracks().forEach(t => { try { t.stop(); } catch (e) {} }); localState.localStream = frontStream; createLocalTile(frontStream); setStatus('Local media active (front camera final)'); return frontStream; }
        }
      }
    } catch (e) { console.warn('Final explicit device attempt failed', e); }

    localState.localStream = stream; createLocalTile(stream); setStatus('Local media active (best-effort)'); return stream;
  } catch (err) {
    console.error('Post-acquire processing failed', err);
    localState.localStream = stream; createLocalTile(stream); setStatus('Local media active (post-processing error)'); return stream;
  }
}

function setMicEnabled(enabled){ if(!localState.localStream) return; localState.localStream.getAudioTracks().forEach(t=>t.enabled=!!enabled); if(el.toggleMicBtn){ el.toggleMicBtn.setAttribute('aria-pressed', String(!!enabled)); el.toggleMicBtn.textContent = enabled ? '🎙️ Mic' : '🔇 Mic'; } }
function setCamEnabled(enabled){ if(!localState.localStream) return; localState.localStream.getVideoTracks().forEach(t=>t.enabled=!!enabled); if(el.toggleCamBtn){ el.toggleCamBtn.setAttribute('aria-pressed', String(!!enabled)); el.toggleCamBtn.textContent = enabled ? '🎥 Cam' : '🚫 Cam'; } const localTile = document.querySelector(`#tile-${localState.peerId}`); if(localTile) localTile.dataset._hasvideo = enabled ? 'true' : 'false'; }

/* ======================
   Firestore helpers
   ====================== */
function roomDocRef(roomId){ return doc(db, 'rooms', roomId); }
function peersCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'peers'); }
function signalsCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'signals'); }
function messagesCollectionRef(roomId){ return collection(db, 'rooms', roomId, 'messages'); }

async function writePeerPresence(roomId, peerId, meta={}) {
  const peerRef = doc(db, 'rooms', roomId, 'peers', peerId);
  const payload = { name: meta.name || localState.displayName || 'Guest', createdAt: serverTimestamp ? serverTimestamp() : new Date(), lastSeen: serverTimestamp ? serverTimestamp() : new Date(), peerId, online:true };
  await setDoc(peerRef, payload, { merge:true });
}

async function touchPeerPresence(){ if(!localState.roomId || !localState.peerId) return; try { await setDoc(doc(db, 'rooms', localState.roomId, 'peers', localState.peerId), { lastSeen: serverTimestamp ? serverTimestamp() : new Date(), online:true }, { merge:true }); } catch(e){ console.warn('touchPeerPresence failed', e); } }
async function removePeerPresence(roomId, peerId){ try { await deleteDoc(doc(db, 'rooms', roomId, 'peers', peerId)); } catch(e){ console.warn('removePeerPresence failed', e); } }
async function sendSignal(roomId, message){ try { const msg = { ...message, ts: serverTimestamp ? serverTimestamp() : Date.now() }; await addDoc(signalsCollectionRef(roomId), msg); } catch(e){ console.error('sendSignal failed', e); } }

/* convenience sendChatMessage remains available but main submit handler uses pre-create + setDoc */
async function sendChatMessage(roomId, name, text){ if(!text || !text.trim()) return null; try { const payload = { name, text, ts: serverTimestamp ? serverTimestamp() : Date.now(), from: localState.peerId || null }; const docRef = await addDoc(messagesCollectionRef(roomId), payload); return docRef && docRef.id ? docRef.id : null; } catch(e){ console.error('sendChatMessage failed', e); return null; } }

/* ======================
   WebRTC helpers, negotiation, etc.
   (KEEP your existing working implementations here)
   For brevity in this paste, include the same makeNewPeerConnection, safeSetRemoteDescription,
   replaceOrAddTrack, createAndSendOffer, handleIncomingOffer/Answer/Ice, etc., from your working code.
   (Important: do not remove the detailed logic you already used.)
   =========================================================================== */

/* ---------- For readability here we include the earlier provided implementations verbatim ---------- */

/* helper queue */
function enqueueCandidateForPeer(peerId, candPayload){ if(!localState.candidateQueue.has(peerId)) localState.candidateQueue.set(peerId, []); localState.candidateQueue.get(peerId).push(candPayload); }
async function drainCandidateQueue(peerId){
  try {
    const queue = localState.candidateQueue.get(peerId) || [];
    if (!queue.length) return;
    const pc = localState.pcMap.get(peerId);
    if (!pc) return;
    const rd = pc.remoteDescription;
    if (!rd || !rd.type) return;
    for (const cand of queue) {
      try { const cobj = cand && cand.candidate ? cand.candidate : cand; if (cobj) await pc.addIceCandidate(new RTCIceCandidate(cobj)); } catch(e){ console.warn('drain addIceCandidate failed', e); }
    }
    localState.candidateQueue.set(peerId, []);
  } catch(e){ console.warn('drainCandidateQueue failed', e); }
}

/* safe setRemoteDescription */
async function safeSetRemoteDescription(pc, desc, retries=6, waitMs=100) {
  for (let i=0;i<retries;i++){
    try { await pc.setRemoteDescription(desc); return; } catch (err) {
      if (err && (err.name === 'InvalidStateError' || String(err).includes('Called in wrong state'))) {
        await new Promise(r=>setTimeout(r, waitMs));
        continue;
      }
      throw err;
    }
  }
  await pc.setRemoteDescription(desc);
}

/* replaceOrAddTrack */
function replaceOrAddTrack(pc, track, stream){
  try {
    const kind = track.kind;
    const senders = pc.getSenders ? pc.getSenders() : [];
    const sender = senders.find(s => s.track && s.track.kind === kind);
    if (sender && typeof sender.replaceTrack === 'function') { sender.replaceTrack(track); return sender; }
    else { return pc.addTrack(track, stream); }
  } catch(e){ try { return pc.addTrack(track, stream); } catch(er){ console.warn('replaceOrAddTrack failed', er); } }
}

/* datachannel handlers - updated to dedupe chat messages received over DC */
function setupDataChannelHandlers(peerId, dc){
  if(!dc) return;
  dc.onopen = ()=> console.log('DC open', peerId);
  dc.onclose = ()=> console.log('DC close', peerId);
  dc.onerror = (e)=> console.warn('DC err', e);
  dc.onmessage = (evt)=> {
    try {
      const data = JSON.parse(evt.data);
      if (data && data.type === 'chat') {
        // build msg id from payload if provided, else stable id
        const incomingTs = data.ts || Date.now();
        const id = data.id ? String(data.id) : stableMsgId(data.from || peerId, data.name || 'Peer', data.text || '', incomingTs);
        if (localState.processedMessageIds && localState.processedMessageIds.has(id)) {
          console.debug('DC chat skipped (processed)', id);
          return;
        }
        appendLogToChat({ id, name: data.name || 'Peer', text: data.text || '', ts: incomingTs, self: false });
        localState.processedMessageIds.add(id);
      } else {
        // not a chat message -> append raw
        appendLogToChat({ id: null, name: peerId, text: evt.data, ts: Date.now(), self:false });
      }
    } catch(e){
      // non-json payload: show raw
      appendLogToChat({ id: null, name: peerId, text: evt.data, ts: Date.now(), self:false });
    }
  };
}

/* makeNewPeerConnection (same as earlier working logic) */
function makeNewPeerConnection(peerId, isOfferer=false) {
  if (localState.pcMap.has(peerId)) return localState.pcMap.get(peerId);
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  const remoteStream = new MediaStream();
  localState.remoteStreams.set(peerId, remoteStream);

  try { if (localState.localStream) localState.localStream.getTracks().forEach(track => { try { replaceOrAddTrack(pc, track, localState.localStream); } catch(e){} }); } catch(e){}
  try { if (localState.screenStream) localState.screenStream.getTracks().forEach(track => { try { replaceOrAddTrack(pc, track, localState.screenStream); } catch(e){} }); } catch(e){}

  pc.addEventListener('track', (evt) => {
    if (evt.streams && evt.streams[0]) { localState.remoteStreams.set(peerId, evt.streams[0]); setRemoteStreamOnTile(peerId, evt.streams[0]); }
    else { const s = localState.remoteStreams.get(peerId) || new MediaStream(); s.addTrack(evt.track); localState.remoteStreams.set(peerId, s); setRemoteStreamOnTile(peerId, s); }
  });

  pc.addEventListener('datachannel', (evt) => { setupDataChannelHandlers(peerId, evt.channel); localState.dcMap.set(peerId, evt.channel); });

  pc.addEventListener('icecandidate', async (evt) => {
    if (!evt.candidate) return;
    try { await sendSignal(localState.roomId, { type:'ice', from: localState.peerId, to: peerId, payload:{ candidate: evt.candidate.toJSON() } }); } catch(e){ console.warn('send ice failed', e); }
  });

  pc.addEventListener('connectionstatechange', () => {
    console.log('pc state', peerId, pc.connectionState);
    if (pc.connectionState === 'connected') {
      const tile = document.querySelector(`#tile-${peerId}`); if (tile) { const v = tile.querySelector('video'); if (v) try{ v.play().catch(()=>{}); } catch(e){} }
    }
  });

  pc.addEventListener('signalingstatechange', () => {
    try { if (pc.remoteDescription && pc.remoteDescription.type) { drainCandidateQueue(peerId).catch(()=>{}); } } catch(e){}
  });

  localState.pcMap.set(peerId, pc);

  if (isOfferer) {
    try { const dc = pc.createDataChannel('p2p-chat'); setupDataChannelHandlers(peerId, dc); localState.dcMap.set(peerId, dc); } catch (e) { console.warn('createDataChannel error', e); }
  }

  return pc;
}

/* polite rule */
function isPoliteWith(remoteId){
  try { if (!localState.peerId || !remoteId) return true; return localState.peerId < remoteId; } catch(e){ return true; }
}

/* createAndSendOffer */
async function createAndSendOffer(roomId, toPeerId){
  setStatus(`Creating offer for ${toPeerId}...`);
  const pc = makeNewPeerConnection(toPeerId, true);
  try {
    if (pc.signalingState && pc.signalingState.includes('have-local-offer')) { console.log('Offer already in-flight to', toPeerId); return; }
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await sendSignal(roomId, { type:'offer', from: localState.peerId, to: toPeerId, payload:{ type: offer.type, sdp: offer.sdp } });
    setStatus(`Offer sent to ${toPeerId}`);
  } catch (e) { console.error('createAndSendOffer failed', e); setStatus('Offer failed'); }
}

/* handleIncomingOffer */
async function handleIncomingOffer(roomId, { from, payload }){
  setStatus(`Received offer from ${from}`);
  const pc = makeNewPeerConnection(from, false);
  const polite = isPoliteWith(from);
  const desc = (typeof payload === 'string' || payload.sdp) ? { type: (payload.type || 'offer'), sdp: (payload.sdp || payload) } : payload;

  try {
    if (pc.signalingState === 'have-local-offer') {
      if (!polite) {
        console.warn('Glare: impolite -> ignoring incoming offer from', from);
        return;
      }
      try {
        await pc.setLocalDescription({ type:'rollback' });
      } catch (rbErr) { console.warn('rollback failed or unsupported', rbErr); }
    }

    await safeSetRemoteDescription(pc, desc);
    await drainCandidateQueue(from);
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    await sendSignal(roomId, { type:'answer', from: localState.peerId, to: from, payload:{ type: answer.type, sdp: answer.sdp } });
    setStatus(`Answer sent to ${from}`);
  } catch (e) {
    console.error('handleIncomingOffer failed', e);
  }
}

/* handleIncomingAnswer */
async function handleIncomingAnswer({ from, payload }){
  const pc = localState.pcMap.get(from);
  if (!pc) return console.warn('No PC for answer', from);
  try {
    const desc = (typeof payload === 'string' || payload.sdp) ? { type: (payload.type || 'answer'), sdp: (payload.sdp || payload) } : payload;
    await safeSetRemoteDescription(pc, desc);
    await drainCandidateQueue(from);
    setStatus(`Received answer from ${from}`);
  } catch (e) { console.error('handleIncomingAnswer failed', e); }
}

/* handleIncomingIce */
async function handleIncomingIce({ from, payload }){
  try {
    const c = payload && payload.candidate ? payload.candidate : payload;
    if (!c) return;
    let pc = localState.pcMap.get(from);
    if (!pc) pc = makeNewPeerConnection(from, false);
    try {
      const rd = pc.remoteDescription;
      if (!rd || !rd.type) { enqueueCandidateForPeer(from, { candidate: c }); return; }
    } catch(e) { enqueueCandidateForPeer(from, { candidate: c }); return; }
    await pc.addIceCandidate(new RTCIceCandidate(c));
  } catch (e) { console.warn('handleIncomingIce failed', e); enqueueCandidateForPeer(from, payload); }
}

/* ======================
   Firestore listeners (signals, peers, messages)
   - Messages listener is idempotent and uses processedMessageIds
   ====================== */
function startListeningToSignals(roomId){
  const q = query(signalsCollectionRef(roomId), orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(async change => {
      if (change.type !== 'added') return;
      const docId = change.doc.id;
      if (localState.processedSignalIds.has(docId)) return;
      localState.processedSignalIds.add(docId);

      const docData = change.doc.data();
      const { type, from, to, payload } = docData;
      if (!type || !from) return;
      if (from === localState.peerId) return;
      if (to && to !== localState.peerId && to !== 'all') return;

      try {
        if (type === 'offer') await handleIncomingOffer(roomId, { from, payload });
        else if (type === 'answer') await handleIncomingAnswer({ from, payload });
        else if (type === 'ice') await handleIncomingIce({ from, payload });
      } catch(e){ console.error('Processing signal failed', e); }
    });
  }, err => console.error('Signals listener error', err));
  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToPeers(roomId){
  const q = query(peersCollectionRef(roomId));
  const unsub = onSnapshot(q, (snapshot) => {
    const nowMs = Date.now();
    snapshot.docs.forEach(docSnap => {
      const data = docSnap.data(); const pid = data.peerId || docSnap.id;
      const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
      const createdAtMs = (data.createdAt && data.createdAt.toMillis) ? data.createdAt.toMillis() : (data.createdAt || nowMs);
      const onlineFlag = data.online === undefined ? true : !!data.online;
      localState.peerMeta.set(pid, { name: data.name || 'Participant', createdAtMs, lastSeenMs, online: onlineFlag });
    });

    snapshot.docChanges().forEach(change => {
      const data = change.doc.data(); const pid = data.peerId || change.doc.id;
      if (change.type === 'added') {
        if (pid === localState.peerId) return;
        const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
        if (Date.now() - lastSeenMs > PRESENCE_TIMEOUT_MS) { console.log('Ignoring stale peer add', pid); return; }
        setStatus(`Peer joined: ${pid}`);
        addRemoteTile(pid, data.name || 'Participant');
        if (!localState.pcMap.has(pid) && localState.peerId && localState.peerId < pid) createAndSendOffer(roomId, pid).catch(e=>console.error(e));
      } else if (change.type === 'removed') {
        setStatus(`Peer left: ${pid}`);
        const pc = localState.pcMap.get(pid); if (pc) { try { pc.close(); } catch(e){} localState.pcMap.delete(pid); }
        localState.remoteStreams.delete(pid); localState.dcMap.delete(pid); localState.peerMeta.delete(pid); removeTile(pid);
      } else if (change.type === 'modified') {
        const tileName = document.querySelector(`#tile-${pid} .name`);
        if (tileName && data.name) tileName.textContent = data.name;
      }
    });

    for (const [pid, meta] of Array.from(localState.peerMeta.entries())) {
      if (pid === localState.peerId) continue;
      const lastSeen = meta.lastSeenMs || meta.lastSeen || 0;
      if ((Date.now() - (lastSeen || Date.now())) > PRESENCE_TIMEOUT_MS) {
        const pc = localState.pcMap.get(pid); if (pc) { try { pc.close(); } catch(e){} localState.pcMap.delete(pid); }
        removeTile(pid); localState.peerMeta.delete(pid); localState.remoteStreams.delete(pid); localState.dcMap.delete(pid);
      }
    }

    updateParticipantsClass();
  }, err => console.error('Peers listener error', err));
  localState.unsubscribers.push(unsub);
  return unsub;
}

function startListeningToMessages(roomId){
  if (!roomId) return;
  if (localState._messagesListening) {
    console.debug('startListeningToMessages: already listening');
    return localState._messagesUnsub || (()=>{});
  }
  localState._messagesListening = true;

  const q = query(messagesCollectionRef(roomId), orderBy('ts'));
  const unsub = onSnapshot(q, (snapshot) => {
    snapshot.docChanges().forEach(change => {
      if (change.type !== 'added') return;
      const docId = change.doc.id;

      if (localState.processedMessageIds && localState.processedMessageIds.has(docId)) {
        // already handled
        // console.debug('Messages listener skipped processed id', docId);
        return;
      }

      // DOM-level guard
      try {
        if (el.chatBox && el.chatBox.querySelector(`[data-msg-id="${String(docId)}"]`)) {
          localState.processedMessageIds.add(docId);
          return;
        }
      } catch(e){ /* ignore selector errors */ }

      const msg = change.doc.data();
      const tsNum = (msg.ts && msg.ts.toMillis) ? msg.ts.toMillis() : (msg.ts || Date.now());
      appendLogToChat({
        id: docId,
        name: msg.name || 'Anon',
        text: msg.text || '',
        ts: tsNum,
        self: msg.from === localState.peerId
      });
      localState.processedMessageIds = localState.processedMessageIds || new Set();
      localState.processedMessageIds.add(docId);
    });
  }, err => console.error('Messages listener error', err));

  localState._messagesUnsub = unsub;
  localState.unsubscribers.push(unsub);
  return unsub;
}

/* ======================
   Cleanup helpers, join/leave, auto name
   ====================== */
async function cleanupRoomIfEmpty(roomId){
  if (!roomId) return;
  try {
    await new Promise(res=>setTimeout(res, 200));
    const peersSnap = await getDocs(peersCollectionRef(roomId));
    if (!peersSnap || peersSnap.empty) {
      setStatus(`Cleaning up empty room ${roomId}`);
      const deletions = [];
      try { const signalsSnap = await getDocs(signalsCollectionRef(roomId)); signalsSnap.forEach(d=> deletions.push(deleteDoc(doc(db, 'rooms', roomId, 'signals', d.id)).catch(()=>{}))); } catch(e){}
      try { const msgsSnap = await getDocs(messagesCollectionRef(roomId)); msgsSnap.forEach(d=> deletions.push(deleteDoc(doc(db, 'rooms', roomId, 'messages', d.id)).catch(()=>{}))); } catch(e){}
      try { const peersSnap2 = await getDocs(peersCollectionRef(roomId)); peersSnap2.forEach(d=> deletions.push(deleteDoc(doc(db, 'rooms', roomId, 'peers', d.id)).catch(()=>{}))); } catch(e){}
      deletions.push(deleteDoc(roomDocRef(roomId)).catch(()=>{}));
      await Promise.all(deletions);
      console.log('Room cleanup complete', roomId);
    } else { console.log('Room not empty  skip cleanup:', roomId, peersSnap.size); }
  } catch(e){ console.warn('cleanupRoomIfEmpty failed', e); }
}

async function pickAutoDisplayName(roomId){
  try {
    const snap = await getDocs(peersCollectionRef(roomId));
    let active=0;
    snap.forEach(docSnap=>{ const d=docSnap.data(); const lastSeenMs = (d.lastSeen && d.lastSeen.toMillis)? d.lastSeen.toMillis() : (d.lastSeen||0); if (Date.now()-lastSeenMs <= PRESENCE_TIMEOUT_MS) active++; });
    return `Participant ${active+1}`;
  } catch(e){ console.warn('pickAutoDisplayName failed', e); return `Participant${Math.floor(Math.random()*1000)}`; }
}

async function joinRoom(roomIdInput){
  if (localState._joined) { setStatus('Already in a room'); return; }
  const roomId = (roomIdInput && String(roomIdInput).trim()) || (window.location.hash ? window.location.hash.replace('#','') : '');
  if (!roomId) { setStatus('Please enter a Room ID before joining'); return; }
  localState.roomId = roomId;
  localState.peerId = genId('p-');

  // reset message dedupe state for fresh join
  localState.processedMessageIds = new Set();
  localState._messagesListening = false;
  localState._messagesUnsub = null;

  const dn = el.displayNameInput && el.displayNameInput.value;
  if (dn && dn.trim()) localState.displayName = dn.trim();
  else { try { const auto = await pickAutoDisplayName(roomId); localState.displayName = auto; if (el.displayNameInput) el.displayNameInput.value = auto; } catch(e){} }

  setStatus(`Joining ${roomId} as ${localState.peerId} (${localState.displayName})`);
  try { const href = new URL(window.location.href); href.hash = roomId; if (el.shareUrl){ el.shareUrl.textContent = href.toString(); el.shareUrl.classList.remove('visually-hidden'); } } catch(e){ if (el.shareUrl) { el.shareUrl.textContent = `${window.location.href}#${roomId}`; el.shareUrl.classList.remove('visually-hidden'); } }

  try { await ensureLocalStream(); } catch(e){ console.warn('No local media available; joining without camera', e); setStatus('Joined (no local media)'); }

  try { await writePeerPresence(roomId, localState.peerId, { name: localState.displayName }); } catch(e){ console.error('Failed to write presence', e); setStatus('Failed to join (Firestore write error)'); return; }

  startListeningToPeers(roomId); startListeningToSignals(roomId); startListeningToMessages(roomId);

  try {
    const peersSnap = await getDocs(peersCollectionRef(roomId));
    peersSnap.forEach(docSnap => {
      const data = docSnap.data(); const pid = data.peerId || docSnap.id;
      if (pid === localState.peerId) return;
      const lastSeenMs = (data.lastSeen && data.lastSeen.toMillis) ? data.lastSeen.toMillis() : (data.lastSeen || 0);
      if (Date.now() - lastSeenMs <= PRESENCE_TIMEOUT_MS) {
        if (!localState.pcMap.has(pid) && localState.peerId && localState.peerId < pid) createAndSendOffer(roomId, pid).catch(e=>console.error(e));
      }
    });
  } catch(e){ console.warn('Pre-offer check failed', e); }

  localState._joined = true;
  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = false;
  if (el.createRoomBtn) el.createRoomBtn.disabled = true;
  setStatus(`Joined ${roomId}`);

  startPresenceHeartbeat(); startVideoStatePolling();

  if (localState._autoJoinedFromHash && el.roomControlsSection) {
    try { el.roomControlsSection.style.display = 'none'; const b = ensureShowControlsButton(); b.style.display = 'inline-block'; } catch(e){}
    if (localState._removeHashAfterAutoJoin) try { history.replaceState(null, '', location.pathname + location.search); } catch(e){}
  }
}

async function leaveRoom(){
  if (!localState._joined) { setStatus('Not in a room'); return; }
  const roomId = localState.roomId; setStatus('Leaving room...');
  for (const [peerId, pc] of localState.pcMap.entries()) { try { pc.close(); } catch(e){} }
  localState.pcMap.clear(); localState.dcMap.clear();
  stopPresenceHeartbeat(); stopVideoStatePolling();
  if (roomId && localState.peerId) {
    try { await setDoc(doc(db, 'rooms', roomId, 'peers', localState.peerId), { online:false, lastSeen: serverTimestamp ? serverTimestamp() : new Date() }, { merge:true }); } catch(e){ console.warn('mark offline failed', e); }
    try { await removePeerPresence(roomId, localState.peerId); } catch(e){ console.warn('remove presence failed', e); }
    try { await cleanupRoomIfEmpty(roomId); } catch(e){ console.warn('cleanup attempt failed', e); }
  }

  // Unsubscribe messages listener & reset dedupe
  try {
    if (localState._messagesUnsub) { try { localState._messagesUnsub(); } catch(e){} localState._messagesUnsub = null; }
    localState._messagesListening = false;
    localState.processedMessageIds = new Set();
  } catch(e){}

  localState.unsubscribers.forEach(unsub => { try { unsub(); } catch(e){} });
  localState.unsubscribers = [];
  if (el.videos) { const tiles = Array.from(el.videos.querySelectorAll('.vid')); tiles.forEach(t=>t.remove()); }
  if (localState.localStream) { localState.localStream.getTracks().forEach(t=>t.stop()); localState.localStream = null; }
  if (localState.screenStream) { localState.screenStream.getTracks().forEach(t=>t.stop()); localState.screenStream = null; }
  localState.roomId = null; localState.peerId = null; localState.remoteStreams.clear(); localState.peerMeta.clear(); localState._joined=false;
  if (el.leaveRoomBtn) el.leaveRoomBtn.disabled = true; if (el.createRoomBtn) el.createRoomBtn.disabled = false;
  setStatus('Left room');
  if (localState._autoJoinedFromHash && el.roomControlsSection) {
    try { el.roomControlsSection.style.display = ''; localState._autoJoinedFromHash = false; const btn = $('#showControlsBtn'); if (btn) btn.style.display = 'none'; } catch(e){}
  }
  scheduleLayout();
}

/* cleanup on unload */
async function tryCleanupOnUnload(){
  stopVideoStatePolling(); stopPresenceHeartbeat();
  try {
    if (localState.roomId && localState.peerId) {
      try { await setDoc(doc(db, 'rooms', localState.roomId, 'peers', localState.peerId), { online:false, lastSeen: serverTimestamp ? serverTimestamp() : new Date() }, { merge:true }); } catch(e){ console.warn('presence set failed on unload', e); }
      try { await removePeerPresence(localState.roomId, localState.peerId); } catch(e){ console.warn('removePeerPresence failed on unload', e); }
      try { await cleanupRoomIfEmpty(localState.roomId); } catch(e){ console.warn('cleanup on unload failed', e); }
    }
  } catch(err){ console.warn('tryCleanupOnUnload error', err); }
  if (localState.localStream) localState.localStream.getTracks().forEach(t=>t.stop());
  if (localState.screenStream) localState.screenStream.getTracks().forEach(t=>t.stop());
  // reset messages listener flags
  try { if (localState._messagesUnsub) { localState._messagesUnsub(); localState._messagesUnsub = null; } localState._messagesListening = false; } catch(e){}
}
window.addEventListener('beforeunload', ()=> tryCleanupOnUnload());
window.addEventListener('pagehide', (ev)=> { if (!ev.persisted) tryCleanupOnUnload(); });

/* presence heartbeat */
function startPresenceHeartbeat(){ if(localState._presenceHeartbeatInterval) return; touchPeerPresence().catch(()=>{}); localState._presenceHeartbeatInterval = setInterval(()=>{ touchPeerPresence().catch(()=>{}); }, PRESENCE_HEARTBEAT_MS); }
function stopPresenceHeartbeat(){ if(localState._presenceHeartbeatInterval){ clearInterval(localState._presenceHeartbeatInterval); localState._presenceHeartbeatInterval=null; } }

/* screen share (unchanged) */
async function startScreenShare(){
  if (!navigator.mediaDevices.getDisplayMedia) { setStatus('Screen share not supported'); return; }
  try {
    const screenStream = await navigator.mediaDevices.getDisplayMedia({ video:true, audio:false });
    localState.screenStream = screenStream; const screenTileId = `screen-${localState.peerId || 'local'}`; addRemoteTile(screenTileId, `${localState.displayName} (screen)`);
    const videoEl = document.querySelector(`#tile-${screenTileId} video`); if (videoEl) videoEl.srcObject = screenStream;
    for (const [peerId, pc] of localState.pcMap.entries()) {
      const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
      if (senders.length > 0) { try { await senders[0].replaceTrack(screenStream.getVideoTracks()[0]); } catch(e){ try { pc.addTrack(screenStream.getVideoTracks()[0], screenStream); } catch(e){} } }
      else { try { pc.addTrack(screenStream.getVideoTracks()[0], screenStream); } catch(e){} }
    }
    screenStream.getVideoTracks()[0].addEventListener('ended', async () => {
      removeTile(screenTileId);
      if (localState.localStream && localState.localStream.getVideoTracks().length > 0) {
        for (const [peerId, pc] of localState.pcMap.entries()) {
          const senders = pc.getSenders().filter(s => s.track && s.track.kind === 'video');
          if (senders.length > 0) { try { await senders[0].replaceTrack(localState.localStream.getVideoTracks()[0]); } catch(e){ console.warn(e); } }
        }
      }
      localState.screenStream = null;
    });
    setStatus('You are sharing your screen');
  } catch(e){ console.error('startScreenShare failed', e); setStatus('Failed to share screen'); }
}

/* chat wiring - PRE-CREATE docRef id, mark processed BEFORE setDoc, DOM-level dedupe */
if (el.chatForm) {
  el.chatForm.addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const text = (el.chatInput.value || '').trim();
    if (!text) return;
    if (!localState.roomId) { setStatus('Not in a room  chat not sent'); return; }

    try {
      const collRef = messagesCollectionRef(localState.roomId);
      const newDocRef = doc(collRef); // client-side docRef with id
      const docId = newDocRef.id;

      // mark processed BEFORE writing
      localState.processedMessageIds = localState.processedMessageIds || new Set();
      localState.processedMessageIds.add(docId);

      // local echo (tagged with docId)
      appendLogToChat({ id: docId, name: localState.displayName || 'Me', text, ts: Date.now(), self: true });

      // write to Firestore
      const payload = { name: localState.displayName || 'Me', text, ts: serverTimestamp ? serverTimestamp() : Date.now(), from: localState.peerId || null };
      await setDoc(newDocRef, payload);

      // Optionally, also broadcast via data channels if you want fast P2P chat echo (not required)
      // for (const [pid, dc] of localState.dcMap.entries()) {
      //   try { if (dc && dc.readyState === 'open') dc.send(JSON.stringify({ type:'chat', id: docId, name: localState.displayName, text, ts: Date.now(), from: localState.peerId })); } catch(e){}
      // }

    } catch (e) {
      console.error('Chat send failed', e);
      appendLogToChat({ name: localState.displayName || 'Me', text, ts: Date.now(), self: true });
    }

    el.chatInput.value = '';
  });
  if (el.sendChatBtn) el.sendChatBtn.addEventListener('click', () => el.chatForm.dispatchEvent(new Event('submit', { cancelable: true })));
}

/* controls wiring (unchanged) */
if (el.createRoomBtn) el.createRoomBtn.addEventListener('click', () => joinRoom(el.roomIdInput.value.trim()).catch(console.error));
if (el.leaveRoomBtn) el.leaveRoomBtn.addEventListener('click', () => leaveRoom().catch(console.error));
if (el.toggleMicBtn) el.toggleMicBtn.addEventListener('click', () => { if(!localState.localStream) return; const enabled = localState.localStream.getAudioTracks().some(t=>t.enabled); setMicEnabled(!enabled); });
if (el.toggleCamBtn) el.toggleCamBtn.addEventListener('click', () => { if(!localState.localStream) return; const enabled = localState.localStream.getVideoTracks().some(t=>t.enabled); setCamEnabled(!enabled); });
if (el.shareScreenBtn) el.shareScreenBtn.addEventListener('click', () => startScreenShare().catch(console.error));
if (el.displayNameInput) el.displayNameInput.addEventListener('change', async () => {
  const nm = el.displayNameInput.value.trim() || 'Guest'; localState.displayName = nm; if (localState.roomId && localState.peerId) try { await writePeerPresence(localState.roomId, localState.peerId, { name: nm }); } catch(e){ console.warn(e); }
});

/* initial preview */
(async function tryInitPreview(){ try { if (!localState.localStream) { await ensureLocalStream({ audio:true, video:{ width:640, height:360 } }); setMicEnabled(true); setCamEnabled(true); } } catch(e){ console.debug('Initial preview unavailable', e); } })();

/* layout helpers (unchanged) */
function fitVideosToViewport(){ try{ const header=document.querySelector('.site-header'); const roomControls=document.querySelector('#room-controls'); const controls=document.querySelector('#video-section .controls')||document.querySelector('.controls'); const footer=document.querySelector('.site-footer'); const top = header?header.getBoundingClientRect().height:0; const roomH = roomControls?roomControls.getBoundingClientRect().height:0; const controlsH=controls?controls.getBoundingClientRect().height:0; const footerH=footer?footer.getBoundingClientRect().height:0; const extras=32; const vh=window.innerHeight; const available = Math.max(160, Math.floor(vh - (top + roomH + controlsH + footerH + extras))); document.documentElement.style.setProperty('--videos-max-h', `${available}px`); const videosEl = document.querySelector('.videos'); if (videosEl) videosEl.style.overflowY = (available < 260) ? 'auto' : 'hidden'; } catch(e){ console.warn('fitVideosToViewport error', e); } }
function layoutVideoGrid(){ try { const videosEl=document.querySelector('.videos'); if(!videosEl) return; const tiles=Array.from(videosEl.querySelectorAll('.vid')); const N=Math.max(tiles.length,1); let cssMaxH=getComputedStyle(document.documentElement).getPropertyValue('--videos-max-h')||''; cssMaxH=cssMaxH.trim().replace('px',''); let availableHeight=parseInt(cssMaxH,10); if(!availableHeight||Number.isNaN(availableHeight)){ const header=document.querySelector('.site-header'); const roomControls=document.querySelector('#room-controls'); const controls=document.querySelector('#video-section .controls')||document.querySelector('.controls'); const footer=document.querySelector('.site-footer'); const top=header?header.getBoundingClientRect().height:0; const roomH=roomControls?roomControls.getBoundingClientRect().height:0; const controlsH=controls?controls.getBoundingClientRect().height:0; const footerH=footer?footer.getBoundingClientRect().height:0; const extras=32; availableHeight=Math.max(160,Math.floor(window.innerHeight - (top + roomH + controlsH + footerH + extras))); } const containerRect=videosEl.getBoundingClientRect(); let containerWidth=(containerRect && containerRect.width && containerRect.width>0)?containerRect.width:(window.innerWidth - (document.querySelector('.sidebar')?document.querySelector('.sidebar').getBoundingClientRect().width:0)-40); if(!containerWidth || Number.isNaN(containerWidth) || containerWidth<=0) containerWidth = Math.max(window.innerWidth * 0.6, 320); const aspectRatio = 16/9; const gap = parseFloat(getComputedStyle(videosEl).gap || 12) || 12; const minTileH = 100; const maxCols = Math.min(N, Math.max(1, Math.floor(containerWidth/160))); let best = { cols:1, rows:N, tileWidth:containerWidth, tileHeight:Math.max(minTileH, Math.floor(containerWidth/aspectRatio)), totalHeight: Math.ceil(N) * Math.floor(containerWidth/aspectRatio), fits:false, overflow:Infinity }; for(let cols=1; cols<=maxCols; cols++){ const tileW=(containerWidth - (cols -1)*gap)/cols; const tileH = tileW / aspectRatio; const rows = Math.ceil(N/cols); const totalH = rows * tileH + (rows -1)*gap; const overflow = Math.max(0, totalH - availableHeight); const fits = totalH <= availableHeight; if(fits){ if(!best.fits || tileH > best.tileHeight) best = { cols, rows, tileWidth:tileW, tileHeight:tileH, totalHeight, fits, overflow }; } else { if(!best.fits){ if(overflow < best.overflow || (Math.abs(overflow - best.overflow) < 1 && tileH > best.tileHeight)) best = { cols, rows, tileWidth:tileW, tileHeight:tileH, totalHeight, fits:false, overflow }; } } } const tileHpx = Math.max(minTileH, Math.floor(best.tileHeight || 180)); const colsToUse = best.cols || 1; const rowsToUse = best.rows || Math.ceil(N/colsToUse); videosEl.style.gridTemplateColumns = `repeat(${colsToUse}, 1fr)`; videosEl.style.setProperty('--tile-height', `${tileHpx}px`); videosEl.style.setProperty('--videos-max-h', `${availableHeight}px`); tiles.forEach(t=>{ try{ t.style.height = `${tileHpx}px`; } catch(e){} }); videosEl.style.overflowY = best.fits ? 'hidden' : 'auto'; const statusEl = document.querySelector('#status'); if(statusEl) statusEl.textContent = `Tiles: ${N} • grid ${colsToUse}×${rowsToUse} • ${best.fits ? 'fit' : 'scroll'}`; } catch(e){ console.warn('layoutVideoGrid error', e); } }

/* visibility rules & polling (unchanged) */
function applyVisibilityRules(maxVisible = MAX_VISIBLE_TILES){ try { const videosEl=document.querySelector('.videos'); if(!videosEl) return; const tiles=Array.from(videosEl.querySelectorAll('.vid')); const total=tiles.length; if(total <= maxVisible){ tiles.forEach(t=>{ t.classList.remove('hidden-by-limit'); t.style.display=''; t.setAttribute('aria-hidden','false'); }); setStatus(`${total} participants`); layoutVideoGrid(); return; } const infos = tiles.map(t=>{ const peer = t.dataset.peer || t.id || ''; const isLocal = t.classList.contains('local') || peer === localState.peerId; const hasVideo = (t.dataset._hasvideo === 'true'); const meta = localState.peerMeta.get(peer) || {}; const createdAtMs = meta.createdAtMs || 0; return { tileEl:t, peer, isLocal, hasVideo, createdAtMs }; }); infos.sort((a,b)=>{ if(a.isLocal && !b.isLocal) return -1; if(!a.isLocal && b.isLocal) return 1; if(a.hasVideo && !b.hasVideo) return -1; if(!a.hasVideo && b.hasVideo) return 1; return (a.createdAtMs || 0) - (b.createdAtMs || 0); }); const visible = infos.slice(0, maxVisible); const visiblePeers = new Set(visible.map(i=>i.peer)); infos.forEach(info=>{ const tile=info.tileEl; if(visiblePeers.has(info.peer)){ tile.classList.remove('hidden-by-limit'); tile.style.display=''; tile.setAttribute('aria-hidden','false'); } else { tile.classList.add('hidden-by-limit'); tile.style.display='none'; tile.setAttribute('aria-hidden','true'); } }); const hiddenCount = total - visiblePeers.size; setStatus(`${total} participants • ${hiddenCount} hidden`); layoutVideoGrid(); } catch(e){ console.warn('applyVisibilityRules err', e); } }
function detectVideoStateAndApply(maxVisible = MAX_VISIBLE_TILES){ try { const videosEl=document.querySelector('.videos'); if(!videosEl) return; const tiles=Array.from(videosEl.querySelectorAll('.vid')); let changed=false; for(const t of tiles){ const videoEl = t.querySelector('video'); let hasVideo=false; try { if(videoEl && videoEl.srcObject){ const vtracks = (videoEl.srcObject.getVideoTracks && videoEl.srcObject.getVideoTracks()) || []; hasVideo = vtracks.some(tr=>tr && tr.enabled !== false && (tr.readyState !== 'ended')); } } catch(e){ hasVideo=false; } const prev = t.dataset._hasvideo === 'true'; if (prev !== hasVideo) { t.dataset._hasvideo = hasVideo ? 'true' : 'false'; changed = true; } } if (changed) applyVisibilityRules(maxVisible); } catch(e){ console.warn('detectVideoStateAndApply err', e); } }
function startVideoStatePolling(){ if (localState._videoDetectInterval) return; localState._videoDetectInterval = setInterval(()=> detectVideoStateAndApply(MAX_VISIBLE_TILES), VIDEO_POLL_INTERVAL_MS); }
function stopVideoStatePolling(){ if(localState._videoDetectInterval){ clearInterval(localState._videoDetectInterval); localState._videoDetectInterval=null; } }

/* shortcuts */
window.addEventListener('keydown',(ev)=>{ if((ev.ctrlKey||ev.metaKey) && ev.key==='m'){ ev.preventDefault(); if(localState.localStream) setMicEnabled(!localState.localStream.getAudioTracks().some(t=>t.enabled)); } if((ev.ctrlKey||ev.metaKey) && ev.key==='e'){ ev.preventDefault(); if(localState.localStream) setCamEnabled(!localState.localStream.getVideoTracks().some(t=>t.enabled)); } });

/* auto-join from hash */
function tryAutoJoinFromHash(){ try{ const raw = window.location.hash ? window.location.hash.replace('#','').trim() : ''; if(!raw) return; if(el.roomIdInput) el.roomIdInput.value = raw; localState._autoJoinedFromHash = true; setTimeout(()=>{ joinRoom(raw).then(()=>{ console.log('Auto-joined room', raw); }).catch(err=>{ console.error('Auto-join failed', err); localState._autoJoinedFromHash = false; if(el.roomControlsSection) el.roomControlsSection.style.display = ''; }); }, 300); } catch(e){ console.warn('tryAutoJoinFromHash error', e); } }
window.addEventListener('load', ()=> setTimeout(()=> tryAutoJoinFromHash(), 300));

/* helpers */
function genId(pref){ return pref + Math.random().toString(36).slice(2,9); }
function ensureShowControlsButton(){ let b = $('#showControlsBtn'); if (b) return b; b = document.createElement('button'); b.id='showControlsBtn'; b.textContent='Show room controls'; b.style.position='fixed'; b.style.bottom='12px'; b.style.left='12px'; b.style.zIndex='9999'; b.style.padding='8px 12px'; b.style.borderRadius='8px'; b.addEventListener('click', ()=>{ if(el.roomControlsSection) el.roomControlsSection.style.display=''; b.style.display='none'; }); document.body.appendChild(b); return b; }

/* expose debug */
window._pakelmeet = { localState, joinRoom, leaveRoom, setStatus, sendChatMessage, applyVisibilityRules, layoutVideoGrid, ensureLocalStream, updateLocalTracksOnAllPCs: async ()=> { for(const [peerId,pc] of localState.pcMap.entries()){ try{ if(localState.localStream) localState.localStream.getTracks().forEach(track=> replaceOrAddTrack(pc, track, localState.localStream)); if(localState.screenStream) localState.screenStream.getTracks().forEach(track=> replaceOrAddTrack(pc, track, localState.screenStream)); } catch(e){ console.warn('updateLocalTracksOnAllPCs', e); } } }, processedSignalIds: localState.processedSignalIds, processedMessageIds: localState.processedMessageIds };

/* =========================
   Fullscreen on double-tap / double-click
   - Attach handlers to each .vid tile
   - Use native Fullscreen API if possible, fallback to .vid.fullscreen CSS class
   ========================= */

(function enableTileDoubleTapFullscreen() {
  const DOUBLE_TAP_MS = 300;   // max delay between taps
  const MAX_MOVE_PX = 24;      // max allowed move to still count as a tap
  const attachedFlag = 'data-fs-attached';

  function isInteractiveTarget(el) {
    if (!el) return false;
    const interactiveTags = ['BUTTON', 'A', 'INPUT', 'SELECT', 'TEXTAREA'];
    if (interactiveTags.includes(el.tagName)) return true;
    if (el.closest && el.closest('.tile-controls')) return true; // keep clicks on control buttons safe
    return false;
  }

  function removeAnyFullscreenTile() {
    const prev = document.querySelector('.vid.fullscreen');
    if (prev) {
      prev.classList.remove('fullscreen');
      // revert body overflow if we blocked it
      try { document.body.style.overflow = ''; } catch (e) {}
    }
  }

  async function enterNativeFullscreen(el) {
    try {
      if (el.requestFullscreen) {
        await el.requestFullscreen();
        return true;
      }
      // vendor prefixes (older browsers)
      if (el.webkitRequestFullscreen) { el.webkitRequestFullscreen(); return true; }
      if (el.mozRequestFullScreen) { el.mozRequestFullScreen(); return true; }
      if (el.msRequestFullscreen) { el.msRequestFullscreen(); return true; }
    } catch (e) {
      console.warn('requestFullscreen failed', e);
    }
    return false;
  }

  async function exitNativeFullscreen() {
    try {
      if (document.exitFullscreen) { await document.exitFullscreen(); return true; }
      if (document.webkitExitFullscreen) { document.webkitExitFullscreen(); return true; }
      if (document.mozCancelFullScreen) { document.mozCancelFullScreen(); return true; }
      if (document.msExitFullscreen) { document.msExitFullscreen(); return true; }
    } catch (e) {
      console.warn('exitFullscreen failed', e);
    }
    return false;
  }

  async function toggleTileFullscreen(tile) {
    if (!tile) return;
    const currentlyNative = !!(document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement);
    const isFullscreenClass = tile.classList.contains('fullscreen');

    // If already native fullscreen but for a different element, exit first
    if (currentlyNative) {
      // If the native fullscreen element is the tile (or inside it), just exit
      const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
      if (fsEl && tile.contains(fsEl)) {
        await exitNativeFullscreen();
        // native fullscreenchange handler will remove/add classes as needed
        return;
      }
      // otherwise exit native and then enter this one
      await exitNativeFullscreen();
      removeAnyFullscreenTile();
    }

    // If this tile is currently using CSS-fullscreen class -> exit
    if (isFullscreenClass) {
      tile.classList.remove('fullscreen');
      try { document.body.style.overflow = ''; } catch(e){}
      return;
    }

    // Otherwise: enter fullscreen - first try native, fallback to CSS class
    removeAnyFullscreenTile();

    const usedNative = await enterNativeFullscreen(tile).catch(()=>false);
    if (usedNative) {
      // add class for consistent styling + in case CSS relies on it
      tile.classList.add('fullscreen');
      try { document.body.style.overflow = 'hidden'; } catch(e){}
      return;
    }

    // fallback: just add class and lock background scroll
    tile.classList.add('fullscreen');
    try { document.body.style.overflow = 'hidden'; } catch(e){}
  }

  // sync classes when native fullscreen changes (e.g., user pressed ESC)
  function onNativeFullscreenChange() {
    const fsEl = document.fullscreenElement || document.webkitFullscreenElement || document.mozFullScreenElement || document.msFullscreenElement;
    // remove existing class from any tile not equal to fsEl
    document.querySelectorAll('.vid.fullscreen').forEach(t => {
      if (!fsEl || !t.contains(fsEl)) {
        t.classList.remove('fullscreen');
      }
    });
    // If fsEl is inside a .vid, ensure that .vid has class
    if (fsEl) {
      const tile = fsEl.closest ? fsEl.closest('.vid') : null;
      if (tile) tile.classList.add('fullscreen');
    } else {
      // no native fullscreen -> restore body overflow
      try { document.body.style.overflow = ''; } catch(e){}
    }
  }

  document.addEventListener('fullscreenchange', onNativeFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onNativeFullscreenChange);
  document.addEventListener('mozfullscreenchange', onNativeFullscreenChange);
  document.addEventListener('MSFullscreenChange', onNativeFullscreenChange);

  // attach handlers to a tile element
  function attachFullscreenHandlers(tile) {
    if (!tile || tile.getAttribute(attachedFlag) === '1') return;
    tile.setAttribute(attachedFlag, '1');

    // --- desktop double-click ---
    tile.addEventListener('dblclick', (ev) => {
      if (isInteractiveTarget(ev.target)) return;
      ev.preventDefault && ev.preventDefault();
      toggleTileFullscreen(tile).catch(console.warn);
    });

    // --- touch double-tap detection ---
    let lastTapTime = 0;
    let lastTouchX = 0;
    let lastTouchY = 0;
    let touchMoved = false;

    tile.addEventListener('touchstart', (ev) => {
      const t = ev.changedTouches && ev.changedTouches[0];
      if (t) {
        lastTouchX = t.clientX;
        lastTouchY = t.clientY;
        touchMoved = false;
      }
    }, { passive: true });

    tile.addEventListener('touchmove', (ev) => {
      touchMoved = true;
    }, { passive: true });

    tile.addEventListener('touchend', (ev) => {
      // ignore if tap landed on interactive control
      if (isInteractiveTarget(ev.target)) {
        lastTapTime = 0; // reset so control taps don't count
        return;
      }

      const t = ev.changedTouches && ev.changedTouches[0];
      const now = Date.now();
      let isDouble = false;
      if (t && !touchMoved) {
        const dx = Math.abs(t.clientX - lastTouchX);
        const dy = Math.abs(t.clientY - lastTouchY);
        if (dx <= MAX_MOVE_PX && dy <= MAX_MOVE_PX) {
          if (now - lastTapTime <= DOUBLE_TAP_MS) isDouble = true;
        }
      }

      if (isDouble) {
        // prevent zoom/double-tap native behavior if possible
        ev.preventDefault && ev.preventDefault();
        toggleTileFullscreen(tile).catch(console.warn);
        lastTapTime = 0;
      } else {
        lastTapTime = now;
      }
    }, { passive: false });

    // keyboard: ESC to exit (if tile has focus)
    tile.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape' || ev.key === 'Esc') {
        if (tile.classList.contains('fullscreen')) {
          // prefer to exit native fullscreen if active
          exitNativeFullscreen().catch(()=>{ tile.classList.remove('fullscreen'); try{ document.body.style.overflow=''; }catch(e){} });
        }
      }
    });
  }

  // expose helper so createLocalTile/addRemoteTile can call it when creating tiles
  window._pakelmeet = window._pakelmeet || {};
  window._pakelmeet.attachFullscreenHandlers = attachFullscreenHandlers;

  // Attach to existing tiles (if any)
  document.querySelectorAll('.vid').forEach(t => {
    try { attachFullscreenHandlers(t); } catch(e){}
  });

  // If any tiles were queued before this module loaded, attach them now
  try {
    if (window._pakelmeet && Array.isArray(window._pakelmeet._pendingAttach) && window._pakelmeet._pendingAttach.length) {
      window._pakelmeet._pendingAttach.forEach(t => {
        try { attachFullscreenHandlers(t); } catch(e){}
      });
      window._pakelmeet._pendingAttach = [];
    }
  } catch (e) { /* ignore */ }

})();
/* End of file */
  