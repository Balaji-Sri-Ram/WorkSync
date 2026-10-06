// =============================================
// WorkSync - Voice & Video Calling (WebRTC)
// =============================================

const socket = io();

// WebRTC configuration - STUN only; add TURN for production
const rtcConfig = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// State
let mySocketId = null;
let myUsername = '';
let peerConnection = null;
let localStream = null;
let remoteStream = null;
let currentCallType = 'voice'; // 'voice' | 'video'
let callState = 'idle'; // idle | calling | incoming | connecting | connected | ended
let callPartner = null; // { id, name }
let ringTimeout = null;
let audioMuted = false;
let videoOff = false;

// DOM elements
const usernameInput = document.getElementById('username-input');
const registerBtn = document.getElementById('register-btn');
const usersList = document.getElementById('users-list');
const videoContainer = document.getElementById('video-container');
const localVideo = document.getElementById('local-video');
const remoteVideo = document.getElementById('remote-video');
const callControls = document.getElementById('call-controls');
const muteBtn = document.getElementById('mute-btn');
const cameraBtn = document.getElementById('camera-btn');
const endBtn = document.getElementById('end-btn');
const statusDisplay = document.getElementById('status-display');
const incomingModal = document.getElementById('incoming-modal');
const incomingTitle = document.getElementById('incoming-title');
const incomingCaller = document.getElementById('incoming-caller');
const acceptBtn = document.getElementById('accept-btn');
const rejectBtn = document.getElementById('reject-btn');

// =============================================
// Registration
// =============================================

registerBtn.addEventListener('click', () => {
  const name = usernameInput.value.trim();
  if (!name) return alert('Please enter your name.');
  myUsername = name;
  socket.emit('register', name);
  registerBtn.disabled = true;
  usernameInput.disabled = true;
  registerBtn.textContent = 'Registered ✔';
});

// =============================================
// Users list
// =============================================

socket.on('connect', () => {
  mySocketId = socket.id;
});

socket.on('users-update', (users) => {
  usersList.innerHTML = '';
  users.forEach((user) => {
    if (user.id === socket.id) return; // don't show self
    const li = document.createElement('li');
    li.innerHTML = `
      <span>${user.name}</span>
      <div class="call-buttons">
        <button class="call-btn" data-id="${user.id}" data-name="${user.name}" data-type="voice" title="Voice Call">🎙 Voice</button>
        <button class="call-btn video" data-id="${user.id}" data-name="${user.name}" data-type="video" title="Video Call">📹 Video</button>
      </div>`;
    usersList.appendChild(li);
  });

  // Attach call button listeners
  document.querySelectorAll('.call-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!myUsername) return alert('Please register first.');
      if (callState !== 'idle') return alert('You are already in a call.');
      const targetId = btn.dataset.id;
      const targetName = btn.dataset.name;
      const type = btn.dataset.type;
      startCall(targetId, targetName, type);
    });
  });
});

// =============================================
// Call State UI helper
// =============================================

function setStatus(msg) {
  statusDisplay.textContent = msg;
}

function showCallUI(type) {
  videoContainer.classList.remove('hidden');
  callControls.classList.remove('hidden');
  // Show camera button only for video calls
  cameraBtn.style.display = type === 'video' ? 'flex' : 'none';
}

function hideCallUI() {
  videoContainer.classList.add('hidden');
  callControls.classList.add('hidden');
}

function showIncomingModal(callerName, type) {
  const emoji = type === 'video' ? '📹' : '🎙';
  incomingTitle.textContent = `${emoji} Incoming ${type === 'video' ? 'Video' : 'Voice'} Call`;
  incomingCaller.textContent = `From: ${callerName}`;
  incomingModal.classList.remove('hidden');
}

function hideIncomingModal() {
  incomingModal.classList.add('hidden');
}

// =============================================
// WebRTC helpers
// =============================================

function createPeerConnection() {
  if (peerConnection) {
    peerConnection.close();
  }
  peerConnection = new RTCPeerConnection(rtcConfig);

  // Send ICE candidates to partner
  peerConnection.onicecandidate = (event) => {
    if (event.candidate && callPartner) {
      socket.emit('ice-candidate', {
        to: callPartner.id,
        candidate: event.candidate
      });
    }
  };

  // Receive remote stream
  peerConnection.ontrack = (event) => {
    if (!remoteStream) {
      remoteStream = new MediaStream();
      remoteVideo.srcObject = remoteStream;
    }
    remoteStream.addTrack(event.track);
  };

  peerConnection.oniceconnectionstatechange = () => {
    console.log('ICE state:', peerConnection.iceConnectionState);
    if (peerConnection.iceConnectionState === 'disconnected' ||
        peerConnection.iceConnectionState === 'failed' ||
        peerConnection.iceConnectionState === 'closed') {
      handleCallEnd('Connection lost.');
    }
  };

  return peerConnection;
}

async function getLocalStream(type) {
  try {
    const constraints = {
      audio: true,
      video: type === 'video'
    };
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    localVideo.srcObject = localStream;
    return localStream;
  } catch (err) {
    let msg = 'Could not access media devices.';
    if (err.name === 'NotAllowedError') {
      msg = type === 'video'
        ? '❌ Camera and microphone permissions are required for video calls.'
        : '❌ Microphone permission is required for voice calls.';
    } else if (err.name === 'NotFoundError') {
      msg = '❌ Camera or microphone not found on this device.';
    } else if (err.name === 'NotReadableError') {
      msg = '❌ Camera or microphone is already in use by another app.';
    }
    setStatus(msg);
    throw err;
  }
}

function addTracksToPC(stream) {
  stream.getTracks().forEach((track) => {
    peerConnection.addTrack(track, stream);
  });
}

// =============================================
// Outgoing Call
// =============================================

async function startCall(targetId, targetName, type) {
  if (!myUsername) { alert('Register first!'); return; }

  callPartner = { id: targetId, name: targetName };
  currentCallType = type;
  callState = 'calling';
  setStatus(`Calling ${targetName}…`);
  showCallUI(type);
  document.getElementById('remote-name').textContent = targetName;

  try {
    await getLocalStream(type);
  } catch { return resetCallState(); }

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
    console.error('Error creating offer:', err);
    resetCallState();
  }
}

// =============================================
// Incoming Call (socket event)
// =============================================

let pendingSignal = null;

socket.on('incoming-call', (data) => {
  if (callState !== 'idle') {
    // Already in a call — auto-reject
    socket.emit('reject-call', { to: data.from });
    return;
  }
  callState = 'incoming';
  callPartner = { id: data.from, name: data.name };
  currentCallType = data.type;
  pendingSignal = data.signal;
  showIncomingModal(data.name, data.type);
  setStatus(`Incoming ${data.type} call from ${data.name}…`);
});

acceptBtn.addEventListener('click', async () => {
  hideIncomingModal();
  callState = 'connecting';
  setStatus('Connecting…');
  showCallUI(currentCallType);
  document.getElementById('remote-name').textContent = callPartner.name;

  try {
    await getLocalStream(currentCallType);
  } catch { return resetCallState(); }

  createPeerConnection();
  addTracksToPC(localStream);

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(pendingSignal));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);

    socket.emit('answer-call', {
      signal: answer,
      to: callPartner.id
    });

    callState = 'connected';
    setStatus(`Connected with ${callPartner.name}`);
  } catch (err) {
    console.error('Error accepting call:', err);
    resetCallState();
  }
});

rejectBtn.addEventListener('click', () => {
  socket.emit('reject-call', { to: callPartner.id });
  hideIncomingModal();
  resetCallState();
  setStatus('Call rejected.');
});

// =============================================
// Call Accepted by remote (Caller side)
// =============================================

socket.on('call-accepted', async (signal) => {
  clearTimeout(ringTimeout);
  callState = 'connecting';
  setStatus('Connecting…');

  try {
    await peerConnection.setRemoteDescription(new RTCSessionDescription(signal));
    callState = 'connected';
    setStatus(`Connected with ${callPartner.name}`);
  } catch (err) {
    console.error('Error setting remote description:', err);
    handleCallEnd('Connection failed.');
  }
});

// =============================================
// ICE Candidates
// =============================================

socket.on('ice-candidate', async (data) => {
  if (!peerConnection) return;
  try {
    await peerConnection.addIceCandidate(new RTCIceCandidate(data.candidate));
  } catch (err) {
    console.error('Error adding ICE candidate:', err);
  }
});

// =============================================
// Call Rejected / Ended by remote
// =============================================

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

// =============================================
// End Call (local button)
// =============================================

endBtn.addEventListener('click', () => {
  if (callPartner) {
    socket.emit('end-call', { to: callPartner.id });
  }
  handleCallEnd('You ended the call.');
});

// =============================================
// Cleanup
// =============================================

function handleCallEnd(message) {
  clearTimeout(ringTimeout);
  setStatus(message || 'Call ended.');
  cleanupMedia();
  hideCallUI();
  hideIncomingModal();
  resetCallState();
  // Briefly show the message then go idle
  setTimeout(() => {
    if (callState === 'idle') setStatus('Idle');
  }, 3000);
}

function cleanupMedia() {
  if (localStream) {
    localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  localVideo.srcObject = null;
  remoteVideo.srcObject = null;
  remoteStream = null;
}

function resetCallState() {
  callState = 'idle';
  callPartner = null;
  pendingSignal = null;
  audioMuted = false;
  videoOff = false;
  muteBtn.textContent = '🎤';
  muteBtn.classList.remove('disabled');
  cameraBtn.textContent = '📹';
  cameraBtn.classList.remove('disabled');
}

// =============================================
// Call Controls
// =============================================

muteBtn.addEventListener('click', () => {
  if (!localStream) return;
  const audioTrack = localStream.getAudioTracks()[0];
  if (!audioTrack) return;
  audioMuted = !audioMuted;
  audioTrack.enabled = !audioMuted;
  muteBtn.textContent = audioMuted ? '🔇' : '🎤';
  muteBtn.classList.toggle('disabled', audioMuted);
  muteBtn.title = audioMuted ? 'Unmute' : 'Mute';
});

cameraBtn.addEventListener('click', () => {
  if (!localStream) return;
  const videoTrack = localStream.getVideoTracks()[0];
  if (!videoTrack) return;
  videoOff = !videoOff;
  videoTrack.enabled = !videoOff;
  cameraBtn.textContent = videoOff ? '🚫' : '📹';
  cameraBtn.classList.toggle('disabled', videoOff);
  cameraBtn.title = videoOff ? 'Turn Camera On' : 'Turn Camera Off';
});
