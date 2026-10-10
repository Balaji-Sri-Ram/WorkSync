import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';

// ─── Socket connection ─────────────────────────────────────────────────────
const socket = io(import.meta.env.DEV ? 'http://localhost:3000' : '/');

// ─── WebRTC Config (replace TURN values with Metered.ca credentials) ───────
const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    {
      urls: "stun:stun.relay.metered.ca:80",
    },
    {
      urls: "turn:global.relay.metered.ca:80",
      username: "5a24ecd2b1f428632361bf9d",
      credential: "FhJc0Hi2Byqlq/uz",
    },
    {
      urls: "turn:global.relay.metered.ca:80?transport=tcp",
      username: "5a24ecd2b1f428632361bf9d",
      credential: "FhJc0Hi2Byqlq/uz",
    },
    {
      urls: "turn:global.relay.metered.ca:443",
      username: "5a24ecd2b1f428632361bf9d",
      credential: "FhJc0Hi2Byqlq/uz",
    },
    {
      urls: "turns:global.relay.metered.ca:443?transport=tcp",
      username: "5a24ecd2b1f428632361bf9d",
      credential: "FhJc0Hi2Byqlq/uz",
    },
  ],
};

// ─── Avatar helpers ────────────────────────────────────────────────────────
const COLORS = 8;
const colorMap = {};

function avatarColor(userId) {
  if (!(userId in colorMap)) {
    colorMap[userId] = Object.keys(colorMap).length % COLORS;
  }
  return colorMap[userId];
}

function initial(name) {
  return (name || '?').charAt(0).toUpperCase();
}

// ══════════════════════════════════════════════════════════════════════════════
export default function App() {

  // ─── Auth state ───────────────────────────────────────────────────────────
  const [username, setUsername] = useState('');
  const [isJoined, setIsJoined] = useState(false);

  // ─── Users / chat state ───────────────────────────────────────────────────
  const [onlineUsers, setOnlineUsers]   = useState([]);
  const [selectedUser, setSelectedUser] = useState(null); // { id, name }

  // ─── Call state ───────────────────────────────────────────────────────────
  const [isInCall, setIsInCall]             = useState(false);
  const [callType, setCallType]             = useState('video'); // 'voice' | 'video'
  const [incomingCall, setIncomingCall]     = useState(null);   // { from, name, signal, type }
  const [audioMuted, setAudioMuted]         = useState(false);
  const [videoOff, setVideoOff]             = useState(false);
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // ─── Toast state ──────────────────────────────────────────────────────────
  const [toast, setToast]     = useState('');
  const [showToast, setShowToast] = useState(false);
  const toastTimer            = useRef(null);

  // ─── WebRTC refs ──────────────────────────────────────────────────────────
  const localVideoRef     = useRef(null);
  const remoteVideoRef    = useRef(null);
  const pcRef             = useRef(null);       // RTCPeerConnection
  const localStreamRef    = useRef(null);
  const screenStreamRef   = useRef(null);        // Screen share stream
  const remoteStreamRef   = useRef(null);
  const partnerRef        = useRef(null);       // { id, name }
  const pendingSignalRef  = useRef(null);
  const ringTimerRef      = useRef(null);
  const pendingCandidatesRef = useRef([]);      // Queue for ICE candidates

  // ─── Show toast notification ───────────────────────────────────────────────
  const notify = useCallback((msg, duration = 3500) => {
    setToast(msg);
    setShowToast(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setShowToast(false), duration);
  }, []);

  // ─── Socket events ─────────────────────────────────────────────────────────
  useEffect(() => {
    socket.on('users-update', (users) => {
      setOnlineUsers(users.filter(u => u.id !== socket.id));
    });

    socket.on('incoming-call', (data) => {
      if (partnerRef.current) {
        // Already in a call — auto reject
        socket.emit('reject-call', { to: data.from });
        return;
      }
      partnerRef.current    = { id: data.from, name: data.name };
      pendingSignalRef.current = data.signal;
      setCallType(data.type);
      setIncomingCall(data);
      notify(`Incoming ${data.type} call from ${data.name}…`, 30000);
    });

    socket.on('call-accepted', async (signal) => {
      clearTimeout(ringTimerRef.current);
      try {
        await pcRef.current.setRemoteDescription(new RTCSessionDescription(signal));
        notify(`Connected with ${partnerRef.current?.name}`);
        // Process any queued candidates
        for (const candidate of pendingCandidatesRef.current) {
          try {
            await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
          } catch (e) {
            console.error('Error adding queued ICE candidate', e);
          }
        }
        pendingCandidatesRef.current = [];
      } catch (err) {
        console.error('call-accepted error:', err);
        endCallCleanup('Connection failed.');
      }
    });

    socket.on('call-rejected', () => {
      clearTimeout(ringTimerRef.current);
      endCallCleanup(`${partnerRef.current?.name} rejected the call.`);
    });

    socket.on('call-ended', () => {
      endCallCleanup('Call ended by the other user.');
    });

    socket.on('ice-candidate', async ({ candidate }) => {
      if (!candidate) return;
      if (!pcRef.current || !pcRef.current.remoteDescription) {
        // Queue candidates if PC isn't ready or remote description isn't set yet
        pendingCandidatesRef.current.push(candidate);
        return;
      }
      try {
        await pcRef.current.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (err) {
        console.error('ICE error:', err);
      }
    });

    socket.on('user-disconnected', (id) => {
      if (partnerRef.current?.id === id) {
        endCallCleanup(`${partnerRef.current.name} disconnected.`);
      }
    });

    return () => {
      socket.off('users-update');
      socket.off('incoming-call');
      socket.off('call-accepted');
      socket.off('call-rejected');
      socket.off('call-ended');
      socket.off('ice-candidate');
      socket.off('user-disconnected');
    };
  }, [notify]);

  // ─── Join the network ──────────────────────────────────────────────────────
  const handleJoin = () => {
    const name = username.trim();
    if (!name) { notify('Please enter your name.'); return; }
    socket.emit('register', name);
    setIsJoined(true);
    notify(`Welcome, ${name}!`);
  };

  // ─── Get camera / mic ──────────────────────────────────────────────────────
  const getMedia = async (type) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: type === 'video',
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      return stream;
    } catch (err) {
      const messages = {
        NotAllowedError:   type === 'video' ? '❌ Camera & mic permission required.' : '❌ Mic permission required.',
        NotFoundError:     '❌ Camera or microphone not found.',
        NotReadableError:  '❌ Device already in use by another app.',
      };
      notify(messages[err.name] || 'Could not access media devices.');
      throw err;
    }
  };

  // ─── Create RTCPeerConnection ──────────────────────────────────────────────
  const createPC = (partnerId) => {
    pcRef.current?.close();
    const pc = new RTCPeerConnection(RTC_CONFIG);
    pcRef.current = pc;

    // Send ICE candidates to the other peer via signaling server
    pc.onicecandidate = ({ candidate }) => {
      if (candidate && partnerRef.current) {
        socket.emit('ice-candidate', { to: partnerRef.current.id, candidate });
      }
    };

    // Receive remote video/audio stream
    pc.ontrack = ({ track }) => {
      if (!remoteStreamRef.current) {
        remoteStreamRef.current = new MediaStream();
      }
      remoteStreamRef.current.addTrack(track);
      if (remoteVideoRef.current) {
        remoteVideoRef.current.srcObject = remoteStreamRef.current;
      }
    };

    // Handle unexpected disconnections
    pc.oniceconnectionstatechange = () => {
      const s = pc.iceConnectionState;
      if (s === 'disconnected' || s === 'failed' || s === 'closed') {
        endCallCleanup('Connection lost.');
      }
    };

    // Add local tracks to the connection
    localStreamRef.current?.getTracks().forEach(t => pc.addTrack(t, localStreamRef.current));

    return pc;
  };

  // ─── Start outgoing call ───────────────────────────────────────────────────
  const startCall = async (type) => {
    if (!selectedUser)         { return; }
    if (!isJoined)             { notify('Please join first.'); return; }
    if (partnerRef.current)    { notify('You are already in a call.'); return; }

    partnerRef.current = { id: selectedUser.id, name: selectedUser.name };
    setCallType(type);
    setIsInCall(true);
    notify(`Calling ${selectedUser.name}…`);

    try {
      await getMedia(type);
    } catch { resetCall(); return; }

    const pc     = createPC(selectedUser.id);
    const offer  = await pc.createOffer();
    await pc.setLocalDescription(offer);

    socket.emit('call-user', {
      userToCall: selectedUser.id,
      signalData: offer,
      name: username,
      type,
    });

    // Auto-cancel if no answer in 30s
    ringTimerRef.current = setTimeout(() => {
      if (partnerRef.current) {
        socket.emit('end-call', { to: partnerRef.current.id });
        endCallCleanup('No answer. Call timed out.');
      }
    }, 30000);
  };

  // ─── Accept incoming call ──────────────────────────────────────────────────
  const acceptCall = async () => {
    if (!incomingCall) return;
    setIncomingCall(null);
    setIsInCall(true);
    notify('Connecting…');

    // Auto-select the caller in the sidebar
    if (!selectedUser || selectedUser.id !== partnerRef.current?.id) {
      setSelectedUser({ id: partnerRef.current.id, name: partnerRef.current.name });
    }

    try {
      await getMedia(callType);
    } catch { resetCall(); return; }

    const pc     = createPC(partnerRef.current.id);
    await pc.setRemoteDescription(new RTCSessionDescription(pendingSignalRef.current));
    
    // Process any queued candidates that arrived before the PC was created
    for (const candidate of pendingCandidatesRef.current) {
      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (e) {
        console.error('Error adding queued ICE candidate', e);
      }
    }
    pendingCandidatesRef.current = [];

    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);

    socket.emit('answer-call', { signal: answer, to: partnerRef.current.id });
    notify(`Connected with ${partnerRef.current.name}`);
  };

  // ─── Reject incoming call ──────────────────────────────────────────────────
  const rejectCall = () => {
    if (partnerRef.current) socket.emit('reject-call', { to: partnerRef.current.id });
    setIncomingCall(null);
    resetCall();
    notify('Call rejected.');
  };

  // ─── End active call ───────────────────────────────────────────────────────
  const endCall = () => {
    if (partnerRef.current) socket.emit('end-call', { to: partnerRef.current.id });
    endCallCleanup('You ended the call.');
  };

  const endCallCleanup = (message) => {
    clearTimeout(ringTimerRef.current);
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach(t => t.stop());
    localStreamRef.current  = null;
    pcRef.current?.close();
    pcRef.current           = null;
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteStreamRef.current = null;
    resetCall();
    notify(message || 'Call ended.');
  };

  const resetCall = () => {
    partnerRef.current       = null;
    pendingSignalRef.current = null;
    pendingCandidatesRef.current = [];
    setIsInCall(false);
    setIncomingCall(null);
    setAudioMuted(false);
    setVideoOff(false);
    setIsScreenSharing(false);
  };

  // ─── Screen sharing ───────────────────────────────────────────────────────
  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;

        // Replace the video track sent to remote peer
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video');
        sender?.replaceTrack(screenTrack);

        // Show screen in local preview
        if (localVideoRef.current) localVideoRef.current.srcObject = screenStream;
        setIsScreenSharing(true);

        // Handle when user clicks the browser's native "Stop sharing" button
        screenTrack.onended = () => stopScreenShare();
      } catch (err) {
        console.error('Screen share error:', err);
      }
    } else {
      stopScreenShare();
    }
  };

  const stopScreenShare = () => {
    screenStreamRef.current?.getTracks().forEach(t => t.stop());
    screenStreamRef.current = null;

    // Swap back to webcam
    const webcamTrack = localStreamRef.current?.getVideoTracks()[0];
    const sender = pcRef.current?.getSenders().find(s => s.track?.kind === 'video');
    if (sender && webcamTrack) sender.replaceTrack(webcamTrack);
    if (localVideoRef.current) localVideoRef.current.srcObject = localStreamRef.current;
    setIsScreenSharing(false);
  };

  // ─── Toggle mute ──────────────────────────────────────────────────────────
  const toggleMute = () => {
    const track = localStreamRef.current?.getAudioTracks()[0];
    if (!track) return;
    const muted = !audioMuted;
    track.enabled = !muted;
    setAudioMuted(muted);
  };

  // ─── Toggle camera ────────────────────────────────────────────────────────
  const toggleCamera = () => {
    const track = localStreamRef.current?.getVideoTracks()[0];
    if (!track) return;
    const off = !videoOff;
    track.enabled = !off;
    setVideoOff(off);
  };

  // ══════════════════════════════════════════════════════════════════════════
  // RENDER
  // ══════════════════════════════════════════════════════════════════════════
  return (
    <div className="app-container">

      {/* ── Navbar ─────────────────────────────────────────────────────── */}
      <header className="navbar">
        <span className="brand-name">WorkSync</span>
        <div className="navbar-user">
          <input
            type="text"
            placeholder="Enter your name…"
            value={username}
            disabled={isJoined}
            onChange={e => setUsername(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !isJoined && handleJoin()}
            autoComplete="off"
          />
          <button onClick={handleJoin} disabled={isJoined}>
            {isJoined ? 'Joined ✔' : 'Join'}
          </button>
        </div>
      </header>

      {/* ── Main Layout ────────────────────────────────────────────────── */}
      <main className={`main-layout ${selectedUser ? 'chat-active' : ''}`}>

        {/* ── Sidebar ── */}
        <aside className="sidebar">
          <div className="sidebar-header">
            <h2>Online Users</h2>
            <span className="online-badge">{onlineUsers.length}</span>
          </div>
          <ul className="users-list">
            {onlineUsers.map(user => (
              <li
                key={user.id}
                className={`user-list-item ${selectedUser?.id === user.id ? 'active' : ''}`}
                onClick={() => setSelectedUser(user)}
              >
                <div className="avatar" data-color={avatarColor(user.id)}>
                  {initial(user.name)}
                </div>
                <div>
                  <div className="user-name">{user.name}</div>
                  <div className="user-status">● Online</div>
                </div>
              </li>
            ))}
          </ul>
        </aside>

        {/* ── Chat Panel ── */}
        <section className="chat-panel">

          {/* Idle state */}
          {!selectedUser && (
            <div className="idle-view">
              <div className="idle-content">
                <div className="idle-icon">💬</div>
                <h3 className="idle-title">Connect with people online</h3>
                <p className="idle-subtitle">
                  Select a user from the sidebar to start a conversation or make a call.
                </p>
              </div>
            </div>
          )}

          {/* Active chat */}
          {selectedUser && (
            <div className="active-chat">

              {/* Chat Header */}
              <div className="chat-header">
                <div className="chat-header-user">
                  <button className="mobile-back-btn" title="Back" onClick={() => setSelectedUser(null)}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
                      <path d="M15 18l-6-6 6-6"/>
                    </svg>
                  </button>
                  <div className="avatar avatar-lg" data-color={avatarColor(selectedUser.id)}>
                    {initial(selectedUser.name)}
                  </div>
                  <div className="chat-header-info">
                    <span className="chat-partner-name">{selectedUser.name}</span>
                    <span className="online-dot-label">
                      <span className="dot" /> Online
                    </span>
                  </div>
                </div>

                <div className="chat-call-actions">
                  {/* Voice call */}
                  <button className="icon-btn voice" title="Voice Call" onClick={() => startCall('voice')}>
                    <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                      <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C9.61 21 3 14.39 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/>
                    </svg>
                  </button>
                  {/* Video call */}
                  <button className="icon-btn video" title="Video Call" onClick={() => startCall('video')}>
                    <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
                      <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
                    </svg>
                  </button>
                </div>
              </div>

              {/* Messages area */}
              <div className="messages-area">
                <div className="messages-placeholder">
                  <p>Say hello! 👋</p>
                </div>
              </div>

              {/* Chat input */}
              <div className="chat-input-bar">
                <button className="attach-btn" title="Attach file">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                    <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.64 16.34a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                  </svg>
                </button>
                <input className="chat-input" type="text" placeholder="Type a message…" autoComplete="off" />
                <button className="emoji-btn" title="Emoji">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="20" height="20">
                    <circle cx="12" cy="12" r="10"/>
                    <path d="M8 13s1.5 2 4 2 4-2 4-2"/>
                    <line x1="9" y1="9" x2="9.01" y2="9"/>
                    <line x1="15" y1="9" x2="15.01" y2="9"/>
                  </svg>
                </button>
                <button className="send-btn" title="Send">
                  <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                  </svg>
                </button>
              </div>

              {/* In-call video overlay */}
              {isInCall && (
                <div className="video-container">
                  <div className="remote-video-wrapper">
                    <video 
                      ref={el => {
                        remoteVideoRef.current = el;
                        if (el && remoteStreamRef.current) el.srcObject = remoteStreamRef.current;
                      }} 
                      autoPlay playsInline 
                    />
                    <div className="video-label">{partnerRef.current?.name || 'Remote'}</div>
                  </div>
                  <div className="local-video-wrapper">
                    <video 
                      ref={el => {
                        localVideoRef.current = el;
                        if (el && (screenStreamRef.current || localStreamRef.current)) {
                          el.srcObject = screenStreamRef.current || localStreamRef.current;
                        }
                      }} 
                      autoPlay playsInline muted 
                    />
                    <div className="video-label">You</div>
                  </div>
                  <div className="call-controls"> 
                    {/* Screen Share – video calls only */}
                    {callType === 'video' && (
                      <button className={`control-btn ${isScreenSharing ? 'screen-active' : ''}`} title={isScreenSharing ? 'Stop Sharing' : 'Share Screen'} onClick={toggleScreenShare}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/>
                        </svg>
                      </button>
                    )}
                    <button className={`control-btn ${audioMuted ? 'muted' : ''}`} title={audioMuted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                      <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                        <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2zm-5 9v-2"/>
                      </svg>
                    </button>
                    {callType === 'video' && (
                      <button className={`control-btn ${videoOff ? 'cam-off' : ''}`} title={videoOff ? 'Camera On' : 'Camera Off'} onClick={toggleCamera}>
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20">
                          <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
                        </svg>
                      </button>
                    )}
                    <button className="control-btn end-call" title="End Call" onClick={endCall}>
                      <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
                        <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C9.61 21 3 14.39 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z" transform="rotate(135 12 12)"/>
                      </svg>
                    </button>
                  </div>
                </div>
              )}

            </div>
          )}
        </section>
      </main>

      {/* ── Status Toast ───────────────────────────────────────────────── */}
      {showToast && <div className="status-toast">{toast}</div>}

      {/* ── Incoming Call Modal ────────────────────────────────────────── */}
      {incomingCall && (
        <div className="modal-overlay">
          <div className="modal-content">
            <div className="modal-avatar" data-color={avatarColor(incomingCall.from)}>
              {initial(incomingCall.name)}
            </div>
            <h3>{incomingCall.type === 'video' ? '📹' : '📞'} Incoming {incomingCall.type === 'video' ? 'Video' : 'Voice'} Call</h3>
            <p>From: {incomingCall.name}</p>
            <div className="modal-actions">
              <button className="btn-reject" onClick={rejectCall}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
                  <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C9.61 21 3 14.39 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z" transform="rotate(135 12 12)"/>
                </svg>
              </button>
              <button className="btn-accept" onClick={acceptCall}>
                <svg viewBox="0 0 24 24" fill="currentColor" width="22" height="22">
                  <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24c1.12.37 2.33.57 3.57.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1C9.61 21 3 14.39 3 6a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.25.2 2.45.57 3.57a1 1 0 0 1-.25 1.02l-2.2 2.2z"/>
                </svg>
              </button>
            </div>
            <p className="modal-hint">Tap to respond</p>
          </div>
        </div>
      )}

    </div>
  );
}
