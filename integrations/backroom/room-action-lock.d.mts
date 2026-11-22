export interface RoomActionLocks {
  /** Acquire the lock for one group; false means that group's action is already pending. */
  begin(roomId: string): boolean;
  /** Release the lock for one group. Returns false if no lock was held. */
  end(roomId: string): boolean;
  /** Whether a mutation is currently pending for this group. */
  isBusy(roomId: string): boolean;
  /** Snapshot the set of currently locked group IDs. */
  snapshot(): Set<string>;
}

export function createRoomActionLocks(): RoomActionLocks;
