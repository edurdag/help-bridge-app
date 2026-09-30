/**
 * HELP Telecare — Platform Abstraction Layer
 * Wraps all platform-specific calls behind a unified interface.
 * Detects Android/iOS/Web and routes to correct implementation.
 */

import { Capacitor } from '@capacitor/core';

export type HelpPlatform = 'android' | 'ios' | 'web';

export interface PlatformCapabilities {
  /** Background BLE supported natively */
  backgroundBle: boolean;
  /** Persistent foreground service available */
  foregroundService: boolean;
  /** Persistent WebSocket in background */
  backgroundWebSocket: boolean;
  /** Native call UI (CallKit/ConnectionService) */
  nativeCallUI: boolean;
  /** Push type for server-initiated wakeup */
  pushType: 'fcm' | 'apns' | 'none';
  /** Can hide app icon from launcher */
  canHideAppIcon: boolean;
  /** Auto-restart after force kill */
  autoRestartAfterKill: 'reliable' | 'limited' | 'none';
  /** Background task scheduling */
  backgroundTaskScheduler: 'workmanager' | 'bgtask' | 'none';
}

// ═══════════════════════════════════════════════════════════
// Platform detection
// ═══════════════════════════════════════════════════════════

let _detectedPlatform: HelpPlatform | null = null;

export function getPlatform(): HelpPlatform {
  if (_detectedPlatform) return _detectedPlatform;

  const cap = Capacitor.getPlatform();
  if (cap === 'android') _detectedPlatform = 'android';
  else if (cap === 'ios') _detectedPlatform = 'ios';
  else _detectedPlatform = 'web';

  return _detectedPlatform;
}

export function isNative(): boolean {
  return Capacitor.isNativePlatform();
}

export function getPlatformIdentifier(): string {
  return `capacitor-${getPlatform()}`;
}

// ═══════════════════════════════════════════════════════════
// Capabilities matrix
// ═══════════════════════════════════════════════════════════

const CAPABILITIES: Record<HelpPlatform, PlatformCapabilities> = {
  android: {
    backgroundBle: true,             // Foreground Service
    foregroundService: true,          // START_STICKY + notification
    backgroundWebSocket: true,        // Runs in foreground service
    nativeCallUI: true,              // ConnectionService (planned)
    pushType: 'fcm',
    canHideAppIcon: true,             // PackageManager.COMPONENT_ENABLED_STATE
    autoRestartAfterKill: 'reliable', // START_STICKY + WorkManager + AlarmManager + BOOT_COMPLETED
    backgroundTaskScheduler: 'workmanager',
  },
  ios: {
    backgroundBle: true,              // bluetooth-central UIBackgroundMode
    foregroundService: false,         // No equivalent on iOS
    backgroundWebSocket: false,       // Killed ~30s after backgrounding
    nativeCallUI: true,              // CallKit (needs native plugin)
    pushType: 'apns',
    canHideAppIcon: false,            // iOS does not allow hiding app icons
    autoRestartAfterKill: 'limited',  // bluetooth-central relaunch + BGTask (unreliable)
    backgroundTaskScheduler: 'bgtask',
  },
  web: {
    backgroundBle: false,
    foregroundService: false,
    backgroundWebSocket: true,        // Browser tab keeps WS alive
    nativeCallUI: false,
    pushType: 'none',
    canHideAppIcon: false,
    autoRestartAfterKill: 'none',
    backgroundTaskScheduler: 'none',
  },
};

export function getCapabilities(): PlatformCapabilities {
  return CAPABILITIES[getPlatform()];
}

// ═══════════════════════════════════════════════════════════
// BLE initialization config per platform
// ═══════════════════════════════════════════════════════════

export interface BleInitOptions {
  /** Android: skip location permission for BLE (API 31+) */
  androidNeverForLocation?: boolean;
  /** iOS: restore BLE connections after app relaunch */
  iosRestoreStateIdentifier?: string;
}

export function getBleInitOptions(): BleInitOptions {
  const platform = getPlatform();

  if (platform === 'android') {
    return {
      androidNeverForLocation: true,
    };
  }

  if (platform === 'ios') {
    return {
      // iOS CoreBluetooth state restoration key
      // When iOS kills the app, it relaunches with this key to restore
      // CBCentralManager state and reconnect to peripherals
      iosRestoreStateIdentifier: 'com.help.telecare.ble.central',
    };
  }

  // Web — no special options
  return {};
}

// ═══════════════════════════════════════════════════════════
// Background telemetry strategy per platform
// ═══════════════════════════════════════════════════════════

export type TelemetryRelayStrategy = 'websocket' | 'http_batch' | 'hybrid';

export interface TelemetryStrategyConfig {
  /** Primary relay method */
  strategy: TelemetryRelayStrategy;
  /** Use WebSocket while in foreground */
  websocketInForeground: boolean;
  /** Use HTTP POST batch in background */
  httpBatchInBackground: boolean;
  /** HTTP batch flush interval (ms) — iOS BGTaskScheduler cadence */
  httpBatchIntervalMs: number;
  /** Maximum buffer size before forced flush */
  maxBufferBeforeFlush: number;
  /** HTTP endpoint for batch telemetry upload */
  httpBatchEndpoint: string;
}

export function getTelemetryStrategy(serverBaseUrl: string): TelemetryStrategyConfig {
  const platform = getPlatform();
  const caps = getCapabilities();

  if (caps.backgroundWebSocket) {
    // Android + Web: WebSocket always works in background
    return {
      strategy: 'websocket',
      websocketInForeground: true,
      httpBatchInBackground: false,
      httpBatchIntervalMs: 0,
      maxBufferBeforeFlush: 10000,
      httpBatchEndpoint: `${serverBaseUrl}/api/telemetry/batch`,
    };
  }

  // iOS: hybrid — WS in foreground, HTTP POST batch in background
  return {
    strategy: 'hybrid',
    websocketInForeground: true,
    httpBatchInBackground: true,
    httpBatchIntervalMs: 30000,    // Flush every 30s when possible
    maxBufferBeforeFlush: 500,     // ~500 messages (~8 minutes at 1Hz)
    httpBatchEndpoint: `${serverBaseUrl}/api/telemetry/batch`,
  };
}

// ═══════════════════════════════════════════════════════════
// App lifecycle states
// ═══════════════════════════════════════════════════════════

export type AppLifecycleState = 'foreground' | 'background' | 'terminated';

let _lifecycleState: AppLifecycleState = 'foreground';
const _lifecycleListeners: Array<(state: AppLifecycleState) => void> = [];

export function getLifecycleState(): AppLifecycleState {
  return _lifecycleState;
}

export function setLifecycleState(state: AppLifecycleState): void {
  if (_lifecycleState !== state) {
    _lifecycleState = state;
    _lifecycleListeners.forEach(fn => fn(state));
  }
}

export function onLifecycleChange(fn: (state: AppLifecycleState) => void): () => void {
  _lifecycleListeners.push(fn);
  return () => {
    const idx = _lifecycleListeners.indexOf(fn);
    if (idx >= 0) _lifecycleListeners.splice(idx, 1);
  };
}

// ═══════════════════════════════════════════════════════════
// Platform-specific log prefix
// ═══════════════════════════════════════════════════════════

export function platformLog(tag: string, msg: string): void {
  const ts = new Date().toLocaleTimeString('tr-TR');
  console.log(`[${tag}:${getPlatform()} ${ts}] ${msg}`);
}
