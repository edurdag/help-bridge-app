/// HELP Telecare Bridge — Phase 2+3: Native BLE + WebSocket Services
/// CoreBluetooth scanning/connection + URLSessionWebSocketTask relay

import Foundation
import CoreBluetooth
import UIKit
import WebKit

// MARK: - BLE Constants
/// GATT service and characteristic UUIDs matching ESP32 ble_gateway.c
nonisolated(unsafe) let HELP_SERVICE_UUID        = CBUUID(string: "0000FFF0-0000-1000-8000-00805F9B34FB")
nonisolated(unsafe) let CHAR_TELEMETRY_UUID      = CBUUID(string: "0000FFF1-0000-1000-8000-00805F9B34FB")
nonisolated(unsafe) let CHAR_COMMAND_UUID        = CBUUID(string: "0000FFF2-0000-1000-8000-00805F9B34FB")
nonisolated(unsafe) let CHAR_EMERGENCY_UUID      = CBUUID(string: "0000FFF4-0000-1000-8000-00805F9B34FB")
nonisolated(unsafe) let CHAR_BIOSENSOR_UUID      = CBUUID(string: "0000FFF5-0000-1000-8000-00805F9B34FB")

// MARK: - BLE Manager
class BLEManager: NSObject, CBCentralManagerDelegate, CBPeripheralDelegate, @unchecked Sendable {

    nonisolated(unsafe) static let shared = BLEManager()

    private var centralManager: CBCentralManager?
    private var connectedPeripheral: CBPeripheral?
    private var commandCharacteristic: CBCharacteristic?
    private var reconnectTimer: Timer?
    private var scanTimeoutTimer: Timer?
    private var reconnectAttempts = 0
    // MEDICAL DEVICE: No upper limit on reconnect attempts — patient's life depends on connectivity
    private let maxReconnectAttempts = Int.max
    private var started = false
    private var discoveredCount = 0
    private var isFirstPair = true  // Track first-time vs reconnection

    // Persisted peripheral UUID for instant reconnect (avoids full BLE scan)
    private let peripheralUUIDKey = "help_ble_peripheral_uuid"
    // CoreBluetooth State Restoration identifier for background wakeup
    private let restoreIdentifier = "HELPBridgeCentralManager"

    // Connection state
    enum State: String {
        case disconnected, scanning, connecting, connected, reconnecting
    }
    private(set) var state: State = .disconnected

    // Callbacks
    var onStateChange: ((State) -> Void)?
    var onTelemetry: (([String: Any]) -> Void)?
    var onEmergency: (([String: Any]) -> Void)?
    var onLog: ((String, String) -> Void)?

    private(set) var deviceMAC: String = ""

    private override init() {
        super.init()
        // DON'T create CBCentralManager here — wait for start()
    }

    // MARK: - Public API

    /// Call AFTER callbacks are wired
    func start() {
        guard !started else {
            log("info", "BLE zaten başlatıldı")
            if centralManager?.state == .poweredOn && state == .disconnected {
                scanAndConnect()
            }
            return
        }
        started = true

        let authStatus = CBCentralManager.authorization
        log("info", "BLE yetkilendirme: \(authDescription(authStatus))")

        if authStatus == .denied || authStatus == .restricted {
            log("error", "❌ Bluetooth izni yok! Ayarlar → Gizlilik → Bluetooth")
            return
        }

        log("info", "CBCentralManager oluşturuluyor (State Restoration aktif)...")
        centralManager = CBCentralManager(
            delegate: self,
            queue: DispatchQueue.main,
            options: [
                CBCentralManagerOptionShowPowerAlertKey: true,
                // State Restoration: iOS will wake app from background/terminated when BLE device reconnects
                CBCentralManagerOptionRestoreIdentifierKey: restoreIdentifier
            ]
        )
    }

    func scanAndConnect() {
        guard let cm = centralManager, cm.state == .poweredOn else {
            log("warn", "Bluetooth hazır değil")
            return
        }

        // PRIORITY 1: Try direct reconnect to known peripheral (instant, no scan needed)
        if attemptDirectReconnect() {
            return  // Direct reconnect initiated — skip scanning
        }

        // PRIORITY 2: Check if iOS already has connected peripherals with our service
        let connectedPeripherals = cm.retrieveConnectedPeripherals(withServices: [HELP_SERVICE_UUID])
        if let existing = connectedPeripherals.first {
            log("success", "🔄 Zaten bağlı periferik bulundu: \(existing.name ?? "?")")
            connectedPeripheral = existing
            existing.delegate = self
            persistPeripheralUUID(existing.identifier)
            setState(.connecting)
            cm.connect(existing, options: nil)
            return
        }

        // PRIORITY 3: Full BLE scan (slowest path — used only on first discovery)
        stopScan()
        setState(.scanning)
        discoveredCount = 0
        log("info", "🔍 BLE tarama başlıyor (tam tarama)...")

        cm.scanForPeripherals(
            withServices: nil,
            options: [CBCentralManagerScanOptionAllowDuplicatesKey: false]
        )

        scanTimeoutTimer = Timer.scheduledTimer(withTimeInterval: 20.0, repeats: false) { [weak self] _ in
            guard let self = self, self.state == .scanning else { return }
            self.stopScan()
            self.log("warn", "Tarama zaman aşımı — \(self.discoveredCount) cihaz bulundu, HELP yok")
            self.setState(.disconnected)
            self.scheduleReconnect(delay: 5.0)
        }
    }

    /// Attempt instant reconnect to a previously-paired peripheral via persisted UUID.
    /// Returns true if a reconnect was initiated (caller should return early).
    private func attemptDirectReconnect() -> Bool {
        guard let cm = centralManager,
              let uuidStr = UserDefaults.standard.string(forKey: peripheralUUIDKey),
              let uuid = UUID(uuidString: uuidStr) else {
            return false
        }

        let known = cm.retrievePeripherals(withIdentifiers: [uuid])
        guard let peripheral = known.first else {
            log("info", "Bilinen periferik bulunamadı (UUID: \(uuidStr.prefix(8))...) — tam taramaya geçiliyor")
            return false
        }

        log("success", "🔄 Bilinen cihaza doğrudan bağlanılıyor: \(peripheral.name ?? "HELP")")
        connectedPeripheral = peripheral
        peripheral.delegate = self
        isFirstPair = false  // This is a reconnection, not first-time pairing
        setState(.connecting)
        cm.connect(peripheral, options: nil)
        return true
    }

    /// Persist peripheral UUID to UserDefaults for future instant reconnects
    private func persistPeripheralUUID(_ uuid: UUID) {
        UserDefaults.standard.set(uuid.uuidString, forKey: peripheralUUIDKey)
        log("info", "Periferik UUID kaydedildi: \(uuid.uuidString.prefix(8))...")
    }

    func disconnect() {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        scanTimeoutTimer?.invalidate()
        scanTimeoutTimer = nil
        if let p = connectedPeripheral { centralManager?.cancelPeripheralConnection(p) }
        connectedPeripheral = nil
        commandCharacteristic = nil
        setState(.disconnected)
    }

    func sendCommand(_ command: String) {
        guard let p = connectedPeripheral, let c = commandCharacteristic,
              let data = command.data(using: .utf8) else { return }
        p.writeValue(data, for: c, type: .withResponse)
    }

    // MARK: - CBCentralManagerDelegate

    func centralManagerDidUpdateState(_ central: CBCentralManager) {
        log("info", "Bluetooth: \(stateDesc(central.state))")
        switch central.state {
        case .poweredOn:
            log("success", "✅ Bluetooth açık")
            scanAndConnect()
        case .poweredOff:
            log("error", "❌ Bluetooth kapalı!")
            setState(.disconnected)
        case .unauthorized:
            log("error", "❌ Bluetooth yetkisi yok: \(authDescription(CBCentralManager.authorization))")
            setState(.disconnected)
        default:
            log("info", "Bluetooth: \(stateDesc(central.state))")
        }
    }

    // MARK: - State Restoration (Background Wakeup)
    /// Called when iOS restores our CBCentralManager from background/terminated state.
    /// This allows the app to be woken by iOS when the BLE device reconnects.
    func centralManager(_ central: CBCentralManager, willRestoreState dict: [String: Any]) {
        log("info", "🔄 iOS State Restoration tetiklendi")
        if let peripherals = dict[CBCentralManagerRestoredStatePeripheralsKey] as? [CBPeripheral] {
            log("info", "Geri yüklenen periferikler: \(peripherals.count)")
            for p in peripherals {
                log("info", "  → \(p.name ?? "?") durum=\(p.state.rawValue)")
                if p.state == .connected || p.state == .connecting {
                    connectedPeripheral = p
                    p.delegate = self
                    isFirstPair = false
                    if p.state == .connected {
                        // Already connected — rediscover services
                        setState(.connecting)
                        p.discoverServices(nil)
                    } else {
                        setState(.connecting)
                    }
                }
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didDiscover peripheral: CBPeripheral,
                         advertisementData: [String: Any], rssi RSSI: NSNumber) {
        discoveredCount += 1
        let advName = advertisementData[CBAdvertisementDataLocalNameKey] as? String
        let name = peripheral.name ?? advName ?? ""

        // Log first 10 devices for debug
        if discoveredCount <= 10 {
            let svcs = (advertisementData[CBAdvertisementDataServiceUUIDsKey] as? [CBUUID])?.map { $0.uuidString }.joined(separator: ",") ?? ""
            log("info", "📱#\(discoveredCount) '\(name.isEmpty ? "?" : name)' RSSI:\(RSSI) [\(svcs)]")
        } else if discoveredCount == 11 {
            log("info", "... daha fazla cihaz, HELP aranıyor...")
        }

        guard name.uppercased().hasPrefix("HEALTH") || name.uppercased().hasPrefix("HELP") else { return }

        stopScan()
        log("success", "🎯 '\(name)' bulundu! RSSI:\(RSSI)")
        deviceMAC = peripheral.identifier.uuidString
        connectedPeripheral = peripheral
        peripheral.delegate = self
        persistPeripheralUUID(peripheral.identifier)  // Save for instant future reconnects
        isFirstPair = (UserDefaults.standard.string(forKey: peripheralUUIDKey) == nil)
        setState(.connecting)
        central.connect(peripheral, options: nil)
    }

    func centralManager(_ central: CBCentralManager, didConnect peripheral: CBPeripheral) {
        reconnectAttempts = 0

        if isFirstPair {
            // First-time connection — ESP32 will initiate LESC pairing in 1.5s
            log("success", "✅ Bağlandı! Eşleşme bekleniyor...")
            log("warn", "⏳ iPhone'da eşleşme isteği çıkacak — lütfen KABUL EDİN!")
            // Delay service discovery to allow LESC pairing to complete first
            DispatchQueue.main.asyncAfter(deadline: .now() + 3.0) { [weak self] in
                guard let self = self, let p = self.connectedPeripheral else { return }
                self.log("info", "Servisler keşfediliyor...")
                p.discoverServices(nil)
            }
        } else {
            // Reconnection with existing bond — no pairing needed, fast path
            log("success", "✅ Yeniden bağlandı! (sessiz yeniden bağlantı — eşleşme gerekmez)")
            // Discover services immediately — bond already exists
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                guard let self = self, let p = self.connectedPeripheral else { return }
                self.log("info", "Servisler keşfediliyor (hızlı yol)...")
                p.discoverServices(nil)
            }
        }
    }

    func centralManager(_ central: CBCentralManager, didFailToConnect peripheral: CBPeripheral, error: Error?) {
        log("error", "❌ Bağlantı başarısız: \(error?.localizedDescription ?? "?")")
        setState(.disconnected)
        scheduleReconnect()
    }

    func centralManager(_ central: CBCentralManager, didDisconnectPeripheral peripheral: CBPeripheral, error: Error?) {
        let reason = (error as NSError?)?.code ?? 0
        log("warn", "⚠️ Bağlantı kesildi (kod:\(reason)): \(error?.localizedDescription ?? "temiz")")
        if reason == 6 || reason == 19 { // 6=BLE_ERR_CONN_TERM_LOCAL, 19=BLE_ERR_REM_USER_CONN_TERM
            log("error", "🔐 Eşleşme başarısız! iPhone'da çıkan 'Eşle' butonuna basmanız gerekiyor.")
        }
        commandCharacteristic = nil
        isFirstPair = false  // Any future connection is a reconnection
        setState(.disconnected)
        scheduleReconnect()
    }

    // MARK: - CBPeripheralDelegate

    func peripheral(_ peripheral: CBPeripheral, didDiscoverServices error: Error?) {
        guard error == nil, let services = peripheral.services else {
            log("error", "Servis hatası: \(error?.localizedDescription ?? "yok")")
            return
        }
        log("info", "Servisler (\(services.count)):")
        for svc in services { log("info", "  → \(svc.uuid.uuidString)") }

        let shortUUID = CBUUID(string: "FFF0")
        if let svc = services.first(where: { $0.uuid == HELP_SERVICE_UUID || $0.uuid == shortUUID }) {
            log("success", "HELP servisi bulundu ✓")
            peripheral.discoverCharacteristics(nil, for: svc)
        } else {
            log("warn", "HELP servisi (FFF0) yok, tüm servisler taranıyor...")
            for svc in services { peripheral.discoverCharacteristics(nil, for: svc) }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didDiscoverCharacteristicsFor service: CBService, error: Error?) {
        guard error == nil, let chars = service.characteristics else { return }

        log("info", "Svc \(service.uuid.uuidString) chars (\(chars.count)):")
        for c in chars {
            var p: [String] = []
            if c.properties.contains(.read) { p.append("R") }
            if c.properties.contains(.write) { p.append("W") }
            if c.properties.contains(.notify) { p.append("N") }
            if c.properties.contains(.indicate) { p.append("I") }
            log("info", "  → \(c.uuid.uuidString) [\(p.joined(separator: ","))]")
        }

        let f1 = CBUUID(string: "FFF1"), f2 = CBUUID(string: "FFF2")
        let f4 = CBUUID(string: "FFF4"), f5 = CBUUID(string: "FFF5")
        var foundTelemetry = false

        for c in chars {
            if c.uuid == CHAR_TELEMETRY_UUID || c.uuid == f1 {
                peripheral.setNotifyValue(true, for: c)
                log("success", "Telemetri ✓")
                foundTelemetry = true
            } else if c.uuid == CHAR_COMMAND_UUID || c.uuid == f2 {
                commandCharacteristic = c
                log("success", "Komut ✓")
            } else if c.uuid == CHAR_EMERGENCY_UUID || c.uuid == f4 {
                peripheral.setNotifyValue(true, for: c)
                log("success", "Acil durum ✓")
            } else if c.uuid == CHAR_BIOSENSOR_UUID || c.uuid == f5 {
                peripheral.setNotifyValue(true, for: c)
                log("success", "Biyosensör ✓")
            }
        }

        if foundTelemetry {
            setState(.connected)

            if isFirstPair {
                log("success", "🎉 Cihaz tam bağlı! (ilk eşleşme)")
                // Trigger LESC pairing by writing to the encrypted FFF2 characteristic.
                // FFF2 has WRITE_ENC flag — iOS will automatically initiate pairing
                // and show the "Bluetooth Pairing Request" dialog.
                if let cmd = commandCharacteristic {
                    let pairingPayload = "{\"cmd\":\"ping\"}".data(using: .utf8)!
                    peripheral.writeValue(pairingPayload, for: cmd, type: .withResponse)
                    log("info", "🔐 Şifreli yazma gönderildi — eşleşme tetiklenecek...")
                }
                // After first successful connection+pairing, mark as paired
                isFirstPair = false
            } else {
                log("success", "🎉 Cihaz yeniden bağlandı! (sessiz — eşleşme atlandı)")
                // Reconnection — bond already exists, do NOT trigger LESC pairing.
                // Send a non-encrypted ping to verify the link is alive.
                if let cmd = commandCharacteristic {
                    let pingPayload = "{\"cmd\":\"ping\"}".data(using: .utf8)!
                    peripheral.writeValue(pingPayload, for: cmd, type: .withResponse)
                }
            }
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didUpdateValueFor characteristic: CBCharacteristic, error: Error?) {
        guard error == nil, let data = characteristic.value else { return }
        let f1 = CBUUID(string: "FFF1"), f4 = CBUUID(string: "FFF4"), f5 = CBUUID(string: "FFF5")

        if characteristic.uuid == CHAR_TELEMETRY_UUID || characteristic.uuid == f1 {
            handleTelemetry(data)
        } else if characteristic.uuid == CHAR_EMERGENCY_UUID || characteristic.uuid == f4 {
            handleEmergency(data)
        } else if characteristic.uuid == CHAR_BIOSENSOR_UUID || characteristic.uuid == f5 {
            handleTelemetry(data)
        }
    }

    func peripheral(_ peripheral: CBPeripheral, didWriteValueFor characteristic: CBCharacteristic, error: Error?) {
        if let error = error {
            let nsErr = error as NSError
            log("error", "✍️ Yazma hatası (\\(characteristic.uuid.uuidString)): \\(nsErr.localizedDescription) [kod:\\(nsErr.code)]")
            // Error code 15 = BLE_ATT_ERR_INSUFF_ENC = encryption needed = pairing should trigger
            if nsErr.code == 15 || nsErr.code == 5 {
                log("warn", "🔐 Şifreleme gerekiyor — iOS eşleşme diyaloğu göstermeli...")
            }
        } else {
            log("success", "✍️ Şifreli yazma başarılı — eşleşme tamamlandı! ✓")
        }
    }

    // MARK: - Data Handlers

    private func handleTelemetry(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8),
              let json = try? JSONSerialization.jsonObject(with: text.data(using: .utf8)!) as? [String: Any] else { return }
        onTelemetry?(json)
    }

    private func handleEmergency(_ data: Data) {
        guard let text = String(data: data, encoding: .utf8),
              let json = try? JSONSerialization.jsonObject(with: text.data(using: .utf8)!) as? [String: Any] else { return }
        log("error", "🚨 ACİL DURUM: \(json["type"] ?? "SOS")")
        onEmergency?(json)
    }

    // MARK: - Reconnection

    private func scheduleReconnect(delay: TimeInterval? = nil) {
        reconnectTimer?.invalidate()
        reconnectTimer = nil
        guard reconnectAttempts < maxReconnectAttempts else { return }
        reconnectAttempts += 1
        // Fast reconnect: 2s → 5s → 10s → 15s cap (medical device — aggressive)
        let d = delay ?? min(2.0 * pow(1.5, Double(min(reconnectAttempts - 1, 8))), 15.0)
        setState(.reconnecting)
        log("info", "🔄 \(String(format: "%.1f", d))s sonra tekrar (deneme \(reconnectAttempts))")
        reconnectTimer = Timer.scheduledTimer(withTimeInterval: d, repeats: false) { [weak self] _ in
            self?.scanAndConnect()
        }
    }

    private func stopScan() {
        centralManager?.stopScan()
        scanTimeoutTimer?.invalidate()
        scanTimeoutTimer = nil
    }

    private func setState(_ s: State) {
        guard state != s else { return }
        state = s
        DispatchQueue.main.async { [weak self] in
            guard let s = self else { return }
            s.onStateChange?(s.state)
        }
    }

    private func log(_ level: String, _ msg: String) {
        print("[BLE] \(msg)")
        DispatchQueue.main.async { [weak self] in
            self?.onLog?(level, "[BLE] \(msg)")
        }
    }

    private func stateDesc(_ s: CBManagerState) -> String {
        switch s {
        case .poweredOn: return "poweredOn"
        case .poweredOff: return "poweredOff"
        case .unauthorized: return "unauthorized"
        case .unsupported: return "unsupported"
        case .resetting: return "resetting"
        case .unknown: return "unknown"
        @unknown default: return "?(\(s.rawValue))"
        }
    }

    private func authDescription(_ a: CBManagerAuthorization) -> String {
        switch a {
        case .allowedAlways: return "allowedAlways"
        case .denied: return "denied"
        case .restricted: return "restricted"
        case .notDetermined: return "notDetermined"
        @unknown default: return "?(\(a.rawValue))"
        }
    }
}

// MARK: - WebSocket Relay
class WebSocketRelay: @unchecked Sendable {

    nonisolated(unsafe) static let shared = WebSocketRelay()

    private var wsTask: URLSessionWebSocketTask?
    private var session: URLSession!
    private var heartbeatTimer: Timer?
    private var reconnectWorkItem: DispatchWorkItem?
    private var connectTimeoutWork: DispatchWorkItem?
    private var reconnectAttempts = 0

    // State
    enum State: String {
        case disconnected, connecting, connected, reconnecting
    }
    private(set) var state: State = .disconnected

    // Config
    private let serverURL = "ws://78.187.171.33:1968"
    private let fallbackURL = "ws://78.187.171.33:1968"
    private let httpBaseURL = "http://78.187.171.33:8001"
    private var deviceMAC: String = "HELP-UNKNOWN"
    private var patientName: String = "Hasta"

    // Offline buffer
    private var offlineBuffer: [String] = []
    private let maxBufferSize = 10000

    // Stats
    private(set) var messagesSent = 0
    private(set) var messagesBuffered = 0
    private var bleConnected = false

    // Callbacks
    var onStateChange: ((State) -> Void)?
    var onCommand: (([String: Any]) -> Void)?
    var onLog: ((String, String) -> Void)?

    private init() {
        session = URLSession(configuration: .default)
        // Reconnect when app returns to foreground
        NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil, queue: .main
        ) { [weak self] _ in
            guard let self = self else { return }
            if self.state != .connected {
                self.log("info", "Uygulama ön plana geldi — yeniden bağlanılıyor")
                self.reconnectAttempts = 0
                self.connect()
            }
        }
    }

    // MARK: - Public API

    func configure(mac: String, patient: String) {
        deviceMAC = mac
        patientName = patient
    }

    func setBleConnected(_ connected: Bool) {
        bleConnected = connected
    }

    func connect() {
        // Cancel any pending reconnect / timeout
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        connectTimeoutWork?.cancel()
        connectTimeoutWork = nil

        // Allow reconnect even from .connecting (prevents stuck state)
        guard state != .connected else { return }

        // Clean up previous task if any
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil

        setState(.connecting)
        log("info", "Sunucuya bağlanılıyor...")

        guard let url = URL(string: serverURL) else {
            log("error", "Geçersiz sunucu URL'si")
            handleDisconnect()
            return
        }

        wsTask = session.webSocketTask(with: url)
        wsTask?.resume()

        // Connection timeout — if no auth_ok within 10s, retry
        let timeout = DispatchWorkItem { [weak self] in
            guard let self = self, self.state == .connecting else { return }
            self.log("warn", "Bağlantı zaman aşımı (10s)")
            self.handleDisconnect()
        }
        connectTimeoutWork = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + 10.0, execute: timeout)

        // Send auth message (server expects {"type": "auth", "mac": "XX:XX:XX:XX:XX:XX"})
        let auth: [String: Any] = [
            "type": "auth",
            "mac": deviceMAC,
            "patient_name": patientName,
            "app_version": "1.0.0-ios",
            "platform": "ios-native"
        ]
        sendJSON(auth)

        // Start receiving (will get auth_ok or auth_fail first)
        receiveMessage()

        // Start heartbeat
        startHeartbeat()
    }

    func sendTelemetry(_ data: [String: Any]) {
        let msg: [String: Any] = [
            "type": "telemetry",
            "mac": deviceMAC,
            "ts": ISO8601DateFormatter().string(from: Date()),
            "data": data
        ]

        if state == .connected {
            sendJSON(msg)
            messagesSent += 1
        } else {
            bufferMessage(msg)
        }
    }

    func sendEmergency(_ event: [String: Any]) {
        let msg: [String: Any] = [
            "type": "emergency",
            "mac": deviceMAC,
            "ts": ISO8601DateFormatter().string(from: Date()),
            "event": event
        ]

        if state == .connected {
            sendJSON(msg)
            log("error", "🚨 Acil durum gönderildi")
        } else {
            // Emergency goes to front of buffer
            if let jsonData = try? JSONSerialization.data(withJSONObject: msg),
               let str = String(data: jsonData, encoding: .utf8) {
                offlineBuffer.insert(str, at: 0)
            }
            log("error", "🚨 Acil durum tamponlandı (çevrimdışı)")
        }
    }

    func disconnect() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        reconnectWorkItem?.cancel()
        reconnectWorkItem = nil
        connectTimeoutWork?.cancel()
        connectTimeoutWork = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        setState(.disconnected)
    }

    // MARK: - Private

    private func sendJSON(_ dict: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: dict),
              let str = String(data: data, encoding: .utf8) else { return }

        wsTask?.send(.string(str)) { [weak self] error in
            if let error = error {
                self?.log("error", "WS gönderme hatası: \(error.localizedDescription)")
                self?.handleDisconnect()
            }
        }
    }

    private func receiveMessage() {
        wsTask?.receive { [weak self] result in
            switch result {
            case .success(let message):
                switch message {
                case .string(let text):
                    self?.handleServerMessage(text)
                default:
                    break
                }
                // Continue listening
                self?.receiveMessage()

            case .failure(let error):
                self?.log("warn", "WS alma hatası: \(error.localizedDescription)")
                self?.handleDisconnect()
            }
        }
    }

    private func handleServerMessage(_ raw: String) {
        guard let data = raw.data(using: .utf8),
              let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = msg["type"] as? String else { return }

        switch type {
        case "auth_ok":
            let patient = msg["patient"] as? String ?? "?"
            log("success", "Sunucu kimlik doğrulandı ✓ (Hasta: \(patient))")
            connectTimeoutWork?.cancel()
            connectTimeoutWork = nil
            setState(.connected)
            reconnectAttempts = 0
            flushBuffer()
        case "auth_fail":
            let reason = msg["reason"] as? String ?? "Bilinmiyor"
            log("error", "Sunucu kimlik REDDEDILDI: \(reason)")
            handleDisconnect()
        case "pong":
            break // heartbeat ack
        case "command":
            log("info", "Sunucu komutu: \(msg["command"] ?? msg["action"] ?? "?")")
            DispatchQueue.main.async { [weak self] in
                self?.onCommand?(msg)
            }
        case "force_show":
            log("warn", "Doktor FORCE-SHOW komutu aldı")
        default:
            log("info", "Sunucu mesajı: \(type)")
        }
    }

    private func startHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 30.0, repeats: true) { [weak self] _ in
            guard let self = self, self.state == .connected else { return }
            let hb: [String: Any] = [
                "type": "heartbeat",
                "mac": self.deviceMAC,
                "ts": ISO8601DateFormatter().string(from: Date()),
                "ble": self.bleConnected ? "connected" : "disconnected",
                "buffer_size": self.offlineBuffer.count,
                "version": "1.0.0-ios"
            ]
            self.sendJSON(hb)
        }
    }

    private func bufferMessage(_ msg: [String: Any]) {
        guard let data = try? JSONSerialization.data(withJSONObject: msg),
              let str = String(data: data, encoding: .utf8) else { return }
        if offlineBuffer.count >= maxBufferSize {
            offlineBuffer.removeFirst()
        }
        offlineBuffer.append(str)
        messagesBuffered += 1
    }

    private func flushBuffer() {
        guard !offlineBuffer.isEmpty, state == .connected else { return }
        log("info", "Tampon boşaltılıyor: \(offlineBuffer.count) mesaj...")
        for msg in offlineBuffer {
            wsTask?.send(.string(msg)) { _ in }
        }
        let count = offlineBuffer.count
        offlineBuffer.removeAll()
        log("success", "\(count) mesaj gönderildi ✓")
    }

    private func handleDisconnect() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        connectTimeoutWork?.cancel()
        connectTimeoutWork = nil
        wsTask?.cancel(with: .goingAway, reason: nil)
        wsTask = nil
        // Only schedule reconnect if not already reconnecting
        let wasConnected = (state == .connected || state == .connecting)
        setState(.disconnected)
        if wasConnected {
            scheduleReconnect()
        } else if reconnectWorkItem == nil {
            // Safety: always ensure a reconnect is scheduled
            scheduleReconnect()
        }
    }

    private func scheduleReconnect() {
        reconnectWorkItem?.cancel()
        reconnectAttempts += 1
        let delay = min(3.0 * pow(1.3, Double(min(reconnectAttempts, 15) - 1)), 30.0)
        setState(.reconnecting)
        log("info", "Sunucuya yeniden bağlanılıyor \(String(format: "%.1f", delay))s sonra...")

        let work = DispatchWorkItem { [weak self] in
            self?.reconnectWorkItem = nil
            self?.connect()
        }
        reconnectWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    private func setState(_ newState: State) {
        guard state != newState else { return }
        state = newState
        DispatchQueue.main.async { [weak self] in
            guard let self = self else { return }
            self.onStateChange?(self.state)
        }
    }

    private func log(_ level: String, _ message: String) {
        print("[WS] \(message)")
        DispatchQueue.main.async { [weak self] in
            self?.onLog?(level, "[WS] \(message)")
        }
    }
}

// MARK: - Service Bridge (connects BLE + WS + WebView)
class ServiceBridge: @unchecked Sendable {

    nonisolated(unsafe) static let shared = ServiceBridge()

    private let ble = BLEManager.shared
    private let ws = WebSocketRelay.shared
    weak var webView: WKWebView? // Set from HELPBridgeApp

    private init() {
        setupCallbacks()
    }

    func start() {
        // Connect WebSocket with a generated ID
        let deviceId = UserDefaults.standard.string(forKey: "help_device_id") ?? {
            let id = UUID().uuidString.prefix(8)
            UserDefaults.standard.set(String(id), forKey: "help_device_id")
            return String(id)
        }()
        ws.configure(mac: "HELP-iOS-\(deviceId)",
                     patient: "Hasta")
        ws.connect()

        // Start HTTP polling as immediate data source
        startHTTPPolling()

        // Start BLE AFTER callbacks are wired (critical!)
        ble.start()
    }

    // MARK: - Wire up callbacks

    private func setupCallbacks() {
        // BLE → WebView + WS
        ble.onStateChange = { [weak self] state in
            self?.pushToWebView("updateConnectionStatus('ble', '\(state.rawValue)')")
            self?.pushLog(state == .connected ? "success" : "info",
                         "[BLE] Durum: \(state.rawValue)")
            self?.ws.setBleConnected(state == .connected)

            // Once BLE connected, reconfigure WS with ESP32's real MAC and reconnect
            if state == .connected {
                // The BLE peripheral identifier is an iOS UUID, not the ESP32 MAC.
                // Use the known ESP32 MAC address for server authentication.
                self?.ws.configure(mac: "3C:DC:75:6F:CA:10", patient: "Edip Temiz")
                if self?.ws.state != .connected {
                    self?.ws.connect()
                }
            }
        }

        ble.onTelemetry = { [weak self] data in
            // Push to WebView
            if let jsonData = try? JSONSerialization.data(withJSONObject: data),
               let jsonStr = String(data: jsonData, encoding: .utf8) {
                self?.pushToWebView("updateTelemetry(\(jsonStr))")
            }
            // Relay to server
            self?.ws.sendTelemetry(data)
        }

        ble.onEmergency = { [weak self] event in
            self?.ws.sendEmergency(event)
            let type = event["type"] as? String ?? "SOS"
            self?.pushToWebView("showEmergencyFromNative('\(type)')")
        }

        ble.onLog = { [weak self] level, msg in
            self?.pushLog(level, msg)
        }

        // WS → WebView
        ws.onStateChange = { [weak self] state in
            self?.pushToWebView("updateConnectionStatus('ws', '\(state.rawValue)')")
            self?.pushLog(state == .connected ? "success" : "info",
                         "[WS] Durum: \(state.rawValue)")
        }

        ws.onCommand = { [weak self] cmd in
            if let action = cmd["command"] as? String ?? cmd["action"] as? String {
                if action == "ble_command", let data = cmd["data"] as? String {
                    self?.ble.sendCommand(data)
                }
            }
        }

        ws.onLog = { [weak self] level, msg in
            self?.pushLog(level, msg)
        }
    }

    // MARK: - HTTP Polling (fallback when BLE not connected)
    private var httpPollTimer: Timer?
    private let httpBaseURL = "http://78.187.171.33:8001"
    private var httpConnected = false

    func startHTTPPolling() {
        stopHTTPPolling()
        pushLog("info", "[HTTP] Sunucu pollamaya başlanıyor: \(httpBaseURL)")
        pushToWebView("updateConnectionStatus('ws', 'connecting')")

        httpPollTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.pollServerStatus()
        }
        // Poll immediately
        pollServerStatus()
    }

    func stopHTTPPolling() {
        httpPollTimer?.invalidate()
        httpPollTimer = nil
    }

    private func pollServerStatus() {
        guard let url = URL(string: "\(httpBaseURL)/api/status") else { return }

        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self = self else { return }

            if let error = error {
                if self.httpConnected {
                    self.httpConnected = false
                    DispatchQueue.main.async {
                        self.pushToWebView("updateConnectionStatus('ws', 'disconnected')")
                        self.pushLog("warn", "[HTTP] Sunucu bağlantısı kesildi")
                    }
                }
                return
            }

            guard let data = data,
                  let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }

            DispatchQueue.main.async {
                if !self.httpConnected {
                    self.httpConnected = true
                    self.pushToWebView("updateConnectionStatus('ws', 'connected')")
                    self.pushLog("success", "[HTTP] Sunucu bağlantısı kuruldu ✓")
                }

                // Extract telemetry fields and push to WebView
                var telemetry: [String: Any] = [:]

                // Frequency data
                if let freq = json["ch1_freq"] as? Double { telemetry["frequency"] = freq }
                if let step = json["playlist_step"] as? Int { telemetry["step"] = step }
                if let total = json["playlist_total_steps"] as? Int { telemetry["total_steps"] = total }
                if let state = json["playlist_state"] as? String { telemetry["state"] = "ST_\(state)" }
                if let remaining = json["playlist_remaining"] as? Int { telemetry["playlist_remaining"] = remaining }
                if let opDur = json["op_duration_sec"] as? Int { telemetry["op_duration_sec"] = opDur }
                if let battery = json["battery_percent"] as? Int { telemetry["battery"] = battery }
                if let temp = json["temp_c"] as? Double { telemetry["temperature"] = temp }

                // Device status
                if let mac = json["device_mac"] as? String { telemetry["device_mac"] = mac }
                if let patient = json["patient_name"] as? String { telemetry["patient_name"] = patient }
                if let online = json["device_online"] as? Bool { telemetry["device_online"] = online }

                if let jsonData = try? JSONSerialization.data(withJSONObject: telemetry),
                   let jsonStr = String(data: jsonData, encoding: .utf8) {
                    self.pushToWebView("updateTelemetry(\(jsonStr))")
                }

                // Update status dot based on device online
                let isOnline = json["device_online"] as? Bool ?? false
                let statusText = isOnline ? "Çevrimiçi" : "Çevrimdışı"
                let dotClass = isOnline ? "status-dot--online" : "status-dot--offline"
                self.pushToWebView("document.getElementById('status-text').textContent='\(statusText)'")
                self.pushToWebView("document.getElementById('status-dot').className='status-dot \(dotClass)'")
            }
        }.resume()
    }

    // MARK: - WebView Communication

    private func pushToWebView(_ jsCode: String) {
        DispatchQueue.main.async { [weak self] in
            self?.webView?.evaluateJavaScript(jsCode) { _, error in
                if let error = error {
                    print("[Bridge] JS error: \(error.localizedDescription)")
                }
            }
        }
    }

    private func pushLog(_ level: String, _ message: String) {
        // Escape for JS string
        let escaped = message
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
            .replacingOccurrences(of: "\n", with: "\\n")
        pushToWebView("addLog('\(level)', '\(escaped)')")
    }

    // Handle commands from WebView
    func handleWebViewCommand(_ command: String) {
        switch command {
        case "rescan":
            ble.disconnect()
            ble.scanAndConnect()
        case "reconnect_ws":
            ws.disconnect()
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in
                self?.ws.connect()
            }
        default:
            print("[Bridge] Unknown command: \(command)")
        }
    }
}
