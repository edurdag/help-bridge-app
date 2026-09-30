/**
 * HELP Telecare — iOS Background Task Scheduler
 * Wraps BGTaskScheduler concepts for TypeScript layer.
 *
 * On iOS, background execution is limited to:
 * 1. bluetooth-central mode — auto-relaunches on BLE peripheral events
 * 2. BGAppRefreshTask — ~30s of execution, iOS schedules at its discretion
 * 3. BGProcessingTask — several minutes, requires power + optional WiFi
 * 4. Silent APNs push — content-available: 1, wakes for ~30s
 *
 * This service manages the TypeScript side of background tasks.
 * The native iOS BGTaskScheduler registration happens in AppDelegate.swift.
 *
 * On Android: delegates to the foreground service (always running).
 * On Web: uses setInterval (tab must be open).
 */

import { getPlatform, platformLog, type AppLifecycleState, onLifecycleChange, getLifecycleState } from './platform.service';

export interface BackgroundTask {
  id: string;
  name: string;
  handler: () => Promise<void>;
  intervalMs: number;
  /** iOS only: requires external power */
  requiresExternalPower?: boolean;
  /** iOS only: requires network connectivity */
  requiresNetwork?: boolean;
}

export type BackgroundTaskStatus = 'idle' | 'scheduled' | 'running' | 'completed' | 'failed';

export class BackgroundSchedulerService {
  private tasks: Map<string, BackgroundTask> = new Map();
  private taskStatuses: Map<string, BackgroundTaskStatus> = new Map();
  private webTimers: Map<string, ReturnType<typeof setInterval>> = new Map();
  private lastRunTimes: Map<string, number> = new Map();

  constructor() {
    // On lifecycle change, handle task scheduling
    onLifecycleChange((state) => {
      this.handleLifecycleChange(state);
    });
  }

  /**
   * Register a background task.
   * On Android: runs via foreground service timer.
   * On iOS: registered with BGTaskScheduler (native side must also register).
   * On Web: uses setInterval.
   */
  registerTask(task: BackgroundTask): void {
    this.tasks.set(task.id, task);
    this.taskStatuses.set(task.id, 'idle');
    this.log(`Registered task: ${task.name} (every ${task.intervalMs / 1000}s)`);

    // Start immediately on web/android
    const platform = getPlatform();
    if (platform === 'web' || platform === 'android') {
      this.startWebTimer(task);
    }
  }

  /** Unregister a task */
  unregisterTask(taskId: string): void {
    this.tasks.delete(taskId);
    this.taskStatuses.delete(taskId);
    this.stopWebTimer(taskId);
    this.log(`Unregistered task: ${taskId}`);
  }

  /** Get task status */
  getTaskStatus(taskId: string): BackgroundTaskStatus {
    return this.taskStatuses.get(taskId) || 'idle';
  }

  /** Get last run time */
  getLastRunTime(taskId: string): number {
    return this.lastRunTimes.get(taskId) || 0;
  }

  /**
   * Called from native iOS side when BGTaskScheduler fires.
   * The native AppDelegate calls into the WebView to execute the handler.
   */
  async executeTask(taskId: string): Promise<boolean> {
    const task = this.tasks.get(taskId);
    if (!task) {
      this.log(`Task ${taskId} not found`);
      return false;
    }

    this.taskStatuses.set(taskId, 'running');
    this.log(`Executing task: ${task.name}`);

    try {
      await task.handler();
      this.taskStatuses.set(taskId, 'completed');
      this.lastRunTimes.set(taskId, Date.now());
      this.log(`Task ${task.name} completed`);
      return true;
    } catch (err) {
      this.taskStatuses.set(taskId, 'failed');
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log(`Task ${task.name} failed: ${errMsg}`);
      return false;
    }
  }

  /**
   * Request immediate task execution (for testing or manual triggers).
   */
  async runTaskNow(taskId: string): Promise<boolean> {
    return this.executeTask(taskId);
  }

  /** Get all registered tasks */
  getRegisteredTasks(): Array<{ id: string; name: string; status: BackgroundTaskStatus; lastRun: number }> {
    const result: Array<{ id: string; name: string; status: BackgroundTaskStatus; lastRun: number }> = [];
    this.tasks.forEach((task, id) => {
      result.push({
        id,
        name: task.name,
        status: this.taskStatuses.get(id) || 'idle',
        lastRun: this.lastRunTimes.get(id) || 0,
      });
    });
    return result;
  }

  /** Destroy all tasks */
  destroy(): void {
    this.webTimers.forEach((_, id) => this.stopWebTimer(id));
    this.tasks.clear();
    this.taskStatuses.clear();
  }

  // ─── Private ──────────────────────────────────────────────

  private handleLifecycleChange(state: AppLifecycleState): void {
    const platform = getPlatform();

    if (state === 'foreground') {
      // Resume web timers if needed
      if (platform === 'web' || platform === 'android') {
        this.tasks.forEach((task) => {
          if (!this.webTimers.has(task.id)) {
            this.startWebTimer(task);
          }
        });
      }

      // On iOS: run any overdue tasks immediately
      if (platform === 'ios') {
        this.tasks.forEach((task) => {
          const lastRun = this.lastRunTimes.get(task.id) || 0;
          const elapsed = Date.now() - lastRun;
          if (elapsed > task.intervalMs) {
            this.executeTask(task.id);
          }
        });
      }
    }

    if (state === 'background' && platform === 'ios') {
      // On iOS background: stop web timers (they'll be unreliable)
      // The native BGTaskScheduler will handle execution
      this.webTimers.forEach((_, id) => this.stopWebTimer(id));
      this.log('iOS backgrounded — delegating to BGTaskScheduler');

      // Schedule iOS background tasks via native bridge
      this.scheduleIOSBackgroundTasks();
    }
  }

  private startWebTimer(task: BackgroundTask): void {
    this.stopWebTimer(task.id);

    const timer = setInterval(async () => {
      await this.executeTask(task.id);
    }, task.intervalMs);

    this.webTimers.set(task.id, timer);
    this.taskStatuses.set(task.id, 'scheduled');
  }

  private stopWebTimer(taskId: string): void {
    const timer = this.webTimers.get(taskId);
    if (timer) {
      clearInterval(timer);
      this.webTimers.delete(taskId);
    }
  }

  /**
   * Schedule iOS background tasks via the native bridge.
   * This posts a message that the native AppDelegate picks up
   * to call BGTaskScheduler.submit().
   *
   * The actual BGTask identifiers must be registered in Info.plist
   * under BGTaskSchedulerPermittedIdentifiers.
   */
  private scheduleIOSBackgroundTasks(): void {
    if (getPlatform() !== 'ios') return;

    this.tasks.forEach((task) => {
      try {
        // Post to native side via custom event
        // Native AppDelegate.swift listens for this and calls
        // BGTaskScheduler.shared.submit(BGAppRefreshTaskRequest(...))
        const event = new CustomEvent('help-schedule-bgtask', {
          detail: {
            identifier: `com.help.telecare.${task.id}`,
            intervalMs: task.intervalMs,
            requiresNetwork: task.requiresNetwork ?? true,
            requiresExternalPower: task.requiresExternalPower ?? false,
          },
        });
        window.dispatchEvent(event);
        this.log(`Scheduled iOS BGTask: ${task.id}`);
      } catch (err) {
        this.log(`Failed to schedule iOS BGTask: ${task.id}`);
      }
    });
  }

  private log(msg: string): void {
    platformLog('BGSCHED', msg);
  }
}

export const backgroundScheduler = new BackgroundSchedulerService();
