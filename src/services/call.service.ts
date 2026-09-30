/**
 * HELP Telecare — LiveKit Video Call Service
 * Handles incoming video calls from doctor dashboard
 * Features: auto-answer for elderly patients, emergency call handling
 */

import {
  Room,
  RoomEvent,
  Track,
  VideoPresets,
  type RemoteTrackPublication,
  type RemoteParticipant,
  type LocalTrackPublication,
} from 'livekit-client';
import { LocalNotifications } from '@capacitor/local-notifications';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

export type CallState = 'idle' | 'ringing' | 'connecting' | 'active' | 'ending';

export interface IncomingCallParams {
  room: string;
  token: string;
  livekit_url: string;
  caller: string;
  emergency?: boolean;
}

export interface CallEventCallbacks {
  onStateChange?: (state: CallState) => void;
  onRemoteVideo?: (element: HTMLMediaElement) => void;
  onRemoteAudio?: (element: HTMLMediaElement) => void;
  onLocalVideo?: (element: HTMLMediaElement) => void;
  onCallEnded?: (durationSec: number) => void;
  onLog?: (level: 'info' | 'warn' | 'error', msg: string) => void;
}

export class CallService {
  private room: Room | null = null;
  private autoAnswerTimer: ReturnType<typeof setTimeout> | null = null;
  private callState: CallState = 'idle';
  private callbacks: CallEventCallbacks = {};
  private startTime = 0;
  private ringtoneInterval: ReturnType<typeof setInterval> | null = null;

  // Auto-answer after 15 seconds (configurable — medical setting)
  // Emergency calls auto-answer immediately (0s)
  private autoAnswerDelaySec = 15;
  private pendingCallParams: IncomingCallParams | null = null;

  constructor() {}

  /** Get current call state */
  getState(): CallState {
    return this.callState;
  }

  /** Register callbacks */
  setCallbacks(cb: CallEventCallbacks): void {
    this.callbacks = cb;
  }

  /** Handle incoming call from WS relay */
  async handleIncomingCall(params: IncomingCallParams): Promise<void> {
    if (this.callState !== 'idle') {
      this.log('warn', 'Incoming call rejected — already in call');
      return;
    }

    this.callState = 'ringing';
    this.pendingCallParams = params;
    this.callbacks.onStateChange?.('ringing');
    this.log('info', `Incoming ${params.emergency ? 'EMERGENCY ' : ''}call from ${params.caller}`);

    // Show notification
    await this.showIncomingCallNotification(params);

    // Haptic feedback — vibrate pattern
    this.startRingtoneVibration();

    // Auto-answer timer
    const delay = params.emergency ? 0 : this.autoAnswerDelaySec;
    if (delay === 0) {
      // Emergency: answer immediately
      await this.acceptCall(params);
    } else {
      this.autoAnswerTimer = setTimeout(() => {
        this.log('info', 'Auto-answering call after timeout');
        this.acceptCall(params);
      }, delay * 1000);
    }
  }

  /** Accept incoming call */
  async acceptCall(params?: IncomingCallParams): Promise<void> {
    const callParams = params || this.pendingCallParams;
    if (!callParams) {
      this.log('error', 'No call params to accept');
      return;
    }

    // Clear timers
    if (this.autoAnswerTimer) {
      clearTimeout(this.autoAnswerTimer);
      this.autoAnswerTimer = null;
    }
    this.stopRingtoneVibration();

    this.callState = 'connecting';
    this.callbacks.onStateChange?.('connecting');
    this.log('info', `Connecting to room: ${callParams.room}`);

    try {
      this.room = new Room({
        adaptiveStream: true,
        dynacast: true,
        videoCaptureDefaults: {
          resolution: VideoPresets.h360.resolution, // Lower res for mobile
        },
      });

      // Track subscribed — remote doctor video/audio
      this.room.on(
        RoomEvent.TrackSubscribed,
        (track: Track, pub: RemoteTrackPublication, participant: RemoteParticipant) => {
          const el = track.attach();
          if (track.kind === Track.Kind.Video) {
            this.log('info', `Remote video from ${participant.identity}`);
            this.callbacks.onRemoteVideo?.(el as HTMLVideoElement);
          } else if (track.kind === Track.Kind.Audio) {
            this.log('info', `Remote audio from ${participant.identity}`);
            // Auto-play audio
            el.style.display = 'none';
            document.body.appendChild(el);
            this.callbacks.onRemoteAudio?.(el as HTMLAudioElement);
          }
        }
      );

      // Track unsubscribed
      this.room.on(RoomEvent.TrackUnsubscribed, (track: Track) => {
        track.detach().forEach((el) => el.remove());
      });

      // Disconnected
      this.room.on(RoomEvent.Disconnected, () => {
        this.log('info', 'Room disconnected');
        this.cleanup();
      });

      // Connected
      this.room.on(RoomEvent.Connected, () => {
        this.callState = 'active';
        this.startTime = Date.now();
        this.callbacks.onStateChange?.('active');
        this.log('info', 'Call connected');
      });

      // Connect to LiveKit
      await this.room.connect(callParams.livekit_url, callParams.token);

      // Enable camera and microphone
      await this.room.localParticipant.setCameraEnabled(true);
      await this.room.localParticipant.setMicrophoneEnabled(true);

      // Get local camera preview
      const camPub = this.room.localParticipant.getTrackPublication(
        Track.Source.Camera
      ) as LocalTrackPublication | undefined;
      if (camPub?.track) {
        const localEl = camPub.track.attach();
        this.callbacks.onLocalVideo?.(localEl as HTMLVideoElement);
      }
    } catch (err) {
      this.log('error', `Connect failed: ${err}`);
      this.callState = 'idle';
      this.callbacks.onStateChange?.('idle');
    }
  }

  /** Decline incoming call */
  declineCall(): void {
    this.log('info', 'Call declined');
    if (this.autoAnswerTimer) {
      clearTimeout(this.autoAnswerTimer);
      this.autoAnswerTimer = null;
    }
    this.stopRingtoneVibration();
    this.pendingCallParams = null;
    this.callState = 'idle';
    this.callbacks.onStateChange?.('idle');
  }

  /** End active call */
  async endCall(): Promise<void> {
    this.callState = 'ending';
    this.callbacks.onStateChange?.('ending');
    this.cleanup();
  }

  /** Handle end_call command from WS */
  handleEndCallCommand(): void {
    this.log('info', 'Doctor ended the call');
    this.cleanup();
  }

  /** Toggle microphone */
  async toggleMute(): Promise<boolean> {
    if (!this.room) return false;
    const micPub = this.room.localParticipant.getTrackPublication(
      Track.Source.Microphone
    );
    if (micPub) {
      const isMuted = !micPub.isMuted;
      await this.room.localParticipant.setMicrophoneEnabled(!isMuted);
      return isMuted;
    }
    return false;
  }

  /** Toggle camera */
  async toggleCamera(): Promise<boolean> {
    if (!this.room) return false;
    const camPub = this.room.localParticipant.getTrackPublication(
      Track.Source.Camera
    );
    if (camPub) {
      const isOff = !camPub.isMuted;
      await this.room.localParticipant.setCameraEnabled(!isOff);
      return isOff;
    }
    return false;
  }

  /** Get call duration in seconds */
  getDurationSec(): number {
    if (this.startTime === 0) return 0;
    return Math.round((Date.now() - this.startTime) / 1000);
  }

  // ─── Private ──────────────────────────────────────────

  private cleanup(): void {
    const duration = this.getDurationSec();

    if (this.room) {
      try {
        this.room.disconnect();
      } catch (_) {}
      this.room = null;
    }

    if (this.autoAnswerTimer) {
      clearTimeout(this.autoAnswerTimer);
      this.autoAnswerTimer = null;
    }
    this.stopRingtoneVibration();

    this.pendingCallParams = null;
    this.startTime = 0;
    this.callState = 'idle';
    this.callbacks.onStateChange?.('idle');
    this.callbacks.onCallEnded?.(duration);
  }

  private async showIncomingCallNotification(params: IncomingCallParams): Promise<void> {
    try {
      await LocalNotifications.schedule({
        notifications: [
          {
            title: params.emergency ? '🚨 EMERGENCY CALL' : '📞 Incoming Call',
            body: `${params.caller} is calling...`,
            id: 99999,
            schedule: { at: new Date(Date.now()) },
            sound: undefined, // Use default sound
            extra: {
              type: 'incoming_call',
              room: params.room,
              emergency: params.emergency,
            },
          },
        ],
      });
    } catch (e) {
      this.log('warn', `Notification failed: ${e}`);
    }
  }

  private startRingtoneVibration(): void {
    // Vibrate pattern for incoming call
    this.ringtoneInterval = setInterval(async () => {
      try {
        await Haptics.impact({ style: ImpactStyle.Heavy });
      } catch (_) {}
    }, 1000);
  }

  private stopRingtoneVibration(): void {
    if (this.ringtoneInterval) {
      clearInterval(this.ringtoneInterval);
      this.ringtoneInterval = null;
    }
  }

  private log(level: 'info' | 'warn' | 'error', msg: string): void {
    console.log(`[CALL:${level.toUpperCase()}] ${msg}`);
    this.callbacks.onLog?.(level, msg);
  }
}
