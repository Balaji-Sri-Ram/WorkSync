
const socket = io();

// WebRTC config – STUN only; add TURN for production
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ── State ──────────────────────────────────────
let mySocketId    = null;
let myUsername    = '';
let peerConnection = null;
let localStream   = null;
let remoteStream  = null;
let currentCallType = 'voice'; // 'voice' | 'video'
let callState     = 'idle';    // idle | calling | incoming | connecting | connected
let callPartner   = null;      // { id, name }
let ringTimeout   = null;
let audioMuted    = false;
let videoOff      = false;
let selectedUser  = null;      // currently selected user in sidebar { id, name }

// Avatar color cycles
const AVATAR_COLORS = 8;
const userColorMap  = {};

// ── DOM Elements ──────────────────────────────
const usernameInput   = document.getElementById('username-input');
const registerBtn     = document.getElementById('register-btn');
const usersList       = document.getElementById('users-list');
const onlineCount     = document.getElementById('online-count');
const idleView        = document.getElementById('idle-view');
const activeChat      = document.getElementById('active-chat');
const chatPartnerName = document.getElementById('chat-partner-name');
const chatPartnerAvatar = document.getElementById('chat-partner-avatar');
const voiceCallBtn    = document.getElementById('voice-call-btn');
const videoCallBtn    = document.getElementById('video-call-btn');
const videoContainer  = document.getElementById('video-container');
const localVideo      = document.getElementById('local-video');
const remoteVideo     = document.getElementById('remote-video');
const callControls    = document.getElementById('call-controls');
const muteBtn         = document.getElementById('mute-btn');
const cameraBtn       = document.getElementById('camera-btn');
const endBtn          = document.getElementById('end-btn');
const statusDisplay   = document.getElementById('status-display');
const incomingModal   = document.getElementById('incoming-modal');
const incomingTitle   = document.getElementById('incoming-title');
const incomingCaller  = document.getElementById('incoming-caller');
const acceptBtn       = document.getElementById('accept-btn');
const rejectBtn       = document.getElementById('reject-btn');
const modalAvatar     = document.getElementById('modal-avatar');

// ── Helpers ────────────────────────────────────

function getAvatarColor(userId) {
  if (!(userId in userColorMap)) {
    userColorMap[userId] = Object.keys(userColorMap).length % AVATAR_COLORS;
  }
  return userColorMap[userId];
}

function firstLetter(name) {
  return (name || '?').charAt(0).toUpperCase();
}

function applyAvatar(el, name, userId) {
  el.textContent = firstLetter(name);
  el.setAttribute('data-color', getAvatarColor(userId));
}

// ── Status Toast ───────────────────────────────

let statusTimer = null;

function showStatus(msg, duration = 3500) {
  statusDisplay.textContent = msg;
  statusDisplay.classList.remove('hidden');
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = setTimeout(() => {
    statusDisplay.classList.add('hidden');
  }, duration);
}

function setStatus(msg) {
  showStatus(msg);
}

// ── Registration ───────────────────────────────

registerBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) { showStatus('Please enter your name.'); return; }
  myUsername = name;
  socket.emit('register', name);
  registerBtn.disabled = true;
  usernameInput.disabled = true;
  registerBtn.textContent = 'Joined ✔';
  showStatus(`Welcome, ${name}!`);
});

// ── Socket connect ─────────────────────────────

socket.on('connect', () => {
  mySocketId = socket.id;
});

// ── Users List ─────────────────────────────────

socket.on('users-update', (users) => {
  const others = users.filter(u => u.id !== socket.id);
  onlineCount.textContent = others.length;
  usersList.innerHTML = '';

  others.forEach((user) => {
    const li = document.createElement('li');
    li.dataset.id   = user.id;
    li.dataset.name = user.name;

    // Avatar
    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    applyAvatar(avatar, user.name, user.id);

    // Info
    const info = document.createElement('div');
    info.innerHTML = `
      <div class="user-name">${user.name}</div>
      <div class="user-status">● Online</div>`;

    li.appendChild(avatar);
    li.appendChild(info);

    // Highlight if already selected
    if (selectedUser && selectedUser.id === user.id) {
      li.classList.add('active');
    }

    li.addEventListener('click', () => selectUser(user.id, user.name));
    usersList.appendChild(li);
  });
});

// ── Select / Open Chat ─────────────────────────

function selectUser(id, name) {
  selectedUser = { id, name };

  // Highlight in sidebar
  document.querySelectorAll('#users-list li').forEach(li => {
    li.classList.toggle('active', li.dataset.id === id);
  });

  // Update chat header
  chatPartnerName.textContent = name;
  applyAvatar(chatPartnerAvatar, name, id);

  // Switch views
  idleView.classList.add('hidden');
  activeChat.classList.remove('hidden');
}

// ── Call via top-right icons ───────────────────

voiceCallBtn.addEventListener('click', () => {
  if (!selectedUser) return;
  if (!myUsername) { showStatus('Please register first.'); return; }
  if (callState !== 'idle') { showStatus('You are already in a call.'); return; }
  startCall(selectedUser.id, selectedUser.name, 'voice');
});

videoCallBtn.addEventListener('click', () => {
  if (!selectedUser) return;
  if (!myUsername) { showStatus('Please register first.'); return; }
  if (callState !== 'idle') { showStatus('You are already in a call.'); return; }
  startCall(selectedUser.id, selectedUser.name, 'video');
});

// ── Call UI helpers ────────────────────────────

function showCallUI(type) {
  videoContainer.classList.remove('hidden');
  callControls.classList.remove('hidden');
  // Camera button only for video
  cameraBtn.style.display = type === 'video' ? 'flex' : 'none';
}

function hideCallUI() {
  videoContainer.classList.add('hidden');
  callControls.classList.add('hidden');
}

function showIncomingModal(callerName, callerId, type) {
  const emoji = type === 'video' ? '📹' : '📞';
  incomingTitle.textContent = `${emoji} Incoming ${type === 'video' ? 'Video' : 'Voice'} Call`;
  incomingCaller.textContent = `From: ${callerName}`;
  applyAvatar(modalAvatar, callerName, callerId);
  incomingModal.classList.remove('hidden');
}

function hideIncomingModal() {
  incomingModal.classList.add('hidden');
}

// ── WebRTC Helpers ─────────────────────────────

function createPeerConnection() {
  if (peerConnection) peerConnection.close();
  peerConnection = new RTCPeerConnection(rtcConfig);

  peerConnection.onicecandidate = (event) => {
    if (event.candidate && callPartner) {
      socket.emit('ice-candidate', {
        to: callPartner.id,
        candidate: event.candidate
      });
    }
  };

  peerConnection.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);
  };

  peerConnection.oniceconnectionstatechange = () => {
    const s = peerConnection.iceConnectionState;
    if (s === 'disconnected' || s === 'failed' || s === 'closed') {
      handleCallEnd('Connection lost.');
    }
  };

  return peerConnection;
}

async function getLocalStream(type) {
  try {
    const constraints = { audio: true, video: type === 'video' };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    let msg = 'Could not access media devices.';
    if (err.name === 'NotAllowedError') {
      msg = type === 'video'
        ? '❌ Camera & mic permission required.'
        : '❌ Microphone permission required.';
    } else if (err.name === 'NotFoundError') {
      msg = '❌ Camera or microphone not found.';
    } else if (err.name === 'NotReadableError') {
      msg = '❌ Device already in use by another app.';
    }
    setStatus(msg);
    throw err;
  }
}

function addTracksToPC(stream) {
  stream.getTracks().forEach(track => peerConnection.addTrack(track, stream));
}

// ── Outgoing Call ──────────────────────────────

async function startCall(targetId, targetName, type) {
  callPartner = { id: targetId, name: targetName };
  currentCallType = type;
  callState = 'calling';
  setStatus(`Calling ${targetName}…`);
  showCallUI(type);
  document.getElementById('remote-name').textContent = targetName;

  try {
    await getLocalStream(type);
  } catch { resetCallState(); return; }

  createPeerConnection();
  addTracksToPC(localStream);

  try {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);

    socket.emit('call-user', {
      userToCall: targetId,
      signalData: offer,
      type
    });

    // 30-second ring timeout
    ringTimeout = setTimeout(() => {
      if (callState === 'calling') {
        setStatus('⏱ No answer. Call timed out.');
        socket.emit('end-call', { to: targetId });
        resetCallState();
      }
    }, 30000);

  } catch (err) {
    console.error('Offer error:', err);
    resetCallState();
  }
}

// ── Incoming Call ──────────────────────────────

let pendingSignal = null;

socket.on('incoming-call', (data) => {
  if (callState !== 'idle') {
    socket.emit('reject-call', { to: data.from });
    return;
  }
  callState = 'incoming';
  callPartner = { id: data.from, name: data.name };
  currentCallType = data.type;
  pendingSignal = data.signal;
  showIncomingModal(data.name, data.from, data.type);
  setStatus(`Incoming ${data.type} call from ${data.name}…`);
});

acceptBtn.addEventListener('click', async () => {
  hideIncomingModal();
  callState = 'connecting';
  setStatus('Connecting…');

  // Auto-open chat for this caller if not already open
  if (!selectedUser || selectedUser.id !== callPartner.id) {
    selectUser(callPartner.id, callPartner.name);
  }

  showCallUI(currentCallType);
  document.getElementById('remote-name').textContent = callPartner.name;

  try {
    await getLocalStream(currentCallType);
  } catch { resetCallState(); return; }

  createPeerConnection();
  addTracksToPC(localStream);

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingSignal));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer-call', { signal: answer, to: callPartner.id });

    callState = 'connected';
    setStatus(`Connected with ${callPartner.name}`);
  } catch (err) {
    console.error('Accept error:', err);
    resetCallState();
  }
});

rejectBtn.addEventListener('click', () => {
  socket.emit('reject-call', { to: callPartner.id });
  hideIncomingModal();
  resetCallState();
  setStatus('Call rejected.');
});

// ── Call Accepted (caller side) ────────────────

socket.on('call-accepted', async (signal) => {
  clearTimeout(ringTimeout);
  callState = 'connecting';
  setStatus('Connecting…');

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
    callState = 'connected';
    setStatus(`Connected with ${callPartner.name}`);
  } catch (err) {
    console.error('Set remote desc error:', err);
    handleCallEnd('Connection failed.');
  }
});

// ── ICE Candidates ─────────────────────────────

socket.on('ice-candidate', async (data) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.error('ICE candidate error:', err);
  }
});

// ── Remote ended / rejected ────────────────────

socket.on('call-rejected', () => {
  clearTimeout(ringTimeout);
  handleCallEnd(`${callPartner?.name} rejected the call.`);
});

socket.on('call-ended', () => {
  handleCallEnd('Call ended by the other user.');
});

socket.on('user-disconnected', (disconnectedId) => {
  if (callPartner && callPartner.id === disconnectedId) {
    handleCallEnd(`${callPartner.name} disconnected.`);
  }
});

// ── End Call (local) ───────────────────────────

endBtn.addEventListener('click', () => {
  if (callPartner) socket.emit('end-call', { to: callPartner.id });
  handleCallEnd('You ended the call.');
});

// ── Cleanup ────────────────────────────────────

function handleCallEnd(message) {
  clearTimeout(ringTimeout);
  cleanupMedia();
  hideCallUI();
  hideIncomingModal();
  resetCallState();
  setStatus(message || 'Call ended.');
}

function cleanupMedia() {
  if (localStream) {
    localStream.getTracks().forEach(t => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  localVideo.srcObject  = null;
  remoteVideo.srcObject = null;
  remoteStream = null;
}

function resetCallState() {
  callState   = 'idle';
  callPartner = null;
  pendingSignal = null;
  audioMuted  = false;
  videoOff    = false;
  muteBtn.classList.remove('disabled');
  cameraBtn.classList.remove('disabled');
}

// ── In-call Controls ───────────────────────────

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  audioMuted = !audioMuted;
  track.enabled = !audioMuted;
  muteBtn.classList.toggle('disabled', audioMuted);
  muteBtn.title = audioMuted ? 'Unmute' : 'Mute Audio';
});

cameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  videoOff = !videoOff;
  track.enabled = !videoOff;
  cameraBtn.classList.toggle('disabled', videoOff);
  cameraBtn.title = videoOff ? 'Turn Camera On' : 'Turn Camera Off';
});
