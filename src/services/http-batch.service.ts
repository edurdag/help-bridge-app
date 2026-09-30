/**
 * HELP Telecare — HTTP Batch Telemetry Service
 * iOS Background fallback: when WebSocket dies in background,
 * this service buffers telemetry and flushes via HTTP POST.
 *
 * On Android: used as HTTP fallback if WebSocket fails.
 * On iOS: primary background telemetry relay mechanism.
 * On Web: not used (WebSocket stays alive in browser tab).
 */

import { getPlatform, getLifecycleState, onLifecycleChange, platformLog } from './platform.service';

export interface BatchFlushResult {
  success: boolean;
  flushedCount: number;
  remainingCount: number;
  error?: string;
}

export interface TelemetryRecord {
  type: 'telemetry' | 'emergency' | 'heartbeat';
  mac: string;
  ts: string;
  data?: Record<string, unknown>;
  event?: Record<string, unknown>;
  [key: string]: unknown;
}

export class HttpBatchService {
  private buffer: TelemetryRecord[] = [];
  private readonly maxBufferSize: number;
  private readonly batchEndpoint: string;
  private readonly deviceMac: string;
  private readonly patientName: string;

  // Flush timer
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushIntervalMs: number;
  private isFlushing = false;

  // Stats
  private totalFlushed = 0;
  private totalDropped = 0;
  private lastFlushTime = 0;
  private consecutiveFailures = 0;

  // IndexedDB for persistent offline storage (survives app kill)
  private dbReady = false;
  private db: IDBDatabase | null = null;
  private readonly DB_NAME = 'help_telemetry_buffer';
  private readonly STORE_NAME = 'records';

  constructor(
    batchEndpoint: string,
    deviceMac: string,
    patientName: string,
    options?: {
      maxBufferSize?: number;
      flushIntervalMs?: number;
    }
  ) {
    this.batchEndpoint = batchEndpoint;
    this.deviceMac = deviceMac;
    this.patientName = patientName;
    this.maxBufferSize = options?.maxBufferSize || 5000;
    this.flushIntervalMs = options?.flushIntervalMs || 30000;

    // Initialize IndexedDB for persistent storage
    this.initIndexedDB();

    // Listen for lifecycle changes — flush when foregrounding
    onLifecycleChange((state) => {
      if (state === 'foreground') {
        this.log('App foregrounded — triggering flush');
        this.flush();
      }
    });
  }

  /** Get buffer size */
  getBufferSize(): number { return this.buffer.length; }

  /** Get stats */
  getStats() {
    return {
      bufferSize: this.buffer.length,
      totalFlushed: this.totalFlushed,
      totalDropped: this.totalDropped,
      lastFlushTime: this.lastFlushTime,
      consecutiveFailures: this.consecutiveFailures,
      dbReady: this.dbReady,
    };
  }

  /** Add a telemetry record to the buffer */
  enqueue(record: TelemetryRecord): void {
    // Emergency records go to front of queue
    if (record.type === 'emergency') {
      this.buffer.unshift(record);
    } else {
      this.buffer.push(record);
    }

    // Enforce max buffer size — drop oldest non-emergency
    while (this.buffer.length > this.maxBufferSize) {
      const idx = this.buffer.findIndex(r => r.type !== 'emergency');
      if (idx >= 0) {
        this.buffer.splice(idx, 1);
        this.totalDropped++;
      } else {
        this.buffer.shift(); // All emergency — drop oldest
        this.totalDropped++;
      }
    }

    // Persist to IndexedDB for crash recovery
    if (this.dbReady) {
      this.persistRecord(record);
    }
  }

  /** Start periodic flush timer */
  startPeriodicFlush(): void {
    this.stopPeriodicFlush();
    this.log(`Starting periodic flush every ${this.flushIntervalMs / 1000}s`);

    this.flushTimer = setInterval(() => {
      if (this.buffer.length > 0) {
        this.flush();
      }
    }, this.flushIntervalMs);
  }

  /** Stop periodic flush */
  stopPeriodicFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Flush buffer to server via HTTP POST */
  async flush(): Promise<BatchFlushResult> {
    if (this.isFlushing || this.buffer.length === 0) {
      return { success: true, flushedCount: 0, remainingCount: this.buffer.length };
    }

    this.isFlushing = true;

    // Take up to 200 records per batch (avoid huge payloads)
    const batch = this.buffer.splice(0, 200);
    const payload = {
      mac: this.deviceMac,
      patient_name: this.patientName,
      platform: getPlatform(),
      batch_size: batch.length,
      records: batch,
      flush_reason: getLifecycleState() === 'background' ? 'background_timer' : 'foreground_flush',
    };

    try {
      const response = await fetch(this.batchEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        // iOS: use keepalive to allow the request to complete in background
        keepalive: true,
      });

      if (response.ok) {
        this.totalFlushed += batch.length;
        this.lastFlushTime = Date.now();
        this.consecutiveFailures = 0;
        this.log(`Flushed ${batch.length} records (${this.buffer.length} remaining)`);

        // Clear from IndexedDB
        if (this.dbReady) {
          this.clearPersistedRecords(batch.length);
        }

        this.isFlushing = false;

        // If more records in buffer, continue flushing
        if (this.buffer.length > 0) {
          return this.flush();
        }

        return { success: true, flushedCount: batch.length, remainingCount: this.buffer.length };
      } else {
        // Server error — put records back
        this.buffer.unshift(...batch);
        this.consecutiveFailures++;
        this.log(`Flush failed (HTTP ${response.status}) — ${batch.length} records returned to buffer`);
        this.isFlushing = false;
        return {
          success: false,
          flushedCount: 0,
          remainingCount: this.buffer.length,
          error: `HTTP ${response.status}`,
        };
      }
    } catch (err) {
      // Network error — put records back
      this.buffer.unshift(...batch);
      this.consecutiveFailures++;
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`Flush network error: ${errMsg}`);
      this.isFlushing = false;
      return {
        success: false,
        flushedCount: 0,
        remainingCount: this.buffer.length,
        error: errMsg,
      };
    }
  }

  /** Restore buffer from IndexedDB after app relaunch */
  async restoreFromPersistence(): Promise<number> {
    if (!this.dbReady || !this.db) return 0;

    return new Promise((resolve) => {
      try {
        const tx = this.db!.transaction(this.STORE_NAME, 'readonly');
        const store = tx.objectStore(this.STORE_NAME);
        const req = store.getAll();

        req.onsuccess = () => {
          const records = req.result || [];
          if (records.length > 0) {
            this.buffer.push(...records);
            this.log(`Restored ${records.length} records from IndexedDB`);
          }
          resolve(records.length);
        };

        req.onerror = () => {
          this.log('IndexedDB restore failed');
          resolve(0);
        };
      } catch (_) {
        resolve(0);
      }
    });
  }

  /** Destroy service */
  destroy(): void {
    this.stopPeriodicFlush();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ─── Private Methods ──────────────────────────────────────

  private initIndexedDB(): void {
    try {
      const request = indexedDB.open(this.DB_NAME, 1);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(this.STORE_NAME)) {
          db.createObjectStore(this.STORE_NAME, { autoIncrement: true });
        }
      };

      request.onsuccess = (event) => {
        this.db = (event.target as IDBOpenDBRequest).result;
        this.dbReady = true;
        this.log('IndexedDB ready for offline persistence');
      };

      request.onerror = () => {
        this.log('IndexedDB init failed — using memory buffer only');
      };
    } catch (_) {
      this.log('IndexedDB not available');
    }
  }

  private persistRecord(record: TelemetryRecord): void {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      tx.objectStore(this.STORE_NAME).add(record);
    } catch (_) { /* ignore */ }
  }

  private clearPersistedRecords(count: number): void {
    if (!this.db) return;
    try {
      const tx = this.db.transaction(this.STORE_NAME, 'readwrite');
      const store = tx.objectStore(this.STORE_NAME);
      const req = store.openCursor();
      let cleared = 0;

      req.onsuccess = (event) => {
        const cursor = (event.target as IDBRequest<IDBCursorWithValue>).result;
        if (cursor && cleared < count) {
          cursor.delete();
          cleared++;
          cursor.continue();
        }
      };
    } catch (_) { /* ignore */ }
  }

  private log(msg: string): void {
    platformLog('BATCH', msg);
  }
}
