import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.help.telecare.bridge',
  appName: 'HELP Sağlık İzleme',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    iosScheme: 'https',
  },
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_help',
      iconColor: '#4CAF50'
    },
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    }
  },
  android: {
    allowMixedContent: true,
    webContentsDebuggingEnabled: true
  },
  ios: {
    // App scheme for WKWebView (default: capacitor)
    scheme: 'HELP Bridge',
    // Safe area inset behavior
    contentInset: 'automatic',
    // Background color while loading
    backgroundColor: '#0A0D18',
    // Enable for dev builds only — disable before App Store/TestFlight
    webContentsDebuggingEnabled: true,
    // Allow inline media playback (needed for LiveKit video calls)
    allowsLinkPreview: false,
  }
};

export default config;
