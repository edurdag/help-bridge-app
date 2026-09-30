/**
 * HELP Telecare Bridge — Main Application
 * Ties together BLE, WebSocket, and Protection services
 * Renders the patient-facing mobile UI
 */

import { bleService, TelemetryData, BleConnectionState } from './services/ble.service';
import { WebSocketRelay, WsConnectionState } from './services/ws-relay.service';
import { protectionService } from './services/protection.service';
import { CallService, CallState, IncomingCallParams } from './services/call.service';

// ═══════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════
const WS_SERVER_URL = 'wss://telecare.help:1968';
const WS_FALLBACK_URL = 'ws://192.168.1.100:1968'; // Local dev fallback
const HTTP_SERVER_URL = 'https://telecare.help:8001';
const HTTP_FALLBACK_URL = 'http://192.168.1.100:8001';
const CMD_POLL_INTERVAL_MS = 3000;
const DEVICE_MAC = localStorage.getItem('help_device_mac') || 'HELP-UNKNOWN';
const PATIENT_NAME = localStorage.getItem('help_patient_name') || 'Hasta';

// ═══════════════════════════════════════════════════════════
// State
// ═══════════════════════════════════════════════════════════
let currentPage = 'dashboard';
let latestTelemetry: TelemetryData = {};
let logLines: { level: string; msg: string; ts: string }[] = [];
let wsRelay: WebSocketRelay | null = null;
const callService = new CallService();
let httpApiBase = '';
let cmdPollTimer: ReturnType<typeof setInterval> | null = null;

// ═══════════════════════════════════════════════════════════
// Boot
// ═══════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', () => {
  renderApp();
  initServices();
});

async function initServices(): Promise<void> {
  addLog('info', 'HELP Telecare Bridge başlatılıyor...');

  // Initialize WebSocket relay
  const wsUrl = await testWsConnection(WS_SERVER_URL) ? WS_SERVER_URL : WS_FALLBACK_URL;
  wsRelay = new WebSocketRelay(wsUrl, DEVICE_MAC, PATIENT_NAME);
  wsRelay.setCallbacks({
    onStateChange: (state) => {
      updateConnectionUI('ws', state);
    },
    onCommand: (cmd) => {
      handleServerCommand(cmd);
    },
    onForceShow: () => {
      protectionService.forceShow();
      showPage('dashboard');
    },
    onIncomingCall: (params) => {
      callService.handleIncomingCall(params);
    },
    onEndCall: () => {
      callService.handleEndCallCommand();
    },
    onLog: (level, msg) => addLog(level, msg),
  });

  // Initialize Call Service
  callService.setCallbacks({
    onStateChange: (state) => {
      updateCallUI(state);
    },
    onRemoteVideo: (el) => {
      const container = document.getElementById('call-remote-video');
      if (container) container.appendChild(el);
    },
    onRemoteAudio: (el) => {
      // Audio element auto-plays (already appended to body by service)
    },
    onLocalVideo: (el) => {
      const preview = document.getElementById('call-local-preview');
      if (preview) preview.appendChild(el);
    },
    onCallEnded: (durationSec) => {
      addLog('info', `Video call ended (${durationSec}s)`);
    },
    onLog: (level, msg) => addLog(level, msg),
  });

  // Initialize BLE
  bleService.setCallbacks({
    onStateChange: (state) => {
      updateConnectionUI('ble', state);
      wsRelay?.setBleConnected(state === 'connected');
    },
    onTelemetry: (data) => {
      latestTelemetry = { ...latestTelemetry, ...data };
      updateVitalsUI(data);
      // Relay to server
      wsRelay?.sendTelemetry(data);
    },
    onEmergency: (event) => {
      wsRelay?.sendEmergency(event);
      showEmergencyUI(event.type);
    },
    onLog: (level, msg) => addLog(level, msg),
  });

  // Initialize protection
  protectionService.setCallbacks({
    onVisibilityChange: (state) => {
      addLog('info', `UI görünürlük: ${state}`);
    },
    onForceShow: () => {
      addLog('warn', 'Doktor uygulamayı açtı');
    },
    onLog: (level, msg) => addLog(level, msg),
  });

  // Connect WebSocket first (for heartbeat)
  wsRelay.connect();

  // Then start BLE scan
  addLog('info', 'BLE tarama başlatılıyor...');
  await bleService.scanAndConnect();

  // Start HTTP command polling as reliable fallback for WS
  httpApiBase = wsUrl.includes('telecare.help') ? HTTP_SERVER_URL : HTTP_FALLBACK_URL;
  startCommandPoll();
}

// ═══════════════════════════════════════════════════════════
// HTTP Command Polling (Reliable WS Fallback)
// ═══════════════════════════════════════════════════════════

function startCommandPoll(): void {
  if (cmdPollTimer) clearInterval(cmdPollTimer);
  cmdPollTimer = setInterval(pollCommands, CMD_POLL_INTERVAL_MS);
  addLog('info', `[CMD_POLL] Started HTTP command polling → ${httpApiBase}`);
}

async function pollCommands(): Promise<void> {
  try {
    const url = `${httpApiBase}/api/bridge/commands?mac=${encodeURIComponent(DEVICE_MAC)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
    if (!resp.ok) return;

    const data = await resp.json();
    const commands: Array<{ cmd_id: string; data: string }> = data.commands || [];

    for (const cmd of commands) {
      addLog('info', `[CMD_POLL] Received: ${cmd.data?.substring(0, 60) || cmd.cmd_id}`);

      // Forward [CMD_JSON] commands to device via BLE
      if (cmd.data && cmd.data.includes('[CMD_JSON]')) {
        const success = await bleService.sendCommand(cmd.data.trim());
        addLog(success ? 'info' : 'error', `[CMD_POLL] BLE forward: ${success ? '✓' : '✗'}`);
      } else {
        // Try to parse as server command
        try {
          const parsed = JSON.parse(cmd.data);
          handleServerCommand(parsed);
        } catch {
          addLog('warn', `[CMD_POLL] Unparseable command: ${cmd.data?.substring(0, 40)}`);
        }
      }

      // ACK the command
      ackCommand(cmd.cmd_id);
    }
  } catch {
    // Silent — HTTP unreachable is normal when offline
  }
}

function ackCommand(cmdId: string): void {
  const url = `${httpApiBase}/api/bridge/ack`;
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mac: DEVICE_MAC, cmd_id: cmdId }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => { /* ignore */ });
}

async function testWsConnection(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(url);
      const timer = setTimeout(() => { ws.close(); resolve(false); }, 3000);
      ws.onopen = () => { clearTimeout(timer); ws.close(); resolve(true); };
      ws.onerror = () => { clearTimeout(timer); resolve(false); };
    } catch { resolve(false); }
  });
}

function handleServerCommand(cmd: Record<string, unknown>): void {
  const action = (cmd.action || cmd.command) as string;
  switch (action) {
    case 'force_show':
      protectionService.forceShow();
      break;
    case 'release_force_show':
      protectionService.releaseForceShow();
      break;
    case 'pin_update':
      if (typeof cmd.pin === 'string') {
        protectionService.updatePin(cmd.pin);
      }
      break;
    case 'notification_style':
      if (typeof cmd.style === 'string') {
        protectionService.updateNotificationStyle(cmd.style as 'minimal' | 'standard' | 'rich');
      }
      break;
    case 'ble_command':
      if (typeof cmd.data === 'string') {
        bleService.sendCommand(cmd.data);
      }
      break;
    default:
      // Auto-forward any command containing [CMD_JSON] data to device via BLE
      if (typeof cmd.data === 'string' && cmd.data.includes('[CMD_JSON]')) {
        addLog('info', `[BRIDGE] Forwarding CMD_JSON to device via BLE: ${(cmd.data as string).substring(0, 80)}`);
        bleService.sendCommand(cmd.data);
      } else if (action) {
        addLog('warn', `[BRIDGE] Unhandled server command: ${action}`);
      }
      break;
  }
}

// ═══════════════════════════════════════════════════════════
// UI Rendering
// ═══════════════════════════════════════════════════════════

function renderApp(): void {
  const app = document.getElementById('app')!;
  app.innerHTML = `
    <!-- Header -->
    <div class="header">
      <div class="header__logo">
        <div class="header__icon">💚</div>
        <div>
          <div class="header__title">HELP</div>
          <div class="header__subtitle">Sağlık İzleme</div>
        </div>
      </div>
      <div class="header__status">
        <span id="status-text" style="font-size:12px;color:var(--text-secondary)">Bağlanıyor...</span>
        <div id="status-dot" class="status-dot status-dot--connecting"></div>
      </div>
    </div>

    <!-- Video Call Overlay (patient side) -->
    <div id="call-overlay" class="call-overlay">
      <!-- Ringing state -->
      <div id="call-ringing" class="call-ringing" style="display:none">
        <div class="call-ringing__icon">📞</div>
        <div class="call-ringing__title" id="call-caller-name">Doctor is calling...</div>
        <div class="call-ringing__subtitle" id="call-auto-answer">Auto-answer in 15s</div>
        <div class="call-ringing__buttons">
          <button class="call-btn call-btn--accept" id="call-btn-accept">✅ Accept</button>
          <button class="call-btn call-btn--decline" id="call-btn-decline">❌ Decline</button>
        </div>
      </div>
      <!-- Active call state -->
      <div id="call-active" class="call-active" style="display:none">
        <div class="call-active__header">
          <span id="call-active-title">📞 Video Call</span>
          <span id="call-active-duration" style="font-family:monospace">00:00</span>
        </div>
        <div class="call-active__video">
          <div id="call-remote-video" class="call-remote-video"></div>
          <div id="call-local-preview" class="call-local-preview"></div>
        </div>
        <div class="call-active__controls">
          <button class="call-btn call-btn--small" id="call-btn-mute" onclick="window._callToggleMute()">🎤</button>
          <button class="call-btn call-btn--small" id="call-btn-cam" onclick="window._callToggleCam()">📷</button>
          <button class="call-btn call-btn--hangup" id="call-btn-hangup" onclick="window._callEnd()">📵</button>
        </div>
      </div>
    </div>

    <!-- Dashboard Page -->
    <div id="page-dashboard" class="page page--active">
      <!-- Vitals Card -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">Yaşam Belirtileri</span>
          <span id="vitals-badge" class="card__badge card__badge--orange">Bekleniyor</span>
        </div>
        <div class="vitals-grid">
          <div class="vital-item vital-item--heart">
            <div class="vital-item__icon">❤️</div>
            <div id="v-hr" class="vital-item__value">--</div>
            <div class="vital-item__label">BPM</div>
          </div>
          <div class="vital-item vital-item--spo2">
            <div class="vital-item__icon">🫁</div>
            <div id="v-spo2" class="vital-item__value">--</div>
            <div class="vital-item__label">SpO₂ %</div>
          </div>
          <div class="vital-item vital-item--temp">
            <div class="vital-item__icon">🌡️</div>
            <div id="v-temp" class="vital-item__value">--</div>
            <div class="vital-item__label">°C</div>
          </div>
          <div class="vital-item vital-item--freq">
            <div class="vital-item__icon">〰️</div>
            <div id="v-freq" class="vital-item__value">--</div>
            <div class="vital-item__label">Frekans Hz</div>
          </div>
        </div>
      </div>

      <!-- Frequency Progress -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">Tedavi İlerlemesi</span>
          <span id="freq-state" class="card__badge card__badge--green">--</span>
        </div>
        <div class="freq-progress">
          <div style="display:flex;align-items:baseline;gap:8px">
            <span id="freq-step" class="freq-progress__step">--</span>
            <span style="color:var(--text-secondary);font-size:14px">/ <span id="freq-total">340</span> adım</span>
          </div>
          <div class="freq-progress__bar-bg">
            <div id="freq-bar" class="freq-progress__bar" style="width:0%"></div>
          </div>
          <div class="freq-progress__text">
            <span id="freq-elapsed">Geçen: --</span>
            <span id="freq-remaining">Kalan: --</span>
          </div>
        </div>
      </div>

      <!-- Connection Status -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">Bağlantılar</span>
        </div>
        <div class="connection-item">
          <div class="connection-item__icon connection-item__icon--ble">📡</div>
          <div class="connection-item__info">
            <div class="connection-item__name">ESP32 Cihaz</div>
            <div id="ble-detail" class="connection-item__detail">Taranıyor...</div>
          </div>
          <span id="ble-status" class="connection-item__status connection-item__status--connecting">Taranıyor</span>
        </div>
        <div class="connection-item">
          <div class="connection-item__icon connection-item__icon--ws">🌐</div>
          <div class="connection-item__info">
            <div class="connection-item__name">Sunucu</div>
            <div id="ws-detail" class="connection-item__detail">telecare.help</div>
          </div>
          <span id="ws-status" class="connection-item__status connection-item__status--connecting">Bağlanıyor</span>
        </div>
      </div>

      <!-- Battery & Power Card -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">Pil ve Güç</span>
          <span id="bat-badge" class="card__badge card__badge--green">--</span>
        </div>
        <div class="battery-panel">
          <div class="battery-gauge">
            <div class="battery-gauge__body">
              <div id="bat-fill" class="battery-gauge__fill" style="height:0%"></div>
              <span id="bat-pct-text" class="battery-gauge__text">--%</span>
            </div>
            <div class="battery-gauge__tip"></div>
          </div>
          <div class="battery-stats">
            <div class="battery-stat">
              <span class="battery-stat__label">Voltaj</span>
              <span id="bat-voltage" class="battery-stat__value">-- V</span>
            </div>
            <div class="battery-stat">
              <span class="battery-stat__label">Akım</span>
              <span id="bat-current" class="battery-stat__value">-- mA</span>
            </div>
            <div class="battery-stat">
              <span class="battery-stat__label">Güç</span>
              <span id="bat-power" class="battery-stat__value">-- mW</span>
            </div>
            <div class="battery-stat">
              <span class="battery-stat__label">Çalışma Süresi</span>
              <span id="bat-runtime" class="battery-stat__value">--</span>
            </div>
            <div class="battery-stat">
              <span class="battery-stat__label">Kaynak</span>
              <span id="bat-source" class="battery-stat__value">--</span>
            </div>
            <div class="battery-stat">
              <span class="battery-stat__label">Şarj</span>
              <span id="bat-charge-status" class="battery-stat__value">--</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Power Consumption Breakdown -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">Güç Tüketimi</span>
          <span id="power-total" class="card__badge card__badge--blue">-- mW</span>
        </div>
        <div class="power-breakdown">
          <div class="power-row">
            <span class="power-row__label">🔧 CPU</span>
            <div class="power-row__bar-bg"><div id="pw-cpu-bar" class="power-row__bar power-row__bar--cpu" style="width:0%"></div></div>
            <span id="pw-cpu" class="power-row__value">--</span>
          </div>
          <div class="power-row">
            <span class="power-row__label">📶 WiFi</span>
            <div class="power-row__bar-bg"><div id="pw-wifi-bar" class="power-row__bar power-row__bar--wifi" style="width:0%"></div></div>
            <span id="pw-wifi" class="power-row__value">--</span>
          </div>
          <div class="power-row">
            <span class="power-row__label">📡 BLE</span>
            <div class="power-row__bar-bg"><div id="pw-ble-bar" class="power-row__bar power-row__bar--ble" style="width:0%"></div></div>
            <span id="pw-ble" class="power-row__value">--</span>
          </div>
          <div class="power-row">
            <span class="power-row__label">🖥️ Ekran</span>
            <div class="power-row__bar-bg"><div id="pw-amoled-bar" class="power-row__bar power-row__bar--amoled" style="width:0%"></div></div>
            <span id="pw-amoled" class="power-row__value">--</span>
          </div>
          <div class="power-row">
            <span class="power-row__label">〰️ LEDC</span>
            <div class="power-row__bar-bg"><div id="pw-ledc-bar" class="power-row__bar power-row__bar--ledc" style="width:0%"></div></div>
            <span id="pw-ledc" class="power-row__value">--</span>
          </div>
          <div class="power-row">
            <span class="power-row__label">📊 Sensör</span>
            <div class="power-row__bar-bg"><div id="pw-sensor-bar" class="power-row__bar power-row__bar--sensor" style="width:0%"></div></div>
            <span id="pw-sensor" class="power-row__value">--</span>
          </div>
        </div>
      </div>

      <!-- WiFi Network Config -->
      <div class="card fade-in">
        <div class="card__header">
          <span class="card__title">WiFi Ağ Yapılandırması</span>
          <span id="wifi-badge" class="card__badge card__badge--orange">Kapalı</span>
        </div>
        <div class="wifi-config">
          <div class="wifi-section">
            <div class="wifi-section__title">📡 STA (İstemci)</div>
            <div class="wifi-row">
              <span class="wifi-row__label">SSID</span>
              <span id="wifi-sta-ssid" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">IP</span>
              <span id="wifi-sta-ip" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Ağ Geçidi</span>
              <span id="wifi-sta-gw" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Sinyal</span>
              <span id="wifi-sta-rssi" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Durum</span>
              <span id="wifi-sta-status" class="wifi-row__value">--</span>
            </div>
          </div>
          <div class="wifi-section">
            <div class="wifi-section__title">🏠 AP (Hotspot)</div>
            <div class="wifi-row">
              <span class="wifi-row__label">SSID</span>
              <span id="wifi-ap-ssid" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">IP</span>
              <span id="wifi-ap-ip" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Kanal</span>
              <span id="wifi-ap-channel" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">İstemciler</span>
              <span id="wifi-ap-clients" class="wifi-row__value">--</span>
            </div>
          </div>
          <div class="wifi-section">
            <div class="wifi-section__title">⚙️ Genel</div>
            <div class="wifi-row">
              <span class="wifi-row__label">Mod</span>
              <span id="wifi-mode" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Sunucu</span>
              <span id="wifi-server" class="wifi-row__value">--</span>
            </div>
            <div class="wifi-row">
              <span class="wifi-row__label">Sıcaklık</span>
              <span id="wifi-temp" class="wifi-row__value">--</span>
            </div>
          </div>
        </div>
      </div>

      <!-- SOS Button -->
      <button id="btn-sos" class="sos-button" onclick="window._handleSOS()">
        SOS
      </button>
      <p style="text-align:center;font-size:12px;color:var(--text-dim);margin-top:-12px">Acil durum butonu</p>
    </div>

    <!-- Settings Page -->
    <div id="page-settings" class="page">
      <div class="card">
        <div class="card__header">
          <span class="card__title">Ayarlar</span>
        </div>
        <ul class="settings-list">
          <li class="settings-item" onclick="window._toggleVisibility()">
            <div class="settings-item__icon">👁️</div>
            <div class="settings-item__content">
              <div class="settings-item__label">Uygulamayı Gizle/Göster</div>
              <div class="settings-item__desc">Simge gizlense de izleme devam eder</div>
            </div>
            <button id="toggle-visibility" class="toggle toggle--active">
              <div class="toggle__knob"></div>
            </button>
          </li>
          <li class="settings-item" onclick="window._showStopDialog()">
            <div class="settings-item__icon">⏸️</div>
            <div class="settings-item__content">
              <div class="settings-item__label">İzlemeyi Durdur</div>
              <div class="settings-item__desc">Doktor PIN kodu gerektirir</div>
            </div>
            <div class="settings-item__arrow">›</div>
          </li>
          <li class="settings-item">
            <div class="settings-item__icon">📱</div>
            <div class="settings-item__content">
              <div class="settings-item__label">Cihaz Bilgisi</div>
              <div id="device-info" class="settings-item__desc">MAC: ${DEVICE_MAC}</div>
            </div>
            <div class="settings-item__arrow">›</div>
          </li>
          <li class="settings-item">
            <div class="settings-item__icon">👤</div>
            <div class="settings-item__content">
              <div class="settings-item__label">Hasta</div>
              <div class="settings-item__desc">${PATIENT_NAME}</div>
            </div>
            <div class="settings-item__arrow">›</div>
          </li>
          <li class="settings-item" onclick="window._showResumDialog()">
            <div class="settings-item__icon">▶️</div>
            <div class="settings-item__content">
              <div class="settings-item__label">İzlemeyi Başlat</div>
              <div class="settings-item__desc">Duraklatılmış izlemeyi yeniden başlat</div>
            </div>
            <div class="settings-item__arrow">›</div>
          </li>
        </ul>
      </div>

      <div class="card">
        <div class="card__header">
          <span class="card__title">İletişim</span>
        </div>
        <ul class="settings-list">
          <li class="settings-item">
            <div class="settings-item__icon">📊</div>
            <div class="settings-item__content">
              <div class="settings-item__label">İstatistikler</div>
              <div id="stats-detail" class="settings-item__desc">Gönderilen: 0 | Tampon: 0</div>
            </div>
          </li>
        </ul>
      </div>
    </div>

    <!-- Logs Page -->
    <div id="page-logs" class="page">
      <div class="card">
        <div class="card__header">
          <span class="card__title">Sistem Günlüğü</span>
          <span class="card__badge card__badge--green" onclick="window._clearLogs()" style="cursor:pointer">Temizle</span>
        </div>
        <div id="log-console" class="log-console">
          <div class="log-line log-line--info">HELP Telecare Bridge hazır.</div>
        </div>
      </div>

      <!-- Reconnect / Scan Buttons -->
      <button class="btn btn--primary" onclick="window._rescan()" style="margin-top:12px">
        📡 Cihazı Yeniden Tara
      </button>
      <button class="btn btn--outline" onclick="window._reconnectWs()" style="margin-top:8px">
        🌐 Sunucuya Yeniden Bağlan
      </button>
    </div>

    <!-- Bottom Navigation -->
    <nav class="nav">
      <button id="nav-dashboard" class="nav__item nav__item--active" onclick="window._showPage('dashboard')">
        <span class="nav__item__icon">💚</span>
        <span>Ana Sayfa</span>
      </button>
      <button id="nav-settings" class="nav__item" onclick="window._showPage('settings')">
        <span class="nav__item__icon">⚙️</span>
        <span>Ayarlar</span>
      </button>
      <button id="nav-logs" class="nav__item" onclick="window._showPage('logs')">
        <span class="nav__item__icon">📋</span>
        <span>Günlük</span>
      </button>
    </nav>

    <!-- PIN Dialog (initially hidden) -->
    <div id="pin-overlay" class="modal-overlay">
      <div class="modal">
        <div class="modal__icon">⚠️</div>
        <div class="modal__title">DİKKAT</div>
        <div class="modal__text">
          İzlemeyi durdurmak doktorunuzun sağlık verilerinizi görmesini engelleyecektir.
          Acil bir durumda doktorunuz sizi arayamayacaktır.
          <br><br>
          Devam etmek için doktorunuzun verdiği PIN kodunu girin.
        </div>
        <div class="pin-input" id="pin-input-container">
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="0" />
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="1" />
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="2" />
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="3" />
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="4" />
          <input class="pin-input__digit" type="tel" maxlength="1" data-pin-index="5" />
        </div>
        <p id="pin-error" style="color:var(--accent-red);font-size:13px;text-align:center;min-height:20px"></p>
        <div class="modal__actions">
          <button class="btn btn--outline" onclick="window._closePinDialog()" style="flex:1">İptal</button>
          <button class="btn btn--danger" onclick="window._submitPin()" style="flex:1">Doğrula ve Durdur</button>
        </div>
      </div>
    </div>

    <!-- Emergency Overlay (initially hidden) -->
    <div id="emergency-overlay" class="modal-overlay">
      <div class="modal" style="border-color:var(--accent-red);box-shadow:var(--shadow-glow-red)">
        <div class="modal__icon heartbeat-anim">🚨</div>
        <div class="modal__title" style="color:var(--accent-red)">ACİL DURUM</div>
        <div id="emergency-text" class="modal__text">Düşme tespit edildi. Doktorunuz bilgilendirildi.</div>
        <button class="btn btn--danger" onclick="window._dismissEmergency()">Tamam, İyiyim</button>
      </div>
    </div>
  `;

  // Setup PIN input auto-advance
  setupPinInputs();

  // Start stats updater
  setInterval(updateStats, 5000);
}

// ═══════════════════════════════════════════════════════════
// UI Updates
// ═══════════════════════════════════════════════════════════

function updateVitalsUI(data: TelemetryData): void {
  const badge = document.getElementById('vitals-badge');
  if (badge) {
    badge.textContent = 'Canlı';
    badge.className = 'card__badge card__badge--green';
  }

  if (data.heart_rate !== undefined) {
    const el = document.getElementById('v-hr');
    if (el) el.textContent = String(data.heart_rate);
  }
  if (data.spo2 !== undefined) {
    const el = document.getElementById('v-spo2');
    if (el) el.textContent = String(data.spo2);
  }
  if (data.temperature !== undefined) {
    const el = document.getElementById('v-temp');
    if (el) el.textContent = data.temperature.toFixed(1);
  }
  if (data.frequency !== undefined) {
    const el = document.getElementById('v-freq');
    if (el) el.textContent = data.frequency < 1000 ? data.frequency.toFixed(2) : String(Math.round(data.frequency));
  }

  // Frequency progress
  if (data.step !== undefined) {
    const total = data.total_steps || 340;
    const pct = Math.min((data.step / total) * 100, 100);
    const stepEl = document.getElementById('freq-step');
    const totalEl = document.getElementById('freq-total');
    const barEl = document.getElementById('freq-bar');
    if (stepEl) stepEl.textContent = String(data.step);
    if (totalEl) totalEl.textContent = String(total);
    if (barEl) barEl.style.width = `${pct}%`;
  }

  if (data.state) {
    const stateEl = document.getElementById('freq-state');
    if (stateEl) {
      const stateMap: Record<string, [string, string]> = {
        'ST_ACTIVE': ['Aktif', 'card__badge--green'],
        'ST_SILENT': ['Sessiz', 'card__badge--orange'],
        'ST_WAITING': ['Bekliyor', 'card__badge--orange'],
        'ST_REST': ['Tamamlandı', 'card__badge--green'],
      };
      const [label, cls] = stateMap[data.state] || [data.state, 'card__badge--orange'];
      stateEl.textContent = label;
      stateEl.className = `card__badge ${cls}`;
    }
  }

  if (data.playlist_remaining !== undefined) {
    const remEl = document.getElementById('freq-remaining');
    if (remEl) remEl.textContent = `Kalan: ${formatDuration(data.playlist_remaining)}`;
  }

  if (data.op_duration_sec !== undefined) {
    const elEl = document.getElementById('freq-elapsed');
    if (elEl) elEl.textContent = `Geçen: ${formatDuration(data.op_duration_sec)}`;
  }

  // Battery, power, and WiFi panels
  updateBatteryUI(data);
  updatePowerUI(data);
  updateWifiUI(data);
}

// ═══════════════════════════════════════════════════════════
// Battery & Power UI
// ═══════════════════════════════════════════════════════════

function updateBatteryUI(data: TelemetryData): void {
  const pct = data.battery_percent as number | undefined;
  if (pct !== undefined) {
    const fillEl = document.getElementById('bat-fill');
    const textEl = document.getElementById('bat-pct-text');
    const badge = document.getElementById('bat-badge');
    if (fillEl) {
      fillEl.style.height = `${Math.min(pct, 100)}%`;
      // Color: green > 50, orange 20-50, red < 20
      fillEl.className = `battery-gauge__fill ${pct > 50 ? 'battery-gauge__fill--good' : pct > 20 ? 'battery-gauge__fill--warn' : 'battery-gauge__fill--critical'}`;
    }
    if (textEl) textEl.textContent = `${pct}%`;
    if (badge) {
      const charging = data.battery_charging as boolean;
      const source = data.power_source as string || '';
      if (charging) {
        badge.textContent = '⚡ Şarj';
        badge.className = 'card__badge card__badge--orange';
      } else if (source.includes('usb')) {
        badge.textContent = '🔌 USB';
        badge.className = 'card__badge card__badge--blue';
      } else {
        badge.textContent = `${pct}%`;
        badge.className = `card__badge ${pct > 20 ? 'card__badge--green' : 'card__badge--red'}`;
      }
    }
  }

  const setEl = (id: string, val: string | undefined) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.textContent = val;
  };

  if (data.battery_voltage !== undefined) setEl('bat-voltage', `${(data.battery_voltage as number).toFixed(2)} V`);
  if (data.load_current_ma !== undefined) setEl('bat-current', `${(data.load_current_ma as number).toFixed(1)} mA`);
  if (data.power_mw !== undefined) setEl('bat-power', `${Math.round(data.power_mw as number)} mW`);

  if (data.battery_runtime_hours !== undefined) {
    const hrs = data.battery_runtime_hours as number;
    if (hrs > 0) {
      const h = Math.floor(hrs);
      const m = Math.round((hrs - h) * 60);
      setEl('bat-runtime', `${h}s ${m}dk`);
    } else {
      setEl('bat-runtime', '∞ (USB)');
    }
  }

  if (data.power_source !== undefined) {
    const srcMap: Record<string, string> = {
      'battery': '🔋 Pil',
      'usb_passthrough': '🔌 USB',
      'usb_charging': '⚡ Şarj',
    };
    setEl('bat-source', srcMap[data.power_source as string] || String(data.power_source));
  }

  if (data.battery_charging !== undefined || data.battery_charge_done !== undefined) {
    const charging = data.battery_charging as boolean;
    const done = data.battery_charge_done as boolean;
    if (charging) {
      const chgMa = data.charge_current_ma as number || 0;
      setEl('bat-charge-status', `⚡ ${chgMa} mA`);
    } else if (done) {
      setEl('bat-charge-status', '✅ Tamamlandı');
    } else {
      setEl('bat-charge-status', '— Şarj yok');
    }
  }
}

// ═══════════════════════════════════════════════════════════
// Power Consumption Breakdown
// ═══════════════════════════════════════════════════════════

function updatePowerUI(data: TelemetryData): void {
  const total = data.total_current_ma as number;
  if (total !== undefined && total > 0) {
    const badge = document.getElementById('power-total');
    if (badge) badge.textContent = `${Math.round(data.power_mw as number || total * 3.7)} mW`;

    const subsystems: Array<{ id: string; field: string }> = [
      { id: 'cpu', field: 'i_cpu_ma' },
      { id: 'wifi', field: 'i_wifi_ma' },
      { id: 'ble', field: 'i_ble_ma' },
      { id: 'amoled', field: 'i_amoled_ma' },
      { id: 'ledc', field: 'i_ledc_ma' },
      { id: 'sensor', field: 'i_sensor_ma' },
    ];

    for (const sub of subsystems) {
      const val = data[sub.field] as number;
      if (val !== undefined) {
        const barEl = document.getElementById(`pw-${sub.id}-bar`);
        const valEl = document.getElementById(`pw-${sub.id}`);
        const pct = Math.min((val / total) * 100, 100);
        if (barEl) barEl.style.width = `${pct}%`;
        if (valEl) valEl.textContent = `${val.toFixed(1)} mA`;
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════
// WiFi Config UI
// ═══════════════════════════════════════════════════════════

function updateWifiUI(data: TelemetryData): void {
  const setEl = (id: string, val: string | undefined) => {
    const el = document.getElementById(id);
    if (el && val !== undefined) el.textContent = val;
  };

  // WiFi badge
  const wifiEnabled = data.wifi_enabled as boolean;
  const wifiStatus = data.wifi_status as string;
  if (wifiEnabled !== undefined || wifiStatus !== undefined) {
    const badge = document.getElementById('wifi-badge');
    if (badge) {
      if (!wifiEnabled) {
        badge.textContent = 'Kapalı';
        badge.className = 'card__badge card__badge--red';
      } else if (wifiStatus === 'CONNECTED') {
        badge.textContent = 'Bağlı';
        badge.className = 'card__badge card__badge--green';
      } else if (wifiStatus === 'CONNECTING') {
        badge.textContent = 'Bağlanıyor';
        badge.className = 'card__badge card__badge--orange';
      } else {
        badge.textContent = wifiStatus || 'Açık';
        badge.className = 'card__badge card__badge--orange';
      }
    }
  }

  // STA section
  if (data.sta_ssid !== undefined) setEl('wifi-sta-ssid', (data.sta_ssid as string) || '—');
  if (data.sta_ip !== undefined) setEl('wifi-sta-ip', (data.sta_ip as string) || '—');
  if (data.sta_gw !== undefined) setEl('wifi-sta-gw', (data.sta_gw as string) || '—');
  if (data.wifi_rssi !== undefined) {
    const rssi = data.wifi_rssi as number;
    const bars = rssi === 0 ? '—' : rssi > -50 ? `${rssi} dBm ████` : rssi > -65 ? `${rssi} dBm ███░` : rssi > -75 ? `${rssi} dBm ██░░` : `${rssi} dBm █░░░`;
    setEl('wifi-sta-rssi', bars);
  }
  if (data.wifi_status !== undefined) setEl('wifi-sta-status', data.wifi_status as string);

  // AP section
  if (data.ap_ssid !== undefined) setEl('wifi-ap-ssid', (data.ap_ssid as string) || '—');
  if (data.ap_ip !== undefined) setEl('wifi-ap-ip', data.ap_ip as string);
  if (data.ap_channel !== undefined) setEl('wifi-ap-channel', String(data.ap_channel));
  if (data.ap_client_count !== undefined) setEl('wifi-ap-clients', String(data.ap_client_count));

  // General section
  if (data.wifi_mode !== undefined) {
    const modeMap: Record<string, string> = { 'ap_sta': 'AP + STA', 'sta': 'STA', 'ap': 'AP', 'off': 'Kapalı' };
    setEl('wifi-mode', modeMap[data.wifi_mode as string] || String(data.wifi_mode));
  }
  if (data.server_ip !== undefined) setEl('wifi-server', data.server_ip as string);
  if (data.temp_c !== undefined) setEl('wifi-temp', `${(data.temp_c as number).toFixed(1)} °C`);
}

function updateConnectionUI(type: 'ble' | 'ws', state: string): void {
  if (type === 'ble') {
    const statusEl = document.getElementById('ble-status');
    const detailEl = document.getElementById('ble-detail');
    if (statusEl) {
      const map: Record<string, [string, string]> = {
        'connected': ['Bağlı', 'connection-item__status--connected'],
        'disconnected': ['Bağlantı Yok', 'connection-item__status--disconnected'],
        'scanning': ['Taranıyor', 'connection-item__status--connecting'],
        'connecting': ['Bağlanıyor', 'connection-item__status--connecting'],
        'reconnecting': ['Yeniden Bağlanıyor', 'connection-item__status--connecting'],
      };
      const [text, cls] = map[state] || ['?', 'connection-item__status--connecting'];
      statusEl.textContent = text;
      statusEl.className = `connection-item__status ${cls}`;
    }
    if (detailEl && state === 'connected') {
      detailEl.textContent = `MAC: ${bleService.getDeviceMac()}`;
    }
  } else {
    const statusEl = document.getElementById('ws-status');
    if (statusEl) {
      const map: Record<string, [string, string]> = {
        'connected': ['Bağlı', 'connection-item__status--connected'],
        'disconnected': ['Bağlantı Yok', 'connection-item__status--disconnected'],
        'connecting': ['Bağlanıyor', 'connection-item__status--connecting'],
        'reconnecting': ['Yeniden Bağlanıyor', 'connection-item__status--connecting'],
      };
      const [text, cls] = map[state] || ['?', 'connection-item__status--connecting'];
      statusEl.textContent = text;
      statusEl.className = `connection-item__status ${cls}`;
    }
  }

  // Update header status dot
  const bleState = bleService.getState();
  const wsState = wsRelay?.getState() || 'disconnected';
  const dot = document.getElementById('status-dot');
  const statusText = document.getElementById('status-text');

  if (bleState === 'connected' && wsState === 'connected') {
    dot?.setAttribute('class', 'status-dot status-dot--online');
    if (statusText) statusText.textContent = 'Çevrimiçi';
  } else if (bleState === 'disconnected' && wsState === 'disconnected') {
    dot?.setAttribute('class', 'status-dot status-dot--offline');
    if (statusText) statusText.textContent = 'Çevrimdışı';
  } else {
    dot?.setAttribute('class', 'status-dot status-dot--connecting');
    if (statusText) statusText.textContent = 'Bağlanıyor...';
  }
}

function updateStats(): void {
  const statsEl = document.getElementById('stats-detail');
  if (statsEl && wsRelay) {
    const s = wsRelay.getStats();
    statsEl.textContent = `Gönderilen: ${s.messagesSent} | Tampon: ${s.messagesBuffered} | Yeniden bağl: ${s.reconnectAttempts}`;
  }
}

// ═══════════════════════════════════════════════════════════
// Navigation
// ═══════════════════════════════════════════════════════════

function showPage(page: string): void {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('page--active'));
  document.querySelectorAll('.nav__item').forEach(n => n.classList.remove('nav__item--active'));

  const pageEl = document.getElementById(`page-${page}`);
  const navEl = document.getElementById(`nav-${page}`);
  if (pageEl) pageEl.classList.add('page--active');
  if (navEl) navEl.classList.add('nav__item--active');
}

// ═══════════════════════════════════════════════════════════
// Logging
// ═══════════════════════════════════════════════════════════

function addLog(level: string, msg: string): void {
  const ts = new Date().toLocaleTimeString('tr-TR');
  logLines.push({ level, msg, ts });
  if (logLines.length > 500) logLines = logLines.slice(-400);

  const console = document.getElementById('log-console');
  if (console) {
    const line = document.createElement('div');
    line.className = `log-line log-line--${level}`;
    line.textContent = `${ts} ${msg}`;
    console.appendChild(line);
    console.scrollTop = console.scrollHeight;
  }
}

// ═══════════════════════════════════════════════════════════
// PIN Dialog
// ═══════════════════════════════════════════════════════════

function setupPinInputs(): void {
  const inputs = document.querySelectorAll<HTMLInputElement>('.pin-input__digit');
  inputs.forEach((input, i) => {
    input.addEventListener('input', () => {
      if (input.value.length === 1 && i < inputs.length - 1) {
        (inputs[i + 1] as HTMLInputElement).focus();
      }
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Backspace' && input.value === '' && i > 0) {
        (inputs[i - 1] as HTMLInputElement).focus();
      }
    });
  });
}

function showPinDialog(): void {
  if (protectionService.isLockedOut()) {
    const remaining = protectionService.getLockoutRemainingMs();
    const mins = Math.ceil(remaining / 60000);
    const errorEl = document.getElementById('pin-error');
    if (errorEl) errorEl.textContent = `PIN kilitlendi. ${mins} dakika sonra tekrar deneyin.`;
    return;
  }

  const overlay = document.getElementById('pin-overlay');
  overlay?.classList.add('modal-overlay--visible');

  // Clear inputs
  document.querySelectorAll<HTMLInputElement>('.pin-input__digit').forEach(i => {
    i.value = '';
    i.classList.remove('pin-input__digit--error');
  });
  const errorEl = document.getElementById('pin-error');
  if (errorEl) errorEl.textContent = '';

  // Focus first
  const first = document.querySelector<HTMLInputElement>('.pin-input__digit');
  setTimeout(() => first?.focus(), 300);
}

function closePinDialog(): void {
  const overlay = document.getElementById('pin-overlay');
  overlay?.classList.remove('modal-overlay--visible');
}

function submitPin(): void {
  const inputs = document.querySelectorAll<HTMLInputElement>('.pin-input__digit');
  let pin = '';
  inputs.forEach(i => pin += i.value);

  if (pin.length < 6) {
    const errorEl = document.getElementById('pin-error');
    if (errorEl) errorEl.textContent = 'Lütfen 6 haneli PIN kodunu girin.';
    return;
  }

  const result = protectionService.verifyPin(pin);

  if (result.correct) {
    closePinDialog();
    protectionService.stopMonitoring();
    wsRelay?.sendMonitoringStopped('patient_pin');
    addLog('warn', 'İzleme DURDURULDU (PIN ile)');
  } else if (result.locked) {
    const errorEl = document.getElementById('pin-error');
    if (errorEl) errorEl.textContent = 'Çok fazla yanlış deneme. 30 dakika kilitlendi. Doktorunuz bilgilendirildi.';
    inputs.forEach(i => i.classList.add('pin-input__digit--error'));
    // Notify server about lockout
    wsRelay?.sendTelemetry({ pin_lockout: true, timestamp: new Date().toISOString() });
  } else {
    const errorEl = document.getElementById('pin-error');
    if (errorEl) errorEl.textContent = `Yanlış PIN. ${result.attemptsLeft} deneme hakkınız kaldı.`;
    inputs.forEach(i => {
      i.value = '';
      i.classList.add('pin-input__digit--error');
    });
    setTimeout(() => {
      inputs.forEach(i => i.classList.remove('pin-input__digit--error'));
    }, 500);
    (inputs[0] as HTMLInputElement).focus();
  }
}

// ═══════════════════════════════════════════════════════════
// Emergency UI
// ═══════════════════════════════════════════════════════════

function showEmergencyUI(type: string): void {
  const overlay = document.getElementById('emergency-overlay');
  const text = document.getElementById('emergency-text');
  const messages: Record<string, string> = {
    'FALL': 'Düşme tespit edildi! Doktorunuz bilgilendirildi.',
    'SOS': 'Acil durum sinyali gönderildi. Doktorunuz bilgilendirildi.',
    'ANOMALY': 'Anormal değerler tespit edildi. Doktorunuz bilgilendirildi.',
  };
  if (text) text.textContent = messages[type] || 'Acil durum tespit edildi.';
  overlay?.classList.add('modal-overlay--visible');
}

// ═══════════════════════════════════════════════════════════
// Utility
// ═══════════════════════════════════════════════════════════

function formatDuration(seconds: number): string {
  if (seconds < 0 || isNaN(seconds)) return '--';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}s ${m}dk`;
  if (m > 0) return `${m}dk ${s}sn`;
  return `${s}sn`;
}

// ═══════════════════════════════════════════════════════════
// Global handlers (for onclick in HTML)
// ═══════════════════════════════════════════════════════════

(window as any)._showPage = showPage;
(window as any)._handleSOS = () => {
  addLog('error', '🚨 HASTA SOS BUTONU — Doktor bilgilendiriliyor...');
  wsRelay?.sendEmergency({
    type: 'SOS',
    timestamp: new Date().toISOString(),
    data: { source: 'patient_button', vitals: latestTelemetry },
  });
  showEmergencyUI('SOS');
};
(window as any)._toggleVisibility = () => {
  protectionService.toggleVisibility();
  const toggle = document.getElementById('toggle-visibility');
  if (toggle) {
    toggle.classList.toggle('toggle--active', protectionService.getVisibility() === 'visible');
  }
};
(window as any)._showStopDialog = () => showPinDialog();
(window as any)._showResumDialog = () => {
  protectionService.resumeMonitoring();
  addLog('success', 'İzleme yeniden başlatıldı');
};
(window as any)._closePinDialog = () => closePinDialog();
(window as any)._submitPin = () => submitPin();
(window as any)._dismissEmergency = () => {
  const overlay = document.getElementById('emergency-overlay');
  overlay?.classList.remove('modal-overlay--visible');
};
(window as any)._clearLogs = () => {
  logLines = [];
  const console = document.getElementById('log-console');
  if (console) console.innerHTML = '<div class="log-line log-line--info">Günlük temizlendi.</div>';
};
(window as any)._rescan = async () => {
  addLog('info', 'Yeniden taranıyor...');
  bleService.enableAutoReconnect();
  await bleService.scanAndConnect();
};
(window as any)._reconnectWs = () => {
  addLog('info', 'Sunucuya yeniden bağlanılıyor...');
  wsRelay?.disconnect();
  setTimeout(() => wsRelay?.connect(), 500);
};

// ═══════════════════════════════════════════════════════════
// Phase 11: Video Call UI Management
// ═══════════════════════════════════════════════════════════
let _callAutoAnswerInterval: ReturnType<typeof setInterval> | null = null;
let _callDurationInterval: ReturnType<typeof setInterval> | null = null;

function updateCallUI(state: CallState): void {
  const overlay = document.getElementById('call-overlay');
  const ringing = document.getElementById('call-ringing');
  const active = document.getElementById('call-active');

  if (!overlay || !ringing || !active) return;

  switch (state) {
    case 'idle':
      overlay.classList.remove('call-overlay--visible');
      ringing.style.display = 'none';
      active.style.display = 'none';
      if (_callAutoAnswerInterval) { clearInterval(_callAutoAnswerInterval); _callAutoAnswerInterval = null; }
      if (_callDurationInterval) { clearInterval(_callDurationInterval); _callDurationInterval = null; }
      // Clean up video elements
      const remoteVid = document.getElementById('call-remote-video');
      if (remoteVid) remoteVid.innerHTML = '';
      const localPrev = document.getElementById('call-local-preview');
      if (localPrev) localPrev.innerHTML = '';
      break;

    case 'ringing':
      overlay.classList.add('call-overlay--visible');
      ringing.style.display = 'flex';
      active.style.display = 'none';
      // Auto-answer countdown
      let countdown = 15;
      const autoEl = document.getElementById('call-auto-answer');
      _callAutoAnswerInterval = setInterval(() => {
        countdown--;
        if (autoEl) autoEl.textContent = `Auto-answer in ${countdown}s`;
        if (countdown <= 0 && _callAutoAnswerInterval) {
          clearInterval(_callAutoAnswerInterval);
          _callAutoAnswerInterval = null;
        }
      }, 1000);
      // Wire up accept/decline buttons
      const acceptBtn = document.getElementById('call-btn-accept');
      const declineBtn = document.getElementById('call-btn-decline');
      if (acceptBtn) acceptBtn.onclick = () => callService.acceptCall();
      if (declineBtn) declineBtn.onclick = () => callService.declineCall();
      break;

    case 'connecting':
      ringing.style.display = 'none';
      active.style.display = 'flex';
      if (_callAutoAnswerInterval) { clearInterval(_callAutoAnswerInterval); _callAutoAnswerInterval = null; }
      const titleEl = document.getElementById('call-active-title');
      if (titleEl) titleEl.textContent = '📞 Connecting...';
      break;

    case 'active':
      ringing.style.display = 'none';
      active.style.display = 'flex';
      const activeTitleEl = document.getElementById('call-active-title');
      if (activeTitleEl) activeTitleEl.textContent = '📞 Video Call Active';
      // Duration timer
      let seconds = 0;
      _callDurationInterval = setInterval(() => {
        seconds++;
        const m = Math.floor(seconds / 60);
        const s = seconds % 60;
        const durEl = document.getElementById('call-active-duration');
        if (durEl) durEl.textContent = `${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}`;
      }, 1000);
      break;
  }
}

// Window globals for call control buttons
(window as any)._callToggleMute = async () => {
  const muted = await callService.toggleMute();
  const btn = document.getElementById('call-btn-mute');
  if (btn) {
    btn.textContent = muted ? '🔇' : '🎤';
    btn.classList.toggle('call-btn--muted', muted);
  }
};
(window as any)._callToggleCam = async () => {
  const off = await callService.toggleCamera();
  const btn = document.getElementById('call-btn-cam');
  if (btn) {
    btn.classList.toggle('call-btn--muted', off);
  }
};
(window as any)._callEnd = () => {
  callService.endCall();
};
