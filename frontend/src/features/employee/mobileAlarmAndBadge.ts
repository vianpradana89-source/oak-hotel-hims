// Utility for Employee Mobile App Icon Badging (Instagram-style numeric badge),
// Web Audio API Urgent Alarm Chime, Vibration, and Native Android/Browser Notifications.

let sharedAudioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx || sharedAudioCtx.state === 'closed') {
    sharedAudioCtx = new AudioCtx();
  }
  if (sharedAudioCtx.state === 'suspended') {
    sharedAudioCtx.resume().catch(() => {});
  }
  return sharedAudioCtx;
}

export function unlockMobileAudioContext(): void {
  try {
    const ctx = getAudioContext();
    if (ctx && ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  } catch {
    // ignore
  }
}

export function updateMobileAppBadge(count: number): void {
  const safeCount = Math.max(0, Math.floor(Number(count) || 0));
  if (typeof document !== 'undefined') {
    document.title = safeCount > 0 ? `(${safeCount}) OAK Lawang` : 'OAK Lawang';
  }
  if (typeof navigator === 'undefined') return;

  try {
    const nav = navigator as any;
    if (typeof nav.setAppBadge === 'function') {
      if (safeCount > 0) {
        nav.setAppBadge(safeCount).catch(() => {});
      } else if (typeof nav.clearAppBadge === 'function') {
        nav.clearAppBadge().catch(() => {});
      }
    }
    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
      navigator.serviceWorker.controller.postMessage({
        type: 'SET_BADGE',
        count: safeCount
      });
    }
  } catch {
    // ignore
  }
}

export function playUrgentHousekeepingAlarm(): void {
  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate([400, 150, 400, 150, 600, 200, 500]);
    }
  } catch {
    // ignore
  }

  try {
    const ctx = getAudioContext();
    if (!ctx) return;

    const now = ctx.currentTime;
    // Play 3 urgent bell/alarm bursts over ~2.2 seconds
    const bursts = [0, 0.75, 1.5];
    const freqs = [880, 1174.66, 1567.98]; // A5 -> D6 -> G6

    for (const offset of bursts) {
      freqs.forEach((freq, idx) => {
        const start = now + offset + idx * 0.14;
        const duration = 0.22;
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'triangle';
        osc.frequency.setValueAtTime(freq, start);

        gain.gain.setValueAtTime(0.001, start);
        gain.gain.exponentialRampToValueAtTime(0.45, start + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, start + duration);

        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(start);
        osc.stop(start + duration);
      });
    }
  } catch {
    // ignore if audio not yet unlocked
  }
}

export async function requestMobileNotificationPermission(): Promise<boolean> {
  if (typeof window === 'undefined' || !('Notification' in window)) return false;
  if (Notification.permission === 'granted') return true;
  if (Notification.permission === 'denied') return false;
  try {
    const perm = await Notification.requestPermission();
    return perm === 'granted';
  } catch {
    return false;
  }
}

export async function triggerUrgentMobileNotification(params: {
  title: string;
  body: string;
  tag?: string;
  badgeCount?: number;
}): Promise<void> {
  if (params.badgeCount !== undefined) {
    updateMobileAppBadge(params.badgeCount);
  }
  playUrgentHousekeepingAlarm();

  if (typeof window === 'undefined' || !('Notification' in window)) return;
  if (Notification.permission !== 'granted') {
    await requestMobileNotificationPermission();
  }
  if (Notification.permission !== 'granted') return;

  const tag = params.tag || `oak-hk-${Date.now()}`;
  try {
    if ('serviceWorker' in navigator) {
      const reg = await navigator.serviceWorker.ready;
      if (reg && typeof reg.showNotification === 'function') {
        await reg.showNotification(params.title, {
          body: params.body,
          icon: '/favicon.png',
          badge: '/favicon.png',
          tag,
          renotify: true,
          requireInteraction: true,
          vibrate: [400, 150, 400, 150, 600]
        } as any);
        return;
      }
    }
  } catch {
    // fallback to window Notification
  }

  try {
    new Notification(params.title, {
      body: params.body,
      icon: '/favicon.png',
      tag
    });
  } catch {
    // ignore
  }
}
