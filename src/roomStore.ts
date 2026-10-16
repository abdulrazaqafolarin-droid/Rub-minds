/** Browser-only prototype. No secrets or private data should be stored here. */
export type Message = { id: string; roomId: string; sender: string; role: 'human' | 'agent' | 'system'; text: string; createdAt: string };
export type Room = { id: string; title: string; objective: string; createdAt: string; messages: Message[] };
const KEY = 'rub-minds-demo-v1';
const listeners = new Set<() => void>();
const channel = typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(KEY) : null;
if (channel) channel.onmessage = () => listeners.forEach(fn => fn());
if (typeof window !== 'undefined') window.addEventListener('storage', e => { if (e.key === KEY) listeners.forEach(fn => fn()); });
export function subscribe(fn: () => void) { listeners.add(fn); return () => { listeners.delete(fn); }; }
export function getRooms(): Room[] { try { return JSON.parse(localStorage.getItem(KEY) || '[]') as Room[]; } catch { return []; } }
function save(rooms: Room[]) { localStorage.setItem(KEY, JSON.stringify(rooms)); listeners.forEach(fn => fn()); channel?.postMessage('changed'); }
export function createRoom(title: string, objective: string): Room {
  const room: Room = { id: crypto.randomUUID(), title: title.trim(), objective: objective.trim(), createdAt: new Date().toISOString(), messages: [] };
  save([room, ...getRooms()]); return room;
}
export function sendMessage(roomId: string, sender: string, role: Message['role'], text: string): Message | null {
  if (!text.trim()) return null;
  const rooms = getRooms(); const room = rooms.find(r => r.id === roomId); if (!room) return null;
  const message: Message = { id: crypto.randomUUID(), roomId, sender, role, text: text.trim(), createdAt: new Date().toISOString() };
  room.messages.push(message); save(rooms); return message;
}
export function getRoom(id: string) { return getRooms().find(r => r.id === id); }
export function inviteUrl(id: string) { return new URL('/?room=' + encodeURIComponent(id), location.origin).toString(); }
