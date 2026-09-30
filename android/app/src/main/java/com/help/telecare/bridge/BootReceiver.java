package com.help.telecare.bridge;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.util.Log;

/**
 * BootReceiver — Auto-starts HELP monitoring service when phone boots.
 * Part of Phase 10: Patient Life Protection System.
 * 
 * This ensures monitoring resumes automatically after phone restarts,
 * without requiring the patient to manually open the app.
 */
public class BootReceiver extends BroadcastReceiver {
    private static final String TAG = "HELP_Boot";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || intent.getAction() == null) return;

        String action = intent.getAction();
        if (Intent.ACTION_BOOT_COMPLETED.equals(action) ||
            "android.intent.action.QUICKBOOT_POWERON".equals(action)) {
            
            Log.i(TAG, "Phone boot detected — starting HELP monitoring service");
            
            Intent serviceIntent = new Intent(context, HelpMonitorService.class);
            serviceIntent.setAction("com.help.telecare.ACTION_BOOT_START");
            
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                context.startForegroundService(serviceIntent);
            } else {
                context.startService(serviceIntent);
            }
        }
    }
}
