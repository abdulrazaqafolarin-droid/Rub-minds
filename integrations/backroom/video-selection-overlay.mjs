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
