import test from "node:test";
import assert from "node:assert/strict";
import {mapDragToDisplay} from "./selection-geometry.mjs";
const base={
 start:{x:80,y:80},end:{x:30,y:20},
 viewport:{x:0,y:0,width:100,height:100},
 display:{x:0,y:0,width:1080,height:1920,totalWidth:1080,totalHeight:1920},
};
test("reverse drag calibrated on Android portrait pixels",()=>{
 assert.deepEqual(mapDragToDisplay(base),{x:324,y:384,width:540,height:1152,displayWidth:1080,displayHeight:1920});
});
test("desktop subwindow offsets are preserved",()=>{
 const r=mapDragToDisplay({...base,viewport:{x:20,y:10,width:100,height:100},
 display:{x:200,y:100,width:500,height:300,totalWidth:1920,totalHeight:1080}});
 assert.deepEqual(r,{x:250,y:130,width:250,height:180,displayWidth:1920,displayHeight:1080});
});
test("reject out-of-bounds drags and stale display geometry",()=>{
 assert.throws(()=>mapDragToDisplay({...base,start:{x:-1,y:0}}),/outside selected viewport/);
 assert.throws(()=>mapDragToDisplay({...base,display:{...base.display,x:900}}),/outside native bounds/);
});
test("reject tiny drags and invalid numeric calibration",()=>{
 assert.throws(()=>mapDragToDisplay({...base,start:{x:1,y:1},end:{x:1.2,y:1.3}}),/too small/);
 assert.throws(()=>mapDragToDisplay({...base,end:{x:NaN,y:20}}),/invalid calibration/);
});
test("screen selection is independent from browser-specific locator semantics",()=>{
 const r=mapDragToDisplay({...base,display:{x:0,y:0,width:1920,height:1080,totalWidth:1920,totalHeight:1080}});
 assert.equal(r.displayWidth,1920);
 assert.equal(r.height,648);
});
