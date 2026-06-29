// WebSocket video streaming — same protocol as the backend srtBridge.ts expects
// Reporter captures camera via getUserMedia() → MediaRecorder → WebSocket → FFmpeg → SRT

const WS_URL = import.meta.env.VITE_WS_URL || '/stream';

export class SrtStreamer {
  private ws: WebSocket | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private bytesSent = 0;

  private onReady?: (streamId: string) => void;
  private onError?: (msg: string) => void;
  private onStats?: (bytes: number) => void;
  private onDisconnect?: () => void;

  constructor(callbacks: {
    onReady?: (streamId: string) => void;
    onError?: (msg: string) => void;
    onStats?: (bytes: number) => void;
    onDisconnect?: () => void;
  }) {
    Object.assign(this, callbacks);
  }

  async start(token: string, conferenceId: string, stream: MediaStream, bitrate: number) {
    // Build WebSocket URL with auth token and conferenceId
    const wsUrl = `${WS_URL}?token=${encodeURIComponent(token)}&conferenceId=${conferenceId}`;
    this.ws = new WebSocket(wsUrl);
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      console.log('[WSStream] Connected to bridge');
    };

    this.ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (msg.type === 'ready') {
          // Backend is ready — start sending video
          this.startRecording(stream, bitrate);
          this.onReady?.(msg.streamId);
        } else if (msg.type === 'error') {
          this.onError?.(msg.message);
          this.stop();
        }
      } catch {}
    };

    this.ws.onerror = () => this.onError?.('WebSocket connection failed');
    this.ws.onclose = () => {
      this.stopRecording();
      this.onDisconnect?.();
    };
  }

  private startRecording(stream: MediaStream, bitrate: number) {
    // Pick best supported codec
    const mimeType = [
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ].find(t => MediaRecorder.isTypeSupported(t)) || 'video/webm';

    this.mediaRecorder = new MediaRecorder(stream, {
      mimeType,
      videoBitsPerSecond: bitrate * 1000,
      audioBitsPerSecond: 128000,
    });

    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0 && this.ws?.readyState === WebSocket.OPEN) {
        e.data.arrayBuffer().then(buf => {
          this.ws!.send(buf);
          this.bytesSent += buf.byteLength;
          this.onStats?.(this.bytesSent);
        });
      }
    };

    // 100ms chunks — same as LiveDesk
    this.mediaRecorder.start(100);
  }

  private stopRecording() {
    if (this.mediaRecorder?.state !== 'inactive') {
      this.mediaRecorder?.stop();
    }
    this.mediaRecorder = null;
  }

  stop() {
    this.stopRecording();
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.close();
    }
    this.ws = null;
  }

  get isStreaming(): boolean {
    return this.ws?.readyState === WebSocket.OPEN &&
           this.mediaRecorder?.state === 'recording';
  }

  get totalBytesSent(): number {
    return this.bytesSent;
  }
}

// Get camera + microphone stream with quality settings
export async function getCameraStream(
  resolution: string,
  fps: number,
  facingMode: 'user' | 'environment' = 'environment',
): Promise<MediaStream> {
  // Always request landscape: use the larger dimension as width
  const parts = resolution.split('x').map(Number);
  const width  = Math.max(parts[0], parts[1]);
  const height = Math.min(parts[0], parts[1]);

  return navigator.mediaDevices.getUserMedia({
    video: {
      width:       { ideal: width },
      height:      { ideal: height },
      aspectRatio: { ideal: 16 / 9 },
      frameRate:   { ideal: fps },
      facingMode:  { ideal: facingMode },
    },
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      sampleRate: 44100,
    },
  });
}
