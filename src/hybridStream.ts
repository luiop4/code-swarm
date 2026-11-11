import * as vscode from 'vscode';
import { basename } from 'node:path';
import { Replay } from './core/model';
import { replay } from './core/planner';
import { planHybrid } from './core/hybridPlan';
import type { Point, Reply } from './nativeOverlay';
import { inputVisual, type InputChange } from './core/managedPlan';
import { visualColumns } from './core/hybridPlan';

type Geometry={x:number;y:number;pitch:number;dpi:number;width:number;height:number;start:number;end:number;charWidth:number;fontSize:number};
interface Bridge{document:()=>vscode.TextDocument;request:(m:object,progress?:(step:number)=>void)=>Promise<Reply>;send:(m:object)=>void;status:(text:string,tip:string)=>void}
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
const num=(v:unknown,fallback:number)=>typeof v==='number'&&Number.isFinite(v)?v:fallback;

/** Fixed cadence, bounded coalescing, and geometry independent of document versions. */
export class HybridStream implements vscode.Disposable{
  private geometry?:Geometry;
  private pending?:Replay;
  private pendingDisk?:Replay;
  private activeRecord?:Replay;
  private timer?:ReturnType<typeof setTimeout>;
  private busy=false;
  private disposed=false;
  private epoch=0;
  private lastChange=0;
  private lastBatch=0;
  private calibration?:Promise<Geometry|undefined>;
  private measuredAt=0;
  private nextProbeAt=0;
  private retries=0;
  private followLine?:number;
  private followPaused=false;
  private previousViewStart?:number;
  private autoScrollUntil=0;
  private autoScrollTarget?:number;
  private lastFollowAt=0;
  private sourceSnapshot:string;
  private contractionUntil=0;
  private controlSerial=0;
  readonly metrics={batches:0,diskBatches:0,calibrations:0,coalesced:0,appended:0,followScrolls:0,lastReason:'idle'};
  constructor(private readonly bridge:Bridge){this.sourceSnapshot=bridge.document().getText();}
  private editor(){const uri=this.bridge.document().uri.toString();return vscode.window.visibleTextEditors.find(e=>e.document.uri.toString()===uri);}
  noteChange(e:vscode.TextDocumentChangeEvent){
    this.lastChange=Date.now();
    const text=e.document.getText(),before=this.sourceSnapshot.replace(/\r\n/g,'\n').split('\n'),after=text.replace(/\r\n/g,'\n').split('\n');this.sourceSnapshot=text;
    let start=0,oldEnd=before.length,newEnd=after.length;
    while(start<oldEnd&&start<newEnd&&before[start]===after[start])start++;
    while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===after[newEnd-1]){oldEnd--;newEnd--;}
    const delta=after.length-before.length;if(delta<0)this.contractionUntil=Date.now()+250;
    if(newEnd>start)this.followLine=Math.min(e.document.lineCount-1,newEnd-1);
    // External reloads often report a whole-document replacement. Only move the
    // actual changed span; otherwise every append prematurely kills all cursors.
    if(this.geometry)this.bridge.send({type:'lineShift',start,end:Math.max(start,oldEnd-1),delta});
  }
  viewport(editor:vscode.TextEditor){
    const start=editor.visibleRanges[0]?.start.line??0,end=editor.visibleRanges.at(-1)?.end.line??start;
    const previousStart=this.previousViewStart;
    const ownScroll=Date.now()<this.autoScrollUntil&&this.autoScrollTarget!==undefined&&this.autoScrollTarget>=start&&this.autoScrollTarget<=end;
    if(this.previousViewStart!==undefined&&start<this.previousViewStart&&!ownScroll&&Date.now()>this.contractionUntil){this.pauseFollow();this.invalidate('manual');this.previousViewStart=start;return;}
    this.previousViewStart=start;
    // Growing the visible document's end is not a scroll. Do not repeatedly
    // cancel the very first measurement as a short file streams into existence.
    if(!this.geometry){if(previousStart!==undefined&&start!==previousStart)this.epoch++;return;}
    if(this.geometry&&(ownScroll||Date.now()-this.lastChange<700)){
      const dy=(this.geometry.start-start)*this.geometry.pitch;
      this.geometry.start=start;this.geometry.end=end;
      if(dy)this.bridge.send({type:'rebase',dy});
    }else this.invalidate();
  }
  manual(kind?:vscode.TextEditorSelectionChangeKind){
    if(kind===vscode.TextEditorSelectionChangeKind.Mouse||(kind===vscode.TextEditorSelectionChangeKind.Keyboard&&Date.now()-this.lastChange>150)){this.pauseFollow();this.invalidate('manual');}
  }
  private pauseFollow(){this.followPaused=true;this.bridge.status('$(debug-pause) Swarm · 跟随暂停','运行“Code Swarm: 继续跟随最新代码”恢复自动滚动。');}
  async resumeFollow(){this.followPaused=false;this.followLine=this.bridge.document().lineCount-1;const editor=this.editor();if(editor)await this.follow(editor);this.bridge.status('$(pulse) Swarm · 跟随已恢复','新生成的代码会自动进入视口；向上滚动或选择代码可暂停。');this.resume();}
  private async follow(editor:vscode.TextEditor){
    if(this.followPaused||this.followLine===undefined||!vscode.workspace.getConfiguration('codeSwarm').get('followStreaming',true)||!vscode.window.state.focused)return;
    let line=Math.max(0,Math.min(editor.document.lineCount-1,this.followLine));
    const ranges=editor.visibleRanges;
    if(ranges.some(r=>line>=r.start.line&&line<=r.end.line))return;
    const wait=320-(Date.now()-this.lastFollowAt);if(wait>0)await pause(wait);
    if(this.disposed||this.followPaused||!vscode.window.state.focused)return;
    line=Math.max(0,Math.min(editor.document.lineCount-1,this.followLine));this.lastFollowAt=Date.now();
    this.previousViewStart=ranges[0]?.start.line;
    this.autoScrollTarget=line;this.autoScrollUntil=Date.now()+500;
    editor.revealRange(new vscode.Range(line,0,line,0),vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    this.metrics.followScrolls++;
    // Scroll before calibration; incoming edits continue coalescing during this wait.
    await pause(55);
  }
  invalidate(reason='layout'){this.epoch++;this.geometry=undefined;this.nextProbeAt=0;this.pending=undefined;this.pendingDisk=undefined;clearTimeout(this.timer);this.timer=undefined;this.bridge.send({type:'clear',reason});}
  visibleChanged(){if(!this.editor())this.invalidate();else this.measuredAt=0;}
  async warm(){const editor=this.editor();if(editor&&vscode.window.state.focused)await this.ensureGeometry(editor);}
  private async ensureGeometry(editor:vscode.TextEditor,anchorLine?:number){
    if(editor.visibleRanges.length!==1||vscode.workspace.getConfiguration('editor',editor.document.uri).get('wordWrap','off')!=='off'){
      this.metrics.lastReason='complexLayout';this.bridge.status('$(circle-outline) Swarm · 等待平整视口','混合定位目前需要关闭自动换行，并展开当前可见区域的折叠代码。');return;
    }
    if(this.geometry&&(Date.now()<this.nextProbeAt||Date.now()-this.measuredAt<1500))return this.geometry;
    if(this.calibration)return this.calibration;
    const epoch=this.epoch;
    const previous=this.geometry;
    this.measuredAt=Date.now();
    this.nextProbeAt=this.measuredAt+1500;
    this.calibration=(async()=>{
      const version=editor.document.version;
      const viewStart=editor.visibleRanges[0]?.start.line??0,viewEnd=editor.visibleRanges.at(-1)?.end.line??viewStart;
      // Sticky headers can cover the viewport's first lines. Controlled input
      // measures its exact insertion line; observation uses an interior pair.
      const start=anchorLine??Math.min(viewStart+6,editor.document.lineCount-1,Math.max(viewStart,viewEnd-5));
      const pitchLine=anchorLine===undefined?Math.min(start+3,editor.document.lineCount-1,Math.max(start,viewEnd-(editor.document.lineCount<=4?0:2))):start;
      const specs=[{id:'origin',line:start,color:0x22ff77}];if(pitchLine>start)specs.push({id:'pitch',line:pitchLine,color:0x22ff77});
      const marker=vscode.window.createTextEditorDecorationType({before:{contentText:'█',color:'#22ff77',width:'0px',height:'0px',fontWeight:'900'},rangeBehavior:vscode.DecorationRangeBehavior.OpenOpen});
      try{
        editor.setDecorations(marker,specs.map(s=>new vscode.Range(s.line,0,s.line,0)));await pause(140);
        if(this.disposed||epoch!==this.epoch)return;
        this.metrics.calibrations++;
        const font=vscode.workspace.getConfiguration('editor',editor.document.uri).get<number>('fontSize',14);
        const zoom=Math.pow(1.2,vscode.workspace.getConfiguration('window').get<number>('zoomLevel',0));
        const result=await this.bridge.request({type:'probe',file:basename(editor.document.uri.path),markers:specs,reset:true,preserve:true,fontSize:font*zoom});
        if(this.disposed||epoch!==this.epoch)return;
        const point=result.points?.find(p=>p.id==='origin');
        if(!point){this.metrics.lastReason=result.reason??'calibration';if(previous)return previous;this.bridge.status('$(circle-outline) Swarm · 等待定位','代码可见时重播；混合模式将重试定位。');return;}
        const dpi=num(result.dpi,1),height=vscode.workspace.getConfiguration('editor',editor.document.uri).get<number>('lineHeight',0);
        const measured=result.points?.find(p=>p.id==='pitch');
        const expected=(height===0?font*1.5:height<8?font*height:height)*zoom*dpi;
        const pitch=measured?(measured.y-point.y)/(pitchLine-start):expected;
        if(pitch<8||pitch>100||Math.abs(pitch-expected)>Math.max(2,expected*.1)){this.metrics.lastReason='cachedLayout';return previous;}
        const moving=previous&&version!==editor.document.version;
        const current=editor.visibleRanges;
        const currentStart=current[0]?.start.line??viewStart;
        this.geometry={x:point.x,y:moving?previous.y:point.y-(start-currentStart)*pitch,pitch:moving?previous.pitch:pitch,dpi,width:num(result.width,1),height:num(result.height,1),start:currentStart,end:current.at(-1)?.end.line??start,charWidth:font*.6*zoom*dpi,fontSize:font*zoom*dpi};
        this.measuredAt=Date.now();
        if(previous){
          const dx=this.geometry.x-previous.x,dy=this.geometry.y-previous.y+(previous.start-this.geometry.start)*pitch;
          if(Math.abs(previous.pitch-pitch)>.5)this.bridge.send({type:'clear'});
          else if(dx||dy)this.bridge.send({type:'rebase',dx,dy});
        }
        return this.geometry;
      }finally{marker.dispose();}
    })();
    try{return await this.calibration;}finally{this.calibration=undefined;}
  }
  private merge(a:Replay,b:Replay){this.metrics.coalesced++;return replay({...b,before:a.before});}
  submit(record:Replay){
    if(record.tasks.length)this.followLine=Math.min(this.bridge.document().lineCount-1,Math.max(...record.tasks.map(t=>t.toLine+Math.max(0,t.newLines.length-1))));
    this.pending=this.pending?this.merge(this.pending,record):record;
    this.retries=0;this.schedule();
  }
  submitDisk(record:Replay){this.pendingDisk=this.pendingDisk?this.merge(this.pendingDisk,record):record;this.schedule();}
  private schedule(delay=16){if(!this.timer&&!this.busy&&!this.disposed){this.timer=setTimeout(()=>{this.timer=undefined;void this.drain();},delay);}}
  private async drain(){
    if(this.busy||this.disposed||(!this.pending&&!this.pendingDisk))return;
    const editor=this.editor();if(!editor||!vscode.window.state.focused){this.metrics.lastReason='notVisible';return;}
    const preview=!this.pending,record=(this.pending??this.pendingDisk)!;
    if(preview)this.pendingDisk=undefined;else this.pending=undefined;
    this.activeRecord=record;this.busy=true;
    try{
      const okay=await this.dispatch(record,true,preview);
      const active=this.activeRecord??record;
      if(!okay&&this.retries++<2){if(preview)this.pendingDisk=this.pendingDisk?this.merge(active,this.pendingDisk):active;else this.pending=this.pending?this.merge(active,this.pending):active;}
      // If generation ended during the scroll wait, finish following its final
      // line even when no later document event will arrive to wake the queue.
      if(okay&&!preview&&!this.pending&&!this.followPaused&&this.followLine!==undefined&&vscode.workspace.getConfiguration('codeSwarm').get('followStreaming',true)&&!editor.visibleRanges.some(r=>this.followLine!>=r.start.line&&this.followLine!<=r.end.line))this.pending=active;
    }catch{this.metrics.lastReason='renderError';}
    finally{this.activeRecord=undefined;this.busy=false;if(this.pending||this.pendingDisk)this.schedule(16);}
  }
  async play(record:Replay){return await this.dispatch(record,false);}
  async perform(change:InputChange,visual:'mixed'|'edit'|'erase',steps:number,progress:(step:number)=>void){
    const editor=this.editor();if(!editor||!vscode.window.state.focused)return {type:'notVisible'} as Reply;
    const position=editor.document.positionAt(change.offset),start=editor.visibleRanges[0]?.start.line??0,end=editor.visibleRanges.at(-1)?.end.line??start;
    const text=(change.kind==='delete'?change.oldText:change.text).slice(0,1400),parts=text.split(/\r?\n/).slice(0,36);
    if(position.line<start||position.line+parts.length>end-1){
      this.autoScrollTarget=position.line;this.autoScrollUntil=Date.now()+500;
      editor.revealRange(new vscode.Range(position,position),vscode.TextEditorRevealType.InCenter);await pause(65);
    }
    let g:Geometry|undefined;
    for(let attempt=0;attempt<3;attempt++){
      const epoch=this.epoch;g=await this.ensureGeometry(editor,position.line);
      if(g&&epoch===this.epoch)break;g=undefined;await pause(50);
    }
    if(!g)return {type:'layoutRequired'} as Reply;
    const first=editor.visibleRanges[0]?.start.line??g.start;g.start=first;
    const points:Point[]=[];
    const point=(line:number)=>{const id=`m${line}`;if(!points.some(p=>p.id===id))points.push({id,x:g.x,y:g.y+(line-first)*g.pitch,height:g.fontSize});return id;};
    let offset=0;const prefix=editor.document.lineAt(position.line).text.slice(0,position.character),serial=++this.controlSerial,hasText=parts.some(p=>p.trim());
    const tasks=parts.map((line,i)=>{
      const column=i===0?visualColumns(prefix):0;
      const task={line:position.line+i,anchor:point(position.line+i),column,text:line||'↵',oldText:line,kind:change.kind,visual:visual==='mixed'?inputVisual(position.line+i):visual,key:`controlled:${serial}:${i}`,begin:0,span:1,width:Math.max(g.charWidth,Math.min(600,visualColumns(line)*g.charWidth)),height:g.pitch};
      offset+=line.length+(text.includes('\r\n')?2:1);return task;
    }).filter((_task,i)=>parts[i].trim()||!hasText&&i===0);
    const topAnchor=point(first),last=Math.min(first+Math.max(12,Math.floor((g.height-g.y-100)/g.pitch)),first+35),bottomAnchor=point(last);
    return await this.bridge.request({type:'perform',preview:true,style:'hybrid',tasks,points,width:g.width,height:g.height,dpi:g.dpi,lineHeight:g.pitch,fontSize:g.fontSize,charWidth:g.charWidth,topAnchor,bottomAnchor,
      steps,duration:visual==='mixed'?.52:.4,workers:32,pointerSize:vscode.workspace.getConfiguration('codeSwarm').get('pointerSize',12),speed:4},progress);
  }
  resume(){if(this.pending||this.pendingDisk)this.schedule();}
  private async dispatch(record:Replay,append:boolean,preview=false){
    const editor=this.editor();if(!editor||!vscode.window.state.focused)return false;
    if(preview&&(editor.document.isDirty||editor.document.getText()===record.after))return true;
    // Establish geometry while the viewport is still stationary. Otherwise each
    // fast follow-scroll can invalidate the initial calibration before it ends.
    if(append&&!this.geometry&&!(await this.ensureGeometry(editor)))return false;
    if(append&&!preview)await this.follow(editor);
    // Include edits received during scrolling so the batch covers the viewport
    // we just revealed, rather than playing only an older offscreen snapshot.
    if(append&&!preview&&this.pending){record=this.merge(record,this.pending);this.pending=undefined;this.activeRecord=record;}
    if(preview&&this.pendingDisk){record=this.merge(record,this.pendingDisk);this.pendingDisk=undefined;this.activeRecord=record;}
    const epoch=this.epoch,g=await this.ensureGeometry(editor);
    if(!g||epoch!==this.epoch||this.disposed)return false;
    const current=editor.visibleRanges,start=current[0]?.start.line??g.start,end=current.at(-1)?.end.line??g.end;
    g.start=start;g.end=end;
    const now=Date.now(),streaming=preview||(append&&now-this.lastBatch<700);
    const visible=(line:number)=>line>=start&&line<=end&&line<editor.document.lineCount;
    const actions=preview?planHybrid(record,()=>true,true).slice(-18):planHybrid(record,visible,streaming);if(!preview)this.lastBatch=now;
    if(!actions.length){this.metrics.lastReason='offscreen';return true;}
    const points=new Map<string,Point>();
    const point=(line:number)=>{const id=`l${line}`;points.set(id,{id,x:g.x,y:g.y+(line-start)*g.pitch,height:g.fontSize});return id;};
    const rows=preview?Math.max(8,Math.min(24,Math.floor((g.height-g.y-120)/g.pitch))):Math.max(1,end-start-2);
    const topAnchor=point(start),bottomAnchor=point(preview?start+rows-1:Math.max(start,end-2));
    const tasks=actions.map((a,index)=>{
      const anchor=preview?start+Math.min(rows,1+(index*7)%rows):a.toLine;
      return {...a,incoming:preview,line:a.toLine,anchor:point(anchor),fromAnchor:!preview&&visible(a.fromLine)?point(a.fromLine):'',width:Math.max(24,Math.min(600,Array.from(a.text).length*g.charWidth)),height:g.pitch,key:`${preview?'incoming:':''}${a.visual}:${a.toLine}:${a.visual==='card'?a.column+':'+a.text:''}`};
    });
    const result=await this.bridge.request({type:append?'append':'play',preview,style:'hybrid',file:basename(editor.document.uri.path),tasks,points:[...points.values()],width:g.width,height:g.height,dpi:g.dpi,lineHeight:g.pitch,fontSize:g.fontSize,charWidth:g.charWidth,topAnchor,bottomAnchor,
      workers:vscode.workspace.getConfiguration('codeSwarm').get('cursorCount',32),pointerSize:vscode.workspace.getConfiguration('codeSwarm').get('pointerSize',12),speed:vscode.workspace.getConfiguration('codeSwarm').get('cardSpeed',4)});
    if(epoch!==this.epoch||this.disposed)return false;
    if(result.type==='layoutRequired'){this.geometry=undefined;this.metrics.lastReason='layout';return false;}
    if(!['playing','appended'].includes(result.type)){this.metrics.lastReason=result.type;return false;}
    this.metrics.batches++;if(append)this.metrics.appended++;
    if(preview)this.metrics.diskBatches++;
    this.metrics.lastReason='rendering';
    const kinds=[...new Set(actions.map(a=>({type:'输入',edit:'替换',erase:'擦除',card:'搬运',outline:'绘制',stamp:'复制',trace:'描摹'}[a.visual])))].join(' / ');
    if(!this.followPaused)this.bridge.status('$(pulse) Swarm · 混合动画',`${actions.length} 个任务 · ${kinds}；持续追赶并跟随最新代码。`);
    return true;
  }
  diagnostics(){return {...this.metrics,followPaused:this.followPaused,followLine:this.followLine,cachedGeometry:Boolean(this.geometry),origin:this.geometry?{x:this.geometry.x,y:this.geometry.y,pitch:this.geometry.pitch}:undefined,queued:Boolean(this.pending||this.pendingDisk),busy:this.busy};}
  dispose(){this.disposed=true;clearTimeout(this.timer);this.pending=undefined;this.pendingDisk=undefined;this.geometry=undefined;this.epoch++;}
}
