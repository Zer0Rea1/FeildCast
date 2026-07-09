import { useEffect, useState } from 'react';

export interface CameraDevice {
  deviceId: string;
  label: string;
  /** Best-effort facing hint derived from label text or getCapabilities() */
  facing: 'user' | 'environment' | 'unknown';
}

/**
 * Enumerates all video-input devices and returns a reactive list.
 *
 * - Returns an empty array until the browser grants camera permission
 *   (labels are blank before permission, so we wait for a non-empty label).
 * - Re-queries whenever a device is added / removed.
 * - On the first call we do a silent getUserMedia({ video: true }) if no
 *   labels are available yet, so the browser prompt fires and we get real
 *   labels on the follow-up enumeration.
 */
export function useCameraDevices(): CameraDevice[] {
  const [devices, setDevices] = useState<CameraDevice[]>([]);

  async function queryDevices() {
    let list = await navigator.mediaDevices.enumerateDevices();
    const videoInputs = list.filter(d => d.kind === 'videoinput');

    // Labels are empty before the user grants permission — trigger a silent prompt
    if (videoInputs.length > 0 && videoInputs.every(d => !d.label)) {
      try {
        const tmp = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        tmp.getTracks().forEach(t => t.stop());
        // Re-enumerate now that we have permission
        list = await navigator.mediaDevices.enumerateDevices();
      } catch {
        // Permission denied — return what we have (unlabelled)
      }
    }

    const cameras: CameraDevice[] = list
      .filter(d => d.kind === 'videoinput')
      .map((d, idx) => {
        const label = d.label || `Camera ${idx + 1}`;
        const facing = guessFacing(label, (d as any).getCapabilities?.()?.facingMode?.[0]);
        return { deviceId: d.deviceId, label, facing };
      });

    setDevices(cameras);
  }

  useEffect(() => {
    queryDevices();
    navigator.mediaDevices.addEventListener('devicechange', queryDevices);
    return () => navigator.mediaDevices.removeEventListener('devicechange', queryDevices);
  }, []);

  return devices;
}

function guessFacing(
  label: string,
  capFacing?: string,
): 'user' | 'environment' | 'unknown' {
  if (capFacing === 'user') return 'user';
  if (capFacing === 'environment') return 'environment';
  const l = label.toLowerCase();
  if (l.includes('front') || l.includes('user') || l.includes('facetime')) return 'user';
  if (l.includes('back') || l.includes('rear') || l.includes('environment')) return 'environment';
  return 'unknown';
}
