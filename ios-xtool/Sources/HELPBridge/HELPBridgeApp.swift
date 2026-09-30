/// HELP Telecare Bridge — iOS App
/// SwiftUI + WKWebView with embedded dashboard

import SwiftUI
import WebKit

@main
struct HELPBridgeApp: App {
    var body: some Scene {
        WindowGroup {
            WebAppView()
                .ignoresSafeArea()
                .preferredColorScheme(.dark)
        }
    }
}

// MARK: - SwiftUI WebView Wrapper
struct WebAppView: UIViewRepresentable {

    func makeCoordinator() -> WebViewCoordinator {
        WebViewCoordinator()
    }

    func makeUIView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.allowsInlineMediaPlayback = true
        config.mediaTypesRequiringUserActionForPlayback = []

        // Native → JS bridge
        let contentController = WKUserContentController()
        contentController.add(context.coordinator, name: "helpNative")
        config.userContentController = contentController

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.scrollView.bounces = false
        webView.isOpaque = false
        webView.backgroundColor = UIColor(red: 0.039, green: 0.051, blue: 0.094, alpha: 1.0)

        #if DEBUG
        if #available(iOS 16.4, *) {
            webView.isInspectable = true
        }
        #endif

        // Load the self-contained dashboard
        webView.loadHTMLString(Self.dashboardHTML(), baseURL: nil)

        // Wire native services to this webview
        ServiceBridge.shared.webView = webView

        return webView
    }

    func updateUIView(_ webView: WKWebView, context: Context) {}

    // MARK: - Read bundled CSS
    private static func readBundledCSS() -> String {
        let searchBundles: [Bundle] = {
            var b = [Bundle.main]
            if let p = Bundle.main.path(forResource: "HELPBridge_HELPBridge", ofType: "bundle"),
               let rb = Bundle(path: p) { b.append(rb) }
            b.append(Bundle.module)
            return b
        }()

        for bundle in searchBundles {
            let fm = FileManager.default
            guard let en = fm.enumerator(atPath: bundle.bundlePath) else { continue }
            while let path = en.nextObject() as? String {
                if path.hasSuffix(".css") {
                    let full = (bundle.bundlePath as NSString).appendingPathComponent(path)
                    if let css = try? String(contentsOfFile: full, encoding: .utf8) {
                        print("[HELP] CSS loaded: \(css.count) bytes from \(path)")
                        return css
                    }
                }
            }
        }
        print("[HELP] No CSS found in bundle")
        return ""
    }

    // MARK: - Dashboard HTML (self-contained)
    private static func dashboardHTML() -> String {
        let css = readBundledCSS()
        let hasCSS = !css.isEmpty

        return """
<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no, viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<title>HELP Telecare</title>
<style>
\(hasCSS ? css : Self.fallbackCSS())
</style>
</head>
<body>
<div id="app">

<!-- Header -->
<div class="header">
  <div class="header__logo">
    <div class="header__icon">💚</div>
    <div>
      <div class="header__title">HELP</div>
      <div class="header__subtitle">Telecare Bridge</div>
    </div>
  </div>
  <div class="header__status">
    <span id="status-text" style="font-size:12px;color:#8892b0">Başlatılıyor...</span>
    <div id="status-dot" class="status-dot status-dot--connecting"></div>
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
        <span style="color:#8892b0;font-size:14px">/ <span id="freq-total">340</span> adım</span>
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
        <div id="ws-detail" class="connection-item__detail">78.187.171.33</div>
      </div>
      <span id="ws-status" class="connection-item__status connection-item__status--connecting">Bağlanıyor</span>
    </div>
  </div>

  <!-- BLE Debug (Live) -->
  <div class="card fade-in" style="border:1px solid #ff9800">
    <div class="card__header">
      <span class="card__title" style="color:#ff9800">🔍 BLE Debug</span>
      <span id="ble-scan-count" class="card__badge card__badge--blue">0 cihaz</span>
    </div>
    <div id="ble-debug" style="font-family:monospace;font-size:11px;color:#8a94a8;max-height:120px;overflow-y:auto;padding:8px;background:#0a0e1a;border-radius:8px">
      <div>BLE başlatılıyor...</div>
    </div>
  </div>

  <!-- SOS Button -->
  <button id="btn-sos" class="sos-button" onclick="handleSOS()">SOS</button>
  <p style="text-align:center;font-size:12px;color:#5a6480;margin-top:-12px">Acil durum butonu</p>
</div>

<!-- Settings Page -->
<div id="page-settings" class="page">
  <div class="card">
    <div class="card__header">
      <span class="card__title">Ayarlar</span>
    </div>
    <ul class="settings-list">
      <li class="settings-item">
        <div class="settings-item__icon">📱</div>
        <div class="settings-item__content">
          <div class="settings-item__label">Platform</div>
          <div class="settings-item__desc">iOS Native (xtool)</div>
        </div>
      </li>
      <li class="settings-item">
        <div class="settings-item__icon">📡</div>
        <div class="settings-item__content">
          <div class="settings-item__label">BLE Durumu</div>
          <div id="settings-ble" class="settings-item__desc">Bağlantı bekleniyor</div>
        </div>
      </li>
      <li class="settings-item">
        <div class="settings-item__icon">🌐</div>
        <div class="settings-item__content">
          <div class="settings-item__label">Sunucu</div>
          <div id="settings-ws" class="settings-item__desc">78.187.171.33:8001</div>
        </div>
      </li>
      <li class="settings-item">
        <div class="settings-item__icon">ℹ️</div>
        <div class="settings-item__content">
          <div class="settings-item__label">Versiyon</div>
          <div class="settings-item__desc">HELP Bridge v1.0 (Phase 1)</div>
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
      <span class="card__badge card__badge--green" onclick="clearLogs()" style="cursor:pointer">Temizle</span>
    </div>
    <div id="log-console" class="log-console">
      <div class="log-line log-line--info">HELP Telecare Bridge hazır.</div>
    </div>
  </div>
  <button class="btn btn--primary" onclick="rescan()" style="margin-top:12px">📡 Cihazı Yeniden Tara</button>
  <button class="btn btn--outline" onclick="reconnectWs()" style="margin-top:8px">🌐 Sunucuya Yeniden Bağlan</button>
</div>

<!-- Emergency Overlay -->
<div id="emergency-overlay" class="modal-overlay">
  <div class="modal" style="border-color:#ff1744;box-shadow:0 0 20px rgba(255,23,68,.3)">
    <div class="modal__icon heartbeat-anim">🚨</div>
    <div class="modal__title" style="color:#ff1744">ACİL DURUM</div>
    <div id="emergency-text" class="modal__text">Acil durum tespit edildi.</div>
    <button class="btn btn--danger" onclick="dismissEmergency()">Tamam, İyiyim</button>
  </div>
</div>

<!-- Pairing Prompt Overlay -->
<div id="pairing-overlay" class="modal-overlay">
  <div class="modal" style="border-color:#ff9800;box-shadow:0 0 20px rgba(255,152,0,.3)">
    <div class="modal__icon" style="font-size:48px">🔐</div>
    <div class="modal__title" style="color:#ff9800">Eşleşme Gerekli</div>
    <p style="text-align:center;color:#8a94a8;font-size:14px;margin:12px 0">
      iPhone ekranında <strong style="color:#fff">"Bluetooth Eşleştirme İsteği"</strong> çıkacak.<br><br>
      Lütfen <strong style="color:#00e676">"Eşle"</strong> butonuna basın!
    </p>
    <button class="btn btn--primary" onclick="dismissPairing()" style="margin-top:12px">Tamam, Anladım</button>
  </div>
</div>

<!-- Bottom Navigation -->
<nav class="nav">
  <button id="nav-dashboard" class="nav__item nav__item--active" onclick="showPage('dashboard')">
    <span class="nav__item__icon">💚</span>
    <span>Ana Sayfa</span>
  </button>
  <button id="nav-settings" class="nav__item" onclick="showPage('settings')">
    <span class="nav__item__icon">⚙️</span>
    <span>Ayarlar</span>
  </button>
  <button id="nav-logs" class="nav__item" onclick="showPage('logs')">
    <span class="nav__item__icon">📋</span>
    <span>Günlük</span>
  </button>
</nav>

</div>

<script>
// ═══════════════════════════════════════════════════════════
// HELP Telecare Bridge — Vanilla JS (no build step)
// ═══════════════════════════════════════════════════════════
var currentPage = 'dashboard';

function showPage(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(function(p) { p.classList.remove('page--active'); });
  document.querySelectorAll('.nav__item').forEach(function(n) { n.classList.remove('nav__item--active'); });
  var pageEl = document.getElementById('page-' + page);
  var navEl = document.getElementById('nav-' + page);
  if (pageEl) pageEl.classList.add('page--active');
  if (navEl) navEl.classList.add('nav__item--active');
}

function addLog(level, msg) {
  var ts = new Date().toLocaleTimeString('tr-TR');
  var el = document.getElementById('log-console');
  if (el) {
    var line = document.createElement('div');
    line.className = 'log-line log-line--' + level;
    line.textContent = ts + ' ' + msg;
    el.appendChild(line);
    el.scrollTop = el.scrollHeight;
  }
  // Also push BLE messages to debug panel on main page
  if (msg.indexOf('[BLE]') !== -1) {
    var dbg = document.getElementById('ble-debug');
    if (dbg) {
      var d = document.createElement('div');
      var color = level === 'error' ? '#ff1744' : level === 'success' ? '#00e676' : level === 'warn' ? '#ff9800' : '#8a94a8';
      d.style.color = color;
      d.textContent = ts.substr(0,8) + ' ' + msg.replace('[BLE] ', '');
      dbg.appendChild(d);
      // Keep last 20 lines
      while (dbg.children.length > 20) dbg.removeChild(dbg.firstChild);
      dbg.scrollTop = dbg.scrollHeight;
    }
  }
}

function clearLogs() {
  var el = document.getElementById('log-console');
  if (el) el.innerHTML = '<div class="log-line log-line--info">Günlük temizlendi.</div>';
}

function handleSOS() {
  addLog('error', '🚨 SOS butonu basıldı!');
  var overlay = document.getElementById('emergency-overlay');
  var text = document.getElementById('emergency-text');
  if (text) text.textContent = 'Acil durum sinyali gönderildi. Doktorunuz bilgilendirildi.';
  if (overlay) overlay.classList.add('modal-overlay--visible');
  // Send to native
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helpNative) {
    window.webkit.messageHandlers.helpNative.postMessage({
      type: 'emergency', data: { action: 'SOS', timestamp: new Date().toISOString() }
    });
  }
}

function dismissEmergency() {
  var overlay = document.getElementById('emergency-overlay');
  if (overlay) overlay.classList.remove('modal-overlay--visible');
}

function rescan() {
  addLog('info', 'BLE yeniden taranıyor...');
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helpNative) {
    window.webkit.messageHandlers.helpNative.postMessage({ type: 'command', data: { command: 'rescan' } });
  }
}

function reconnectWs() {
  addLog('info', 'Sunucuya yeniden bağlanılıyor...');
  if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helpNative) {
    window.webkit.messageHandlers.helpNative.postMessage({ type: 'command', data: { command: 'reconnect_ws' } });
  }
}

function formatDuration(seconds) {
  if (seconds < 0 || isNaN(seconds)) return '--';
  var h = Math.floor(seconds / 3600);
  var m = Math.floor((seconds % 3600) / 60);
  var s = Math.floor(seconds % 60);
  if (h > 0) return h + 's ' + m + 'dk';
  if (m > 0) return m + 'dk ' + s + 'sn';
  return s + 'sn';
}

// Public API for native code to push telemetry
window.updateTelemetry = function(data) {
  if (data.heart_rate !== undefined) {
    var el = document.getElementById('v-hr');
    if (el) el.textContent = String(data.heart_rate);
  }
  if (data.spo2 !== undefined) {
    var el = document.getElementById('v-spo2');
    if (el) el.textContent = String(data.spo2);
  }
  if (data.temperature !== undefined) {
    var el = document.getElementById('v-temp');
    if (el) el.textContent = data.temperature.toFixed(1);
  }
  if (data.frequency !== undefined) {
    var el = document.getElementById('v-freq');
    if (el) el.textContent = data.frequency < 1000 ? data.frequency.toFixed(2) : String(Math.round(data.frequency));
  }
  if (data.step !== undefined) {
    var total = data.total_steps || 340;
    var pct = Math.min((data.step / total) * 100, 100);
    var stepEl = document.getElementById('freq-step');
    var totalEl = document.getElementById('freq-total');
    var barEl = document.getElementById('freq-bar');
    if (stepEl) stepEl.textContent = String(data.step);
    if (totalEl) totalEl.textContent = String(total);
    if (barEl) barEl.style.width = pct + '%';
  }
  if (data.state) {
    var stateEl = document.getElementById('freq-state');
    if (stateEl) {
      var map = {
        'ST_ACTIVE': ['Aktif', 'card__badge--green'],
        'ST_SILENT': ['Sessiz', 'card__badge--orange'],
        'ST_WAITING': ['Bekliyor', 'card__badge--orange'],
        'ST_REST': ['Tamamlandı', 'card__badge--green']
      };
      var entry = map[data.state] || [data.state, 'card__badge--orange'];
      stateEl.textContent = entry[0];
      stateEl.className = 'card__badge ' + entry[1];
    }
  }
  if (data.playlist_remaining !== undefined) {
    var remEl = document.getElementById('freq-remaining');
    if (remEl) remEl.textContent = 'Kalan: ' + formatDuration(data.playlist_remaining);
  }
  if (data.op_duration_sec !== undefined) {
    var elEl = document.getElementById('freq-elapsed');
    if (elEl) elEl.textContent = 'Geçen: ' + formatDuration(data.op_duration_sec);
  }

  // Update vitals badge
  var badge = document.getElementById('vitals-badge');
  if (badge) { badge.textContent = 'Canlı'; badge.className = 'card__badge card__badge--green'; }
};

window.updateConnectionStatus = function(type, state) {
  if (type === 'ble') {
    var s = document.getElementById('ble-status');
    var d = document.getElementById('ble-detail');
    var map = { connected: ['Bağlı','connected'], disconnected: ['Bağlantı Yok','disconnected'],
                scanning: ['Taranıyor','connecting'], connecting: ['Eşleşiyor...','connecting'],
                reconnecting: ['Yeniden...','connecting'] };
    var e = map[state] || [state, 'connecting'];
    if (s) { s.textContent = e[0]; s.className = 'connection-item__status connection-item__status--' + e[1]; }
    // Show pairing prompt when connecting (ESP32 will initiate LESC)
    if (state === 'connecting') {
      var po = document.getElementById('pairing-overlay');
      if (po) po.classList.add('modal-overlay--visible');
    } else if (state === 'connected' || state === 'disconnected' || state === 'scanning') {
      var po = document.getElementById('pairing-overlay');
      if (po) po.classList.remove('modal-overlay--visible');
    }
  } else {
    var s = document.getElementById('ws-status');
    var map = { connected: ['Bağlı','connected'], disconnected: ['Bağlantı Yok','disconnected'],
                connecting: ['Bağlanıyor','connecting'] };
    var e = map[state] || [state, 'connecting'];
    if (s) { s.textContent = e[0]; s.className = 'connection-item__status connection-item__status--' + e[1]; }
  }
};

function dismissPairing() {
  var po = document.getElementById('pairing-overlay');
  if (po) po.classList.remove('modal-overlay--visible');
}

// Boot message
addLog('info', 'HELP Telecare Bridge başlatıldı (iOS)');
addLog('info', 'Platform: iOS Native — WKWebView');
addLog('info', 'BLE ve sunucu bağlantısı bekleniyor...');

// Called from native code when ESP32 sends emergency
window.showEmergencyFromNative = function(type) {
  var overlay = document.getElementById('emergency-overlay');
  var text = document.getElementById('emergency-text');
  var messages = {
    'FALL': 'Düşme tespit edildi! Doktorunuz bilgilendirildi.',
    'SOS': 'Acil durum sinyali gönderildi. Doktorunuz bilgilendirildi.',
    'ANOMALY': 'Anormal değerler tespit edildi. Doktorunuz bilgilendirildi.'
  };
  if (text) text.textContent = messages[type] || 'Acil durum tespit edildi.';
  if (overlay) overlay.classList.add('modal-overlay--visible');
  addLog('error', '🚨 ACİL DURUM: ' + type);
};

// Notify native that webview is ready
if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.helpNative) {
  window.webkit.messageHandlers.helpNative.postMessage({ type: 'ready', data: {} });
}
</script>
</body>
</html>
"""
    }

    // MARK: - Fallback CSS (if bundle CSS not found)
    private static func fallbackCSS() -> String {
        return """
:root{--bg-primary:#0a0e1a;--bg-secondary:#111827;--bg-card:#1a2035;--bg-glass:rgba(26,32,53,.85);--accent-green:#00e676;--accent-green-dim:rgba(0,230,118,.15);--accent-blue:#2196f3;--accent-blue-dim:rgba(33,150,243,.15);--accent-red:#ff1744;--accent-red-dim:rgba(255,23,68,.15);--accent-orange:#ff9100;--accent-orange-dim:rgba(255,145,0,.15);--text-primary:#e8eaf6;--text-secondary:#8892b0;--text-dim:#5a6480;--border-subtle:rgba(255,255,255,.06);--border-accent:rgba(0,230,118,.3);--shadow-card:0 4px 24px rgba(0,0,0,.3);--shadow-glow-green:0 0 20px rgba(0,230,118,.2);--shadow-glow-red:0 0 20px rgba(255,23,68,.3);--safe-top:env(safe-area-inset-top,0px);--safe-bottom:env(safe-area-inset-bottom,0px);--transition-fast:.15s cubic-bezier(.4,0,.2,1);--transition-smooth:.3s cubic-bezier(.4,0,.2,1)}
*,*:before,*:after{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%;overflow:hidden;font-family:-apple-system,sans-serif;background:var(--bg-primary);color:var(--text-primary);-webkit-tap-highlight-color:transparent;user-select:none;-webkit-user-select:none}
#app{height:100%;display:flex;flex-direction:column;padding-top:var(--safe-top);padding-bottom:var(--safe-bottom)}
.header{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:var(--bg-glass);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border-bottom:1px solid var(--border-subtle);z-index:100;flex-shrink:0}
.header__logo{display:flex;align-items:center;gap:10px}
.header__icon{width:36px;height:36px;background:linear-gradient(135deg,var(--accent-green),#00c853);border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;box-shadow:var(--shadow-glow-green)}
.header__title{font-size:18px;font-weight:700}
.header__subtitle{font-size:11px;color:var(--text-secondary)}
.header__status{display:flex;align-items:center;gap:8px}
.status-dot{width:10px;height:10px;border-radius:50%}
.status-dot--online{background:var(--accent-green);box-shadow:0 0 8px var(--accent-green)}
.status-dot--offline{background:var(--accent-red)}
.status-dot--connecting{background:var(--accent-orange);animation:pulse-dot 1s ease-in-out infinite}
@keyframes pulse-dot{0%,to{opacity:1}50%{opacity:.3}}
.page{flex:1;overflow-y:auto;padding:16px;display:none}
.page--active{display:block}
.card{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:16px;padding:20px;margin-bottom:12px;box-shadow:var(--shadow-card)}
.card__header{display:flex;align-items:center;justify-content:space-between;margin-bottom:16px}
.card__title{font-size:14px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:.5px}
.card__badge{font-size:11px;padding:3px 8px;border-radius:6px;font-weight:600}
.card__badge--green{background:var(--accent-green-dim);color:var(--accent-green)}
.card__badge--orange{background:var(--accent-orange-dim);color:var(--accent-orange)}
.vitals-grid{display:grid;grid-template-columns:1fr 1fr;gap:12px}
.vital-item{background:#ffffff08;border-radius:12px;padding:16px;text-align:center;border:1px solid var(--border-subtle)}
.vital-item__icon{font-size:24px;margin-bottom:6px}
.vital-item__value{font-size:28px;font-weight:800;line-height:1;margin-bottom:4px}
.vital-item__label{font-size:11px;color:var(--text-secondary);text-transform:uppercase}
.vital-item--heart .vital-item__value{color:var(--accent-red)}
.vital-item--spo2 .vital-item__value{color:var(--accent-blue)}
.vital-item--temp .vital-item__value{color:var(--accent-orange)}
.vital-item--freq .vital-item__value{color:var(--accent-green);font-size:20px}
.connection-item{display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--border-subtle)}
.connection-item:last-child{border-bottom:none}
.connection-item__icon{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px}
.connection-item__icon--ble{background:var(--accent-blue-dim)}
.connection-item__icon--ws{background:var(--accent-green-dim)}
.connection-item__info{flex:1}
.connection-item__name{font-size:14px;font-weight:600}
.connection-item__detail{font-size:12px;color:var(--text-secondary)}
.connection-item__status{font-size:12px;font-weight:600;padding:4px 10px;border-radius:8px}
.connection-item__status--connected{color:var(--accent-green);background:var(--accent-green-dim)}
.connection-item__status--disconnected{color:var(--accent-red);background:var(--accent-red-dim)}
.connection-item__status--connecting{color:var(--accent-orange);background:var(--accent-orange-dim)}
.freq-progress__bar-bg{height:6px;background:#ffffff14;border-radius:3px;overflow:hidden;margin:8px 0}
.freq-progress__bar{height:100%;background:linear-gradient(90deg,var(--accent-green),#00e5ff);border-radius:3px;transition:width 1s ease}
.freq-progress__text{display:flex;justify-content:space-between;font-size:12px;color:var(--text-secondary)}
.freq-progress__step{font-size:20px;font-weight:700;color:var(--accent-green)}
.nav{display:flex;background:var(--bg-glass);backdrop-filter:blur(20px);border-top:1px solid var(--border-subtle);flex-shrink:0;z-index:100}
.nav__item{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;padding:10px 0;border:none;background:none;color:var(--text-dim);font-size:10px;font-weight:500;cursor:pointer}
.nav__item--active{color:var(--accent-green)}
.nav__item--active:before{content:"";position:absolute;top:0;left:50%;transform:translate(-50%);width:32px;height:3px;background:var(--accent-green);border-radius:0 0 3px 3px}
.nav__item__icon{font-size:20px}
.btn{display:inline-flex;align-items:center;justify-content:center;padding:14px 24px;border-radius:12px;font-size:15px;font-weight:600;border:none;cursor:pointer;width:100%}
.btn--primary{background:linear-gradient(135deg,var(--accent-green),#00c853);color:#0a0e1a}
.btn--danger{background:linear-gradient(135deg,var(--accent-red),#d50000);color:#fff}
.btn--outline{background:transparent;border:1.5px solid var(--border-accent);color:var(--accent-green)}
.sos-button{width:120px;height:120px;border-radius:50%;background:linear-gradient(135deg,var(--accent-red),#b71c1c);border:4px solid rgba(255,255,255,.2);color:#fff;font-size:32px;font-weight:800;cursor:pointer;display:flex;align-items:center;justify-content:center;margin:24px auto;box-shadow:0 0 30px #ff174466}
.log-console{background:#0d1117;border-radius:12px;padding:12px;font-family:monospace;font-size:11px;line-height:1.6;max-height:240px;overflow-y:auto;border:1px solid var(--border-subtle)}
.log-line{color:var(--text-secondary)}
.log-line--info{color:var(--accent-blue)}
.log-line--error{color:var(--accent-red)}
.log-line--warn{color:var(--accent-orange)}
.log-line--success{color:var(--accent-green)}
.fade-in{animation:fadeIn .3s ease}
@keyframes fadeIn{0%{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
.modal-overlay{position:fixed;top:0;right:0;bottom:0;left:0;background:#000000b3;backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;z-index:1000;padding:24px;opacity:0;pointer-events:none;transition:.3s}
.modal-overlay--visible{opacity:1;pointer-events:all}
.modal{background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:20px;padding:28px 24px;width:100%;max-width:360px}
.modal__icon{font-size:48px;text-align:center;margin-bottom:16px}
.modal__title{font-size:20px;font-weight:700;text-align:center;margin-bottom:8px}
.modal__text{font-size:14px;color:var(--text-secondary);text-align:center;line-height:1.5;margin-bottom:20px}
.heartbeat-anim{animation:heartbeat 1s ease-in-out infinite}
@keyframes heartbeat{0%,to{transform:scale(1)}14%{transform:scale(1.15)}28%{transform:scale(1)}42%{transform:scale(1.1)}56%{transform:scale(1)}}
.settings-list{list-style:none}
.settings-item{display:flex;align-items:center;gap:12px;padding:14px 0;border-bottom:1px solid var(--border-subtle)}
.settings-item:last-child{border-bottom:none}
.settings-item__icon{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:16px;background:#ffffff0d}
.settings-item__content{flex:1}
.settings-item__label{font-size:15px;font-weight:500}
.settings-item__desc{font-size:12px;color:var(--text-secondary);margin-top:2px}
"""
    }
}

// MARK: - WebView Coordinator
class WebViewCoordinator: NSObject, WKNavigationDelegate, WKScriptMessageHandler {

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard let body = message.body as? [String: Any],
              let type = body["type"] as? String else {
            print("[HELP] Invalid message from JS")
            return
        }
        let data = body["data"] as? [String: Any] ?? [:]

        switch type {
        case "ready":
            print("[HELP] WebView ready — starting native services")
            ServiceBridge.shared.start()
        case "log":
            if let msg = data["message"] as? String {
                print("[HELP-JS] \(msg)")
            }
        case "command":
            if let cmd = data["command"] as? String {
                print("[HELP] Command: \(cmd)")
                ServiceBridge.shared.handleWebViewCommand(cmd)
            }
        case "emergency":
            print("[HELP] 🚨 EMERGENCY: \(data)")
            ServiceBridge.shared.handleWebViewCommand("emergency")
            // Also send via native WS
            WebSocketRelay.shared.sendEmergency(data)
        default:
            print("[HELP] Message: \(type) → \(data)")
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        print("[HELP] WebView finished loading")
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        print("[HELP] WebView failed: \(error.localizedDescription)")
    }
}
