/**
 * WebRTC Camera and Media Device Utilities for Cross-Device Production Reliability.
 * Handles device enumeration, progressive constraints, hardware contention fallbacks,
 * and RTCPeerConnection sender management across Android, iOS, tablets, and desktop browsers.
 */

/**
 * Check if the current browser environment supports the MediaDevices API.
 */
export const isMediaDevicesSupported = () => {
  return typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function';
};

/**
 * Safely enumerate video input devices without throwing.
 * Returns an array of MediaDeviceInfo objects of kind 'videoinput'.
 */
export const getVideoDevices = async () => {
  if (!isMediaDevicesSupported() || typeof navigator.mediaDevices.enumerateDevices !== 'function') {
    return [];
  }
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    return devices.filter((d) => d.kind === 'videoinput');
  } catch (err) {
    console.warn('Failed to enumerate media devices:', err);
    return [];
  }
};

/**
 * Identify a candidate device from enumerated video devices that matches
 * the requested facing mode and is distinct from the current device ID.
 *
 * @param {MediaDeviceInfo[]} devices
 * @param {'user'|'environment'} targetFacingMode
 * @param {string|null} currentDeviceId
 * @returns {MediaDeviceInfo|null}
 */
export const findCandidateDevice = (devices, targetFacingMode, currentDeviceId = null) => {
  if (!Array.isArray(devices) || devices.length === 0) return null;

  // Filter out the currently active device if specified
  const otherDevices = currentDeviceId
    ? devices.filter((d) => d.deviceId && d.deviceId !== currentDeviceId)
    : devices;

  if (otherDevices.length === 0) return null;

  // Label patterns for rear/environment vs front/user cameras
  const isBack = targetFacingMode === 'environment';
  const pattern = isBack
    ? /(back|rear|environment|camera2\s*0|main|wide)/i
    : /(front|user|forward|face|selfie|camera2\s*1)/i;

  // Priority 1: Label matches the target facing mode
  const labelMatch = otherDevices.find((d) => d.label && pattern.test(d.label));
  if (labelMatch) return labelMatch;

  // Priority 2: If switching to rear, pick a device whose label does NOT match front
  if (isBack) {
    const notFront = otherDevices.find((d) => d.label && !/(front|user|selfie)/i.test(d.label));
    if (notFront) return notFront;
  } else {
    // Priority 2: If switching to front, pick a device whose label does NOT match rear
    const notBack = otherDevices.find((d) => d.label && !/(back|rear)/i.test(d.label));
    if (notBack) return notBack;
  }

  // Priority 3: First alternate device available
  return otherDevices[0] || null;
};

/**
 * Reliably find the video RTCRtpSender in an active RTCPeerConnection.
 * Works across browsers with transceiver support and standard getSenders().
 *
 * @param {RTCPeerConnection|null} pc
 * @returns {RTCRtpSender|null}
 */
export const getVideoSender = (pc) => {
  if (!pc) return null;

  // 1. Transceiver inspection (modern WebRTC 1.0 standard)
  if (typeof pc.getTransceivers === 'function') {
    try {
      const transceivers = pc.getTransceivers();
      const videoTransceiver = transceivers.find((t) => {
        const senderKind = t.sender?.track?.kind;
        const receiverKind = t.receiver?.track?.kind;
        return senderKind === 'video' || receiverKind === 'video';
      });
      if (videoTransceiver?.sender) {
        return videoTransceiver.sender;
      }
    } catch (e) {
      console.warn('Transceiver inspection failed, falling back to getSenders:', e);
    }
  }

  // 2. getSenders inspection
  if (typeof pc.getSenders === 'function') {
    try {
      const senders = pc.getSenders();
      // First check for a sender holding an active video track
      const withVideoTrack = senders.find((s) => s.track && s.track.kind === 'video');
      if (withVideoTrack) return withVideoTrack;

      // If track is null or muted, inspect sender parameters
      const byCodecs = senders.find((s) => {
        try {
          const params = s.getParameters?.();
          return params?.codecs?.some((c) => c.mimeType?.toLowerCase().includes('video'));
        } catch {
          return false;
        }
      });
      if (byCodecs) return byCodecs;

      // Otherwise return sender where kind wasn't audio
      const nonAudio = senders.find((s) => !s.track || s.track.kind !== 'audio');
      if (nonAudio) return nonAudio;
    } catch (e) {
      console.warn('getSenders inspection failed:', e);
    }
  }

  return null;
};

/**
 * Request a camera video stream using progressive constraint fallbacks.
 * Prevents throwing on strict constraints (e.g. OverconstrainedError on devices
 * that don't support exact facingMode or high resolutions).
 *
 * @param {'user'|'environment'} targetFacingMode
 * @param {string|null} preferredDeviceId
 * @returns {Promise<MediaStream>}
 */
export const requestCameraStream = async (targetFacingMode, preferredDeviceId = null) => {
  if (!isMediaDevicesSupported()) {
    throw new Error('MediaDevices API is not supported in this browser or context.');
  }

  // Constraint sets to try sequentially
  const constraintPlans = [];

  // Plan 1: If a preferred device ID is available, try targeting it directly
  if (preferredDeviceId) {
    constraintPlans.push({
      video: { deviceId: { exact: preferredDeviceId } },
      audio: false,
    });
  }

  // Plan 2: Exact facingMode (supported by most mobile browsers)
  constraintPlans.push({
    video: { facingMode: { exact: targetFacingMode } },
    audio: false,
  });

  // Plan 3: Ideal facingMode (soft preference for mobile and desktop)
  constraintPlans.push({
    video: { facingMode: { ideal: targetFacingMode } },
    audio: false,
  });

  // Plan 4: Simple facingMode string
  constraintPlans.push({
    video: { facingMode: targetFacingMode },
    audio: false,
  });

  // Plan 5: Basic video fallback if facingMode constraints fail
  constraintPlans.push({
    video: true,
    audio: false,
  });

  let lastError = null;

  for (const constraints of constraintPlans) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      if (stream && stream.getVideoTracks().length > 0) {
        return stream;
      }
      // If stream has no video tracks, stop it and continue
      if (stream) {
        stopMediaStream(stream);
      }
    } catch (err) {
      lastError = err;
      // If error indicates hardware lock or device contention, rethrow immediately
      // so caller's controlled fallback can release the old track
      if (
        err.name === 'NotReadableError' ||
        err.name === 'TrackStartError' ||
        err.name === 'AbortError'
      ) {
        throw err;
      }
      // For constraint errors (OverconstrainedError, NotFoundError, etc.), try next plan
    }
  }

  throw lastError || new Error(`Failed to acquire camera for facingMode: ${targetFacingMode}`);
};

/**
 * Safely stop all tracks on a MediaStream.
 *
 * @param {MediaStream|null} stream
 */
export const stopMediaStream = (stream) => {
  if (!stream) return;
  try {
    stream.getTracks().forEach((track) => {
      try {
        if (track && track.readyState !== 'ended') {
          track.stop();
        }
      } catch (e) {
        console.warn('Error stopping track:', e);
      }
    });
  } catch (e) {
    console.warn('Error stopping stream tracks:', e);
  }
};

/**
 * Map native media errors to friendly, actionable messages.
 *
 * @param {Error|null} err
 * @returns {string}
 */
export const getHumanReadableMediaError = (err) => {
  if (!err) return 'An unknown camera error occurred.';

  const errorMessages = {
    NotAllowedError: '❌ Camera permission denied. Please allow camera access in your browser settings.',
    PermissionDeniedError: '❌ Camera permission denied.',
    NotFoundError: '❌ No camera found matching the requested mode.',
    DevicesNotFoundError: '❌ No camera devices found on this system.',
    NotReadableError: '❌ Camera is currently busy or in use by another application.',
    TrackStartError: '❌ Could not start camera source. Another application may be using it.',
    OverconstrainedError: '❌ Requested camera resolution or mode is not supported by your hardware.',
    ConstraintNotSatisfiedError: '❌ Camera constraints could not be satisfied.',
    AbortError: '❌ Camera acquisition was aborted.',
    SecurityError: '❌ Camera access requires HTTPS or a secure localhost connection.',
  };

  return errorMessages[err.name] || err.message || 'Could not switch camera.';
};
