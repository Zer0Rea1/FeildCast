import { useEffect, useRef } from 'react';
import Hls from 'hls.js';

interface Props {
  src: string;
  reporterName: string;
  bitrate?: number;
}

export default function HLSPlayer({ src, reporterName, bitrate }: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef   = useRef<Hls | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true, backBufferLength: 10 });
      hlsRef.current = hls;
      hls.loadSource(src);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, () => { video.play().catch(() => {}); });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data.fatal) setTimeout(() => hls.loadSource(src), 3000);
      });
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = src;
      video.play().catch(() => {});
    }

    return () => { hlsRef.current?.destroy(); };
  }, [src]);

  return (
    <div style={{ position: 'relative', background: '#111', borderRadius: 10, overflow: 'hidden' }}>
      <video ref={videoRef} muted style={{ width: '100%', aspectRatio: '16/9', display: 'block' }} />
      <div style={{
        position: 'absolute', bottom: 0, left: 0, right: 0,
        background: 'linear-gradient(transparent, rgba(0,0,0,0.8))',
        padding: '20px 12px 10px', display: 'flex', justifyContent: 'space-between',
        alignItems: 'flex-end',
      }}>
        <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{reporterName}</span>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <div style={{
            background: '#E24B4A', color: '#fff', fontSize: 10, fontWeight: 700,
            padding: '2px 8px', borderRadius: 4,
          }}>● LIVE</div>
          {bitrate && <span style={{ color: '#aaa', fontSize: 10 }}>{bitrate} kbps</span>}
        </div>
      </div>
    </div>
  );
}
