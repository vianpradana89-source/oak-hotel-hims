import { Client, type Pool } from 'pg';

/** Fixed channel name — never built from user input. */
const CHANNEL = 'oak_hims_realtime';

/** PostgreSQL NOTIFY payload is limited to ~8000 bytes. Stay conservative. */
const MAX_NOTIFY_PAYLOAD_BYTES = 7900;

export type RealtimeEvent = {
  eventType: string;
  propertyId: number;
  payload: Record<string, unknown> | null;
  timestamp: string;
};

export type PostgresRealtimeBus = {
  /**
   * Publish an event to PostgreSQL via the shared pool.
   * Returns true on success, false on validation or publish failure.
   * Never throws.
   */
  publish(eventType: string, payload: unknown, propertyId: number): Promise<boolean>;

  /**
   * Start the dedicated LISTEN client.
   * Idempotent while already connecting/listening.
   * May be called again after stop() to restart.
   */
  start(onEvent: (event: RealtimeEvent) => void): Promise<void>;

  /**
   * Stop the LISTEN client. Ends in-flight connections and cancels pending reconnects.
   * Returns a promise that resolves once the client is closed.
   * Safe to call multiple times.
   */
  stop(): Promise<void>;
};

type Phase = 'idle' | 'connecting' | 'listening' | 'stopping';

type BusInner = {
  phase: Phase;
  client: Client | null;
  onEvent: (event: RealtimeEvent) => void;
  connectGen: number; // monotonic counter; increments each time we start a new connect attempt
};

function isPositiveInteger(v: unknown): v is number {
  if (typeof v !== 'number' || !Number.isFinite(v) || !Number.isInteger(v)) {
    return false;
  }
  return v > 0;
}

function isValidEventType(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidPayload(v: unknown): v is Record<string, unknown> | null {
  return v === null || (typeof v === 'object' && !Array.isArray(v));
}

function parseNotification(raw: string): RealtimeEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const obj = parsed as Record<string, unknown>;
  if (!isValidEventType(obj.eventType)) return null;
  if (!isPositiveInteger(obj.propertyId)) return null;
  if (!isValidPayload(obj.payload)) return null;
  const ts = typeof obj.timestamp === 'string' && obj.timestamp.length > 0
    ? obj.timestamp
    : new Date().toISOString();
  return {
    eventType: obj.eventType.trim(),
    propertyId: obj.propertyId,
    payload: obj.payload as Record<string, unknown> | null,
    timestamp: ts,
  };
}

/** Safely end a client without throwing on already-closed instances. */
async function safeEnd(client: Client): Promise<void> {
  try {
    await client.end();
  } catch {
    // Already closed or connection lost — ignore
  }
}

/**
 * Check whether this generation is still the active one.
 * Returns true when the client is still owned by this generation and stop has not been requested.
 */
function isActiveGeneration(
  client: Client,
  gen: number,
  inner: BusInner,
  stoppedFlag: boolean,
): boolean {
  if (stoppedFlag) return false;
  if (inner.phase === 'stopping') return false;
  if (inner.client !== client) return false;
  if (inner.connectGen !== gen) return false;
  return true;
}

export function createPostgresRealtimeBus(config: {
  pool: Pool;
  listenerConfig: {
    host: string;
    port: number;
    user: string;
    password: string;
    database: string;
  };
  /** TEMP REALTIME-2B DIAGNOSTICS — same value shared across all bus log lines. */
  diagnosticInstanceId?: string;
}): PostgresRealtimeBus {
  // TEMP REALTIME-2B DIAGNOSTICS: use caller-provided ID so all logs in one process share the same ID
  const diagnosticInstanceId = config.diagnosticInstanceId || `pid-${process.pid}`;
  let inner: BusInner = {
    phase: 'idle',
    client: null,
    onEvent: () => undefined,
    connectGen: 0,
  };
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectDelay = 1_000;
  const MAX_RECONNECT_MS = 30_000;
  let stoppedFlag = false;

  function clearReconnectTimer() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  /**
   * Schedule a reconnect with exponential backoff.
   * Guards against scheduling from a stale generation or while stopping.
   */
  function scheduleReconnect(nextOnEvent: (event: RealtimeEvent) => void, gen: number) {
    if (stoppedFlag) return;
    if (inner.phase === 'stopping') return;
    // Only reschedule if this generation is still the latest
    if (inner.connectGen !== gen) return;
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectAndListen(nextOnEvent);
    }, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, MAX_RECONNECT_MS);
  }

  /**
   * Attempt to connect a dedicated LISTEN client and attach the notification handler.
   *
   * Ownership invariant: inner.client references the CURRENTLY ACTIVE client at all times.
   * This client is assigned BEFORE the first await so post-await guards work correctly.
   */
  async function connectAndListen(nextOnEvent: (event: RealtimeEvent) => void) {
    if (stoppedFlag || inner.phase === 'stopping' || inner.phase === 'connecting') return;

    const gen = ++inner.connectGen;
    inner.phase = 'connecting';
    inner.onEvent = nextOnEvent;

    const client = new Client({
      host: config.listenerConfig.host,
      port: config.listenerConfig.port,
      user: config.listenerConfig.user,
      password: config.listenerConfig.password,
      database: config.listenerConfig.database,
    });

    // ASSIGN OWNERSHIP BEFORE THE FIRST AWAIT
    // This is the critical fix: inner.client must reference this client so that
    // post-await guards (client !== inner.client) evaluate correctly.
    inner.client = client;

    // Idempotent single-dispatch disconnect handler
    let disconnectScheduled = false;
    async function handleDisconnect(closeClient: Client) {
      if (disconnectScheduled) return;
      disconnectScheduled = true;
      if (inner.client === client && inner.connectGen === gen && !stoppedFlag && inner.phase !== 'stopping') {
        inner.client = null;
        inner.phase = 'idle';
        // Ensure the dead connection is closed — node-postgres may emit 'end' after 'error'
        await safeEnd(closeClient);
        scheduleReconnect(inner.onEvent, gen);
      }
    }

    client.on('error', (err) => {
      console.error(`[SSE] LISTEN client error: ${err?.message || String(err)}`);
      handleDisconnect(client);
    });
    client.on('end', () => {
      handleDisconnect(client);
    });

    try {
      await client.connect();

      // GUARD after connect(): verify this generation is still active
      if (!isActiveGeneration(client, gen, inner, stoppedFlag)) {
        await safeEnd(client);
        return;
      }

      client.on('notification', (notification: import('pg').Notification) => {
        // Notification events must also respect the active-generation invariant
        if (inner.phase !== 'listening') return;
        if (inner.client !== client || inner.connectGen !== gen) return;
        const event = parseNotification(notification.payload ?? '');
        if (!event) {
          console.warn('[SSE] malformed notification payload ignored');
          return;
        }
        // TEMP REALTIME-2B DIAGNOSTICS
        console.log(`[RT2_NOTIFY_RX] instance=${diagnosticInstanceId} event=${event.eventType} property=${event.propertyId}`);
        inner.onEvent(event);
      });

      await client.query(`LISTEN ${CHANNEL}`);

      // GUARD after LISTEN(): verify this generation is still active
      if (!isActiveGeneration(client, gen, inner, stoppedFlag)) {
        await safeEnd(client);
        return;
      }

      inner.phase = 'listening';
      reconnectDelay = 1_000; // reset backoff on success
      console.log(`[SSE] LISTEN started on channel "${CHANNEL}"`);
    } catch (err: any) {
      // Connection or LISTEN failed
      if (!isActiveGeneration(client, gen, inner, stoppedFlag)) {
        // Stale attempt (newer generation already started or stop requested) — ignore
        await safeEnd(client);
        return;
      }
      console.error(`[SSE] LISTEN connection failed: ${err?.message || String(err)}`);
      // CRITICAL: close the orphaned client before scheduling reconnect to prevent
      // a leaked PostgreSQL connection when connect() succeeded but LISTEN() failed.
      inner.client = null;
      inner.phase = 'idle';
      await safeEnd(client);
      scheduleReconnect(nextOnEvent, gen);
    }
  }

  async function publish(eventType: string, payload: unknown, propertyId: number): Promise<boolean> {
    if (!isValidEventType(eventType)) {
      console.warn('[SSE] publish rejected: invalid eventType');
      return false;
    }
    if (!isPositiveInteger(propertyId)) {
      console.warn(`[SSE] publish rejected: invalid propertyId=${propertyId}`);
      return false;
    }
    if (payload !== null && (typeof payload !== 'object' || Array.isArray(payload))) {
      console.warn('[SSE] publish rejected: payload must be object or null');
      return false;
    }

    let payloadStr: string;
    try {
      payloadStr = JSON.stringify({
        eventType,
        propertyId,
        payload: payload as Record<string, unknown> | null,
        timestamp: new Date().toISOString(),
      });
    } catch {
      console.warn('[SSE] publish rejected: payload serialization failed (circular?)');
      return false;
    }

    // PAYLOAD SIZE SAFETY: PostgreSQL NOTIFY payload limit is ~8000 bytes
    if (Buffer.byteLength(payloadStr, 'utf8') > MAX_NOTIFY_PAYLOAD_BYTES) {
      console.warn(`[SSE] publish rejected: payload exceeds ${MAX_NOTIFY_PAYLOAD_BYTES} bytes`);
      return false;
    }

    try {
      await config.pool.query('SELECT pg_notify($1, $2)', [CHANNEL, payloadStr]);
      // TEMP REALTIME-2B DIAGNOSTICS
      console.log(`[RT2_PUBLISH_OK] instance=${diagnosticInstanceId} event=${eventType} property=${propertyId}`);
      return true;
    } catch (err: any) {
      console.warn(`[SSE] publish failed: ${err?.message || String(err)}`);
      // TEMP REALTIME-2B DIAGNOSTICS
      console.log(`[RT2_PUBLISH_FAIL] instance=${diagnosticInstanceId} event=${eventType} property=${propertyId} error=${err?.message || String(err)}`);
      return false;
    }
  }

  async function start(onEvent: (event: RealtimeEvent) => void): Promise<void> {
    if (inner.phase === 'listening' || inner.phase === 'connecting') return;
    stoppedFlag = false;
    await connectAndListen(onEvent);
  }

  async function stop(): Promise<void> {
    stoppedFlag = true;
    clearReconnectTimer();

    if (inner.phase === 'listening' || inner.phase === 'connecting') {
      inner.phase = 'stopping';
      const client = inner.client;
      // Clear ownership so in-flight handlers know this generation is dead
      inner.client = null;
      if (client) {
        await safeEnd(client);
      }
    }

    inner.phase = 'idle';
    console.log('[SSE] LISTEN stopped');
  }

  return { publish, start, stop };
}
