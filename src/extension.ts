import * as vscode from 'vscode';
import { createServer, Server, Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { assertText, Replay } from './core/model';
import { replay, ReplayHistory, validateProposal } from './core/planner';
import { demoReplays } from './core/demo';
import { NativeOverlay } from './nativeOverlay';
import { ManagedInput } from './managedInput';

interface ProposalInput { uri: string; expectedVersion: number; afterText: string; agent?: string; label?: string }
interface Proposal { id: string; uri: string; version: number; before: string; after: string; agent: string; label: string }
const safeLabel = (value: unknown, fallback: string) => typeof value === 'string' ? value.slice(0, 80) : fallback;

/** Keeps Markdown code fences out of the live editor while model tokens arrive. */
class SourceTextStream {
  private raw='';
  private source='';
  private mode:'detect'|'plain'|'fenced'='detect';
  private contentStart=0;
  push(chunk:string){
    this.raw+=chunk;
    if(this.mode==='detect'){
      const leading=this.raw.match(/^\s*/)?.[0].length??0;
      const head=this.raw.slice(leading);
      if(head.length<3&&'```'.startsWith(head))return this.source;
      if(head.startsWith('```')){
        const lineEnd=this.raw.indexOf('\n',leading+3);
        if(lineEnd<0)return this.source;
        this.mode='fenced';this.contentStart=lineEnd+1;
      }else this.mode='plain';
    }
    if(this.mode==='plain')this.source=this.raw;
    else if(this.mode==='fenced'){
      let body=this.raw.slice(this.contentStart);
      const close=body.lastIndexOf('\n```');
      if(close>=0&&/^\s*$/.test(body.slice(close+4)))body=body.slice(0,close);
      this.source=body;
    }
    return this.source;
  }
  finish(){return this.source;}
}

class SwarmController implements vscode.Disposable {
  private panel?: vscode.WebviewPanel;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly history = new ReplayHistory();
  private readonly previews = new Map<string, string>();
  private target?: vscode.TextDocument;
  private baseline?: string;
  private capture?: { before: string; after: string; sources: Set<string> };
  private timer?: ReturnType<typeof setTimeout>;
  private proposal?: Proposal;
  private writing?: { agent: string; text: string; version: number };
  private applying = false;
  private preparing = false;
  private serial = 0;
  private mode: 'demo' | 'live' | 'idle' = 'idle';
  private overlay?: NativeOverlay;
  private managed?:ManagedInput;
  private inputServer?:Server;
  private inputClient?:Socket;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(vscode.workspace.onDidChangeTextDocument(e => this.changed(e)));
    // Copilot/language changes may replace a document model while retaining its URI.
    // Keep the watch and rebind instead of killing the display process on model close.
    this.disposables.push(vscode.workspace.onDidOpenTextDocument(doc=>{
      if(this.target?.uri.toString()===doc.uri.toString()){
        const previous=this.baseline;this.target=doc;
        if(previous!==undefined&&previous!==doc.getText())this.changed({document:doc,contentChanges:[{range:new vscode.Range(0,0,0,0),rangeOffset:0,rangeLength:0,text:''}],reason:undefined});
      }
    }));
    this.disposables.push(vscode.workspace.registerTextDocumentContentProvider('code-swarm-preview', {
      provideTextDocumentContent: uri => this.previews.get(uri.toString()) ?? 'Preview expired. Generate a new proposal.'
    }));
  }

  async open() {
    if (this.panel) { this.panel.reveal(this.panel.viewColumn, true); return; }
    const panel = vscode.window.createWebviewPanel('codeSwarm.stage', 'Code Swarm · 代码蜂群',
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'dist')] });
    this.panel = panel;
    const dist = vscode.Uri.joinPath(this.context.extensionUri, 'dist');
    const nonce = randomBytes(18).toString('base64');
    const template = await readFile(vscode.Uri.joinPath(dist, 'index.html').fsPath, 'utf8');
    if (this.panel !== panel) return;
    panel.webview.html = template
      .replaceAll('{{CSP}}', `default-src 'none'; script-src 'nonce-${nonce}'; style-src ${panel.webview.cspSource}; img-src ${panel.webview.cspSource} data:; connect-src 'none';`)
      .replaceAll('{{NONCE}}', nonce)
      .replaceAll('{{SCRIPT}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'app.js')).toString())
      .replaceAll('{{STYLE}}', panel.webview.asWebviewUri(vscode.Uri.joinPath(dist, 'style.css')).toString());
    panel.webview.onDidReceiveMessage(async message => {
      // No code, path, version or edit is accepted from the animation surface.
      if (!message || typeof message.type !== 'string') return;
      try {
        switch (message.type) {
          case 'ready': this.state(); break;
          case 'demo': await this.demo(); break;
          case 'attach': await this.attach(); break;
          case 'detach': this.detach(); break;
          case 'import': await this.importProposal(); break;
          case 'apply': await this.applyProposal(); break;
          case 'reveal': if (this.target) await vscode.window.showTextDocument(this.target, { viewColumn: vscode.ViewColumn.One }); break;
        }
      } catch (e) { this.notice(e); }
    }, undefined, this.disposables);
    panel.onDidDispose(() => {
      if (this.panel === panel) { this.panel = undefined; this.reset(); }
    }, undefined, this.disposables);
  }

  private send(message: object) { void this.panel?.webview.postMessage(message); }
  private state() {
    this.send({ type: 'state', mode: this.mode, watching: this.target ? vscode.workspace.asRelativePath(this.target.uri) : null,
      history: this.history.all(), cursorCount: vscode.workspace.getConfiguration('codeSwarm').get('cursorCount', 32),
      proposal: this.proposal ? { label: this.proposal.label, agent: this.proposal.agent, version: this.proposal.version } : null });
  }
  private notice(e: unknown) {
    const text = e instanceof Error ? e.message : String(e);
    this.send({ type: 'notice', text });
    void vscode.window.showWarningMessage(`Code Swarm: ${text}`);
  }
  private reset() {
    this.inputClient?.destroy();this.inputClient=undefined;
    this.inputServer?.close();this.inputServer=undefined;
    this.managed?.dispose();this.managed=undefined;
    this.overlay?.dispose();this.overlay=undefined;
    clearTimeout(this.timer); this.timer=undefined; this.capture = undefined; this.target = undefined; this.baseline = undefined;
    this.proposal = undefined; this.previews.clear(); this.history.clear(); this.mode = 'idle';
  }
  detach() { this.reset(); this.state(); }
  async demo() {
    this.reset(); this.mode = 'demo';
    for (const item of demoReplays()) this.history.push(item);
    await this.open(); this.state();
  }
  async attach(uri?: vscode.Uri, native = false) {
    let doc = uri ? await vscode.workspace.openTextDocument(uri) : vscode.window.activeTextEditor?.document;
    if (!doc) {
      const candidates = vscode.window.visibleTextEditors.filter(e => ['file', 'untitled', 'vscode-remote'].includes(e.document.uri.scheme));
      if (candidates.length === 1) doc = candidates[0].document;
      else if (candidates.length > 1) {
        const picked = await vscode.window.showQuickPick(candidates.map(e => ({ label: vscode.workspace.asRelativePath(e.document.uri), document: e.document })),
          { title: '选择要监听的代码文件' });
        if (!picked) return;
        doc = picked.document;
      }
    }
    if (!doc || doc.uri.scheme === 'code-swarm-preview') throw new Error('请先在原生编辑器中打开代码文件，再运行“监听当前代码文件”。');
    if (!['file', 'untitled', 'vscode-remote'].includes(doc.uri.scheme)) throw new Error('只支持本地、远程工作区或未命名文本文件。');
    assertText(doc.getText());
    // Establish the source editor first. In an empty VS Code window a webview may
    // occupy column one as a preview, which opening a text document can replace.
    if(native&&this.panel){this.panel.dispose();this.panel=undefined;}
    const editor=await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
    this.reset(); this.target = doc; this.baseline = doc.getText(); this.mode = 'live';
    this.history.push(replay({ file: vscode.workspace.asRelativePath(doc.uri), before: this.baseline, after: this.baseline,
      label: '已建立监听基线 · 等待文件变化', attribution: 'Unattributed', source: 'observed' }));
    if(native){
      const overlay=new NativeOverlay(this.context,doc);this.overlay=overlay;
      try{await overlay.start();if(process.platform==='win32'&&doc.uri.scheme==='file'&&vscode.workspace.isTrusted)this.listenInput(doc);}catch(e){if(this.overlay===overlay)this.reset();throw e;}
    }else{await this.open();this.state();}
  }
  private changed(event: vscode.TextDocumentChangeEvent) {
    if (event.document.uri.toString() !== this.target?.uri.toString() || !event.contentChanges.length) return;
    this.target=event.document;
    if (this.proposal && this.proposal.version !== event.document.version) {
      this.proposal = undefined;
      this.send({ type: 'proposal', proposal: null });
    }
    const next = event.document.getText();
    if(this.managed?.active){this.baseline=next;this.capture=undefined;clearTimeout(this.timer);this.timer=undefined;return;}
    try { assertText(next); } catch {
      this.baseline = undefined; this.capture = undefined; clearTimeout(this.timer);this.timer=undefined;
      this.send({ type: 'notice', text: '文件超过原型限制，已暂停捕获；恢复到限制内后会重新建立基线。' }); return;
    }
    if (this.baseline === undefined) {
      this.baseline = next;
      this.push(replay({ file: vscode.workspace.asRelativePath(event.document.uri), before: next, after: next,
        label: '文件恢复限制内 · 新基线', attribution: 'Unattributed', source: 'observed' })); return;
    }
    const attributed = this.writing && this.writing.text === next && this.writing.version === event.document.version ? this.writing.agent : undefined;
    const source = attributed ?? (event.reason === vscode.TextDocumentChangeReason.Undo ? 'Undo' : event.reason === vscode.TextDocumentChangeReason.Redo ? 'Redo' : 'Unattributed');
    if (!this.capture) this.capture = { before: this.baseline, after: next, sources: new Set([source]) };
    else { this.capture.after = next; this.capture.sources.add(source); }
    this.baseline = next;
    const delay = vscode.workspace.getConfiguration('codeSwarm').get<number>('captureDelay', 80);
    if(!this.timer)this.timer = setTimeout(() => this.flush(), Math.min(1500, Math.max(60, delay)));
  }
  flush() {
    clearTimeout(this.timer);this.timer=undefined;
    const captured = this.capture; this.capture = undefined;
    if (!captured || !this.target || captured.before === captured.after) return;
    const attribution = captured.sources.size === 1 ? [...captured.sources][0] : 'Mixed / unattributed';
    this.push(replay({ file: vscode.workspace.asRelativePath(this.target.uri), before: captured.before, after: captured.after,
      source: attribution === 'Unattributed' || attribution.includes('unattributed') || ['Undo', 'Redo'].includes(attribution) ? 'observed' : 'proposal',
      attribution, label: `文档 v${this.target.version} · ${attribution}` }));
  }
  private push(record: Replay) { this.history.push(record); this.send({ type: 'append', record });void this.overlay?.play(record).catch(e=>this.notice(e)); }
  async replayOverlay() {
    if(!this.overlay){await this.attach(undefined,true);}
    const record=this.history.all().filter(r=>r.tasks.length&&r.after===this.target?.getText()).at(-1);
    if(record)await this.overlay?.play(record);
    else await this.demoOverlay();
  }
  async demoOverlay(style?:'cards'|'cues') {
    if(!this.overlay)await this.attach(undefined,true);
    if(!this.target)return;
    const record=replay({before:'',after:this.target.getText(),file:vscode.workspace.asRelativePath(this.target.uri),label:'原生覆盖演示 · 文件不会修改',source:'demo',attribution:'Demo workers'});
    await this.overlay?.play(record,style);
  }
  async overlayStatus(){return this.overlay?await this.overlay.diagnostics():undefined;}
  async resumeFollow(){await this.overlay?.resumeFollow();}
  async beginAnimatedInput(input:{uri:string;expectedVersion:number}){
    if(this.managed?.active||this.preparing||this.applying)throw new Error('请先结束当前输入或补丁操作。');
    const uri=vscode.Uri.parse(input.uri);if(uri.scheme!=='file')throw new Error('动画输入目前需要本地代码文件。');
    const doc=await vscode.workspace.openTextDocument(uri);
    if(!Number.isInteger(input.expectedVersion)||doc.version!==input.expectedVersion)throw new Error('文件版本已变化，请重新开始。');
    await this.attach(uri,true);
    return await this.startManaged(doc,input.expectedVersion);
  }
  private async startManaged(doc:vscode.TextDocument,version:number){
    if(this.managed?.active||!this.overlay)throw new Error('当前动画输入不可用。');
    const uri=doc.uri;
    const managed=new ManagedInput(this.context,doc,this.overlay!);this.managed=managed;
    try{await managed.start(version);if(this.managed!==managed)throw new Error('输入已取消。');}
    catch(e){managed.dispose();if(this.managed===managed)this.managed=undefined;throw e;}
    void managed.completion.then(result=>{
      if(this.managed!==managed||doc.isClosed)return;
      this.baseline=doc.getText();this.history.push(replay({before:managed.original,after:doc.getText(),file:vscode.workspace.asRelativePath(uri),source:result.state==='completed'?'proposal':'observed',attribution:result.state==='completed'?'Animated input':'Mixed / interrupted',label:result.state==='completed'?'动画驱动的真实输入':'动画输入已中断 · 保留当前内容'}));
    });
    return managed.status();
  }
  private listenInput(doc:vscode.TextDocument){
    const key=createHash('sha256').update(doc.uri.fsPath.toLowerCase()).digest('hex');
    const server=createServer(socket=>{
      socket.on('error',()=>socket.destroy());
      if(this.target!==doc||this.inputClient||this.managed?.active){socket.end('BUSY\n');return;}
      this.inputClient=socket;
      void this.receiveInput(socket,doc).finally(()=>{if(this.inputClient===socket)this.inputClient=undefined;});
    });
    server.on('error',e=>this.notice(e));
    server.listen('\\\\.\\pipe\\code-swarm-'+key);
    this.inputServer=server;
  }
  private async receiveInput(socket:Socket,doc:vscode.TextDocument){
    let session:ManagedInput|undefined;
    try{
      const lines=createInterface({input:socket,crlfDelay:Infinity});
      const info=await this.startManaged(doc,doc.version);
      session=this.inputSession(info.id);
      socket.once('close',()=>session?.stop());
      if(socket.destroyed)return;
      socket.write('READY\n');
      for await(const line of lines){
        if(line==='END'){
          const result=await session.finish();
          if(result.state!=='completed')throw new Error(result.reason);
          socket.end('DONE\n');return;
        }
        const text:unknown=JSON.parse(line);
        if(typeof text!=='string')throw new Error('需要代码文本。');
        session.offer(text);
      }
    }catch(e){if(!socket.destroyed)socket.end('ERROR '+String(e).replace(/[\r\n]/g,' ')+'\n');}
    finally{session?.stop();}
  }
  private inputSession(id:string){if(!this.managed||this.managed.id!==id)throw new Error('输入会话已过期。');return this.managed;}
  updateAnimatedInput(id:string,text:string){const session=this.inputSession(id);if(!session.active)throw new Error('输入会话已结束，请重新开始。');session.offer(text);}
  async finishAnimatedInput(id:string){return await this.inputSession(id).finish();}
  stopAnimatedInput(id?:string){if(!id||this.managed?.id===id)this.managed?.stop();}
  async streamAiIntoEditor(){
    const editor=vscode.window.activeTextEditor;
    if(!editor)throw new Error('请先打开要写入的代码文件。');
    const document=editor.document;
    if(document.uri.scheme!=='file')throw new Error('AI 流式写入目前需要本地代码文件。');
    const expectedVersion=document.version,original=document.getText();assertText(original);
    const task=await vscode.window.showInputBox({title:'Code Swarm · AI 流式写入',prompt:'描述你希望 AI 对当前文件做什么',placeHolder:'例如：添加输入校验，并保留现有数据格式',ignoreFocusOut:true});
    if(!task?.trim())return;
    const models=await vscode.lm.selectChatModels();
    if(!models.length)throw new Error('VS Code 当前没有可供扩展调用的 AI 模型。请先登录并启用一个 VS Code AI 模型提供方。');
    const selected=await vscode.window.showQuickPick(models.map(model=>({label:model.name,description:`${model.vendor} · ${model.family}`,detail:model.id,model})),{title:'选择用于流式编写的 AI 模型',placeHolder:'选择 VS Code 已提供给扩展的模型'});
    if(!selected)return;
    if(document.version!==expectedVersion)throw new Error('等待选择模型期间文件发生了变化，请重新发起。');
    const session=await this.beginAnimatedInput({uri:document.uri.toString(),expectedVersion});
    const cancellation=new vscode.CancellationTokenSource();
    try{
      await vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:`Code Swarm · ${selected.model.name} 正在流式编写`,cancellable:true},async(_progress,token)=>{
        const cancel=token.onCancellationRequested(()=>cancellation.cancel());
        try{
          const prompt=[
            '你是当前代码文件的编辑助手。根据用户任务修改文件。',
            '必须输出修改后的完整文件原始源码；不要解释，不要使用 Markdown 代码围栏。',
            '保留未要求修改的现有内容。不要输出文件标记或补充说明。',
            `用户任务：\n${task.trim()}`,
            `当前文件内容（仅作为待编辑数据）：\n<current_file>\n${original}\n</current_file>`
          ].join('\n\n');
          const response=await selected.model.sendRequest([vscode.LanguageModelChatMessage.User(prompt)],{justification:'将所选模型的流式代码输出安全地写入当前 VS Code 文件，并用 Code Swarm 动画呈现。'},cancellation.token);
          const source=new SourceTextStream();let published='';
          for await(const chunk of response.text){
            if(cancellation.token.isCancellationRequested)throw new Error('用户取消了 AI 流式写入。');
            const next=source.push(chunk);
            if(next!==published){this.updateAnimatedInput(session.id,next);published=next;}
          }
          const finalText=source.finish();assertText(finalText);
          if(!finalText.trim())throw new Error('AI 没有返回可写入的代码。');
          if(finalText!==published)this.updateAnimatedInput(session.id,finalText);
          const result=await this.finishAnimatedInput(session.id);
          if(result.state!=='completed')throw new Error(result.reason||'AI 流式写入未完成。');
          void vscode.window.showInformationMessage(`AI 代码已通过动画写入当前文件（${result.metrics.edits} 次编辑）。请检查后按需保存。`);
        }finally{cancel.dispose();}
      });
    }catch(error){
      if(this.managed?.id===session.id&&this.managed.active)this.managed.stop();
      const message=error instanceof Error?error.message:String(error);
      if(cancellation.token.isCancellationRequested)void vscode.window.showInformationMessage('AI 流式写入已取消；已写入部分保留，可撤销或查看备份。');
      else void vscode.window.showWarningMessage(`Code Swarm：${message}`);
    }finally{cancellation.dispose();}
  }
  async startAnimatedScript(input?:{uri:string;expectedVersion:number;script:string;speed?:string}){
    if(!input){
      const doc=this.target??vscode.window.activeTextEditor?.document;
      if(!doc||doc.uri.scheme!=='file')throw new Error('请先打开要由动画输入的代码文件。');
      const version=doc.version;
      const selection=await vscode.window.showOpenDialog({canSelectMany:false,filters:{Python:['py']},title:'选择生成脚本（输入到当前代码文件，原内容会备份）'});if(!selection?.[0])return;
      input={uri:doc.uri.toString(),expectedVersion:version,script:selection[0].fsPath,speed:'turbo'};
    }
    if(input.speed&&!['slow','normal','fast','turbo'].includes(input.speed))throw new Error('不支持的脚本速度。');
    const info=await this.beginAnimatedInput(input);
    await this.inputSession(info.id).launchScript(input.script,input.speed);return info;
  }
  async chooseInput(){
    const options=[
      {label:'使用 VS Code AI 实时生成并动画写入',description:'选择 VS Code 提供的模型；生成片段会持续进入当前文件。',run:()=>this.streamAiIntoEditor()},
      {label:'接收 CMD 生成器 / 监听当前文件',description:'已接入的生成器等待动画回执；普通直接写盘只播放回放。',run:()=>this.attach(undefined,true)},
      {label:'接收其他 AI 或工具的内容',description:'复制暂存路径，让工具写入副本。',run:()=>this.startStaging()},
      {label:'从插件启动 Python 生成器',description:'选择兼容的生成脚本。',run:()=>this.startAnimatedScript()}
    ];
    const choice=await vscode.window.showQuickPick(options,{title:'选择代码输入来源'});
    if(choice)await choice.run();
  }
  async startStaging(){
    const document=vscode.window.activeTextEditor?.document;
    if(!document||document.uri.scheme!=='file')throw new Error('请先打开真实目标文件。');
    const info=await this.beginAnimatedInput({uri:document.uri.toString(),expectedVersion:document.version});
    const session=this.inputSession(info.id);
    try{
      const path=await session.openStaging();
      await vscode.env.clipboard.writeText(path);
      void vscode.window.showInformationMessage('暂存文件路径已复制。请让 AI 或脚本修改这个副本，保持目标文件可见。完成后运行“结束通用动画输入”。');
    }catch(e){session.stop();throw e;}
  }
  async finishStaging(){
    if(!this.managed)throw new Error('请先启动通用动画输入。');
    return await this.managed.finishStaging();
  }
  pauseAnimatedInput(){this.managed?.pause();}
  async resumeAnimatedInput(){await this.managed?.resume();}
  async openInputBackup(){
    const value=this.context.globalState.get<string>('lastInputBackup');if(!value)throw new Error('还没有动画输入备份。');
    const text=await readFile(vscode.Uri.parse(value).fsPath,'utf8');
    const uri=vscode.Uri.parse(`code-swarm-preview:/input-backup/${Date.now()}/before.txt`);this.previews.set(uri.toString(),text);
    await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri),{preview:false});
  }
  async showOverlayStatus(){
    if(!this.overlay)throw new Error('尚未开启原生覆盖。');
    const info=await this.overlay.saveDiagnostics();
    const positioning=info.hybrid.calibrations?`混合动画 ${info.hybrid.batches} 批 · 定位 ${info.hybrid.calibrations} 次 · ${info.hybrid.lastReason}`:`${info.lastProbe.found}/${info.lastProbe.requested} 个定位点`;
    void vscode.window.showInformationMessage(`Code Swarm: ${positioning}；${info.document.dirty?'编辑器有未保存内容':'文档已保存'}。状态记录已保存。`);
  }

  async previewEdit(input: ProposalInput) {
    if(this.managed?.active)throw new Error('请先结束动画输入，再预览补丁。');
    if (this.applying || this.preparing) throw new Error('正在准备或提交上一份补丁，请稍后。');
    this.preparing = true;
    try { return await this.preparePreview(input); }
    finally { this.preparing = false; }
  }
  private async preparePreview(input: ProposalInput) {
    if (!input || !this.target || input.uri !== this.target.uri.toString()) throw new Error('补丁只能针对已监听的文件。');
    this.flush();
    const before = this.target.getText();
    assertText(input.afterText);
    const eol = this.target.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n';
    const after = validateProposal(before, this.target.version, input.expectedVersion, input.afterText.replace(/\r\n|\r|\n/g, eol));
    const p: Proposal = { id: String(++this.serial), uri: input.uri, version: this.target.version, before, after,
      agent: safeLabel(input.agent, 'Adapter'), label: safeLabel(input.label, 'AI 补丁') };
    this.proposal = p;
    this.previews.clear();
    const left = vscode.Uri.parse(`code-swarm-preview:/${p.id}/before.txt`);
    const right = vscode.Uri.parse(`code-swarm-preview:/${p.id}/after.txt`);
    this.previews.set(left.toString(), before); this.previews.set(right.toString(), after);
    if(!this.overlay)await this.open();
    if (this.proposal !== p || !this.target) throw new Error('预览已取消或文档已变化，请重试。');
    this.push(replay({ file: vscode.workspace.asRelativePath(this.target.uri), before, after, source: 'proposal', attribution: p.agent, label: `预览（尚未应用）· ${p.label}` }));
    await vscode.commands.executeCommand('vscode.diff', left, right, `Code Swarm · ${p.label} · 尚未应用`, { preview: true });
    if (this.proposal !== p) throw new Error('预览期间文档已变化，请重新生成补丁。');
    this.state();
    return { proposalId: p.id, expectedVersion: p.version };
  }
  async importProposal() {
    if (!this.target) throw new Error('请先监听一个代码文件。');
    const selection = await vscode.window.showOpenDialog({ canSelectMany: false, filters: { 'Swarm proposal': ['json'] }, title: '选择 AI 补丁 JSON（目标始终是当前监听文件）' });
    if (!selection?.[0]) return;
    const stat = await vscode.workspace.fs.stat(selection[0]);
    if (stat.size > 500_000) throw new Error('补丁 JSON 过大。');
    const value = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(selection[0])).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('补丁 JSON 必须是对象。');
    await this.previewEdit({ uri: this.target.uri.toString(), expectedVersion: value.expectedVersion ?? this.target.version,
      afterText: value.afterText, agent: value.agent, label: value.label });
  }
  async previewCurrentJson(){
    if(!this.target)throw new Error('请先监听目标代码文件。');
    const json=vscode.window.activeTextEditor?.document;
    if(!json||json.getText().length>500000)throw new Error('请先打开补丁 JSON 文件。');
    const value=JSON.parse(json.getText());
    await this.previewEdit({uri:this.target.uri.toString(),expectedVersion:value.expectedVersion??this.target.version,
      afterText:value.afterText,agent:value.agent,label:value.label});
  }
  async applyProposal() {
    if(this.managed?.active)throw new Error('请先结束动画输入。');
    if (this.preparing) throw new Error('差异预览仍在准备中，请稍后再应用。');
    if (this.applying) return false;
    const p = this.proposal, doc = this.target;
    if (!p || !doc) throw new Error('没有有效的补丁。请先导入并查看预览。');
    if (!vscode.workspace.isTrusted) throw new Error('工作区尚未受信任，当前仅允许只读预览。');
    this.applying = true;
    try {
      const editor = await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.One, preview: false });
      // Recheck after the await, then TextEditor.edit carries the document version to VS Code.
      if (doc.isClosed || doc.version !== p.version || doc.getText() !== p.before || this.proposal !== p) {
        throw new Error('文件已变化，补丁已过期。请重新预览。');
      }
      this.flush();
      this.writing = { agent: p.agent, text: p.after, version: p.version + 1 };
      const ok = await editor.edit(builder => builder.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(p.before.length)), p.after),
        { undoStopBefore: true, undoStopAfter: true });
      if (!ok) throw new Error('VS Code 拒绝了编辑，可能存在并发修改。请重新预览。');
      this.flush(); this.proposal = undefined;
      this.send({ type: 'proposal', proposal: null });
      this.send({ type: 'notice', text: '补丁已应用到编辑器缓冲区。可 Ctrl+Z 撤销；保存遵循你的 VS Code 设置。' });
      return true;
    } finally { this.writing = undefined; this.applying = false; }
  }
  status() {
    return { mode: this.mode, uri: this.target?.uri.toString(), version: this.target?.version,
      history: this.history.all(), pending: Boolean(this.proposal), panelOpen: Boolean(this.panel), nativeOverlay:Boolean(this.overlay),animatedInput:this.managed?.status() };
  }
  dispose() { this.reset(); this.panel?.dispose(); for (const d of this.disposables) d.dispose(); }
}

interface AnimatedEditParameters {afterText:string;targetFile?:string;summary?:string}

/** Copilot Agent entry point: route its proposed full-file output through managed animation. */
class SwarmAnimatedEditTool implements vscode.LanguageModelTool<AnimatedEditParameters>{
  constructor(private readonly controller:SwarmController){}
  prepareInvocation(options:vscode.LanguageModelToolInvocationPrepareOptions<AnimatedEditParameters>){
    const doc=vscode.window.activeTextEditor?.document;
    const target=options.input.targetFile?.trim()||(doc?vscode.workspace.asRelativePath(doc.uri):'当前活动代码文件');
    const summary=options.input.summary?.trim();
    return {
      invocationMessage:`Code Swarm 正在动画写入 ${target}`,
      confirmationMessages:{
        title:'确认通过 Code Swarm 写入代码',
        message:new vscode.MarkdownString(`将把 AI 提供的完整文件内容，通过动画输入写入当前编辑器 **${target}**。${summary?`\n\n操作说明：${summary}`:''}\n\n写入前会保留本地备份；完成后仍由你决定是否保存。`)
      }
    };
  }
  async invoke(options:vscode.LanguageModelToolInvocationOptions<AnimatedEditParameters>,token:vscode.CancellationToken){
    if(!vscode.workspace.isTrusted)throw new Error('请先信任当前工作区，再使用动画写入。');
    const editor=vscode.window.activeTextEditor;
    if(!editor||editor.document.uri.scheme!=='file')throw new Error('请先在编辑器中打开并聚焦要写入的本地代码文件，再从 Copilot 聊天调用此工具。');
    const document=editor.document,expectedVersion=document.version;
    assertText(options.input.afterText);
    const stream=new SourceTextStream();
    stream.push(options.input.afterText);
    const afterText=stream.finish();assertText(afterText);
    if(!afterText.trim())throw new Error('没有收到完整代码。请让 AI 将修改后的完整文件内容传给动画写入工具。');
    const target=options.input.targetFile?.trim();
    if(target){
      const normalized=(value:string)=>value.replace(/\\/g,'/').replace(/^\.\//,'').toLocaleLowerCase();
      const candidates=[document.uri.fsPath,vscode.workspace.asRelativePath(document.uri),document.uri.path.split('/').at(-1)??''];
      if(!candidates.some(value=>normalized(value)===normalized(target)))throw new Error(`目标文件不匹配。当前活动文件是 ${vscode.workspace.asRelativePath(document.uri)}；请聚焦目标文件后重试。`);
    }
    if(afterText===document.getText())throw new Error('当前文件已经等于 AI 输出，没有剩余差异可播放。请在 AI 使用普通编辑工具之前调用 Code Swarm 动画写入。');
    const session=await this.controller.beginAnimatedInput({uri:document.uri.toString(),expectedVersion});
    const cancel=token.onCancellationRequested(()=>this.controller.stopAnimatedInput(session.id));
    try{
      this.controller.updateAnimatedInput(session.id,afterText);
      const result=await this.controller.finishAnimatedInput(session.id);
      if(result.state!=='completed')throw new Error(result.reason||'动画写入未完成。');
      return new vscode.LanguageModelToolResult([new vscode.LanguageModelTextPart(`已将 ${vscode.workspace.asRelativePath(document.uri)} 通过 Code Swarm 动画写入完成，共 ${result.metrics.edits} 次编辑；内容尚未保存。`)]);
    }finally{cancel.dispose();if(token.isCancellationRequested)this.controller.stopAnimatedInput(session.id);}
  }
}

export function activate(context: vscode.ExtensionContext) {
  const controller = new SwarmController(context);
  context.subscriptions.push(controller);
  context.subscriptions.push(vscode.lm.registerTool('code-swarm-animate_edit',new SwarmAnimatedEditTool(controller)));
  for (const [name, fn] of Object.entries({ open: () => controller.open(), demo: () => controller.demo(),
    attach: () => controller.attach(undefined,process.platform==='win32'&&vscode.workspace.getConfiguration('codeSwarm').get('presentation','native')==='native'),
    overlayStart:()=>controller.attach(undefined,true),overlayDemo:()=>controller.demoOverlay(),overlayReplay:()=>controller.replayOverlay(),
    cardsDemo:()=>controller.demoOverlay('cards'),
    overlayStatus:()=>controller.showOverlayStatus(),
    resumeFollow:()=>controller.resumeFollow(),
    chooseInput:()=>controller.chooseInput(),streamAi:()=>controller.streamAiIntoEditor(),startStaging:()=>controller.startStaging(),finishStaging:()=>controller.finishStaging(),
    animatedScript:()=>controller.startAnimatedScript(),pauseAnimatedInput:()=>controller.pauseAnimatedInput(),resumeAnimatedInput:()=>controller.resumeAnimatedInput(),stopAnimatedInput:()=>controller.stopAnimatedInput(),openInputBackup:()=>controller.openInputBackup(),
    previewCurrentJson:()=>controller.previewCurrentJson(),
    detach: () => controller.detach(), importProposal: () => controller.importProposal(), applyProposal: () => controller.applyProposal() })) {
    context.subscriptions.push(vscode.commands.registerCommand(`codeSwarm.${name}`, fn));
  }
  return {
    /** Provider-neutral adapter: no model keys, network calls or automatic approval. */
    previewEdit: (input: ProposalInput) => controller.previewEdit(input),
    attach: (uri: vscode.Uri) => controller.attach(uri),
    getStatus: () => controller.status(),
    startOverlay:(uri:vscode.Uri)=>controller.attach(uri,true),
    playOverlay:()=>controller.demoOverlay(),
    getOverlayStatus:()=>controller.overlayStatus(),
    beginAnimatedInput:(input:{uri:string;expectedVersion:number})=>controller.beginAnimatedInput(input),
    updateAnimatedInput:(id:string,text:string)=>controller.updateAnimatedInput(id,text),
    finishAnimatedInput:(id:string)=>controller.finishAnimatedInput(id),
    startAnimatedScript:(input:{uri:string;expectedVersion:number;script:string;speed?:string})=>controller.startAnimatedScript(input),
    flush: () => controller.flush()
  };
}
