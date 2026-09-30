package com.help.telecare.bridge;

import android.app.AlarmManager;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.SystemClock;
import android.util.Log;

import androidx.core.app.NotificationCompat;

/**
 * HelpMonitorService — Persistent foreground service for patient life monitoring.
 * Part of Phase 10: Patient Life Protection System.
 * 
 * This service:
 * - Runs as a foreground service with a non-dismissible notification
 * - Keeps the app alive even when the user navigates away
 * - Uses START_STICKY to auto-restart if killed by Android
 * - Acquires a partial WakeLock to survive Doze mode
 * - Sets up AlarmManager watchdog for extra restart reliability
 * 
 * The actual BLE + WebSocket logic runs in the Capacitor WebView;
 * this service just keeps the process alive and visible.
 */
public class HelpMonitorService extends Service {
    private static final String TAG = "HELP_Service";
    private static final String CHANNEL_ID = "help_monitor_channel";
    private static final int NOTIFICATION_ID = 1968; // Same as bridge port for easy recall
    private static final int WATCHDOG_ALARM_ID = 1969;

    private PowerManager.WakeLock wakeLock;
    private AlarmManager alarmManager;

    @Override
    public void onCreate() {
        super.onCreate();
        Log.i(TAG, "HelpMonitorService created");
        createNotificationChannel();
        acquireWakeLock();
        scheduleWatchdogAlarm();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        Log.i(TAG, "HelpMonitorService started (flags=" + flags + ")");

        // Build foreground notification
        Notification notification = buildNotification("HELP Sağlık İzleme aktif", "Cihaz izleniyor");

        // Start as foreground service
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            // Android 14+ requires specifying foreground service type
            startForeground(NOTIFICATION_ID, notification,
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE |
                android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_HEALTH);
        } else {
            startForeground(NOTIFICATION_ID, notification);
        }

        // START_STICKY: Android will auto-restart this service if killed
        return START_STICKY;
    }

    @Override
    public void onDestroy() {
        Log.w(TAG, "HelpMonitorService destroyed — will be restarted by START_STICKY or AlarmManager");
        
        if (wakeLock != null && wakeLock.isHeld()) {
            wakeLock.release();
        }

        // Schedule immediate restart via AlarmManager as backup
        scheduleImmediateRestart();

        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null; // Not a bound service
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // Called when user swipes app from recent apps
        Log.w(TAG, "Task removed (app swiped from recents) — scheduling restart");
        scheduleImmediateRestart();
        super.onTaskRemoved(rootIntent);
    }

    // ─── Notification ────────────────────────────────────────

    private void createNotificationChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                "HELP Sağlık İzleme",
                NotificationManager.IMPORTANCE_LOW  // Low = no sound, but persistent
            );
            channel.setDescription("Sağlık izleme servisi aktif olduğunda gösterilir");
            channel.setShowBadge(false);
            channel.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);

            NotificationManager manager = getSystemService(NotificationManager.class);
            if (manager != null) {
                manager.createNotificationChannel(channel);
            }
        }
    }

    private Notification buildNotification(String title, String text) {
        // Tapping notification opens the app
        Intent notifIntent = new Intent(this, MainActivity.class);
        notifIntent.setFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP);
        PendingIntent pendingIntent = PendingIntent.getActivity(
            this, 0, notifIntent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(title)
            .setContentText(text)
            .setSmallIcon(android.R.drawable.ic_menu_compass) // TODO: custom HELP icon
            .setOngoing(true)         // Cannot be dismissed
            .setAutoCancel(false)     // Cannot be auto-cancelled
            .setContentIntent(pendingIntent)
            .setPriority(NotificationCompat.PRIORITY_LOW)
            .setCategory(NotificationCompat.CATEGORY_SERVICE)
            .setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .build();
    }

    /**
     * Update the notification text (called from Capacitor plugin).
     * Allows the WebView to update vital signs in the notification.
     */
    public void updateNotification(String title, String text) {
        Notification notification = buildNotification(title, text);
        NotificationManager manager = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
        if (manager != null) {
            manager.notify(NOTIFICATION_ID, notification);
        }
    }

    // ─── WakeLock ────────────────────────────────────────────

    private void acquireWakeLock() {
        PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
        if (pm != null) {
            wakeLock = pm.newWakeLock(
                PowerManager.PARTIAL_WAKE_LOCK,
                "HELP::MonitorWakeLock"
            );
            wakeLock.acquire(); // Held indefinitely until service destroyed
            Log.i(TAG, "WakeLock acquired");
        }
    }

    // ─── Watchdog Alarm ──────────────────────────────────────

    private void scheduleWatchdogAlarm() {
        alarmManager = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (alarmManager == null) return;

        Intent intent = new Intent(this, HelpMonitorService.class);
        intent.setAction("com.help.telecare.ACTION_WATCHDOG");
        PendingIntent pi = PendingIntent.getService(
            this, WATCHDOG_ALARM_ID, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Check every 60 seconds if service is still running
        alarmManager.setRepeating(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + 60000,
            60000,  // 60 second interval
            pi
        );

        Log.i(TAG, "Watchdog alarm scheduled (60s interval)");
    }

    private void scheduleImmediateRestart() {
        AlarmManager am = (AlarmManager) getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;

        Intent intent = new Intent(this, HelpMonitorService.class);
        intent.setAction("com.help.telecare.ACTION_RESTART");
        PendingIntent pi = PendingIntent.getService(
            this, WATCHDOG_ALARM_ID + 1, intent,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );

        // Restart in 3 seconds
        am.set(
            AlarmManager.ELAPSED_REALTIME_WAKEUP,
            SystemClock.elapsedRealtime() + 3000,
            pi
        );

        Log.i(TAG, "Immediate restart scheduled (3s)");
    }
}
