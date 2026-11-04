import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { ArrowLeft, Hand, MonitorPlay, Power, ShieldCheck, Smartphone } from 'lucide-react';
import { supabase } from './supabase';
import { type BackroomDevice } from './backroomCloudDevices';
import { validateDeviceSignal } from '../integrations/backroom/desktop-realtime-protocol.mjs';
import { createNormalizedDragSelection, getContainedVideoRect, mapVideoSelectionToFrame, normalizeClientPointToVideo } from '../integrations/backroom/video-selection-overlay.mjs';
import { waitForIceGatheringComplete } from '../integrations/backroom/ice-gathering.mjs';

const uuid = () => crypto.randomUUID();
type Point = { x: number; y: number };
type PointerStart = Point & { pointerId: number; startedAt: number; mode: 'touch' | 'composer' };

export default function BackroomAndroidControl({ device, roomId }: { device: BackroomDevice; roomId: string }) {
  const [appPackage, setAppPackage] = useState(device.apps[0]?.package_name ?? '');
  const [channelReady, setChannelReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [sessionId, setSessionId] = useState('');
  const [viewReady, setViewReady] = useState(false);
  const [sourceVisible, setSourceVisible] = useState(false);
  const sourceVisibilityRef = useRef<boolean | null>(null);
  const [dataReady, setDataReady] = useState(false);
  const [controlGranted, setControlGranted] = useState(false);
  const [remoteText, setRemoteText] = useState('');
  const [selectionMode, setSelectionMode] = useState(false);
  const [composerTargetId, setComposerTargetId] = useState('');
  const [sendControlVerified, setSendControlVerified] = useState(false);
  const [providerConversationIdentityAvailable, setProviderConversationIdentityAvailable] = useState(false);
  const providerConversationIdentityDigestRef = useRef('');
  const [sendControlCheckPending, setSendControlCheckPending] = useState(false);
  const [sendControlStatus, setSendControlStatus] = useState('No native Send control verified.');
  const [selectionPreview, setSelectionPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [remoteTextBusy, setRemoteTextBusy] = useState(false);
  const [remoteTextStatus, setRemoteTextStatus] = useState('Focus a normal text field in the phone app, then type here.');
  const [message, setMessage] = useState('Choose an app added on the phone, then start a view session.');
  const [messageError, setMessageError] = useState(false);
  const peerRef = useRef<RTCPeerConnection | null>(null);
  const dataRef = useRef<RTCDataChannel | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef('');
  const pendingControlRequestRef = useRef('');
  const pointerRef = useRef<PointerStart | null>(null);
  const pendingTouchAcksRef = useRef<Map<string, number>>(new Map());
  const pendingNavigationAcksRef = useRef<Map<string, number>>(new Map());
  const pendingRemoteTextAcksRef = useRef<Map<string, number>>(new Map());
  const pendingComposerSelectionAcksRef = useRef<Map<string, number>>(new Map());
  const composerTargetRef = useRef('');
  const sendTargetRef = useRef('');
  const pendingSendControlCheckRef = useRef('');
  const sendControlCheckTimerRef = useRef<number | null>(null);
  const controlExpiryRef = useRef<number | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const disconnectTimerRef = useRef<number | null>(null);
  const controlRequestTimerRef = useRef<number | null>(null);

  const notify = useCallback((text: string, error = false) => {
    setMessage(text); setMessageError(error);
  }, []);

  const clearComposerTarget = useCallback((notifyPhone = true) => {
    const channel = dataRef.current;
    const activeSession = sessionRef.current;
    if (notifyPhone && channel && channel.readyState === 'open' && activeSession) {
      try {
        channel.send(JSON.stringify({
          kind: 'clear_composer_target',
          selectionId: uuid(),
          sessionId: activeSession,
          appPackageName: appPackage,
        }));
      } catch { /* Local UI state is cleared even if the peer is disconnected. */ }
    }
    if (sendControlCheckTimerRef.current !== null) window.clearTimeout(sendControlCheckTimerRef.current);
    sendControlCheckTimerRef.current = null;
    pendingSendControlCheckRef.current = '';
    setSendControlCheckPending(false);
    composerTargetRef.current = '';
    sendTargetRef.current = '';
    setComposerTargetId('');
    setSendControlVerified(false);
    setProviderConversationIdentityAvailable(false);
    providerConversationIdentityDigestRef.current = '';
    setSendControlStatus('No native Send control verified.');
    setSelectionPreview(null);
    setSelectionMode(false);
  }, [appPackage]);


  const disposePeer = useCallback(() => {
    if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
    if (startTimerRef.current !== null) window.clearTimeout(startTimerRef.current);
    if (disconnectTimerRef.current !== null) window.clearTimeout(disconnectTimerRef.current);
    if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
    controlExpiryRef.current = null; startTimerRef.current = null; disconnectTimerRef.current = null; controlRequestTimerRef.current = null;
    if (sendControlCheckTimerRef.current !== null) window.clearTimeout(sendControlCheckTimerRef.current);
    sendControlCheckTimerRef.current = null;
    pendingSendControlCheckRef.current = '';
    const peer = peerRef.current;
    if (peer) { peer.ontrack = null; peer.onconnectionstatechange = null; peer.close(); }
    peerRef.current = null;
    dataRef.current?.close(); dataRef.current = null;
    for (const timer of pendingTouchAcksRef.current.values()) window.clearTimeout(timer);
    pendingTouchAcksRef.current.clear();
    for (const timer of pendingNavigationAcksRef.current.values()) window.clearTimeout(timer);
    pendingNavigationAcksRef.current.clear();
    for (const timer of pendingRemoteTextAcksRef.current.values()) window.clearTimeout(timer);
    pendingRemoteTextAcksRef.current.clear();
    for (const timer of pendingComposerSelectionAcksRef.current.values()) window.clearTimeout(timer);
    pendingComposerSelectionAcksRef.current.clear();
    composerTargetRef.current = '';
    sendTargetRef.current = '';
    providerConversationIdentityDigestRef.current = '';
    streamRef.current?.getTracks().forEach(track => track.stop()); streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    sessionRef.current = ''; pointerRef.current = null; pendingControlRequestRef.current = '';
    sourceVisibilityRef.current = null;
    setSessionId(''); setViewReady(false); setSourceVisible(false); setDataReady(false); setControlGranted(false); setRemoteText(''); setRemoteTextBusy(false); setSelectionMode(false); setComposerTargetId(''); setSendControlVerified(false); setProviderConversationIdentityAvailable(false); setSendControlCheckPending(false); setSendControlStatus('No native Send control verified.'); setSelectionPreview(null); setRemoteTextStatus('Select the actual composer in the streamed app before inserting text.'); setBusy(false);
  }, []);

  const stopRemote = useCallback(async (expectedSession = sessionRef.current) => {
    if (!supabase || !expectedSession || !device.device_id) {
      if (!expectedSession || sessionRef.current === expectedSession) disposePeer();
      return;
    }
    const requestId = uuid();
    try {
      await supabase.functions.invoke('backroom-device', {
        body: { action: 'android/command', deviceId: device.device_id, roomId,
          requestId, issuedAt: Date.now(), sessionId: expectedSession,
          command: 'stop_session', appPackageName: appPackage },
      });
    } catch { /* The server session expires automatically; local media is still stopped. */ }
    // A delayed event for an older peer must never tear down a newer session.
    if (sessionRef.current === expectedSession) disposePeer();
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
      for (const timer of pendingRemoteTextAcksRef.current.values()) window.clearTimeout(timer);
      pendingRemoteTextAcksRef.current.clear();
      for (const timer of pendingComposerSelectionAcksRef.current.values()) window.clearTimeout(timer);
      pendingComposerSelectionAcksRef.current.clear();
      composerTargetRef.current = '';
      peerRef.current?.close(); dataRef.current?.close();
      streamRef.current?.getTracks().forEach(track => track.stop());
      if (videoRef.current) videoRef.current.srcObject = null;
      peerRef.current = null; dataRef.current = null; streamRef.current = null; sessionRef.current = '';
    };
  }, [device.device_id, device.platform, device.status, device.apps, roomId, appPackage, disposePeer, notify, stopRemote, clearComposerTarget]);

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
    sessionRef.current = nextSessionId; sourceVisibilityRef.current = null; setSessionId(nextSessionId);
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
      data.onclose = () => {
        setDataReady(false);
        for (const timer of pendingTouchAcksRef.current.values()) window.clearTimeout(timer);
        pendingTouchAcksRef.current.clear();
        for (const timer of pendingRemoteTextAcksRef.current.values()) window.clearTimeout(timer);
        pendingRemoteTextAcksRef.current.clear();
        for (const timer of pendingComposerSelectionAcksRef.current.values()) window.clearTimeout(timer);
        pendingComposerSelectionAcksRef.current.clear();
        composerTargetRef.current = '';
        sendTargetRef.current = '';
        setComposerTargetId(''); setSendControlVerified(false);
        setProviderConversationIdentityAvailable(false);
        setSendControlStatus('No native Send control verified.');
        setSelectionPreview(null); setSelectionMode(false);
        setRemoteTextBusy(false);
        setRemoteTextStatus('Phone data channel closed before acknowledgement. Check the phone field before retrying; the text may already have been inserted.');
      };
      data.onmessage = event => {
        let acknowledgement: any;
        try { acknowledgement = JSON.parse(String(event.data)); } catch { return; }
        if (!acknowledgement || acknowledgement.sessionId !== nextSessionId) return;
        if (acknowledgement.kind === 'remote_keyboard_revoked') {
          for (const timer of pendingRemoteTextAcksRef.current.values()) window.clearTimeout(timer);
          pendingRemoteTextAcksRef.current.clear();
          setRemoteTextBusy(false);
          clearComposerTarget(false);
          setRemoteTextStatus('The phone user revoked remote typing.');
          return;
        }
        if (acknowledgement.kind === 'composer_target_ack' &&
            typeof acknowledgement.selectionId === 'string' &&
            typeof acknowledgement.selected === 'boolean' &&
            typeof acknowledgement.reason === 'string') {
          const selectionTimer = pendingComposerSelectionAcksRef.current.get(acknowledgement.selectionId);
          if (selectionTimer === undefined) return;
          window.clearTimeout(selectionTimer);
          pendingComposerSelectionAcksRef.current.delete(acknowledgement.selectionId);
          if (acknowledgement.selected && typeof acknowledgement.targetId === 'string' &&
              /^[a-f0-9]{64}$/.test(acknowledgement.targetId)) {
            composerTargetRef.current = acknowledgement.targetId;
            setComposerTargetId(acknowledgement.targetId);
            const sendTarget = typeof acknowledgement.sendTargetId === 'string' &&
              /^[a-f0-9]{64}$/.test(acknowledgement.sendTargetId)
                ? acknowledgement.sendTargetId : '';
            const sendVerified = acknowledgement.sendAvailable === true && Boolean(sendTarget);
            const returnedProviderDigest = typeof acknowledgement.providerConversationIdentityDigest === 'string' &&
              /^[a-f0-9]{64}$/.test(acknowledgement.providerConversationIdentityDigest)
                ? acknowledgement.providerConversationIdentityDigest : '';
            const conversationIdentityAvailable = acknowledgement.providerConversationIdentityAvailable === true &&
              Boolean(returnedProviderDigest);
            providerConversationIdentityDigestRef.current = conversationIdentityAvailable ? returnedProviderDigest : '';
            sendTargetRef.current = sendVerified ? sendTarget : '';
            setSendControlVerified(sendVerified);
            setProviderConversationIdentityAvailable(conversationIdentityAvailable);
            const sendReason = typeof acknowledgement.sendReason === 'string'
              ? acknowledgement.sendReason.replaceAll('_', ' ')
              : 'phone companion update required';
            setSendControlStatus(sendVerified
              ? conversationIdentityAvailable
                ? 'One unique Send control and a stable provider-conversation identity were found at selection time. Native wake still requires the trusted queue bridge, local consent and a fresh identity recheck.'
                : 'One unique Send control was found, but this app has no verified stable conversation identity. Native autonomous wake is unavailable; the control is not permission to send.'
              : 'Send control not verified: ' + sendReason + '.');
            setSelectionPreview(null);
            setSelectionMode(false);
            setRemoteTextStatus(sendVerified
              ? conversationIdentityAvailable
                ? 'Composer and Send control selected. A provider-conversation identity was detected locally. Focus the exact field before inserting a draft; native wake remains unavailable until the trusted queue bridge and consented execution path are complete.'
                : 'Composer and Send control selected, but this app does not expose a verified stable conversation identity. Native autonomous wake is blocked; manual draft insertion remains available.'
              : 'Composer selected. Tap that exact field on the phone so it is focused, then insert a draft.');
            notify(sendVerified
              ? conversationIdentityAvailable
                ? 'Android found one editable composer and one nearby Send control. Conversation identity was detected locally; no message was sent.'
                : 'Android found the composer and Send control, but cannot verify which provider conversation is active. Native wake is blocked; no message was sent.'
              : 'Android selected one real editable composer in the approved app. No unique Send control was verified.');
          } else {
            clearComposerTarget(false);
            setRemoteTextStatus('Composer selection rejected: ' + acknowledgement.reason.replaceAll('_', ' ') + '. Drag over exactly one visible, editable, non-password field.');
            notify('Android could not verify one unique editable composer. Select one field, not a broad area or multiple controls.', true);
          }
          return;
        }
        if (acknowledgement.kind === 'send_control_ack' &&
            typeof acknowledgement.requestId === 'string' &&
            typeof acknowledgement.available === 'boolean' &&
            typeof acknowledgement.reason === 'string') {
          if (acknowledgement.requestId !== pendingSendControlCheckRef.current) return;
          if (sendControlCheckTimerRef.current !== null) window.clearTimeout(sendControlCheckTimerRef.current);
          sendControlCheckTimerRef.current = null;
          pendingSendControlCheckRef.current = '';
          setSendControlCheckPending(false);
          const returnedTarget = typeof acknowledgement.sendTargetId === 'string' &&
            /^[a-f0-9]{64}$/.test(acknowledgement.sendTargetId)
              ? acknowledgement.sendTargetId : '';
          const sendIdentityChanged = Boolean(returnedTarget && returnedTarget !== sendTargetRef.current);
          const remainsSameTarget = acknowledgement.available === true &&
            Boolean(returnedTarget) && !sendIdentityChanged &&
            Boolean(composerTargetRef.current);
          const recheckedProviderDigest = typeof acknowledgement.providerConversationIdentityDigest === 'string' &&
            /^[a-f0-9]{64}$/.test(acknowledgement.providerConversationIdentityDigest)
              ? acknowledgement.providerConversationIdentityDigest : '';
          const sameProviderConversation = acknowledgement.providerConversationIdentityAvailable === true &&
            Boolean(providerConversationIdentityDigestRef.current) &&
            recheckedProviderDigest === providerConversationIdentityDigestRef.current;
          setSendControlVerified(remainsSameTarget);
          setProviderConversationIdentityAvailable(sameProviderConversation);
          if (!sameProviderConversation) providerConversationIdentityDigestRef.current = '';
          if (!remainsSameTarget) sendTargetRef.current = '';
          setSendControlStatus(remainsSameTarget
            ? sameProviderConversation
              ? 'Rechecked: the same Send control and the same provider conversation are still selected. No action was taken.'
              : 'The Send control is unchanged, but the provider conversation could not be confirmed as the original chat. Native wake is blocked; draft insertion remains available.'
            : 'Recheck failed: ' + acknowledgement.reason.replaceAll('_', ' ') +
              (sendIdentityChanged
                ? '. The Send control identity changed; select the composer again.' : '.'));
          notify(remainsSameTarget
            ? sameProviderConversation
              ? 'The original provider conversation and Send control were rechecked. No message was sent.'
              : 'Provider conversation identity changed or is unavailable. Native wake is blocked; no message was sent.'
            : 'Native Send control is no longer verified. The Android frame remains draft-only.', !remainsSameTarget);
          return;
        }
        if (acknowledgement.kind === 'remote_text_ack' &&
            typeof acknowledgement.requestId === 'string' &&
            typeof acknowledgement.accepted === 'boolean' &&
            typeof acknowledgement.result === 'string') {
          const textTimer = pendingRemoteTextAcksRef.current.get(acknowledgement.requestId);
          if (textTimer === undefined) return;
          window.clearTimeout(textTimer);
          pendingRemoteTextAcksRef.current.delete(acknowledgement.requestId);
          setRemoteTextBusy(false);
          if (acknowledgement.accepted) {
            setRemoteText('');
            setRemoteTextStatus('Text inserted into the focused phone field. Nothing was submitted.');
          } else {
            const reason = acknowledgement.result.replaceAll('_', ' ');
            clearComposerTarget();
            setRemoteTextStatus('Phone declined text: ' + reason + '. Verify the app, permissions and exact focused composer, then select it again.');
          }
          return;
        }
        if (acknowledgement.kind === 'navigation_ack' &&
            typeof acknowledgement.navigationId === 'string' &&
            acknowledgement.action === 'back' && typeof acknowledgement.accepted === 'boolean') {
          const navigationTimer = pendingNavigationAcksRef.current.get(acknowledgement.navigationId);
          if (navigationTimer === undefined) return;
          window.clearTimeout(navigationTimer);
          pendingNavigationAcksRef.current.delete(acknowledgement.navigationId);
          notify(acknowledgement.accepted
            ? 'Android dispatched Back in the selected app.'
            : 'Android rejected Back. Check that the selected app is still foreground and local touch is armed.', !acknowledgement.accepted);
          return;
        }
        if (acknowledgement.kind === 'touch_control_revoked') {
          setControlGranted(false);
          for (const timer of pendingNavigationAcksRef.current.values()) window.clearTimeout(timer);
          pendingNavigationAcksRef.current.clear();
          pendingControlRequestRef.current = '';
          if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
          if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
          controlExpiryRef.current = null;
          controlRequestTimerRef.current = null;
          notify('The phone user disarmed remote touch. The live app view continues without input control.');
          return;
        }
        if (acknowledgement.kind === 'app_visibility' && typeof acknowledgement.visible === 'boolean') {
          sourceVisibilityRef.current = acknowledgement.visible;
          setSourceVisible(acknowledgement.visible);
          if (!acknowledgement.visible) {
            clearComposerTarget();
            setControlGranted(false);
            pendingControlRequestRef.current = '';
            if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
            if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
            controlExpiryRef.current = null;
            controlRequestTimerRef.current = null;
            for (const timer of pendingNavigationAcksRef.current.values()) window.clearTimeout(timer);
            pendingNavigationAcksRef.current.clear();
            notify('The selected app window is hidden on the phone. Keep that app in the foreground; video and touch pause until Android reports it visible.');
          } else {
            notify('The selected app window is visible again. Request touch control separately after locally arming it on the phone.');
          }
          return;
        }
        if (acknowledgement.kind !== 'touch_ack' ||
            typeof acknowledgement.gestureId !== 'string' ||
            typeof acknowledgement.accepted !== 'boolean') return;
        const timer = pendingTouchAcksRef.current.get(acknowledgement.gestureId);
        if (timer === undefined) return;
        window.clearTimeout(timer);
        pendingTouchAcksRef.current.delete(acknowledgement.gestureId);
        notify(acknowledgement.accepted
          ? 'Android completed the tap/swipe gesture.'
          : 'Android rejected the gesture. Check that the selected app is still foreground and local touch is armed.', !acknowledgement.accepted);
      };
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
        const initiallyVisible = sourceVisibilityRef.current ?? stream.getVideoTracks().every(track => !track.muted);
        sourceVisibilityRef.current = initiallyVisible;
        setViewReady(true);
        setSourceVisible(initiallyVisible);
        setBusy(false);
        for (const track of stream.getVideoTracks()) {
          track.addEventListener('mute', () => {
            if (streamRef.current !== stream) return;
            sourceVisibilityRef.current = false;
            setSourceVisible(false);
            setControlGranted(false);
            if (controlExpiryRef.current !== null) window.clearTimeout(controlExpiryRef.current);
            if (controlRequestTimerRef.current !== null) window.clearTimeout(controlRequestTimerRef.current);
            controlExpiryRef.current = null;
            controlRequestTimerRef.current = null;
            pendingControlRequestRef.current = '';
            notify('The selected app window is hidden on the phone. Keep that app in the foreground; the stream will resume when it is visible.');
          });
          track.addEventListener('unmute', () => {
            if (streamRef.current !== stream) return;
            sourceVisibilityRef.current = true;
            setSourceVisible(true);
            notify('The selected app window is visible again. Request touch control separately after locally arming it on the phone.');
          });
        }
        notify(initiallyVisible
          ? 'Live app stream connected. Keep the selected app visible on the phone. Request touch control separately after locally arming it.'
          : 'The selected app window is hidden on the phone. Bring it to the foreground to resume the stream.');
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

  const sendNavigationAction = (action: 'back') => {
    const channel = dataRef.current;
    if (!controlGranted || !sourceVisible || !dataReady || !channel || channel.readyState !== 'open') {
      notify('Wait for the app view and locally armed touch control before using Back.', true);
      return;
    }
    const navigationId = uuid();
    const timer = window.setTimeout(() => {
      pendingNavigationAcksRef.current.delete(navigationId);
      notify('No acknowledgement arrived for Back. The phone may be offline or the app may have left the foreground.', true);
    }, 4_000);
    pendingNavigationAcksRef.current.set(navigationId, timer);
    try {
      channel.send(JSON.stringify({
        kind: 'navigation', navigationId, sessionId: sessionRef.current, appPackageName: appPackage, action,
      }));
    } catch {
      window.clearTimeout(timer);
      pendingNavigationAcksRef.current.delete(navigationId);
      notify('The phone rejected the Back command channel. Reconnect the stream before retrying.', true);
    }
  };

  const sendRemoteText = () => {
    const channel = dataRef.current;
    const text = remoteText;
    if (!viewReady || !sourceVisible || !dataReady || !channel || channel.readyState !== 'open') {
      setRemoteTextStatus('Wait for the selected phone app and data channel to be live.');
      return;
    }
    if (!text.trim() || text.length > 4_000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) {
      setRemoteTextStatus('Enter up to 4,000 characters. Line breaks are accepted only by multiline phone fields; no Enter action is sent.');
      return;
    }
    if (remoteTextBusy) return;
    const selectedTargetId = composerTargetRef.current;
    if (!/^[a-f0-9]{64}$/.test(selectedTargetId)) {
      setRemoteTextStatus('Select one real composer in the phone app first.');
      return;
    }
    const requestId = uuid();
    const timeout = window.setTimeout(() => {
      pendingRemoteTextAcksRef.current.delete(requestId);
      setRemoteTextBusy(false);
      clearComposerTarget();
      setRemoteTextStatus('No phone-keyboard acknowledgement arrived. Do not retry blindly; check the selected app field for the draft before sending another insertion.');
    }, 6_000);
    pendingRemoteTextAcksRef.current.set(requestId, timeout);
    setRemoteTextBusy(true);
    setRemoteTextStatus('Sending text to the focused phone field…');
    try {
      channel.send(JSON.stringify({
        kind: 'remote_text', requestId, sessionId: sessionRef.current, appPackageName: appPackage, targetId: selectedTargetId, text,
      }));
    } catch {
      window.clearTimeout(timeout);
      pendingRemoteTextAcksRef.current.delete(requestId);
      setRemoteTextBusy(false);
      setRemoteTextStatus('The phone data channel rejected the typing request. Reconnect the app view before retrying.');
    }
  };

  const contentPoint = (event: PointerEvent<HTMLDivElement>) => {
    const video = videoRef.current;
    if (!video || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const box = video.getBoundingClientRect();
    return normalizeClientPointToVideo(getContainedVideoRect(box, video.videoWidth, video.videoHeight), event.clientX, event.clientY);
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    const mode = selectionMode ? 'composer' : controlGranted ? 'touch' : null;
    if (!mode || !viewReady || !sourceVisible || !dataReady || busy || event.button !== 0) return;
    const point = contentPoint(event);
    if (!point) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    pointerRef.current = { ...point, pointerId: event.pointerId, startedAt: Date.now(), mode };
    if (mode === 'composer') setSelectionPreview({ x: point.x, y: point.y, width: 0, height: 0 });
  };

  const pointerMove = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId || start.mode !== 'composer') return;
    const end = contentPoint(event);
    if (!end) return;
    const region = createNormalizedDragSelection(start, end, 0.001);
    setSelectionPreview(region);
  };

  const selectComposer = (region: { x: number; y: number; width: number; height: number }) => {
    const channel = dataRef.current;
    if (!viewReady || !sourceVisible || !dataReady || !channel || channel.readyState !== 'open') {
      setRemoteTextStatus('Wait until the selected app stream and data channel are live.');
      return;
    }
    // Android invalidates its previous local target as soon as a new drag begins.
    // Clear the frame-side digest at the same boundary so stale chat identity is never shown as current.
    clearComposerTarget(false);
    const selectionId = uuid();
    const timer = window.setTimeout(() => {
      pendingComposerSelectionAcksRef.current.delete(selectionId);
      clearComposerTarget(false);
      setRemoteTextStatus('Android did not confirm the selection. Check that Accessibility permission is enabled and the approved app is foreground.');
      notify('No composer-selection acknowledgement arrived from Android. No typing target has been registered.', true);
    }, 8_000);
    pendingComposerSelectionAcksRef.current.set(selectionId, timer);
    setSelectionPreview(region);
    setRemoteTextStatus('Checking the selected region against the phone accessibility tree…');
    try {
      channel.send(JSON.stringify({
        kind: 'select_composer_target',
        selectionId,
        sessionId: sessionRef.current,
        appPackageName: appPackage,
        region: { left: region.x, top: region.y, right: region.x + region.width, bottom: region.y + region.height },
      }));
    } catch {
      window.clearTimeout(timer);
      pendingComposerSelectionAcksRef.current.delete(selectionId);
      clearComposerTarget(false);
      setRemoteTextStatus('The Android data channel rejected composer selection. Reconnect the stream and retry.');
    }
  };

  const recheckSendControl = () => {
    const channel = dataRef.current;
    const session = sessionRef.current;
    const composerTarget = composerTargetRef.current;
    const sendTarget = sendTargetRef.current;
    if (!session || !channel || channel.readyState !== 'open' ||
        !composerTarget || !sendTarget || !viewReady || !sourceVisible || !dataReady) {
      setSendControlVerified(false);
      setProviderConversationIdentityAvailable(false);
      providerConversationIdentityDigestRef.current = '';
      sendTargetRef.current = '';
      setSendControlStatus('Recheck unavailable: the live phone session or selected target is missing.');
      return;
    }
    if (pendingSendControlCheckRef.current) return;
    const requestId = uuid();
    pendingSendControlCheckRef.current = requestId;
    setSendControlCheckPending(true);
    setSendControlStatus('Rechecking the focused composer and exact Send-control identity on the phone…');
    sendControlCheckTimerRef.current = window.setTimeout(() => {
      if (pendingSendControlCheckRef.current !== requestId) return;
      pendingSendControlCheckRef.current = '';
      sendControlCheckTimerRef.current = null;
      setSendControlCheckPending(false);
      setSendControlVerified(false);
      setProviderConversationIdentityAvailable(false);
      providerConversationIdentityDigestRef.current = '';
      sendTargetRef.current = '';
      setSendControlStatus('Recheck timed out. The Send control is not currently verified; no action was taken.');
      notify('The phone did not confirm the Send-control recheck. The frame remains draft-only.', true);
    }, 8_000);
    try {
      channel.send(JSON.stringify({
        kind: 'verify_composer_send',
        requestId,
        sessionId: session,
        appPackageName: appPackage,
        composerTargetId: composerTarget,
        sendTargetId: sendTarget,
      }));
    } catch {
      if (sendControlCheckTimerRef.current !== null) {
        window.clearTimeout(sendControlCheckTimerRef.current);
      }
      sendControlCheckTimerRef.current = null;
      pendingSendControlCheckRef.current = '';
      setSendControlCheckPending(false);
      setSendControlVerified(false);
      setProviderConversationIdentityAvailable(false);
      providerConversationIdentityDigestRef.current = '';
      sendTargetRef.current = '';
      setSendControlStatus('The phone data channel rejected the Send-control recheck.');
    }
  };

  const pointerUp = (event: PointerEvent<HTMLDivElement>) => {
    const start = pointerRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    pointerRef.current = null;
    const end = contentPoint(event), channel = dataRef.current;
    if (!end || !channel || channel.readyState !== 'open') return;
    if (start.mode === 'composer') {
      const region = createNormalizedDragSelection(start, end);
      if (!region) {
        setSelectionPreview(null);
        setRemoteTextStatus('Drag around one composer. The selection must be large enough to identify one editable field.');
        return;
      }
      selectComposer(region);
      return;
    }
    if (!controlGranted) return;
    const distance = Math.hypot(end.x - start.x, end.y - start.y);
    const durationMs = Math.min(1_500, Math.max(40, Date.now() - start.startedAt));
    const gesture = distance >= 0.02 ? 'swipe' : durationMs >= 500 ? 'long_press' : 'tap';
    const to = gesture === 'swipe' ? end : start;
    const gestureId = uuid();
    const timeout = window.setTimeout(() => {
      pendingTouchAcksRef.current.delete(gestureId);
      notify('No acknowledgement arrived for that gesture. The phone may be offline or the touch service may have stopped.', true);
    }, 4_000);
    pendingTouchAcksRef.current.set(gestureId, timeout);
    try {
      channel.send(JSON.stringify({ kind: 'touch', gestureId, sessionId: sessionRef.current, appPackageName: appPackage,
        gesture, from: { x: start.x, y: start.y }, to: { x: to.x, y: to.y }, durationMs }));
    } catch {
      window.clearTimeout(timeout);
      pendingTouchAcksRef.current.delete(gestureId);
      notify('The touch data channel rejected the gesture. Reconnect the stream before retrying.', true);
    }
  };
  const pointerCancel = (event: PointerEvent<HTMLDivElement>) => {
    if (pointerRef.current?.pointerId === event.pointerId) pointerRef.current = null;
  };

  const selectionOverlay = (() => {
    const video = videoRef.current;
    const surface = video?.parentElement;
    if (!selectionPreview || !video || !surface || video.videoWidth <= 0 || video.videoHeight <= 0) return null;
    const videoRect = getContainedVideoRect(video.getBoundingClientRect(), video.videoWidth, video.videoHeight);
    const surfaceRect = surface.getBoundingClientRect();
    return mapVideoSelectionToFrame(videoRect, surfaceRect, selectionPreview);
  })();

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
    <div className={'br-android-live-surface' + ((controlGranted || selectionMode) ? ' controllable' : '')}
      onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={pointerCancel}
      onContextMenu={event => event.preventDefault()}
      role={(controlGranted || selectionMode) ? 'application' : 'img'} aria-label={selectionMode ? 'Drag around one actual editable composer in the streamed app' : controlGranted ? 'Tap and swipe inside the streamed Android app' : 'Android app screen preview'}
      tabIndex={(controlGranted || selectionMode) ? 0 : -1}>
      <video ref={videoRef} autoPlay playsInline muted />
      {!viewReady ? <div className="br-android-live-placeholder"><MonitorPlay size={26}/>
        <b>{sessionId ? 'Waiting for the phone stream' : 'No app stream active'}</b>
        <span>Start sharing in Rub Minds Companion, then request this app here.</span>
      </div> : !sourceVisible ? <div className="br-android-live-placeholder">
        <Smartphone size={24}/><b>App window hidden on the phone</b>
        <span>Bring the selected app to the foreground on the phone. The picture and touch control resume when Android reports it visible.</span>
      </div> : null}
      {viewReady && selectionOverlay ? <div className="br-android-composer-selection" style={{
        left: selectionOverlay.left + '%',
        top: selectionOverlay.top + '%',
        width: selectionOverlay.width + '%',
        height: selectionOverlay.height + '%',
      }} aria-hidden="true"/> : null}
      {viewReady && selectionMode ? <div className="br-android-touch-hint"><Hand size={13}/> Drag around one composer</div> : viewReady && controlGranted ? <div className="br-android-touch-hint"><Hand size={13}/> Tap · swipe · long press</div> : null}
    </div>
    {sessionId ? <div className="br-android-keyboard">
      <div className="br-android-composer-head">
        <b>Original app composer</b>
        <span>{composerTargetId
          ? sendControlVerified
            ? providerConversationIdentityAvailable
              ? 'Composer + Send found · conversation identity detected'
              : 'Composer + Send found · native wake blocked'
            : 'Composer selected · draft only'
          : 'No target selected'}</span>
      </div>
      <div className="br-android-composer-actions">
        <button type="button" onClick={() => {
          if (selectionMode) { setSelectionMode(false); setSelectionPreview(null); }
          else { clearComposerTarget(); setSelectionMode(true); setRemoteTextStatus('Drag a rectangle around exactly one editable composer in the live phone app.'); }
        }} disabled={!viewReady || !sourceVisible || !dataReady || remoteTextBusy}>
          {selectionMode ? 'Cancel selection' : 'Drag-select typing area'}
        </button>
        {composerTargetId ? <button type="button" onClick={() => { clearComposerTarget(); setRemoteTextStatus('Composer target cleared. Select the exact field again before inserting text.'); }}>Clear target</button> : null}
        {composerTargetId && sendTargetRef.current ? <button type="button" onClick={recheckSendControl}
          disabled={!viewReady || !sourceVisible || !dataReady || remoteTextBusy || sendControlCheckPending}>
          {sendControlCheckPending ? 'Rechecking Send…' : 'Recheck Send control'}
        </button> : null}
      </div>
      <label htmlFor="br-android-remote-text">Draft for the selected composer</label>
      <textarea id="br-android-remote-text" value={remoteText} maxLength={4_000}
        onChange={event => setRemoteText(event.target.value)}
        placeholder={composerTargetId ? 'Type a draft for the selected field…' : 'Select the actual typing area in the streamed app first…'}
        rows={3} disabled={!viewReady || !sourceVisible || !dataReady || remoteTextBusy || !composerTargetId}/>
      <div className="br-android-keyboard-actions">
        <span>{remoteText.length.toLocaleString()}/4,000</span>
        <button type="button" onClick={sendRemoteText}
          disabled={!viewReady || !sourceVisible || !dataReady || remoteTextBusy || !composerTargetId || !remoteText.trim()}>
          {remoteTextBusy ? 'Inserting…' : 'Insert draft'}
        </button>
      </div>
      <p role="status">{remoteTextStatus}</p>
      <small>{sendControlVerified
        ? providerConversationIdentityAvailable
          ? 'The phone found one unique Send control and detected a provider-conversation identity locally. The digest stays on the phone. This is not permission to click Send: the trusted queue bridge, local wake consent and execution rechecks are still required. Labels and editor/message contents are never transmitted to Rub Minds.'
          : 'The phone found one unique Send control, but this app has no verified stable provider-conversation identity. Native autonomous Send is blocked for this app. Manual draft insertion remains available; the control is not permission to click it. Labels and editor/message contents are never transmitted to Rub Minds.'
        : 'Selection resolves to one editable, visible, non-password field in the selected foreground app. The phone checks nearby accessibility metadata locally for one Send control; ambiguous or missing controls stay draft-only. Labels and editor/message contents are never transmitted to Rub Minds.'}</small>
      <p className="br-android-stream-disclaimer">{sendControlStatus}</p>
    </div> : null}
    <div className="br-android-stream-actions">
      {!sessionId
        ? <button type="button" disabled={!channelReady || !device.apps.length || busy} onClick={() => void startView()}><MonitorPlay size={14}/> Start app view</button>
        : <>
          {!controlGranted
            ? <button type="button" disabled={!viewReady || !sourceVisible || !dataReady || busy} onClick={() => void sendDeviceCommand('request_control')}><Hand size={14}/> Request touch control</button>
            : <>
              <span className="br-android-control-grant"><ShieldCheck size={14}/> Touch enabled temporarily</span>
              <button type="button" disabled={!sourceVisible || !dataReady || busy} onClick={() => sendNavigationAction('back')}><ArrowLeft size={14}/> Back</button>
            </>}
          <button type="button" className="stop" disabled={busy} onClick={() => void sendDeviceCommand('stop_session')}><Power size={14}/> Stop session</button>
        </>}
    </div>
    <div className={'br-android-stream-status' + (messageError ? ' error' : '')} role="status">{message}</div>
    <p className="br-android-stream-disclaimer">
      Open this Backroom control page on a second device, such as your Windows laptop. The selected app must stay visible on the phone; showing Backroom on that same phone hides the shared app and pauses its picture. Choose the app window, not the whole display. Touch is a separate local 15-minute permission. This mirrors the real app; it is not an isolated virtual copy.
    </p>
  </section>;
}
