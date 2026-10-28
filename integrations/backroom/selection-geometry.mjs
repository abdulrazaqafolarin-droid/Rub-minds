/**
 * Universal drag-to-select geometry. The adapter supplies an already-calibrated
 * viewport-to-display affine mapping; this module never guesses OS coordinates.
 *
 * viewport bounds are CSS-independent logical units; display dimensions are
 * native orientation-current pixel units. Rotation must be resolved by the host.
 */
const finite=n=>typeof n==="number" && Number.isFinite(n);
export function mapDragToDisplay({start,end,viewport,display,minSize=8}) {
  if(!start||!end||!viewport||!display)throw new TypeError("selection calibration required");
  const nums=[start.x,start.y,end.x,end.y,viewport.x,viewport.y,
    viewport.width,viewport.height,display.x,display.y,display.width,display.height,
    display.totalWidth,display.totalHeight,minSize];
  if(!nums.every(finite)||viewport.width<=0||viewport.height<=0||
     display.width<=0||display.height<=0||display.totalWidth<=0||display.totalHeight<=0||minSize<=0)throw new TypeError("invalid calibration");
  if(display.x<0||display.y<0||display.x+display.width>display.totalWidth||
     display.y+display.height>display.totalHeight)throw new RangeError("display calibration outside native bounds");
  const minX=Math.min(start.x,end.x),maxX=Math.max(start.x,end.x);
  const minY=Math.min(start.y,end.y),maxY=Math.max(start.y,end.y);
  if(minX<viewport.x||minY<viewport.y||maxX>viewport.x+viewport.width||
     maxY>viewport.y+viewport.height)throw new RangeError("drag outside selected viewport");
  const scaleX=display.width/viewport.width,scaleY=display.height/viewport.height;
  const raw={
    x:display.x+(minX-viewport.x)*scaleX,
    y:display.y+(minY-viewport.y)*scaleY,
    width:(maxX-minX)*scaleX,
    height:(maxY-minY)*scaleY,
  };
  if(raw.width<minSize||raw.height<minSize)throw new RangeError("selection too small");
  const x=Math.max(0,Math.floor(raw.x)),y=Math.max(0,Math.floor(raw.y));
  const right=Math.min(display.totalWidth,Math.ceil(raw.x+raw.width));
  const bottom=Math.min(display.totalHeight,Math.ceil(raw.y+raw.height));
  return Object.freeze({x,y,width:right-x,height:bottom-y,displayWidth:display.totalWidth,displayHeight:display.totalHeight});
}
