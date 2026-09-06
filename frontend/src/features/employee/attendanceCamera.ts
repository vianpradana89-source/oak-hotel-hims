export type AttendanceCameraPhase = 'idle' | 'requesting' | 'live' | 'captured' | 'error';
export type AttendanceCameraEvent = 'start' | 'ready' | 'fail' | 'capture' | 'retake' | 'reset';
export type AttendanceCaptureSource = 'live' | null;

export const ATTENDANCE_CAMERA_COPY = {
  requesting: 'Membuka kamera...',
  error: 'Kamera belum dapat dibuka',
  retry: 'Buka Kamera',
  retake: 'Foto Ulang',
  capture: 'Ambil Foto'
} as const;

export function applyAttendanceCameraEvent(
  current: AttendanceCameraPhase,
  event: AttendanceCameraEvent
): AttendanceCameraPhase {
  switch (event) {
    case 'start':
    case 'retake':
      return 'requesting';
    case 'ready':
      return current === 'requesting' ? 'live' : current;
    case 'fail':
      return 'error';
    case 'capture':
      return current === 'live' ? 'captured' : current;
    case 'reset':
      return 'idle';
    default:
      return current;
  }
}

export function shouldMirrorAttendanceFacing(facingMode: string | undefined | null): boolean {
  return facingMode !== 'environment';
}

export function isFrontFacingStream(stream: MediaStream): boolean {
  const facing = stream.getVideoTracks()[0]?.getSettings()?.facingMode;
  return shouldMirrorAttendanceFacing(facing);
}

export function stopMediaStream(stream: MediaStream | null | undefined): void {
  if (!stream) return;
  stream.getTracks().forEach((track) => {
    try {
      track.stop();
    } catch {
      /* already ended */
    }
  });
}

export function canSubmitAttendanceSelfie(options: {
  requirePhoto: boolean;
  photoBlob: Blob | null;
  captureSource: AttendanceCaptureSource;
}): boolean {
  if (!options.requirePhoto) {
    return options.photoBlob == null || options.captureSource === 'live';
  }
  return options.photoBlob != null && options.captureSource === 'live';
}

export function attendanceGateAllowsFileUpload(): boolean {
  return false;
}

export function createCameraStartGuard() {
  let generation = 0;
  return {
    next(): number {
      generation += 1;
      return generation;
    },
    isCurrent(id: number): boolean {
      return id === generation;
    },
    invalidate(): void {
      generation += 1;
    }
  };
}

export async function attachStreamToVideo(
  video: HTMLVideoElement,
  stream: MediaStream
): Promise<void> {
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  if (video.readyState < 1) {
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('VIDEO_METADATA_TIMEOUT')), 8000);
      const onReady = () => {
        clearTimeout(timeout);
        video.removeEventListener('loadedmetadata', onReady);
        resolve();
      };
      video.addEventListener('loadedmetadata', onReady);
    });
  }
  await video.play();
}
