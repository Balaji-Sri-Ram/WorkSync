import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isMediaDevicesSupported,
  getVideoDevices,
  findCandidateDevice,
  getVideoSender,
  requestCameraStream,
  stopMediaStream,
  getHumanReadableMediaError,
} from './cameraUtils.js';

const originalNavigatorDesc = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

function setMockNavigator(mock) {
  Object.defineProperty(globalThis, 'navigator', {
    value: mock,
    configurable: true,
    writable: true,
  });
}

describe('WebRTC Camera Utilities', () => {
  afterEach(() => {
    if (originalNavigatorDesc) {
      Object.defineProperty(globalThis, 'navigator', originalNavigatorDesc);
    }
  });

  describe('isMediaDevicesSupported', () => {
    test('returns false when mediaDevices is undefined', () => {
      setMockNavigator({});
      assert.equal(isMediaDevicesSupported(), false);
    });

    test('returns true when getUserMedia is a function', () => {
      setMockNavigator({
        mediaDevices: {
          getUserMedia: async () => {},
        },
      });
      assert.equal(isMediaDevicesSupported(), true);
    });
  });

  describe('getVideoDevices', () => {
    test('filters out audio devices and returns only videoinput devices', async () => {
      setMockNavigator({
        mediaDevices: {
          getUserMedia: async () => {},
          enumerateDevices: async () => [
            { kind: 'audioinput', deviceId: 'mic-1', label: 'Microphone' },
            { kind: 'videoinput', deviceId: 'cam-front', label: 'Front Camera' },
            { kind: 'videoinput', deviceId: 'cam-back', label: 'Back Camera' },
            { kind: 'audiooutput', deviceId: 'spk-1', label: 'Speaker' },
          ],
        },
      });

      const videoDevices = await getVideoDevices();
      assert.equal(videoDevices.length, 2);
      assert.equal(videoDevices[0].deviceId, 'cam-front');
      assert.equal(videoDevices[1].deviceId, 'cam-back');
    });

    test('returns empty array when enumerateDevices throws or fails', async () => {
      setMockNavigator({
        mediaDevices: {
          getUserMedia: async () => {},
          enumerateDevices: async () => {
            throw new Error('Permission denied');
          },
        },
      });

      const videoDevices = await getVideoDevices();
      assert.deepEqual(videoDevices, []);
    });
  });

  describe('findCandidateDevice', () => {
    const devices = [
      { kind: 'videoinput', deviceId: 'dev-1', label: 'Front Facing Camera (Selfie)' },
      { kind: 'videoinput', deviceId: 'dev-2', label: 'Back Camera 0 (Wide)' },
      { kind: 'videoinput', deviceId: 'dev-3', label: 'Back Ultra Wide Camera' },
    ];

    test('selects rear camera when switching to environment', () => {
      const match = findCandidateDevice(devices, 'environment', 'dev-1');
      assert.equal(match.deviceId, 'dev-2');
    });

    test('selects front camera when switching to user', () => {
      const match = findCandidateDevice(devices, 'user', 'dev-2');
      assert.equal(match.deviceId, 'dev-1');
    });

    test('excludes the currently active device ID', () => {
      const match = findCandidateDevice(devices, 'environment', 'dev-2');
      assert.equal(match.deviceId, 'dev-3');
    });

    test('returns null when no candidate devices exist', () => {
      assert.equal(findCandidateDevice([], 'environment'), null);
      assert.equal(findCandidateDevice([{ deviceId: 'only-one' }], 'environment', 'only-one'), null);
    });
  });

  describe('getVideoSender', () => {
    test('extracts video sender from peer connection transceivers', () => {
      const mockVideoSender = { track: { kind: 'video' } };
      const mockAudioSender = { track: { kind: 'audio' } };

      const pc = {
        getTransceivers: () => [
          { sender: mockAudioSender, receiver: { track: { kind: 'audio' } } },
          { sender: mockVideoSender, receiver: { track: { kind: 'video' } } },
        ],
      };

      const result = getVideoSender(pc);
      assert.equal(result, mockVideoSender);
    });

    test('falls back to getSenders when transceivers are unavailable', () => {
      const mockVideoSender = { track: { kind: 'video' } };
      const mockAudioSender = { track: { kind: 'audio' } };

      const pc = {
        getSenders: () => [mockAudioSender, mockVideoSender],
      };

      const result = getVideoSender(pc);
      assert.equal(result, mockVideoSender);
    });

    test('returns null when no pc or no video sender exists', () => {
      assert.equal(getVideoSender(null), null);
      assert.equal(getVideoSender({ getSenders: () => [] }), null);
    });
  });

  describe('requestCameraStream', () => {
    test('tries exact facingMode first, then falls back to ideal and simple constraints', async () => {
      const attempts = [];
      const mockStream = {
        getVideoTracks: () => [{ kind: 'video', readyState: 'live', stop: () => {} }],
      };

      setMockNavigator({
        mediaDevices: {
          getUserMedia: async (constraints) => {
            attempts.push(constraints);
            if (constraints.video.facingMode?.exact) {
              const err = new Error('Constraint not satisfied');
              err.name = 'OverconstrainedError';
              throw err;
            }
            return mockStream;
          },
        },
      });

      const stream = await requestCameraStream('environment');
      assert.equal(stream, mockStream);
      assert.equal(attempts.length, 2);
      assert.deepEqual(attempts[0].video, { facingMode: { exact: 'environment' } });
      assert.deepEqual(attempts[1].video, { facingMode: { ideal: 'environment' } });
    });

    test('immediately rethrows hardware lock errors (NotReadableError)', async () => {
      setMockNavigator({
        mediaDevices: {
          getUserMedia: async () => {
            const err = new Error('Device busy');
            err.name = 'NotReadableError';
            throw err;
          },
        },
      });

      await assert.rejects(
        async () => {
          await requestCameraStream('environment');
        },
        (err) => err.name === 'NotReadableError'
      );
    });
  });

  describe('stopMediaStream', () => {
    test('stops all active tracks on the stream', () => {
      let stoppedCount = 0;
      const stream = {
        getTracks: () => [
          { readyState: 'live', stop: () => { stoppedCount++; } },
          { readyState: 'live', stop: () => { stoppedCount++; } },
          { readyState: 'ended', stop: () => { stoppedCount++; } }, // already ended
        ],
      };

      stopMediaStream(stream);
      assert.equal(stoppedCount, 2);
    });
  });

  describe('getHumanReadableMediaError', () => {
    test('provides clear messages for standard media errors', () => {
      assert.match(getHumanReadableMediaError({ name: 'NotAllowedError' }), /permission denied/i);
      assert.match(getHumanReadableMediaError({ name: 'NotFoundError' }), /no camera found/i);
      assert.match(getHumanReadableMediaError({ name: 'NotReadableError' }), /busy or in use/i);
      assert.match(getHumanReadableMediaError({ name: 'OverconstrainedError' }), /not supported/i);
      assert.match(getHumanReadableMediaError({ name: 'SecurityError' }), /HTTPS/i);
    });
  });
});
