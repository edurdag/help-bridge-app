package com.help.telecare.bridge;

import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.util.Log;

import com.getcapacitor.BridgeActivity;

/**
 * MainActivity — Launches the Capacitor WebView and starts the HELP monitoring service.
 * 
 * On launch:
 * 1. Starts the HelpMonitorService as a foreground service
 * 2. Loads the Capacitor WebView with the bridge app
 * 3. The WebView handles BLE scanning, WebSocket relay, and all UI
 */
public class MainActivity extends BridgeActivity {
    private static final String TAG = "HELP_Main";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        // Start the foreground monitoring service
        startMonitorService();
    }

    @Override
    public void onResume() {
        super.onResume();
        // Ensure service is running when app comes to foreground
        startMonitorService();
    }

    private void startMonitorService() {
        try {
            Intent serviceIntent = new Intent(this, HelpMonitorService.class);
            serviceIntent.setAction("com.help.telecare.ACTION_START");

            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                startForegroundService(serviceIntent);
            } else {
                startService(serviceIntent);
            }

            Log.i(TAG, "HelpMonitorService started from MainActivity");
        } catch (Exception e) {
            Log.e(TAG, "Failed to start HelpMonitorService: " + e.getMessage());
        }
    }
}
