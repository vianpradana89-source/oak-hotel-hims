// Utility for Employee Mobile App Icon Badging (Instagram-style numeric badge),
// Web Audio API Urgent Alarm Chime, Vibration, Configurable Duration/Repeats, and Native Notifications.

export type MobileAlarmRepeatMode = '1x' | '3x' | '5x' | '10x' | 'loop';

export const MOBILE_ALARM_REPEAT_OPTIONS: {
  value: MobileAlarmRepeatMode;
  label: string;
  desc: string;
  cycles: number;
}[] = [
  { value: '1x', label: '1x Bunyi (3 Detik)', desc: 'Sekali dering singkat (~3 detik)', cycles: 1 },
  { value: '3x', label: '3x Bunyi (8 Detik)', desc: 'Standar operasional (~8 detik)', cycles: 3 },
  { value: '5x', label: '5x Bunyi (14 Detik)', desc: 'Dering menengah (~14 detik)', cycles: 5 },
  { value: '10x', label: '10x Bunyi (28 Detik)', desc: 'Dering panjang (~28 detik)', cycles: 10 },
  { value: 'loop', label: 'Berulang Sampai Dimatikan', desc: 'Terus berbunyi (maks 60 detik) hingga direspons', cycles: 22 },
];

const ALARM_STORAGE_KEY = 'oak_mobile_alarm_repeat_mode';

let sharedAudioCtx: AudioContext | null = null;
let activeAlarmTimers: Array<ReturnType<typeof setTimeout>> = [];
let activeOscillators: OscillatorNode[] = [];

export function getMobileAlarmRepeatMode(): MobileAlarmRepeatMode {
  if (typeof window === 'undefined') return '3x';
  try {
    const raw = window.localStorage.getItem(ALARM_STORAGE_KEY);
    if (raw === '1x' || raw === '3x' || raw === '5x' || raw === '10x' || raw === 'loop') {
      return raw;
    }
  } catch {
    // ignore
  }
  return '3x';
}

export function setMobileAlarmRepeatMode(mode: MobileAlarmRepeatMode): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ALARM_STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

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

export function stopUrgentHousekeepingAlarm(): void {
  for (const timer of activeAlarmTimers) {
    clearTimeout(timer);
  }
  activeAlarmTimers = [];

  for (const osc of activeOscillators) {
    try {
      osc.stop();
      osc.disconnect();
    } catch {
      // ignore already stopped
    }
  }
  activeOscillators = [];

  try {
    if (typeof navigator !== 'undefined' && typeof navigator.vibrate === 'function') {
      navigator.vibrate(0);
    }
  } catch {
    // ignore
  }
}

function playSingleAlarmCycle(): void {
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
        activeOscillators.push(osc);
      });
    }
  } catch {
    // ignore if audio not yet unlocked
  }
}

export function playUrgentHousekeepingAlarm(overrideMode?: MobileAlarmRepeatMode): void {
  stopUrgentHousekeepingAlarm();

  const mode = overrideMode || getMobileAlarmRepeatMode();
  const option = MOBILE_ALARM_REPEAT_OPTIONS.find((o) => o.value === mode) || MOBILE_ALARM_REPEAT_OPTIONS[1];
  const totalCycles = Math.max(1, option.cycles);

  // Immediately play cycle 1
  playSingleAlarmCycle();

  // Schedule subsequent cycles every 2.7 seconds
  for (let i = 1; i < totalCycles; i++) {
    const t = setTimeout(() => {
      playSingleAlarmCycle();
    }, i * 2700);
    activeAlarmTimers.push(t);
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
