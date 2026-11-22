/**
 * In-memory per-group action locks for Backroom device mutations.
 * These coordinate one authenticated Backroom workspace only; server-side
 * owner checks remain authoritative for every pairing, approval and revocation.
 */
export function createRoomActionLocks() {
  const activeRooms = new Set();

  return Object.freeze({
    begin(roomId) {
      if (typeof roomId !== "string" || !roomId.trim()) {
        throw new TypeError("roomId must be a non-empty string");
      }
      if (activeRooms.has(roomId)) return false;
      activeRooms.add(roomId);
      return true;
    },
    end(roomId) {
      return activeRooms.delete(roomId);
    },
    isBusy(roomId) {
      return activeRooms.has(roomId);
    },
    snapshot() {
      return new Set(activeRooms);
    },
  });
}
