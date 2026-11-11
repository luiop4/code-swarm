import * as vscode from 'vscode';
import { spawn, ChildProcessWithoutNullStreams } from 'node:child_process';
import { createInterface } from 'node:readline';
import { basename, dirname } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { Replay, SwarmTask } from './core/model';
import { planFloatingCards } from './core/cardPlan';
import { HybridStream } from './hybridStream';
import { DiskStream } from './diskStream';
import { replay } from './core/planner';
import type { InputChange } from './core/managedPlan';

export type Point = { id: string; x: number; y: number; height: number };
export type Reply = { type: string; requestId?: string; points?: Point[]; reason?: string; [key: string]: unknown };
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** A display-only native process. File edits never cross this boundary. */
export class NativeOverlay implements vscode.Disposable {
  private child?: ChildProcessWithoutNullStreams;
  private readonly listeners: vscode.Disposable[] = [];
  private readonly pending = new Map<string, { resolve: (value: Reply) => void; timer: ReturnType<typeof setTimeout>;progress?:(step:number)=>void }>();
  private markers: vscode.TextEditorDecorationType[] = [];
  private generation = 0;
  private serial = 0;
  private disposed = false;
  private lastReply: Reply = { type: 'idle', visiblePointers: 0 };
  private lastProbe = { requested: 0, found: 0, reason: '' };
  private lastDiagnostic: Reply | undefined;
  private conflictNotified=false;
  private readonly hybrid: HybridStream;
  private disk?:DiskStream;
  private controlled=false;
  private isHybrid(){return this.controlled||vscode.workspace.getConfiguration('codeSwarm').get('animationStyle','hybrid')==='hybrid';}
  get document(){return vscode.workspace.textDocuments.find(d=>d.uri.toString()===this.original.uri.toString()&&!d.isClosed)??this.original;}
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80);

  constructor(private readonly context: vscode.ExtensionContext, private readonly original: vscode.TextDocument) {
    const document=original, matches=(doc:vscode.TextDocument)=>doc.uri.toString()===original.uri.toString();
    this.hybrid=new HybridStream({document:()=>this.document,request:(m,p)=>this.request(m,p),send:m=>this.send(m),status:(text,tip)=>{this.status.text=text;this.status.tooltip=tip;this.status.command=text.includes('跟随暂停')?'codeSwarm.resumeFollow':'codeSwarm.overlayReplay';}});
    this.status.command = 'codeSwarm.overlayReplay';
    this.status.text = '$(pulse) Swarm · 原生覆盖';
    this.status.tooltip = '正在监听此文件。点击重播最近一次变化；空闲鼠标自动隐藏。';
    this.listeners.push(vscode.window.onDidChangeTextEditorVisibleRanges(e => { if(matches(e.textEditor.document)){if(this.isHybrid())this.hybrid.viewport(e.textEditor);else this.cancel();} }));
    this.listeners.push(vscode.window.onDidChangeActiveTextEditor(() => {if(this.isHybrid()){this.hybrid.visibleChanged();this.hybrid.resume();}else this.cancel();}));
    this.listeners.push(vscode.window.onDidChangeVisibleTextEditors(()=>{if(this.isHybrid()){this.hybrid.visibleChanged();this.hybrid.resume();}}));
    this.listeners.push(vscode.window.onDidChangeWindowState(e => { this.cancel(e.focused?'layout':'notForeground'); this.send({type:e.focused?'resume':'suspend'});if(e.focused&&this.isHybrid())void this.hybrid.warm(); }));
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(e => { if(matches(e.document) && e.contentChanges.length){if(this.isHybrid())this.hybrid.noteChange(e);else this.floatScene();} }));
    this.listeners.push(vscode.window.onDidChangeTextEditorSelection(e=>{
      if(matches(e.textEditor.document)){if(this.isHybrid())this.hybrid.manual(e.kind);else if(e.kind===vscode.TextEditorSelectionChangeKind.Keyboard||e.kind===vscode.TextEditorSelectionChangeKind.Mouse)this.cancel();}
    }));
    this.listeners.push(vscode.workspace.onDidChangeConfiguration(e => { if(e.affectsConfiguration('editor')||e.affectsConfiguration('window.zoomLevel')||e.affectsConfiguration('codeSwarm.animationStyle'))this.cancel(); }));
    if(document.uri.scheme==='file'){
      const watcher=vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(dirname(document.uri.fsPath),basename(document.uri.fsPath)));
      this.listeners.push(watcher,watcher.onDidChange(()=>void this.checkDiskConflict()));
    }
  }
  async start() {
    if(process.platform !== 'win32')throw new Error('原生透明覆盖目前支持 Windows；其他系统可使用回放舞台。');
    if(!vscode.workspace.isTrusted)throw new Error('工作区未受信任，当前不能启动原生覆盖程序。');
    const exe = vscode.Uri.joinPath(this.context.extensionUri,'dist','native','CodeSwarmOverlay.exe').fsPath;
    const inspect=this.context.extensionMode!==vscode.ExtensionMode.Production&&process.env.SWARM_INSPECT_NATIVE==='1';
    const child = spawn(exe, inspect?['--inspect']:[], {windowsHide:true,stdio:['pipe','pipe','pipe']});
    this.child=child;
    child.stdin.on('error',()=>{});
    const lines=createInterface({input:child.stdout});
    const ready=new Promise<void>((resolve,reject)=>{
      const timer=setTimeout(()=>reject(new Error('覆盖程序启动超时。')),6000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});
      child.once('exit',()=>{clearTimeout(timer);reject(new Error('覆盖程序已退出。'));});
      lines.on('line',line=>{
        try{
          const value=JSON.parse(line.replace(/^\uFEFF/,'')) as Reply;
          this.lastReply=value;
          if(value.type==='probeDiagnostic')this.lastDiagnostic=value;
          if(value.type==='invalidated')this.hybrid.invalidate();
          if(value.type==='ready'){clearTimeout(timer);resolve();}
          if(value.type==='actProgress'&&typeof value.ticket==='string'&&Number.isInteger(value.step))this.pending.get(value.ticket)?.progress?.(Number(value.step));
          if(value.requestId){const item=this.pending.get(value.requestId);if(item){clearTimeout(item.timer);this.pending.delete(value.requestId);item.resolve(value);}}
        }catch{}
      });
    });
    child.on('exit',()=>{if(!this.disposed){this.cancel();this.status.text='$(circle-slash) Swarm · 已停止';}});
    child.stderr.on('data',()=>{}); // No code contents or machine paths logged to UI.
    await ready;
    this.status.show();
    if(this.isHybrid())void this.hybrid.warm();
    if(this.document.uri.scheme==='file'){
      this.disk=new DiskStream(this.document.uri.fsPath,(before,after)=>{
        if(this.controlled||!this.isHybrid()||this.document.isDirty||after===this.document.getText())return;
        this.hybrid.submitDisk(replay({before,after,file:basename(this.document.uri.path),label:'正在接收代码',source:'observed',attribution:'Disk stream'}));
      });
      await this.disk.start();
    }
  }
  private send(message: object) { if(!this.disposed&&this.child?.stdin.writable)this.child.stdin.write(JSON.stringify(message)+'\n'); }
  private request(message: object,progress?:(step:number)=>void): Promise<Reply> {
    const requestId=String(++this.serial);
    return new Promise(resolve=>{
      const timer=setTimeout(()=>{this.pending.delete(requestId);resolve({type:'timeout',requestId});},2500);
      this.pending.set(requestId,{resolve,timer,progress});this.send({...message,requestId});
    });
  }
  private clearMarkers() { for(const m of this.markers)m.dispose();this.markers=[]; }
  cancel(reason='layout') { this.generation++;this.clearMarkers();this.hybrid.invalidate(reason); }
  private floatScene(){this.generation++;this.clearMarkers();this.send({type:vscode.workspace.getConfiguration('codeSwarm').get('animationStyle','cards')==='cards'?'float':'clear'});}
  private async checkDiskConflict(){
    await pause(250);
    if(this.disposed||this.document.isClosed||!this.document.isDirty)return;
    try{
      const bytes=await vscode.workspace.fs.readFile(this.document.uri);
      if(bytes.length>500000)return;
      const disk=Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/,'');
      if(disk.includes('\0')||disk===this.document.getText())return;
      this.cancel();this.status.text='$(warning) Swarm · 外部修改待合并';
      this.status.tooltip='编辑器含未保存内容，磁盘上另有修改。先解决版本差异，回放才能跟随当前文件；不会自动覆盖编辑器。';
      if(!this.conflictNotified){this.conflictNotified=true;void vscode.window.showInformationMessage('Code Swarm: 检测到磁盘修改，但编辑器有未保存内容。当前没有自动载入新代码，请先合并或保存后再回放。');}
    }catch{}
  }

  async play(record: Replay, styleOverride?:'cards'|'cues'|'hybrid') {
    if(this.controlled)return;
    const selected=styleOverride??vscode.workspace.getConfiguration('codeSwarm').get('animationStyle','hybrid');
    if(selected==='hybrid'){
      if(record.source==='proposal'&&this.document.getText()!==record.after)return;
      if(record.source==='demo')await this.hybrid.play(record);else this.hybrid.submit(record);
      return;
    }
    this.floatScene();const generation=this.generation;
    const editor=vscode.window.visibleTextEditors.find(e=>e.document.uri.toString()===this.document.uri.toString());
    if(!editor||editor.document!==this.document||!vscode.window.state.focused||!record.tasks.length)return;
    if(this.document.getText()!==record.after)return;
    const version=this.document.version;
    const visible=(line:number)=>line>=0&&line<this.document.lineCount&&editor.visibleRanges.some(r=>line>=r.start.line&&line<Math.max(r.start.line+1,r.end.line-1));
    const style=selected;
    const cardPlan=planFloatingCards(record,visible);
    const tasks=style==='cards'?cardPlan.cards:record.tasks.filter(t=>visible(Math.min(t.toLine,this.document.lineCount-1))).slice(0,50);
    if(!tasks.length)return;
    const positions=new Map<number,string>();
    const specs:{id:string;color:number;line:number}[]=[];
    const addPosition=(line:number)=>{
      line=Math.max(0,Math.min(this.document.lineCount-1,line));
      if(!visible(line)||positions.size>=60)return '';
      if(positions.has(line))return positions.get(line)!;
      const i=positions.size,id=`p${i}`;
      // A saturated rectangular marker; source text, selection and layout stay unchanged.
      const color=0x22ff77;
      positions.set(line,id);specs.push({id,color,line});return id;
    };
    const mapped=tasks.map(t=>({task:t,anchor:addPosition(t.toLine),fromAnchor:t.kind==='move'?addPosition(t.fromLine):''}));
    const first=tasks[0].toLine;addPosition(first+3);
    const viewStart=editor.visibleRanges[0]?.start.line??first;
    const viewEnd=Math.max(viewStart,(editor.visibleRanges.at(-1)?.end.line??first)-2);
    const topAnchor=addPosition(viewStart),bottomAnchor=addPosition(viewEnd);
    try{
      // Adjacent full-block markers can touch at larger font sizes. Measure them in
      // separate passes instead of guessing how to split a connected rectangle.
      const batches:typeof specs[]=[];
      for(const spec of specs.sort((a,b)=>a.line-b.line)){
        let batch=batches.find(b=>spec.line-b[b.length-1].line>=2);
        if(!batch){batch=[];batches.push(batch);}batch.push(spec);
      }
      let result:Reply={type:'anchors',points:[]};
      for(let index=0;index<batches.length;index++){
        const batch=batches[index];
        const marker=vscode.window.createTextEditorDecorationType({before:{contentText:'█',color:'#22ff77',width:'0px',height:'0px',fontWeight:'900'},rangeBehavior:vscode.DecorationRangeBehavior.ClosedClosed});
        this.markers.push(marker);editor.setDecorations(marker,batch.map(s=>new vscode.Range(s.line,0,s.line,0)));
        await pause(180);
        if(generation!==this.generation||this.disposed||version!==this.document.version)return;
        result=await this.request({type:'probe',file:basename(this.document.uri.path),markers:batch,reset:index===0,preserve:true});
        if(generation!==this.generation||this.disposed||version!==this.document.version)return;
        this.clearMarkers();
      }
      const points=result.points??[];
      this.lastProbe={requested:specs.length,found:points.length,reason:result.reason??result.type};
      this.clearMarkers();
      if(!points.length){
        this.status.text='$(circle-outline) Swarm · 等待对齐';
        this.status.tooltip=`定位失败：找到 ${points.length}/${specs.length} 个标记。点击重试，或运行“Code Swarm: 查看覆盖状态”。`;
        void this.saveDiagnostics();return;
      }
      const pointById=new Map(points.map(p=>[p.id,p]));
      const font=vscode.workspace.getConfiguration('editor',this.document.uri).get<number>('fontSize',14);
      const zoom=Math.pow(1.2,vscode.workspace.getConfiguration('window').get<number>('zoomLevel',0));
      const configHeight=vscode.workspace.getConfiguration('editor',this.document.uri).get<number>('lineHeight',0);
      const dpi=typeof result.dpi==='number'?result.dpi:1;
      const fallback=(configHeight===0?font*1.5:configHeight<8?font*configHeight:configHeight)*zoom*dpi;
      // Derive physical line pitch from adjacent visible anchors when possible.
      const pitches:number[]=[];
      for(const [line,id] of positions){const p=pointById.get(id),q=pointById.get(positions.get(line+1)??'');if(p&&q&&q.y-p.y>=8&&q.y-p.y<100)pitches.push(q.y-p.y);}
      const lineHeight=pitches.sort((a,b)=>a-b)[Math.floor(pitches.length/2)]??fallback;
      const pixelScale=lineHeight/(fallback/dpi);
      const visual=mapped.filter(m=>pointById.has(m.anchor)).map(m=>{
        const text='text' in m.task?m.task.text:(m.task.kind==='delete'?m.task.oldLines:m.task.newLines).join('\n');
        const column='column' in m.task?m.task.column:0;
        return{kind:m.task.kind,line:m.task.toLine,anchor:m.anchor,fromAnchor:m.fromAnchor,text:text.slice(0,500),oldText:'oldText' in m.task?m.task.oldText:m.task.oldLines.join('\n'),column,
          width:Math.min(450,Math.max(45,...text.split('\n').map(s=>s.length*font*.6*zoom*pixelScale))),
          height:'text' in m.task?lineHeight:lineHeight*Math.max(1,Math.min(3,m.task.kind==='delete'?m.task.oldLines.length:m.task.newLines.length))};
      });
      this.send({type:'play',tasks:visual,lineHeight,zoom,style,topAnchor,bottomAnchor,charWidth:font*.6*zoom*pixelScale,
        speed:vscode.workspace.getConfiguration('codeSwarm').get('cardSpeed',4),reconstruction:cardPlan.reconstruction,
        workers:vscode.workspace.getConfiguration('codeSwarm').get('cursorCount',32),
        pointerSize:vscode.workspace.getConfiguration('codeSwarm').get('pointerSize',12)});
      this.status.text=style==='cards'?'$(layers) Swarm · 悬浮代码卡':'$(pulse) Swarm · 原生覆盖';this.status.tooltip=`${visual.length} 个视觉任务${cardPlan.reconstruction?' · 重建当前视口':''}。点击重播；空闲指针隐藏。`;
      void this.saveDiagnostics();
    }finally{if(generation===this.generation)this.clearMarkers();}
  }
  async diagnostics() { const process=await this.request({type:'status'});return{process,hybrid:this.hybrid.diagnostics(),disk:this.disk?.metrics,lastProbe:this.lastProbe,lastDiagnostic:this.lastDiagnostic,lastReply:this.lastReply}; }
  setControlled(value:boolean){this.controlled=value;this.cancel();}
  async perform(change:InputChange,visual:'mixed'|'edit'|'erase',steps:number,progress:(step:number)=>void){return await this.hybrid.perform(change,visual,steps,progress);}
  async resumeFollow(){await this.hybrid.resumeFollow();}
  async saveDiagnostics(){
    const info={...(await this.diagnostics()),document:{uri:this.document.uri.toString(),version:this.document.version,dirty:this.document.isDirty},focused:vscode.window.state.focused,visibleRanges:vscode.window.activeTextEditor?.visibleRanges};
    await mkdir(this.context.logUri.fsPath,{recursive:true});
    await writeFile(vscode.Uri.joinPath(this.context.logUri,'native-overlay.json').fsPath,JSON.stringify(info,null,2));
    return info;
  }
  dispose(){
    if(this.disposed)return;
    this.disk?.dispose();this.cancel();this.hybrid.dispose();this.send({type:'stop'});this.disposed=true;
    this.child?.stdin.end();const child=this.child;
    const kill=setTimeout(()=>{if(child?.exitCode===null)child.kill();},1200);kill.unref();
    for(const item of this.pending.values()){clearTimeout(item.timer);item.resolve({type:'disposed'});}this.pending.clear();
    this.status.dispose();for(const listener of this.listeners)listener.dispose();
  }
}
