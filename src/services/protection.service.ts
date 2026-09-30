/**
 * HELP Telecare — Patient Protection Service
 * Implements show/hide toggle, doctor-set PIN, and monitoring control
 * 
 * This service manages the "life protection" layer that prevents
 * accidental monitoring stops, handles the PIN system, and manages
 * the app visibility state.
 */

export type UIVisibility = 'visible' | 'hidden' | 'force_shown';
export type MonitoringState = 'active' | 'paused_by_pin' | 'stopped';

interface ProtectionConfig {
  pin: string;           // 6-digit doctor-set PIN
  pinLength: number;     // PIN length (4-8)
  lockoutAttempts: number; // Max wrong attempts before lockout
  lockoutDurationMs: number; // Lockout duration in ms
  notificationStyle: 'minimal' | 'standard' | 'rich';
}

export interface ProtectionCallbacks {
  onVisibilityChange?: (state: UIVisibility) => void;
  onMonitoringChange?: (state: MonitoringState) => void;
  onPinLockout?: (remainingMs: number) => void;
  onForceShow?: () => void;
  onLog?: (level: 'info' | 'success' | 'warn' | 'error', msg: string) => void;
}

const STORAGE_KEYS = {
  PIN: 'help_monitor_pin',
  VISIBILITY: 'help_ui_visibility',
  MONITORING: 'help_monitoring_state',
  LOCKOUT_UNTIL: 'help_pin_lockout_until',
  WRONG_ATTEMPTS: 'help_pin_wrong_attempts',
  NOTIFICATION_STYLE: 'help_notification_style',
};

export class ProtectionService {
  private config: ProtectionConfig;
  private callbacks: ProtectionCallbacks = {};
  private visibility: UIVisibility = 'visible';
  private monitoring: MonitoringState = 'active';
  private wrongAttempts = 0;
  private lockoutUntil = 0;

  constructor() {
    this.config = {
      pin: this.loadPin(),
      pinLength: 6,
      lockoutAttempts: 3,
      lockoutDurationMs: 30 * 60 * 1000, // 30 minutes
      notificationStyle: (localStorage.getItem(STORAGE_KEYS.NOTIFICATION_STYLE) as ProtectionConfig['notificationStyle']) || 'standard',
    };

    // Restore state
    this.wrongAttempts = parseInt(localStorage.getItem(STORAGE_KEYS.WRONG_ATTEMPTS) || '0', 10);
    this.lockoutUntil = parseInt(localStorage.getItem(STORAGE_KEYS.LOCKOUT_UNTIL) || '0', 10);
    this.visibility = (localStorage.getItem(STORAGE_KEYS.VISIBILITY) as UIVisibility) || 'visible';
    this.monitoring = (localStorage.getItem(STORAGE_KEYS.MONITORING) as MonitoringState) || 'active';
  }

  /** Register callbacks */
  setCallbacks(cb: ProtectionCallbacks): void {
    this.callbacks = cb;
  }

  /** Get current visibility */
  getVisibility(): UIVisibility { return this.visibility; }

  /** Get current monitoring state */
  getMonitoring(): MonitoringState { return this.monitoring; }

  /** Get notification style */
  getNotificationStyle(): string { return this.config.notificationStyle; }

  /** Has doctor set a PIN? */
  hasPinConfigured(): boolean { return this.config.pin.length >= 4; }

  /** Patient toggles UI visibility */
  toggleVisibility(): void {
    if (this.visibility === 'force_shown') {
      // Cannot hide when doctor force-showed
      this.log('warn', 'Cannot hide — doctor force-show active');
      return;
    }

    this.visibility = this.visibility === 'visible' ? 'hidden' : 'visible';
    localStorage.setItem(STORAGE_KEYS.VISIBILITY, this.visibility);
    this.callbacks.onVisibilityChange?.(this.visibility);
    this.log('info', `UI visibility: ${this.visibility}`);
  }

  /** Doctor forces app to show (via server command) */
  forceShow(): void {
    this.visibility = 'force_shown';
    localStorage.setItem(STORAGE_KEYS.VISIBILITY, this.visibility);
    this.callbacks.onVisibilityChange?.(this.visibility);
    this.callbacks.onForceShow?.();
    this.log('warn', 'Doctor FORCE-SHOW activated');
  }

  /** Doctor releases force-show (via server command) */
  releaseForceShow(): void {
    this.visibility = 'visible';
    localStorage.setItem(STORAGE_KEYS.VISIBILITY, this.visibility);
    this.callbacks.onVisibilityChange?.(this.visibility);
    this.log('info', 'Doctor released force-show');
  }

  /** Check if PIN entry is currently locked out */
  isLockedOut(): boolean {
    if (this.lockoutUntil > Date.now()) {
      return true;
    }
    // Lockout expired
    if (this.lockoutUntil > 0) {
      this.lockoutUntil = 0;
      this.wrongAttempts = 0;
      localStorage.setItem(STORAGE_KEYS.LOCKOUT_UNTIL, '0');
      localStorage.setItem(STORAGE_KEYS.WRONG_ATTEMPTS, '0');
    }
    return false;
  }

  /** Get remaining lockout time in ms */
  getLockoutRemainingMs(): number {
    if (!this.isLockedOut()) return 0;
    return this.lockoutUntil - Date.now();
  }

  /**
   * Verify PIN entered by patient.
   * Returns true if correct, false if wrong.
   * After `lockoutAttempts` wrong tries, triggers lockout.
   */
  verifyPin(enteredPin: string): { correct: boolean; locked: boolean; attemptsLeft: number } {
    if (this.isLockedOut()) {
      const remaining = this.getLockoutRemainingMs();
      this.callbacks.onPinLockout?.(remaining);
      return { correct: false, locked: true, attemptsLeft: 0 };
    }

    if (enteredPin === this.config.pin) {
      // Correct PIN
      this.wrongAttempts = 0;
      localStorage.setItem(STORAGE_KEYS.WRONG_ATTEMPTS, '0');
      this.log('info', 'PIN verified correctly');
      return { correct: true, locked: false, attemptsLeft: this.config.lockoutAttempts };
    }

    // Wrong PIN
    this.wrongAttempts++;
    localStorage.setItem(STORAGE_KEYS.WRONG_ATTEMPTS, String(this.wrongAttempts));

    if (this.wrongAttempts >= this.config.lockoutAttempts) {
      // Trigger lockout
      this.lockoutUntil = Date.now() + this.config.lockoutDurationMs;
      localStorage.setItem(STORAGE_KEYS.LOCKOUT_UNTIL, String(this.lockoutUntil));
      this.log('error', `PIN lockout activated — ${this.config.lockoutDurationMs / 60000} min`);
      this.callbacks.onPinLockout?.(this.config.lockoutDurationMs);
      return { correct: false, locked: true, attemptsLeft: 0 };
    }

    const left = this.config.lockoutAttempts - this.wrongAttempts;
    this.log('warn', `Wrong PIN — ${left} attempts remaining`);
    return { correct: false, locked: false, attemptsLeft: left };
  }

  /** Stop monitoring (after PIN verification) */
  stopMonitoring(): void {
    this.monitoring = 'paused_by_pin';
    localStorage.setItem(STORAGE_KEYS.MONITORING, this.monitoring);
    this.callbacks.onMonitoringChange?.(this.monitoring);
    this.log('warn', 'Monitoring PAUSED by patient (PIN verified)');
  }

  /** Resume monitoring */
  resumeMonitoring(): void {
    this.monitoring = 'active';
    localStorage.setItem(STORAGE_KEYS.MONITORING, this.monitoring);
    this.callbacks.onMonitoringChange?.(this.monitoring);
    this.log('success', 'Monitoring RESUMED');
  }

  /** Update PIN from server (doctor changed it) */
  updatePin(newPin: string): void {
    this.config.pin = newPin;
    localStorage.setItem(STORAGE_KEYS.PIN, newPin);
    this.log('info', 'PIN updated by doctor');
  }

  /** Update notification style from server */
  updateNotificationStyle(style: 'minimal' | 'standard' | 'rich'): void {
    this.config.notificationStyle = style;
    localStorage.setItem(STORAGE_KEYS.NOTIFICATION_STYLE, style);
    this.log('info', `Notification style: ${style}`);
  }

  // ─── Private ──────────────────────────────────────────────

  private loadPin(): string {
    return localStorage.getItem(STORAGE_KEYS.PIN) || '000000'; // Default PIN
  }

  private log(level: 'info' | 'success' | 'warn' | 'error', msg: string): void {
    console.log(`[PROTECT] ${msg}`);
    this.callbacks.onLog?.(level, `[PROTECT] ${msg}`);
  }
}

export const protectionService = new ProtectionService();
