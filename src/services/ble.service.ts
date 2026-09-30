/**
 * HELP Telecare — BLE Service Layer
 * Manages BLE connection to ESP32 HELP device
 * 
 * GATT Characteristics:
 *   0xFFF1 — Telemetry (NOTIFY): vital signs JSON every 1s
 *   0xFFF2 — Command (WRITE): send commands to device
 *   0xFFF4 — Emergency (NOTIFY): SOS/fall alerts
 *   0xFFF5 — Biosensor (NOTIFY): rich sensor data
 *   0xFFF6 — Audio (NOTIFY): Opus audio stream (emergency only)
 */

import { BleClient, BleDevice, numbersToDataView, dataViewToText } from '@capacitor-community/bluetooth-le';
import { getBleInitOptions, getPlatform, platformLog } from './platform.service';

// ═══════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════
const SERVICE_UUID = '0000fff0-0000-1000-8000-00805f9b34fb';
const CHAR_TELEMETRY = '0000fff1-0000-1000-8000-00805f9b34fb';
const CHAR_COMMAND   = '0000fff2-0000-1000-8000-00805f9b34fb';
const CHAR_EMERGENCY = '0000fff4-0000-1000-8000-00805f9b34fb';
const CHAR_BIOSENSOR = '0000fff5-0000-1000-8000-00805f9b34fb';
const CHAR_AUDIO     = '0000fff6-0000-1000-8000-00805f9b34fb';

const SCAN_TIMEOUT_MS = 15000;
const RECONNECT_DELAY_MS = 3000;
const MAX_RECONNECT_ATTEMPTS = 100; // Essentially infinite reconnects

export type BleConnectionState = 'disconnected' | 'scanning' | 'connecting' | 'connected' | 'reconnecting';

export interface TelemetryData {
  heart_rate?: number;
  spo2?: number;
  temperature?: number;
  frequency?: number;
  step?: number;
  total_steps?: number;
  state?: string;
  battery?: number;
  op_duration_sec?: number;
  playlist_remaining?: number;
  playlist_state?: string;
  [key: string]: unknown;
}

export interface EmergencyEvent {
  type: 'FALL' | 'SOS' | 'ANOMALY';
  timestamp: string;
  data?: Record<string, unknown>;
}

export type BleEventCallback = {
  onStateChange?: (state: BleConnectionState) => void;
  onTelemetry?: (data: TelemetryData) => void;
  onEmergency?: (event: EmergencyEvent) => void;
  onBiosensor?: (data: Record<string, unknown>) => void;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', msg: string) => void;
};

// ═══════════════════════════════════════════════════════════
// BLE Service Class
// ═══════════════════════════════════════════════════════════
export class BleService {
  private device: BleDevice | null = null;
  private state: BleConnectionState = 'disconnected';
  private callbacks: BleEventCallback = {};
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private initialized = false;
  private shouldAutoReconnect = true;
  private lastTelemetryTime = 0;
  private deviceMac = '';

  /** Get current connection state */
  getState(): BleConnectionState { return this.state; }

  /** Get connected device MAC */
  getDeviceMac(): string { return this.deviceMac; }

  /** Get last telemetry timestamp */
  getLastTelemetryTime(): number { return this.lastTelemetryTime; }

  /** Register event callbacks */
  setCallbacks(cb: BleEventCallback): void {
    this.callbacks = cb;
  }

  /** Initialize BLE */
  async initialize(): Promise<boolean> {
    try {
      const initOptions = getBleInitOptions();
      await BleClient.initialize(initOptions);
      this.initialized = true;
      this.log('info', 'BLE initialized');
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `BLE init failed: ${msg}`);
      return false;
    }
  }

  /** Scan and connect to first HELP device */
  async scanAndConnect(): Promise<boolean> {
    if (!this.initialized) {
      const ok = await this.initialize();
      if (!ok) return false;
    }

    this.setState('scanning');
    this.log('info', 'Scanning for HELP devices...');

    return new Promise<boolean>((resolve) => {
      let found = false;
      const timeout = setTimeout(async () => {
        if (!found) {
          try { await BleClient.stopLEScan(); } catch (_) { /* ignore */ }
          this.log('warn', 'Scan timeout — no HELP device found');
          this.setState('disconnected');
          resolve(false);
        }
      }, SCAN_TIMEOUT_MS);

      BleClient.requestLEScan(
        { services: [SERVICE_UUID] },
        async (result) => {
          if (found) return;
          found = true;
          clearTimeout(timeout);

          try { await BleClient.stopLEScan(); } catch (_) { /* ignore */ }

          const dev = result.device;
          this.log('success', `Found: ${dev.name || dev.deviceId}`);
          this.device = dev;
          this.deviceMac = dev.deviceId;

          const connected = await this.connectToDevice(dev);
          resolve(connected);
        }
      ).catch((e: unknown) => {
        clearTimeout(timeout);
        const msg = e instanceof Error ? e.message : String(e);
        this.log('error', `Scan failed: ${msg}`);
        this.setState('disconnected');
        resolve(false);
      });
    });
  }

  /** Connect to a specific device */
  private async connectToDevice(device: BleDevice): Promise<boolean> {
    this.setState('connecting');
    this.log('info', `Connecting to ${device.deviceId}...`);

    try {
      await BleClient.connect(device.deviceId, (deviceId) => {
        this.log('warn', `Disconnected from ${deviceId}`);
        this.setState('disconnected');
        if (this.shouldAutoReconnect) {
          this.scheduleReconnect();
        }
      });

      this.log('success', 'Connected! Subscribing to notifications...');

      // Subscribe to telemetry
      await BleClient.startNotifications(
        device.deviceId,
        SERVICE_UUID,
        CHAR_TELEMETRY,
        (value) => this.handleTelemetry(value)
      );

      // Subscribe to emergency
      try {
        await BleClient.startNotifications(
          device.deviceId,
          SERVICE_UUID,
          CHAR_EMERGENCY,
          (value) => this.handleEmergency(value)
        );
      } catch (_) {
        this.log('warn', 'Emergency characteristic not available');
      }

      // Subscribe to biosensor
      try {
        await BleClient.startNotifications(
          device.deviceId,
          SERVICE_UUID,
          CHAR_BIOSENSOR,
          (value) => this.handleBiosensor(value)
        );
      } catch (_) {
        this.log('warn', 'Biosensor characteristic not available');
      }

      this.setState('connected');
      this.reconnectAttempts = 0;
      this.log('success', 'All notifications active ✓');
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `Connection failed: ${msg}`);
      this.setState('disconnected');
      if (this.shouldAutoReconnect) {
        this.scheduleReconnect();
      }
      return false;
    }
  }

  /** Send command to ESP32 via GATT write */
  async sendCommand(command: string): Promise<boolean> {
    if (!this.device || this.state !== 'connected') {
      this.log('error', 'Cannot send command — not connected');
      return false;
    }

    try {
      const encoder = new TextEncoder();
      const data = encoder.encode(command);
      const dataView = numbersToDataView(Array.from(data));

      try {
        // Try standard write-with-response first
        await BleClient.write(
          this.device.deviceId,
          SERVICE_UUID,
          CHAR_COMMAND,
          dataView
        );
      } catch {
        // Fallback to writeWithoutResponse (firmware supports WRITE_NO_RSP)
        this.log('warn', 'Write-with-response failed, trying writeWithoutResponse...');
        await BleClient.writeWithoutResponse(
          this.device.deviceId,
          SERVICE_UUID,
          CHAR_COMMAND,
          dataView
        );
      }
      this.log('info', `Command sent: ${command.substring(0, 50)}`);
      return true;
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `Command failed: ${msg}`);
      return false;
    }
  }

  /** Disconnect from device */
  async disconnect(): Promise<void> {
    this.shouldAutoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.device) {
      try {
        await BleClient.disconnect(this.device.deviceId);
      } catch (_) { /* ignore */ }
    }
    this.device = null;
    this.setState('disconnected');
    this.log('info', 'Disconnected');
  }

  /** Enable auto-reconnect and start scanning */
  enableAutoReconnect(): void {
    this.shouldAutoReconnect = true;
  }

  // ─── Private Methods ─────────────────────────────────────

  private handleTelemetry(value: DataView): void {
    try {
      const text = dataViewToText(value);
      const data: TelemetryData = JSON.parse(text);
      this.lastTelemetryTime = Date.now();
      this.callbacks.onTelemetry?.(data);
    } catch (e: unknown) {
      // Binary telemetry or malformed JSON — skip
    }
  }

  private handleEmergency(value: DataView): void {
    try {
      const text = dataViewToText(value);
      const data = JSON.parse(text);
      const event: EmergencyEvent = {
        type: data.type || 'SOS',
        timestamp: data.timestamp || new Date().toISOString(),
        data,
      };
      this.log('error', `🚨 EMERGENCY: ${event.type}`);
      this.callbacks.onEmergency?.(event);
    } catch (_) { /* ignore */ }
  }

  private handleBiosensor(value: DataView): void {
    try {
      const text = dataViewToText(value);
      const data = JSON.parse(text);
      this.callbacks.onBiosensor?.(data);
    } catch (_) { /* ignore */ }
  }

  private scheduleReconnect(): void {
    if (this.reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      this.log('error', 'Max reconnect attempts reached');
      return;
    }

    this.reconnectAttempts++;
    const delay = Math.min(RECONNECT_DELAY_MS * Math.pow(1.5, this.reconnectAttempts - 1), 30000);
    this.setState('reconnecting');
    this.log('info', `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})...`);

    this.reconnectTimer = setTimeout(async () => {
      if (this.device && this.shouldAutoReconnect) {
        const ok = await this.connectToDevice(this.device);
        if (!ok && this.shouldAutoReconnect) {
          // Try a fresh scan instead
          this.scanAndConnect();
        }
      } else if (this.shouldAutoReconnect) {
        this.scanAndConnect();
      }
    }, delay);
  }

  private setState(s: BleConnectionState): void {
    if (this.state !== s) {
      this.state = s;
      this.callbacks.onStateChange?.(s);
    }
  }

  private log(level: 'info' | 'success' | 'warn' | 'error', msg: string): void {
    platformLog('BLE', msg);
    this.callbacks.onLog?.(level, `[BLE] ${msg}`);
  }
}

/** Singleton */
export const bleService = new BleService();
