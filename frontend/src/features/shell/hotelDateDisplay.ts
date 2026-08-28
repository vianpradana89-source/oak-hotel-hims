/**
 * Hotel Business Date & Live Time Formatter
 *
 * Provides operational display context in Asia/Jakarta hotel semantics.
 * Note: Browser-rendered clock is advisory display only; backend database
 * timestamps remain authoritative for all financial and audited records.
 */

export function formatHotelBusinessDate(date: Date = new Date()): string {
  try {
    const dtf = new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });

    // Formats into: "Jum, 28 Agu 2026 06:15"
    const parts = dtf.formatToParts(date);
    let weekday = '';
    let day = '';
    let month = '';
    let year = '';
    let hour = '';
    let minute = '';

    for (const part of parts) {
      if (part.type === 'weekday') weekday = part.value;
      if (part.type === 'day') day = part.value;
      if (part.type === 'month') month = part.value;
      if (part.type === 'year') year = part.value;
      if (part.type === 'hour') hour = part.value;
      if (part.type === 'minute') minute = part.value;
    }

    const dateStr = `${weekday}, ${day} ${month} ${year}`;
    const timeStr = `${hour}:${minute} WIB`;

    return `${dateStr} · ${timeStr}`;
  } catch {
    // Fallback if Intl fails
    return date.toLocaleDateString('id-ID');
  }
}

export function formatCompactHotelDate(date: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
