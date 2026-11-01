const finite = value => typeof value === 'number' && Number.isFinite(value);

export function getContainedVideoRect(box, videoWidth, videoHeight) {
  if (!box || ![box.left, box.top, box.width, box.height, videoWidth, videoHeight].every(finite) ||
      box.width <= 0 || box.height <= 0 || videoWidth <= 0 || videoHeight <= 0) {
    return null;
  }
  const scale = Math.min(box.width / videoWidth, box.height / videoHeight);
  const width = videoWidth * scale;
  const height = videoHeight * scale;
  return Object.freeze({
    left: box.left + (box.width - width) / 2,
    top: box.top + (box.height - height) / 2,
    width,
    height,
  });
}

export function mapVideoSelectionToFrame(videoRect, frameRect, selection) {
  if (!videoRect || !frameRect || !selection) return null;
  const values = [
    videoRect.left, videoRect.top, videoRect.width, videoRect.height,
    frameRect.left, frameRect.top, frameRect.width, frameRect.height,
    selection.x, selection.y, selection.width, selection.height,
  ];
  if (!values.every(finite) || videoRect.width <= 0 || videoRect.height <= 0 ||
      frameRect.width <= 0 || frameRect.height <= 0 ||
      selection.x < 0 || selection.y < 0 ||
      selection.width <= 0 || selection.height <= 0 ||
      selection.x + selection.width > 1 || selection.y + selection.height > 1) {
    return null;
  }
  return Object.freeze({
    left: ((videoRect.left - frameRect.left + selection.x * videoRect.width) / frameRect.width) * 100,
    top: ((videoRect.top - frameRect.top + selection.y * videoRect.height) / frameRect.height) * 100,
    width: (selection.width * videoRect.width / frameRect.width) * 100,
    height: (selection.height * videoRect.height / frameRect.height) * 100,
  });
}


/** Convert a pointer position to normalized coordinates in the actual video content. */
export function normalizeClientPointToVideo(rect, clientX, clientY) {
  if (!rect || ![rect.left, rect.top, rect.width, rect.height, clientX, clientY].every(finite) ||
      rect.width <= 0 || rect.height <= 0) {
    return null;
  }
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x < 0 || x > 1 || y < 0 || y > 1) return null;
  return Object.freeze({ x, y });
}

/** Build a normalized drag rectangle; invalid, tiny or out-of-video drags fail closed. */
export function createNormalizedDragSelection(start, end, minSize = 0.01) {
  if (!start || !end ||
      ![start.x, start.y, end.x, end.y, minSize].every(finite) ||
      minSize <= 0 ||
      [start.x, start.y, end.x, end.y].some(value => value < 0 || value > 1)) {
    return null;
  }
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const width = Math.abs(end.x - start.x);
  const height = Math.abs(end.y - start.y);
  if (width < minSize || height < minSize) return null;
  return Object.freeze({ x, y, width, height });
}
