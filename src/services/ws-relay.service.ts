/**
 * HELP Telecare — WebSocket Relay Service
 * Relays BLE telemetry from phone to telecare.help server
 * Implements heartbeat/dead man's switch for patient life protection
 */
import { getPlatformIdentifier, getPlatform, getCapabilities, platformLog, onLifecycleChange } from './platform.service';
export type WsConnectionState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting';

export interface WsEventCallbacks {
  onStateChange?: (state: WsConnectionState) => void;
  onCommand?: (command: Record<string, unknown>) => void;
  onForceShow?: () => void;
  onIncomingCall?: (params: { room: string; token: string; livekit_url: string; caller: string; emergency?: boolean }) => void;
  onEndCall?: (params: { room: string }) => void;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', msg: string) => void;
}

// ═══════════════════════════════════════════════════════════
// WebSocket Relay Service
// ═══════════════════════════════════════════════════════════
export class WebSocketRelay {
  private ws: WebSocket | null = null;
  private state: WsConnectionState = 'disconnected';
  private callbacks: WsEventCallbacks = {};
  private serverUrl: string;
  private deviceMac: string;
  private patientName: string;
  
  // Heartbeat (dead man's switch)
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;
  private readonly HEARTBEAT_INTERVAL_MS = 30000; // 30 seconds
  
  // Reconnect
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempts = 0;
  private maxReconnectDelay = 30000;
  private shouldAutoReconnect = true;
  
  // Offline buffer
  private offlineBuffer: string[] = [];
  private readonly MAX_BUFFER_SIZE = 10000; // ~10K messages buffered offline
  
  // Stats
  private messagesSent = 0;
  private messagesBuffered = 0;
  private lastSendTime = 0;
  private phoneBattery = -1;
  private bleConnected = false;

  constructor(serverUrl: string, deviceMac: string, patientName: string) {
    this.serverUrl = serverUrl;
    this.deviceMac = deviceMac;
    this.patientName = patientName;
  }

  /** Get current state */
  getState(): WsConnectionState { return this.state; }

  /** Register callbacks */
  setCallbacks(cb: WsEventCallbacks): void {
    this.callbacks = cb;
  }

  /** Update phone battery level (included in heartbeat) */
  setPhoneBattery(level: number): void {
    this.phoneBattery = level;
  }

  /** Update BLE connection status (included in heartbeat) */
  setBleConnected(connected: boolean): void {
    this.bleConnected = connected;
  }

  /** Connect to WebSocket server */
  connect(): void {
    if (this.state === 'connected' || this.state === 'connecting') return;

    this.setState('connecting');
    this.log('info', `Connecting to ${this.serverUrl}...`);

    try {
      this.ws = new WebSocket(this.serverUrl);

      this.ws.onopen = () => {
        this.log('success', 'WebSocket connected ✓');
        this.setState('connected');
        this.reconnectAttempts = 0;

        // Send identification
        this.sendRaw(JSON.stringify({
          type: 'identify',
          mac: this.deviceMac,
          patient_name: this.patientName,
          app_version: '1.0.0',
          platform: getPlatformIdentifier(),
        }));

        // Start heartbeat
        this.startHeartbeat();

        // Flush offline buffer
        this.flushOfflineBuffer();
      };

      this.ws.onmessage = (event) => {
        this.handleServerMessage(event.data);
      };

      this.ws.onerror = (event) => {
        this.log('error', `WebSocket error: ${event}`);
      };

      this.ws.onclose = (event) => {
        this.log('warn', `WebSocket closed (code: ${event.code})`);
        this.stopHeartbeat();
        this.ws = null;
        this.setState('disconnected');

        if (this.shouldAutoReconnect) {
          this.scheduleReconnect();
        }
      };
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log('error', `WebSocket connection failed: ${msg}`);
      this.setState('disconnected');
      if (this.shouldAutoReconnect) {
        this.scheduleReconnect();
      }
    }
  }

  /** Send telemetry data to server */
  sendTelemetry(data: Record<string, unknown>): void {
    const msg = JSON.stringify({
      type: 'telemetry',
      mac: this.deviceMac,
      ts: new Date().toISOString(),
      data,
    });

    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
      this.messagesSent++;
      this.lastSendTime = Date.now();
    } else {
      // Buffer offline
      this.bufferMessage(msg);
    }
  }

  /** Send emergency event to server (high priority) */
  sendEmergency(event: { type: string; timestamp: string; data?: Record<string, unknown> }): void {
    const msg = JSON.stringify({
      type: 'emergency',
      mac: this.deviceMac,
      ts: new Date().toISOString(),
      event,
    });

    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
      this.log('error', `🚨 Emergency sent: ${event.type}`);
    } else {
      // Emergency messages go to front of buffer
      this.offlineBuffer.unshift(msg);
      this.log('error', `🚨 Emergency buffered (offline): ${event.type}`);
    }
  }

  /** Send monitoring stopped event */
  sendMonitoringStopped(reason: string): void {
    const msg = JSON.stringify({
      type: 'monitoring_stopped',
      mac: this.deviceMac,
      reason,
      timestamp: new Date().toISOString(),
    });

    if (this.state === 'connected' && this.ws?.readyState === WebSocket.OPEN) {
      this.sendRaw(msg);
    } else {
      this.bufferMessage(msg);
    }
  }

  /** Disconnect from server */
  disconnect(): void {
    this.shouldAutoReconnect = false;
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
      this.ws = null;
    }
    this.setState('disconnected');
    this.log('info', 'WebSocket disconnected');
  }

  /** Get stats */
  getStats() {
    return {
      messagesSent: this.messagesSent,
      messagesBuffered: this.offlineBuffer.length,
      lastSendTime: this.lastSendTime,
      reconnectAttempts: this.reconnectAttempts,
    };
  }

  // ─── Private Methods ─────────────────────────────────────

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.sendHeartbeat(); // Send immediately

    this.heartbeatInterval = setInterval(() => {
      this.sendHeartbeat();
    }, this.HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  private sendHeartbeat(): void {
    if (this.state !== 'connected' || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;

    const hb = JSON.stringify({
      type: 'heartbeat',
      mac: this.deviceMac,
      ts: new Date().toISOString(),
      battery: this.phoneBattery,
      ble: this.bleConnected ? 'connected' : 'disconnected',
      buffer_size: this.offlineBuffer.length,
      version: '1.0.0',
    });

    this.sendRaw(hb);
  }

  private handleServerMessage(raw: string): void {
    try {
      const msg = JSON.parse(raw);
      const type = msg.type;

      switch (type) {
        case 'pong':
          // Server heartbeat acknowledgment
          break;

        case 'command':
          // Doctor sent a command to relay to ESP32
          this.log('info', `Server command: ${msg.command || msg.action}`);
          this.callbacks.onCommand?.(msg);
          break;

        case 'force_show':
          // Doctor wants to force-show the app UI
          this.log('warn', 'Doctor FORCE-SHOW command received');
          this.callbacks.onForceShow?.();
          break;

        case 'pin_update':
          // Doctor changed the monitoring PIN
          if (msg.pin) {
            localStorage.setItem('help_monitor_pin', msg.pin);
            this.log('info', 'Monitoring PIN updated by doctor');
          }
          break;

        case 'notification_style':
          // Doctor changed notification style
          if (msg.style) {
            localStorage.setItem('help_notification_style', msg.style);
            this.log('info', `Notification style changed to: ${msg.style}`);
          }
          break;

        case 'incoming_call':
          // Doctor is initiating a video call
          this.log('warn', `Incoming ${msg.emergency ? 'EMERGENCY ' : ''}video call from ${msg.caller || 'Doctor'}`);
          this.callbacks.onIncomingCall?.({
            room: msg.room,
            token: msg.token,
            livekit_url: msg.livekit_url,
            caller: msg.caller || 'Doctor',
            emergency: !!msg.emergency,
          });
          break;

        case 'end_call':
          // Doctor ended the video call
          this.log('info', 'Doctor ended video call');
          this.callbacks.onEndCall?.({ room: msg.room });
          break;

        default:
          this.log('info', `Server message: ${type}`);
      }
    } catch (_) {
      // Non-JSON message
    }
  }

  private bufferMessage(msg: string): void {
    if (this.offlineBuffer.length >= this.MAX_BUFFER_SIZE) {
      // Drop oldest non-emergency messages
      const firstNonEmergency = this.offlineBuffer.findIndex(m => !m.includes('"type":"emergency"'));
      if (firstNonEmergency >= 0) {
        this.offlineBuffer.splice(firstNonEmergency, 1);
      } else {
        this.offlineBuffer.shift();
      }
    }
    this.offlineBuffer.push(msg);
    this.messagesBuffered++;
  }

  private async flushOfflineBuffer(): Promise<void> {
    if (this.offlineBuffer.length === 0) return;

    this.log('info', `Flushing ${this.offlineBuffer.length} buffered messages...`);
    let flushed = 0;

    while (this.offlineBuffer.length > 0 && this.state === 'connected') {
      const msg = this.offlineBuffer.shift();
      if (msg) {
        this.sendRaw(msg);
        flushed++;
        // Throttle to avoid overwhelming server
        if (flushed % 100 === 0) {
          await new Promise(r => setTimeout(r, 50));
        }
      }
    }

    this.log('success', `Flushed ${flushed} buffered messages ✓`);
  }

  private sendRaw(msg: string): void {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(msg);
      }
    } catch (_) { /* ignore */ }
  }

  private scheduleReconnect(): void {
    this.reconnectAttempts++;
    const delay = Math.min(3000 * Math.pow(1.3, this.reconnectAttempts - 1), this.maxReconnectDelay);
    this.setState('reconnecting');
    this.log('info', `Reconnecting in ${(delay / 1000).toFixed(1)}s (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(() => {
      if (this.shouldAutoReconnect) {
        this.connect();
      }
    }, delay);
  }

  private setState(s: WsConnectionState): void {
    if (this.state !== s) {
      this.state = s;
      this.callbacks.onStateChange?.(s);
    }
  }

  private log(level: 'info' | 'success' | 'warn' | 'error', msg: string): void {
    platformLog('WS', msg);
    this.callbacks.onLog?.(level, `[WS] ${msg}`);
  }
}
