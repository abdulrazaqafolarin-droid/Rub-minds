export type IceGatheringPeer = Pick<
  RTCPeerConnection,
  'iceGatheringState' | 'addEventListener' | 'removeEventListener'
>;
export function waitForIceGatheringComplete(
  peer: IceGatheringPeer,
  options?: { timeoutMs?: number }
): Promise<void>;
