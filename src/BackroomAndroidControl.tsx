import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { Hand, MonitorPlay, Power, ShieldCheck, Smartphone } from 'lucide-react';
import { supabase } from './supabase';
import { type BackroomDevice } from './backroomCloudDevices';
import { validateDeviceSignal } from '../integrations/backroom/desktop-realtime-protocol.mjs';
import { getContainedVideoRect, normalizeClientPointToVideo } from '../integrations/backroom/video-selection-overlay.mjs';
import { waitForIceGatheringComplete } from '../integrations/backroom/ice-gathering.mjs';

const uuid = () => crypto.randomUUID();
type Point = { x: number; y: number };
type PointerStart = Point & { pointerId: number; startedAt: number };

export default function BackroomAndroidControl({ device, roomId }: { device: BackroomDevice; roomId: string }) {
  const [appPackage, setAppPackage] = useState(device.apps[0]?.package_name ?? '');
  const [channelReady, setChannelReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [viewReady, setViewReady] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const [dataReady, setDataReady] = useState(false);
  const [controlGranted, setControlGranted] = useState(false);
  const [message, setMessage] = useState('Choose an app added on the phone, then start a view session.');
  const [messageError, setMessageError] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataRef = useRef<RTCDataChannel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef('');
  const pendingControlRequestRef = useRef('');
  const pointerRef = useRef<PointerStart | null>(null);
  const controlExpiryRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const controlRequestTimerRef = useRef<number | null>(null);

  const notify = useCallback((text: string, error = false) => {
    setMessage(text); setMessageError(error);
  }, []);

  const disposePeer = useCallback(() => {
    if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    if (disconnectTimerRef.current !== null) window.clearTimeout(disconnectTimerRef.current);
    if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
    controlExpiryRef.current = null; startTimerRef.current = null; disconnectTimerRef.current = null; controlRequestTimerRef.current = null;
    const peer = peerRef.current;
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); }
    peerRef.current = null;
    dataRef.current?.close(); dataRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    sessionRef.current = ''; pointerRef.current = null; pendingControlRequestRef.current = '';
    setSessionId(''); setViewReady(false); setSourceVisible(false); setDataReady(false); setControlGranted(false); setBusy(false);
  }, []);

  const stopRemote = useCallback(async (expectedSession = sessionRef.current) => {
    if (!supabase || !expectedSession || !device.device_id) { disposePeer(); return; }
    const requestId = uuid();
    try {
      await supabase.functions.invoke('backroom-device', {
        body: { action: 'android/command', deviceId: device.device_id, roomId,
          requestId, issuedAt: Date.now(), sessionId: expectedSession,
          command: 'stop_session', appPackageName: appPackage },
      });
    } catch { /* The server session expires automatically; local media is still stopped. */ }
    disposePeer();
  }, [device.device_id, roomId, appPackage, disposePeer]);

  useEffect(() => {
    setAppPackage(device.apps[0]?.package_name ?? '');
    disposePeer(); setChannelReady(false);
    if (!supabase || device.platform !== 'android' || device.status !== 'active' || !roomId) return;
    let disposed = false;
    const channel = supabase.channel('backroom-android:' + device.device_id.toLowerCase() + ':' + roomId.toLowerCase(), {
      config: { private: true, broadcast: { ack: true, self: false } },
    });
    channel.on('broadcast', { event: 'android_signal' }, async ({ payload }: any) => {
      if (disposed) return;
      const signal = validateDeviceSignal(payload, { deviceId: device.device_id, roomId, now: Date.now(), maxAgeMs: 120_000 });
      if (!signal || signal.sessionId !== sessionRef.current) return;
      const peer = peerRef.current;
      if (signal.answer && peer) {
        try { await peer.setRemoteDescription(signal.answer as RTCSessionDescriptionInit); }
        catch { notify('The phone returned an invalid WebRTC answer. Stop and start a fresh session.', true); void stopRemote(signal.sessionId); }
      }
      if (signal.stop) { notify('The phone stopped the screen-sharing session.'); disposePeer(); }
    });
    channel.on('broadcast', { event: 'android_response' }, ({ payload }: any) => {
      if (disposed || payload?.deviceId !== device.device_id || payload?.roomId !== roomId ||
          payload?.sessionId !== sessionRef.current || typeof payload?.requestId !== 'string' ||
          payload.requestId !== pendingControlRequestRef.current) return;
      pendingControlRequestRef.current = '';
      if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
      controlRequestTimerRef.current = null;
      if (payload.capability !== 'control') return;
      const granted = payload.ok === true;
      setControlGranted(granted);
      if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
      controlExpiryRef.current = granted ? window.setTimeout(() => {
        controlExpiryRef.current = null; setControlGranted(false);
        notify('The 15-minute local touch grant may have expired. Request control again after re-arming it on the phone.', true);
      }, 14 * 60 * 1000) : null;
      notify(granted
        ? 'Touch control granted. Tap, swipe or long-press inside the streamed app. Switching apps on the phone stops the session.'
        : 'Touch control was not granted. Enable the accessibility service and arm touch locally on the phone.', !granted);
    });
    channel.subscribe((status: string) => {
      if (disposed) return;
      setChannelReady(status === 'SUBSCRIBED');
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') notify('Private group/device channel unavailable. Check group membership and Realtime authorization.', true);
    });
    return () => {
      disposed = true;
      void supabase?.removeChannel(channel);
      const active = sessionRef.current;
      if (active) {
        void supabase?.functions.invoke('backroom-device', {
          body: { action: 'android/command', deviceId: device.device_id, roomId, requestId: uuid(),
            issuedAt: Date.now(), sessionId: active, command: 'stop_session', appPackageName: appPackage },
        });
      }
      // Avoid React state writes from an unmount cleanup.
      if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
      if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
      if (disconnectTimerRef.current !== null) window.clearTimeout(disconnectTimerRef.current);
      if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
      peerRef.current?.close(); dataRef.current?.close();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      peerRef.current = null; dataRef.current = null; streamRef.current = null; sessionRef.current = '';
    };
  }, [device.device_id, device.platform, device.status, device.apps, roomId, appPackage, disposePeer, notify, stopRemote]);

  useEffect(() => {
    const video = videoRef.current, stream = streamRef.current;
    if (!viewReady || !video || !stream) return;
    if (video.srcObject !== stream) video.srcObject = stream;
    void video.play().catch(() => undefined);
  }, [viewReady]);

  const startView = async () => {
    if (busy || !channelReady || !supabase || !device.apps.some(app => app.package_name === appPackage)) return;
    if (!appPackage) return notify('Select an app that has been added on the phone.', true);
    if (peerRef.current) disposePeer();
    setBusy(true); setControlGranted(false); setViewReady(false); setDataReady(false);
    notify('Creating a secure screen session…');
    const nextSessionId = uuid(), requestId = uuid();
    sessionRef.current = nextSessionId; setSessionId(nextSessionId);
    try {
      const peer = new RTCPeerConnection({ iceServers: [
        { urls: ['stun:stun.l.google.com:19302'] }, { urls: ['stun:stun.cloudflare.com:3478'] },
      ] });
      peerRef.current = peer;
      // The offer must include a video m-line; the phone answers it with its
      // MediaProjection track. A data-channel-only offer cannot carry video.
      peer.addTransceiver('video', { direction: 'recvonly' });
      const data = peer.createDataChannel('backroom-input', { ordered: true });
      dataRef.current = data;
      data.onopen = () => setDataReady(true);
      data.onclose = () => setDataReady(false);
      peer.ontrack = event => {
        if (peerRef.current !== peer || sessionRef.current !== nextSessionId) return;
        const stream = event.streams[0] ?? new MediaStream([event.track]);
        streamRef.current = stream;
        if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
        startTimerRef.current = null;
        for (const track of stream.getVideoTracks()) track.addEventListener('ended', () => {
          if (streamRef.current === stream) {
            notify('Android screen sharing ended.', true);
            void stopRemote(nextSessionId);
          }
        });
        setViewReady(true); setSourceVisible(true); setBusy(false);
        for (const track of stream.getVideoTracks()) {
          track.addEventListener('mute', () => {
            if (streamRef.current !== stream) return;
            setSourceVisible(false);
            setControlGranted(false);
            notify('The selected app window is hidden on the phone. Keep that app in the foreground; the stream will resume when it is visible.');
          });
          track.addEventListener('unmute', () => {
            if (streamRef.current !== stream) return;
            setSourceVisible(true);
            notify('The selected app window is visible again. Request touch control separately after locally arming it on the phone.');
          });
        }
        notify('Live app stream connected. Keep the selected app visible on the phone. Request touch control separately after locally arming it.');
      };
      peer.onconnectionstatechange = () => {
        if (peerRef.current !== peer) return;
        if (peer.connectionState === 'connected') {
          if (disconnectTimerRef.current !== null) window.clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = null;
        } else if (peer.connectionState === 'disconnected') {
          if (disconnectTimerRef.current !== null) window.clearTimeout(disconnectTimerRef.current);
          disconnectTimerRef.current = window.setTimeout(() => {
            disconnectTimerRef.current = null;
            if (peerRef.current === peer && peer.connectionState === 'disconnected') {
              notify('The phone connection stayed offline for 20 seconds. Ending screen sharing to protect the session.', true);
              void stopRemote(nextSessionId);
            }
          }, 20_000);
        } else if (peer.connectionState === 'failed' || peer.connectionState === 'closed') {
          notify('WebRTC connection failed or closed. Check network/peer connectivity and retry.', true);
          void stopRemote(nextSessionId);
        }
      };
      const offer = await peer.createOffer();
      await peer.setLocalDescription(offer);
      await waitForIceGatheringComplete(peer);
      const { data: result, error } = await supabase.functions.invoke('backroom-device', {
        body: { action: 'android/session-start', deviceId: device.device_id, roomId,
          requestId, issuedAt: Date.now(), sessionId: nextSessionId, appPackageName: appPackage,
          offer: { sdp: peer.localDescription?.sdp ?? '' } },
      });
      if (error || !result?.ok) throw new Error(result?.reason?.replaceAll('_', ' ') || error?.message || 'Android stream request rejected.');
      notify('Request sent to the phone. It must be online, sharing the selected app window, and approved in this group.');
      startTimerRef.current = window.setTimeout(() => {
        if (sessionRef.current !== nextSessionId || (peer.connectionState === 'connected' && streamRef.current)) return;
        notify('No app stream arrived within 45 seconds. Check the companion and phone network, then stop and retry.', true);
        void stopRemote(nextSessionId);
      }, 45_000);
    } catch (error) {
      await stopRemote(nextSessionId);
      pendingControlRequestRef.current = '';
      notify(error instanceof Error ? error.message : 'Could not start the Android app stream.', true);
    }
  };

  const sendDeviceCommand = async (command: 'request_control' | 'stop_session') => {
    if (!supabase || !sessionRef.current || busy) return;
    if (command === 'request_control' && (!viewReady || !dataReady)) return notify('Wait until the stream and touch data channel are connected.', true);
    const expectedSession = sessionRef.current;
    const requestId = uuid();
    if (command === 'request_control') pendingControlRequestRef.current = requestId;
    setBusy(true);
    try {
      const { data, error } = await supabase.functions.invoke('backroom-device', {
        body: { action: 'android/command', deviceId: device.device_id, roomId,
          requestId, issuedAt: Date.now(), sessionId: expectedSession,
          command, appPackageName: appPackage },
      });
      if (error || !data?.ok) throw new Error(data?.reason?.replaceAll('_', ' ') || error?.message || 'Phone rejected the command.');
      if (command === 'request_control') {
        setBusy(false);
        if (pendingControlRequestRef.current === requestId) {
          notify('Touch permission requested. Waiting for the phone to confirm its local permission.');
          if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
          controlRequestTimerRef.current = window.setTimeout(() => {
            controlRequestTimerRef.current = null;
            if (pendingControlRequestRef.current === requestId) {
              pendingControlRequestRef.current = '';
              setControlGranted(false);
              notify('The phone did not confirm touch control in time. Check that the companion is connected and locally armed, then request again.', true);
            }
          }, 45_000);
        }
      } else { notify('Stopping the phone session…'); disposePeer(); }
    } catch (error) {
      if (command === 'request_control' && pendingControlRequestRef.current === requestId) {
        pendingControlRequestRef.current = '';
        if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
        controlRequestTimerRef.current = null;
      }
      setBusy(false);
      notify(error instanceof Error ? error.message : 'Could not send the phone command.', true);
    }
  };

  const contentPoint = (event: PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const box = video.getBoundingClientRect();
    return normalizeClientPointToVideo(getContainedVideoRect(box, video.videoWidth, video.videoHeight), event.clientX, event.clientY);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (!controlGranted || !sourceVisible || busy || event.button !== 0) return;
    const point = contentPoint(event);
    if (!point) return;
    event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { ...point, pointerId: event.pointerId, startedAt: Date.now() };
  };
  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    const end = contentPoint(event), channel = dataRef.current;
    if (!end || !channel || channel.readyState !== 'open') return;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const durationMs = Math.min(1_500, Math.max(40, Date.now() - start.startedAt));
    const gesture = distance >= 0.02 ? 'swipe' : durationMs >= 500 ? 'long_press' : 'tap';
    const to = gesture === 'swipe' ? end : start;
    channel.send(JSON.stringify({ kind: 'touch', sessionId: sessionRef.current, appPackageName,
      gesture, from: { x: start.x, y: start.y }, to: { x: to.x, y: to.y }, durationMs }));
  };
  const pointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current?.pointerId === event.pointerId) pointerRef.current = null;
  };

  return <section className="br-android-stream" aria-label="Android live app stream">
    <div className="br-android-stream-head">
      <div><b><Smartphone size={14}/> Live Android app</b><small>{device.device_label} · user-consented screen sharing</small></div>
      <span className={viewReady ? 'live' : sessionId ? 'waiting' : 'waiting'}>{viewReady ? 'Live' : sessionId ? 'Connecting' : 'Ready'}</span>
    </div>
    <label className="br-android-app-picker"><span>App on phone</span>
      <select value={appPackage} onChange={event => setAppPackage(event.target.value)} disabled={Boolean(sessionId) || busy}>
        {device.apps.map(app => <option key={app.package_name} value={app.package_name}>{app.app_label}</option>)}
      </select>
    </label>
    <div className={'br-android-live-surface' + (controlGranted ? ' controllable' : '')}
      onPointerDown={pointerDown} onPointerUp={pointerUp} onPointerCancel={pointerCancel}
      onContextMenu={event => event.preventDefault()}
      role={controlGranted ? 'application' : 'img'} aria-label={controlGranted ? 'Tap and swipe inside the streamed Android app' : 'Android app screen preview'}
      tabIndex={controlGranted ? 0 : -1}>
      <video ref={videoRef} autoPlay playsInline muted />
      {!viewReady ? <div className="br-android-live-placeholder"><MonitorPlay size={26}/>
        <b>{sessionId ? 'Waiting for the phone stream' : 'No app stream active'}</b>
        <span>Start sharing in Rub Minds Companion, then request this app here.</span>
      </div> : !sourceVisible ? <div className="br-android-live-placeholder">
        <Smartphone size={24}/><b>App window hidden on the phone</b>
        <span>Bring the selected app to the foreground on the phone. The picture and touch control resume when Android reports it visible.</span>
      </div> : null}
      {viewReady && controlGranted ? <div className="br-android-touch-hint"><Hand size={13}/> Tap · swipe · long press</div> : null}
    </div>
    <div className="br-android-stream-actions">
      {!sessionId
        ? <button type="button" disabled={!channelReady || !device.apps.length || busy} onClick={() => void startView()}><MonitorPlay size={14}/> Start app view</button>
        : <>
          {!controlGranted
            ? <button type="button" disabled={!viewReady || !sourceVisible || !dataReady || busy} onClick={() => void sendDeviceCommand('request_control')}><Hand size={14}/> Request touch control</button>
            : <span className="br-android-control-grant"><ShieldCheck size={14}/> Touch enabled temporarily</span>}
          <button type="button" className="stop" disabled={busy} onClick={() => void sendDeviceCommand('stop_session')}><Power size={14}/> Stop session</button>
        </>}
    </div>
    <div className={'br-android-stream-status' + (messageError ? ' error' : '')} role="status">{message}</div>
    <p className="br-android-stream-disclaimer">
      Open this Backroom control page on a second device, such as your Windows laptop. The selected app must stay visible on the phone; showing Backroom on that same phone hides the shared app and pauses its picture. Choose the app window, not the whole display. Touch is a separate local 15-minute permission. This mirrors the real app; it is not an isolated virtual copy.
    </p>
  </section>;
}
