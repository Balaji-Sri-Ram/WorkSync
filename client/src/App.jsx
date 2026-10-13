import React, { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import './App.css';
import {
  isMediaDevicesSupported,
  getVideoDevices,
  findCandidateDevice,
  getVideoSender,
  requestCameraStream,
  stopMediaStream,
  getHumanReadableMediaError,
} from './cameraUtils.js';

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
  const [facingMode, setFacingMode]         = useState('user'); // 'user' or 'environment'
  const [isFlippingCamera, setIsFlippingCamera] = useState(false);

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

  // Concurrency lock & async synchronization refs (prevent stale closures)
  const isSwitchingCameraRef = useRef(false);
  const isInCallRef          = useRef(false);
  const videoOffRef          = useRef(false);
  const isScreenSharingRef   = useRef(false);
  const facingModeRef        = useRef('user');

  useEffect(() => { isInCallRef.current = isInCall; }, [isInCall]);
  useEffect(() => { videoOffRef.current = videoOff; }, [videoOff]);
  useEffect(() => { isScreenSharingRef.current = isScreenSharing; }, [isScreenSharing]);
  useEffect(() => { facingModeRef.current = facingMode; }, [facingMode]);

  // Teardown tracks and connections on unmount
  useEffect(() => {
    return () => {
      clearTimeout(ringTimerRef.current);
      clearTimeout(toastTimer.current);
      screenStreamRef.current?.getTracks().forEach((t) => t.stop());
      localStreamRef.current?.getTracks().forEach((t) => t.stop());
      pcRef.current?.close();
    };
  }, []);

  // ─── Show toast notification ───────────────────────────────────────────────
  const notify = useCallback((msg, duration = 3500) => {
    setToast(msg);
    setShowToast(true);
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setShowToast(false), duration);
  }, []);

  // ─── Reset Call State ──────────────────────────────────────────────────────
  const resetCall = useCallback(() => {
    partnerRef.current           = null;
    pendingSignalRef.current     = null;
    pendingCandidatesRef.current = [];
    setIsInCall(false);
    setIncomingCall(null);
    setAudioMuted(false);
    setVideoOff(false);
    setIsScreenSharing(false);
  }, []);

  // ─── End Call Cleanup ──────────────────────────────────────────────────────
  const endCallCleanup = useCallback((message) => {
    clearTimeout(ringTimerRef.current);
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;
    localStreamRef.current?.getTracks().forEach((t) => t.stop());
    localStreamRef.current  = null;
    pcRef.current?.close();
    pcRef.current           = null;
    if (localVideoRef.current)  localVideoRef.current.srcObject  = null;
    if (remoteVideoRef.current) remoteVideoRef.current.srcObject = null;
    remoteStreamRef.current = null;
    resetCall();
    notify(message || 'Call ended.');
  }, [notify, resetCall]);

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
  }, [notify, endCallCleanup]);

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
        video: type === 'video' ? { facingMode: facingModeRef.current } : false,
      });
      localStreamRef.current = stream;
      if (localVideoRef.current) localVideoRef.current.srcObject = stream;
      return stream;
    } catch (err) {
      notify(getHumanReadableMediaError(err));
      throw err;
    }
  };

  // ─── Create RTCPeerConnection ──────────────────────────────────────────────
  const createPC = () => {
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
    localStreamRef.current?.getTracks().forEach((t) => pc.addTrack(t, localStreamRef.current));

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

    const pc     = createPC();
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

    const pc = createPC();
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

  // ─── Screen sharing ───────────────────────────────────────────────────────
  const toggleScreenShare = async () => {
    if (!isScreenSharing) {
      try {
        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
        screenStreamRef.current = screenStream;

        // Replace the video track sent to remote peer
        const screenTrack = screenStream.getVideoTracks()[0];
        const sender = getVideoSender(pcRef.current);
        await sender?.replaceTrack(screenTrack);

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

  const stopScreenShare = async () => {
    screenStreamRef.current?.getTracks().forEach((t) => t.stop());
    screenStreamRef.current = null;

    // Swap back to webcam
    const webcamTrack = localStreamRef.current?.getVideoTracks()[0];
    const sender = getVideoSender(pcRef.current);
    if (sender && webcamTrack) {
      await sender.replaceTrack(webcamTrack);
    }
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

  // ─── Flip camera ──────────────────────────────────────────────────────────
  const flipCamera = async () => {
    if (callType !== 'video' || !isInCallRef.current) return;
    if (isSwitchingCameraRef.current) return;

    if (!isMediaDevicesSupported()) {
      notify('❌ Camera API is not supported in this browser or context.');
      return;
    }

    isSwitchingCameraRef.current = true;
    setIsFlippingCamera(true);

    const currentFacing = facingModeRef.current;
    const targetFacing = currentFacing === 'user' ? 'environment' : 'user';
    const oldVideoTrack = localStreamRef.current?.getVideoTracks()[0];
    const currentDeviceId = oldVideoTrack?.getSettings?.()?.deviceId || null;
    const wasVideoEnabled = oldVideoTrack ? oldVideoTrack.enabled : !videoOffRef.current;

    let newStream = null;
    let oldTrackTemporarilyStopped = false;

    try {
      // 1. Enumerate video devices to avoid redundant or invalid switches
      const videoDevices = await getVideoDevices();
      if (videoDevices.length === 1) {
        notify('Only one camera detected on this device.');
        return;
      }

      // Identify candidate device ID by label matching if available
      const candidateDevice = findCandidateDevice(videoDevices, targetFacing, currentDeviceId);
      const preferredDeviceId = candidateDevice?.deviceId || null;

      // 2. Acquisition Phase
      // Step A: Attempt non-destructive acquisition (preserves old track while acquiring)
      try {
        newStream = await requestCameraStream(targetFacing, preferredDeviceId);
      } catch (acquireErr) {
        // Step B: Controlled fallback for hardware contention
        // (devices that cannot open two cameras concurrently, throwing NotReadableError / TrackStartError)
        const isHardwareContention =
          acquireErr.name === 'NotReadableError' ||
          acquireErr.name === 'TrackStartError' ||
          acquireErr.name === 'AbortError';

        if (isHardwareContention && oldVideoTrack && oldVideoTrack.readyState === 'live') {
          console.warn('Camera hardware contention detected. Stopping old track for fallback...');
          oldVideoTrack.stop();
          oldTrackTemporarilyStopped = true;

          try {
            newStream = await requestCameraStream(targetFacing, preferredDeviceId);
          } catch (fallbackErr) {
            console.error('Fallback camera acquisition failed:', fallbackErr);
            // Step C: Graceful recovery - restore the previous camera so user isn't left without video
            try {
              const restoredStream = await requestCameraStream(currentFacing, currentDeviceId);
              const restoredTrack = restoredStream.getVideoTracks()[0];
              if (restoredTrack && localStreamRef.current) {
                localStreamRef.current.removeTrack(oldVideoTrack);
                localStreamRef.current.addTrack(restoredTrack);
                restoredTrack.enabled = wasVideoEnabled;

                const sender = getVideoSender(pcRef.current);
                if (!isScreenSharingRef.current && sender) {
                  await sender.replaceTrack(restoredTrack);
                }
                if (localVideoRef.current && !isScreenSharingRef.current) {
                  localVideoRef.current.srcObject = localStreamRef.current;
                }
              }
            } catch (restoreErr) {
              console.error('Failed to restore previous camera:', restoreErr);
            }
            notify(getHumanReadableMediaError(fallbackErr));
            return;
          }
        } else {
          throw acquireErr;
        }
      }

      // 3. Validation Phase
      const newVideoTrack = newStream?.getVideoTracks()[0];
      if (!newVideoTrack || newVideoTrack.readyState === 'ended') {
        throw new Error('Acquired camera stream does not contain a valid active video track.');
      }

      // Verify call is still active
      if (!isInCallRef.current || !pcRef.current) {
        stopMediaStream(newStream);
        return;
      }

      // 4. Multi-camera check: verify the new track is not identical to current
      const newDeviceId = newVideoTrack.getSettings?.()?.deviceId;
      if (videoDevices.length > 1 && currentDeviceId && newDeviceId === currentDeviceId) {
        const altDevice = videoDevices.find((d) => d.deviceId && d.deviceId !== currentDeviceId);
        if (altDevice?.deviceId) {
          stopMediaStream(newStream);
          newStream = await requestCameraStream(targetFacing, altDevice.deviceId).catch(() => null);
        }
      }

      const finalVideoTrack = newStream?.getVideoTracks()[0];
      if (!finalVideoTrack) {
        throw new Error('Could not acquire an alternate camera track.');
      }

      // 5. Inherit videoOff state
      finalVideoTrack.enabled = !videoOffRef.current;

      // 6. Replace track on RTCPeerConnection sender (unless screen sharing is active)
      const sender = getVideoSender(pcRef.current);
      if (!isScreenSharingRef.current && sender) {
        await sender.replaceTrack(finalVideoTrack);
      }

      // 7. Update local MediaStream and local video preview
      if (localStreamRef.current) {
        if (oldVideoTrack) {
          localStreamRef.current.removeTrack(oldVideoTrack);
        }
        localStreamRef.current.addTrack(finalVideoTrack);
      } else {
        localStreamRef.current = new MediaStream([finalVideoTrack]);
      }

      // Safely stop obsolete old track if it wasn't already stopped during fallback
      if (oldVideoTrack && !oldTrackTemporarilyStopped && oldVideoTrack !== finalVideoTrack) {
        oldVideoTrack.stop();
      }

      if (localVideoRef.current && !isScreenSharingRef.current) {
        localVideoRef.current.srcObject = localStreamRef.current;
        localVideoRef.current.play?.().catch(() => {});
      }

      // 8. Update React state only after all operations succeed
      setFacingMode(targetFacing);
      notify(`Switched to ${targetFacing === 'environment' ? 'rear' : 'front'} camera`, 2000);
    } catch (err) {
      console.error('Error flipping camera:', err);
      if (newStream) {
        stopMediaStream(newStream);
      }
      notify(getHumanReadableMediaError(err));
    } finally {
      isSwitchingCameraRef.current = false;
      setIsFlippingCamera(false);
    }
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
                  
                  {/* Floating Top Right Controls */}
                  <div className="top-right-controls">
                    {/* Flip Camera (Mobile Only) */}
                    {callType === 'video' && (
                      <button
                        className="icon-btn floating-btn mobile-only-btn flip-cam"
                        title={isFlippingCamera ? 'Switching camera...' : `Flip to ${facingMode === 'user' ? 'rear' : 'front'} camera`}
                        onClick={flipCamera}
                        disabled={isFlippingCamera}
                        aria-label="Flip Camera"
                      >
                        <svg
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          width="22"
                          height="22"
                          className={`icon-animate ${isFlippingCamera ? 'spinning' : ''}`}
                        >
                          <polyline points="17 1 21 5 17 9" />
                          <path d="M3 11V9a4 4 0 0 1 4-4h14" />
                          <polyline points="7 23 3 19 7 15" />
                          <path d="M21 13v2a4 4 0 0 1-4 4H3" />
                        </svg>
                      </button>
                    )}
                  </div>

                  <div className="remote-video-wrapper">
                    <video 
                      ref={el => {
                        remoteVideoRef.current = el;
                        if (el && remoteStreamRef.current) el.srcObject = remoteStreamRef.current;
                      }} 
                      autoPlay playsInline 
                    />
                    <div className="video-label">{selectedUser?.name || 'Remote'}</div>
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
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" className="icon-animate">
                          <path d="M20 3H4a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h6v2H8v2h8v-2h-2v-2h6a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2zm0 13H4V5h16v11z"/>
                        </svg>
                      </button>
                    )}
                    
                    {/* Mute Button */}
                    <button className={`control-btn ${audioMuted ? 'muted' : ''}`} title={audioMuted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                      {audioMuted ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" className="icon-animate icon-crossed">
                          <line x1="1" y1="1" x2="23" y2="23" />
                          <path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6" />
                          <path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23" />
                          <line x1="12" y1="19" x2="12" y2="23" />
                          <line x1="8" y1="23" x2="16" y2="23" />
                        </svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" className="icon-animate">
                          <path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 0 0-6 0v6a3 3 0 0 0 3 3zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 14 0h-2zm-5 9v-2"/>
                        </svg>
                      )}
                    </button>

                    {/* Camera Off Button */}
                    {callType === 'video' && (
                      <button className={`control-btn ${videoOff ? 'cam-off' : ''}`} title={videoOff ? 'Camera On' : 'Camera Off'} onClick={toggleCamera}>
                        {videoOff ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" width="20" height="20" className="icon-animate icon-crossed">
                            <path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10" />
                            <line x1="1" y1="1" x2="23" y2="23" />
                          </svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="currentColor" width="20" height="20" className="icon-animate">
                            <path d="M17 10.5V7a1 1 0 0 0-1-1H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-3.5l4 4v-11l-4 4z"/>
                          </svg>
                        )}
                      </button>
                    )}

                    {/* End Call Button */}
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
