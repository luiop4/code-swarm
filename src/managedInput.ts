import * as vscode from 'vscode';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn, ChildProcess } from 'node:child_process';
import { DiskStream } from './diskStream';
import { assertText } from './core/model';
import { applyInputChange, nextInputChange, parallelInputText } from './core/managedPlan';
import { NativeOverlay } from './nativeOverlay';

type State='running'|'paused'|'completed'|'stopped'|'conflict';
const wait=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));

/** The only new write boundary. Native rendering supplies bounded progress, never text or edits. */
export class ManagedInput implements vscode.Disposable{
  readonly id=randomUUID();
  readonly original:string;
  readonly backup:vscode.Uri;
  readonly incoming:vscode.Uri;
  private expected:string;
  private expectedVersion:number;
  private desired:string;
  private state:State='running';
  private reason='';
  private pauseForFocus=false;
  private lastCheckpoint?:{type:string;applied:number;steps:number};
  private own?:{version:number;text:string};
  private sourceDone=false;
  private busy=false;
  private first=true;
  private epoch=0;
  private renderRetries=0;
  private source?:DiskStream;
  private staging?:vscode.Uri;
  private closingStaging=false;
  private producer?:ChildProcess;
  private disk?:Buffer;
  private readonly listeners:vscode.Disposable[]=[];
  private readonly badge=vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right,81);
  private resolve!:(value:ReturnType<ManagedInput['status']>)=>void;
  readonly completion=new Promise<ReturnType<ManagedInput['status']>>(r=>{this.resolve=r;});
  readonly metrics={signals:0,edits:0,operations:0,received:0};
  constructor(private readonly context:vscode.ExtensionContext,readonly document:vscode.TextDocument,private readonly overlay:NativeOverlay){
    this.original=this.expected=this.desired=document.getText();this.expectedVersion=document.version;
    const directory=vscode.Uri.joinPath(context.globalStorageUri,'input-sessions',this.id);
    this.backup=vscode.Uri.joinPath(directory,'before.txt');this.incoming=vscode.Uri.joinPath(directory,'incoming.txt');
  }
  get active(){return this.state==='running'||this.state==='paused';}
  async start(expectedVersion:number){
    if(!vscode.workspace.isTrusted)throw new Error('请在受信任的工作区中使用动画输入。');
    assertText(this.original);if(this.document.version!==expectedVersion)throw new Error('文件已变化，请重新开始动画输入。');
    await mkdir(vscode.Uri.joinPath(this.backup,'..').fsPath,{recursive:true});
    await writeFile(this.backup.fsPath,this.original,'utf8');
    await writeFile(this.incoming.fsPath,this.original,'utf8');
    if(this.document.uri.scheme==='file')this.disk=await readFile(this.document.uri.fsPath);
    this.guard();
    await this.context.globalState.update('lastInputBackup',this.backup.toString());
    this.overlay.setControlled(true);
    this.badge.command='codeSwarm.pauseAnimatedInput';this.show();
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(e=>{
      if(!this.active||e.document.uri.toString()!==this.document.uri.toString()||!e.contentChanges.length)return;
      const text=e.document.getText();
      if(this.own&&e.document.version===this.own.version&&text===this.own.text){this.expected=text;this.expectedVersion=e.document.version;}
      else this.end('conflict','文件被其他编辑修改，已停止动画输入；当前内容和输入前备份均已保留。');
    }));
    this.listeners.push(vscode.workspace.onDidSaveTextDocument(doc=>{
      if(!this.active||doc.uri.toString()!==this.document.uri.toString())return;
      const saved=doc.getText();void readFile(doc.uri.fsPath).then(bytes=>{if(bytes.toString('utf8').replace(/^\uFEFF/,'')===saved)this.disk=bytes;}).catch(()=>{});
    }));
    this.listeners.push(vscode.window.onDidChangeWindowState(e=>{
      if(!this.active)return;
      if(!e.focused){if(this.state==='running')this.pause(true);else if(this.state==='paused'){this.pauseForFocus=true;this.reason='切回 VS Code 后继续。';this.show();}}
      else if(e.focused&&this.pauseForFocus)void this.resume();
    }));
  }
  offer(text:string){
    if(!this.active)return;assertText(text);
    const eol=this.document.eol===vscode.EndOfLine.CRLF?'\r\n':'\n';
    this.desired=text.replace(/\r\n|\r|\n/g,eol);assertText(this.desired);this.metrics.received++;
    this.show();void this.drain();
  }
  async acceptBatch(text:string){
    this.offer(text);
    while(this.active&&(this.busy||this.expected!==this.desired||this.state==='paused'))await wait(20);
    if(!this.active)throw new Error(this.reason);
    this.guard();
  }
  async finish(){this.sourceDone=true;void this.drain();return await this.completion;}
  async openStaging(){
    const path=this.document.uri.fsPath;
    const staged=vscode.Uri.file(join(dirname(path),'.swarm-'+this.id.slice(0,8)+'-'+basename(path)));
    await writeFile(staged.fsPath,this.original,{encoding:'utf8',flag:'wx'});
    this.staging=staged;
    const accept=(text:string)=>{
      if(this.closingStaging||!this.active)return;
      try{this.offer(text);}catch(e){this.end('conflict',String(e));}
    };
    this.listeners.push(vscode.workspace.onDidChangeTextDocument(event=>{
      if(event.contentChanges.length&&event.document.uri.toString()===staged.toString())accept(event.document.getText());
    }));
    this.source=new DiskStream(staged.fsPath,(_before,after)=>{
      if(!this.dirtyStaging())accept(after);
    });
    await this.source.start();
    return staged.fsPath;
  }
  private dirtyStaging(){
    return vscode.workspace.textDocuments.find(d=>d.isDirty&&d.uri.toString()===this.staging?.toString());
  }
  async finishStaging(){
    if(!this.active||!this.staging)throw new Error('请先启动通用动画输入。');
    this.closingStaging=true;
    try{
      const text=this.dirtyStaging()?.getText()??new TextDecoder('utf-8',{fatal:true}).decode(await readFile(this.staging.fsPath));
      this.offer(text);
    }catch(e){this.closingStaging=false;throw e;}
    this.source?.dispose();
    return await this.finish();
  }
  async launchScript(script:string,speed='normal'){
    const runner=vscode.Uri.joinPath(this.context.extensionUri,'dist','input-producer.py').fsPath;
    const child=spawn('python',[runner,script,this.incoming.fsPath,speed],{
      windowsHide:true,stdio:['pipe','pipe','pipe'],env:{...process.env,PYTHONIOENCODING:'utf-8',PYTHONDONTWRITEBYTECODE:'1'}
    });
    this.producer=child;
    child.stderr.resume();
    child.stdin.on('error',()=>{if(this.active)this.end('conflict','脚本连接中断。');});
    createInterface({input:child.stdout}).on('line',line=>{
      if(line!=='SWARM_BATCH_READY'||!this.active)return;
      void readFile(this.incoming.fsPath,'utf8').then(text=>this.acceptBatch(text)).then(()=>{
        if(this.active)child.stdin.write('APPLIED\n');
      }).catch(e=>this.end('conflict',String(e)));
    });
    child.once('error',()=>this.end('conflict','脚本未能启动，请检查 Python 和脚本路径；目标文件保持可恢复。'));
    child.once('exit',code=>{
      if(!this.active)return;
      if(code!==0){this.end('conflict','脚本执行失败，已保留暂存输入和已写入内容。');return;}
      void readFile(this.incoming.fsPath,'utf8').then(text=>{this.offer(text);void this.finish();}).catch(()=>this.end('conflict','无法读取最终输入，已停止。'));
    });
  }
  private guard(){
    if(this.document.isClosed||this.document.version!==this.expectedVersion||this.document.getText()!==this.expected)throw new Error('目标文件已被其他编辑修改。');
  }
  private async diskGuard(){
    if(!this.disk)return;
    let bytes=await readFile(this.document.uri.fsPath);
    if(bytes.equals(this.disk))return;
    await wait(25);bytes=await readFile(this.document.uri.fsPath);
    if(bytes.equals(this.disk))return;
    if(!this.document.isDirty&&bytes.toString('utf8').replace(/^\uFEFF/,'')===this.expected){this.disk=bytes;return;}
    throw new Error('目标文件的磁盘版本发生变化，已停止，未覆盖磁盘内容。');
  }
  private async commit(after:string,epoch:number){
    if(this.state!=='running'||epoch!==this.epoch)return;
    this.guard();await this.diskGuard();
    if(this.state!=='running'||epoch!==this.epoch)return;this.guard();
    if(after===this.expected)return;
    const editor=vscode.window.visibleTextEditors.find(e=>e.document===this.document);
    if(!editor||!vscode.window.state.focused){this.pause(true);return;}
    const edit=nextInputChange(this.expected,after);if(!edit)return;
    const range=new vscode.Range(this.document.positionAt(edit.offset),this.document.positionAt(edit.offset+edit.length));
    this.own={version:this.document.version+1,text:after};
    try{
      const ok=await editor.edit(b=>b.replace(range,edit.text),{undoStopBefore:this.first,undoStopAfter:false});
      if(!ok||this.document.getText()!==after)throw new Error('编辑未能完成，已保留当前内容。');
      this.expected=after;this.expectedVersion=this.document.version;this.first=false;this.metrics.edits++;
    }finally{this.own=undefined;}
  }
  private async drain(){
    if(this.busy||this.state!=='running')return;this.busy=true;
    try{
      while(this.state==='running'){
        this.guard();
        const change=nextInputChange(this.expected,this.desired);
        if(!change){if(this.sourceDone){await this.undoBoundary();this.end('completed','动画输入完成；保存遵循 VS Code 设置，可撤销本次输入。');}break;}
        const epoch=this.epoch,before=this.expected;
        const visual=change.kind==='delete'?'erase':change.kind==='replace'?'edit':'mixed';
        const steps=visual==='mixed'?4:1,startLine=this.document.positionAt(change.offset).line;
        let last=0,applied=0,error:unknown,chain=Promise.resolve();
        const reply=await this.overlay.perform(change,visual,steps,step=>{
          if(step<=last||step>steps||!Number.isInteger(step))return;last=step;this.metrics.signals++;
          chain=chain.then(async()=>{
            if(error||this.state!=='running'||epoch!==this.epoch)return;
            try{await this.commit(applyInputChange(before,change,visual==='mixed'?parallelInputText(change.text,step,steps,startLine):change.text),epoch);if(this.state==='running'&&epoch===this.epoch)applied=step;}
            catch(e){error=e;this.end('conflict',e instanceof Error?e.message:'输入已停止。');}
          });
        });
        await chain;if(this.state!=='running'||epoch!==this.epoch)break;
        if(reply.type!=='performed'||applied!==steps){
          this.lastCheckpoint={type:reply.type,applied,steps};
          if((reply.type==='layoutRequired'||reply.reason==='layout')&&this.renderRetries++<3){this.overlay.cancel();await wait(100);continue;}
          const focus=reply.reason==='notForeground'||!vscode.window.state.focused;this.pause(focus);if(!focus)this.reason='动画显示被中断，点击继续后从当前内容接着输入。';this.show();break;
        }
        this.renderRetries=0;this.metrics.operations++;this.show();
      }
    }catch(e){this.end('conflict',e instanceof Error?e.message:'输入已停止。');}
    finally{this.busy=false;if(this.state==='running'&&(this.expected!==this.desired||this.sourceDone))setTimeout(()=>void this.drain(),0);}
  }
  private async undoBoundary(){
    const editor=vscode.window.visibleTextEditors.find(e=>e.document===this.document);
    if(editor&&!this.first)await editor.edit(()=>{},{undoStopBefore:false,undoStopAfter:true});
  }
  pause(focus=false){if(this.state!=='running')return;this.state='paused';this.epoch++;this.pauseForFocus=focus;this.overlay.cancel();this.reason=focus?'切回 VS Code 后继续。':'点击继续动画输入。';this.show();}
  async resume(){
    if(this.state!=='paused')return;
    try{this.guard();await this.diskGuard();}catch(e){this.end('conflict',String(e));return;}
    this.pauseForFocus=false;this.state='running';this.reason='';this.show();void this.drain();
  }
  stop(){if(this.active){void this.undoBoundary();this.end('stopped','已停止，保留已输入内容；可撤销或查看输入前备份。');}}
  private end(state:State,reason:string){
    if(!this.active)return;this.state=state;this.reason=reason;this.epoch++;this.source?.dispose();
    if(this.producer?.exitCode===null)this.producer.kill();
    this.overlay.setControlled(false);for(const d of this.listeners)d.dispose();this.show();this.resolve(this.status());
  }
  private show(){
    this.badge.text=this.state==='running'?`$(edit) Swarm · 动画输入 ${this.metrics.edits}`:this.state==='paused'?'$(play) Swarm · 继续动画输入':this.state==='completed'?'$(check) Swarm · 输入完成':'$(debug-stop) Swarm · 输入已停止';
    this.badge.tooltip=this.reason||'动画正在驱动真实编辑；点击暂停。';
    this.badge.command=this.state==='paused'?'codeSwarm.resumeAnimatedInput':this.state==='running'?'codeSwarm.pauseAnimatedInput':'codeSwarm.openInputBackup';this.badge.show();
  }
  status(){return {id:this.id,state:this.state,reason:this.reason,pausedForFocus:this.pauseForFocus,lastCheckpoint:this.lastCheckpoint,uri:this.document.uri.toString(),backup:this.backup.toString(),incoming:this.incoming.toString(),queued:this.expected!==this.desired,metrics:{...this.metrics}};}
  dispose(){this.stop();this.source?.dispose();this.badge.dispose();for(const d of this.listeners)d.dispose();}
}
