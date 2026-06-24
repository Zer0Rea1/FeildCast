// Handles WebSocket connection + MediaRecorder for reporter SRT streaming
// This is the same pattern as LiveDesk, adapted for React Native

const WS_URL = process.env.EXPO_PUBLIC_WS_URL || 'ws://localhost:3000/stream';

// Polyfill MediaRecorder for native platforms to prevent ReferenceError
class NativeMediaRecorderShim {
  state = 'inactive';
  ondataavailable: ((e: any) => void) | null = null;
  private intervalId: any = null;

  constructor(private stream: any, private options?: any) {}

  static isTypeSupported(mimeType: string): boolean {
    return false; // Native doesn't support WebM/MediaRecorder in JS
  }

  start(timeslice = 100) {
    this.state = 'recording';
    console.warn(
      '[SrtStreamer] MediaRecorder is not natively supported in React Native (Android/iOS). ' +
      'Streaming is only supported on Web. Sending dummy heartbeat data to keep connection alive.'
    );
    // Send dummy heartbeat packets to prevent WS/FFmpeg from closing immediately
    this.intervalId = setInterval(() => {
      if (this.ondataavailable && this.state === 'recording') {
        const dummyData = new ArrayBuffer(1024); // 1KB dummy chunk
        this.ondataavailable({
          data: {
            size: dummyData.byteLength,
            arrayBuffer: async () => dummyData,
          }
        });
      }
    }, timeslice);
  }

  stop() {
    this.state = 'inactive';
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}

const MediaRecorderClass = typeof MediaRecorder !== 'undefined' ? MediaRecorder : (NativeMediaRecorderShim as any);

export class SrtStreamer {
  private ws: WebSocket | null = null;
  private mediaRecorder: any = null;
  private bytesSent = 0;
  private onReady?: (streamId: string) => void;
  private onError?: (msg: string) => void;
  private onStats?: (bytes: number) => void;

  constructor(callbacks: {
    onReady?: (streamId: string) => void;
    onError?: (msg: string) => void;
    onStats?: (bytes: number) => void;
  }) {
    this.onReady = callbacks.onReady;
    this.onError = callbacks.onError;
    this.onStats = callbacks.onStats;
  }

  async start(token: string, conferenceId: string, stream: any, bitrate: number) {
    const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}&conferenceId=${conferenceId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ready') {
          this.startRecording(stream, bitrate);
          this.onReady?.(msg.streamId);
        } else if (msg.type === 'error') {
          this.onError?.(msg.message);
          this.stop();
        }
      } catch {}
    };

    this.ws.onerror = () => {
      this.onError?.('Connection failed');
    };

    this.ws.onclose = () => {
      this.stopRecording();
    };
  }

  private startRecording(stream: any, bitrate: number) {
    const mimeType = MediaRecorderClass.isTypeSupported('video/webm;codecs=vp9,opus')
      ? 'video/webm;codecs=vp9,opus'
      : 'video/webm;codecs=vp8,opus';

    this.mediaRecorder = new MediaRecorderClass(stream, {
      mimeType,
      videoBitsPerSecond: bitrate * 1000,
      audioBitsPerSecond: 128000,
    });

    this.mediaRecorder.ondataavailable = (e: any) => {
      if (e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then((buf: ArrayBuffer) => {
          if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(buf);
            this.bytesSent += buf.byteLength;
            this.onStats?.(this.bytesSent);
          }
        });
      }
    };

    this.mediaRecorder.start(100); // 100ms chunks
  }

  private stopRecording() {
    if (this.mediaRecorder?.state !== 'inactive') {
      this.mediaRecorder?.stop();
    }
  }

  stop() {
    this.stopRecording();
    this.ws?.close();
    this.ws = null;
    this.bytesSent = 0;
  }

  get isStreaming() {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}
