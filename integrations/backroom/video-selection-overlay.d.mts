/** Type declarations for the validated, framework-independent video selection geometry helpers. */
export interface Rect { left: number; top: number; width: number; height: number }
export interface Point { x: number; y: number }
export interface Selection extends Point { width: number; height: number }
export function getContainedVideoRect(box: Rect, videoWidth: number, videoHeight: number): Readonly<Rect> | null;
export function mapVideoSelectionToFrame(videoRect: Rect | null, frameRect: Rect | null, selection: Selection | null): Readonly<Rect> | null;
export function normalizeClientPointToVideo(rect: Rect | null, clientX: number, clientY: number): Readonly<Point> | null;
export function createNormalizedDragSelection(start: Point | null, end: Point | null, minSize?: number): Readonly<Selection> | null;
