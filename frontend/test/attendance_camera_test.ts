import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ATTENDANCE_CAMERA_COPY,
  applyAttendanceCameraEvent,
  attachStreamToVideo,
  attendanceGateAllowsFileUpload,
  canSubmitAttendanceSelfie,
  createCameraStartGuard,
  shouldMirrorAttendanceFacing,
  stopMediaStream,
  type AttendanceCameraPhase
} from '../src/features/employee/attendanceCamera.ts';

let assertions = 0;
const check = (condition: unknown, message: string) => {
  assert.ok(condition, message);
  assertions += 1;
};

const here = path.dirname(fileURLToPath(import.meta.url));
const gateSrc = fs.readFileSync(path.join(here, '..', 'src/features/employee/AttendanceGateScreen.tsx'), 'utf8');

console.log('=== OAK HIMS Attendance Live Camera Tests ===\n');

console.log('--- 1. Explicit camera state machine ---');
const flow: AttendanceCameraPhase[] = [];
let phase: AttendanceCameraPhase = 'idle';
phase = applyAttendanceCameraEvent(phase, 'start');
flow.push(phase);
phase = applyAttendanceCameraEvent(phase, 'ready');
flow.push(phase);
phase = applyAttendanceCameraEvent(phase, 'capture');
flow.push(phase);
phase = applyAttendanceCameraEvent(phase, 'retake');
flow.push(phase);
check(flow[0] === 'requesting', 'auto/start enters requesting, not idle empty/file state');
check(flow[1] === 'live', 'ready only from requesting marks live');
check(flow[2] === 'captured', 'capture from live marks captured');
check(flow[3] === 'requesting', 'retake immediately restarts camera (requesting), no file fallback');
check(applyAttendanceCameraEvent('live', 'ready') === 'live', 'ready is ignored unless requesting');
check(applyAttendanceCameraEvent('requesting', 'fail') === 'error', 'startup failure is error');
check(applyAttendanceCameraEvent('error', 'start') === 'requesting', 'retry from error restarts camera');

console.log('--- 2. Auto-open and fallback copy ---');
check(gateSrc.includes('startCameraRef.current()'), 'gate auto-starts camera when selfie-ready');
check(gateSrc.includes("facingMode: 'user'"), 'front camera is requested');
check(gateSrc.includes('ATTENDANCE_CAMERA_COPY.requesting'), 'requesting overlay copy is shown');
check(gateSrc.includes('ATTENDANCE_CAMERA_COPY.error'), 'startup failure copy is shown');
check(gateSrc.includes('ATTENDANCE_CAMERA_COPY.retry'), 'Buka Kamera retry exists for failure/gesture');
check(ATTENDANCE_CAMERA_COPY.requesting === 'Membuka kamera...', 'requesting copy is exact');
check(ATTENDANCE_CAMERA_COPY.error === 'Kamera belum dapat dibuka', 'error copy is exact');
check(ATTENDANCE_CAMERA_COPY.retry === 'Buka Kamera', 'retry button copy is exact');

console.log('--- 3. No gallery / file upload path ---');
check(attendanceGateAllowsFileUpload() === false, 'helper forbids file upload');
check(!gateSrc.includes('Pilih File'), 'Pilih File is removed from attendance gate');
check(!gateSrc.includes('type="file"'), 'no file input in attendance gate');
check(!gateSrc.includes('handleFileInputChange'), 'gallery upload handler is removed');
check(!gateSrc.includes('fileInputRef'), 'file input ref is removed');
check(!gateSrc.includes("capture=\"user\""), 'legacy capture file input is removed');

console.log('--- 4. Submit requires a new live capture ---');
check(canSubmitAttendanceSelfie({
  requirePhoto: true,
  photoBlob: null,
  captureSource: null
}) === false, 'submit disabled without live capture when photo required');
check(canSubmitAttendanceSelfie({
  requirePhoto: true,
  photoBlob: new Blob(['x'], { type: 'image/jpeg' }),
  captureSource: null
}) === false, 'a blob without live source cannot submit');
check(canSubmitAttendanceSelfie({
  requirePhoto: true,
  photoBlob: new Blob(['x'], { type: 'image/jpeg' }),
  captureSource: 'live'
}) === true, 'live capture enables submit when photo required');
check(canSubmitAttendanceSelfie({
  requirePhoto: false,
  photoBlob: null,
  captureSource: null
}) === true, 'optional photo still allows submit without a selfie');
check(gateSrc.includes('captureSource'), 'gate tracks live capture source');
check(gateSrc.includes("setCaptureSource('live')"), 'only live capture sets the submit source');

console.log('--- 5. Stream cleanup and start-guard ---');
const stopped: string[] = [];
const fakeStream = {
  getTracks: () => [
    { stop: () => { stopped.push('v'); } },
    { stop: () => { stopped.push('a'); } }
  ]
} as unknown as MediaStream;
stopMediaStream(fakeStream);
check(stopped.join('') === 'va', 'stopMediaStream stops every track');
stopMediaStream(null);
check(true, 'stopMediaStream accepts a null stream');

const guard = createCameraStartGuard();
const first = guard.next();
const second = guard.next();
check(guard.isCurrent(first) === false, 'older getUserMedia generation is stale');
check(guard.isCurrent(second) === true, 'latest start generation is current');
guard.invalidate();
check(guard.isCurrent(second) === false, 'unmount/retake invalidates in-flight starts');
check(gateSrc.includes('cameraGuardRef'), 'gate uses a start-generation guard');
check(gateSrc.includes('stopMediaStream'), 'gate stops tracks on replace/unmount');

console.log('--- 6. Video becomes live only after play/metadata ---');
check(gateSrc.includes('attachStreamToVideo'), 'stream is attached through play/metadata helper');
let played = false;
let metadataBound = false;
const fakeVideo = {
  srcObject: null as MediaStream | null,
  muted: false,
  playsInline: false,
  readyState: 0,
  addEventListener(event: string, handler: () => void) {
    if (event === 'loadedmetadata') {
      metadataBound = true;
      handler();
    }
  },
  removeEventListener() {},
  play: async () => { played = true; }
} as unknown as HTMLVideoElement;
await attachStreamToVideo(fakeVideo, fakeStream);
check(fakeVideo.srcObject === fakeStream, 'srcObject is assigned before play');
check(fakeVideo.muted === true, 'video is muted for autoplay');
check(metadataBound === true, 'waits for loadedmetadata when not ready');
check(played === true, 'video.play() is attempted');

console.log('--- 7. Mirror behavior preserved ---');
check(shouldMirrorAttendanceFacing('user') === true, 'front camera is mirrored');
check(shouldMirrorAttendanceFacing(undefined) === true, 'unknown facing defaults to mirrored front');
check(shouldMirrorAttendanceFacing('environment') === false, 'rear camera is not mirrored');
check(gateSrc.includes('drawImage(video, 0, 0'), 'capture draws unflipped bytes');
check(gateSrc.includes('setCapturedPreviewMirrored(livePreviewMirrored)'), 'captured preview may stay visually mirrored');
check(gateSrc.includes('isFrontFacingStream(stream)'), 'live mirror follows actual stream facing');

console.log(`\n=== PASSED: ${assertions} assertions ===`);
