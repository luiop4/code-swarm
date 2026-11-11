import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
const wait=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function untilOverlay(api:any,predicate:(s:any)=>boolean){
  let state:any;
  for(let i=0;i<40;i++){state=await api.getOverlayStatus();if(predicate(state))return state;await wait(50);}
  assert.fail('overlay did not reach expected state: '+JSON.stringify(state));
}
export async function run(){
  const extension=vscode.extensions.getExtension('code-swarm-local.code-swarm-prototype')!;
  const api=await extension.activate();
  await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle','cards',vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('editor').update('fontSize',19,vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('editor').update('lineHeight',23,vscode.ConfigurationTarget.Workspace);
  const folder=vscode.workspace.workspaceFolders![0].uri.fsPath;
  const uri=vscode.Uri.file(join(folder,'native-overlay-fixture.py'));
  const code=Array.from({length:18},(_,i)=>`def worker_${i}(task):\n    return {"worker": ${i}, "task": task}\n\n`).join('\n');
  await writeFile(uri.fsPath,code);
  const doc=await vscode.workspace.openTextDocument(uri);
  await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,preview:false});
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  if(process.env.SWARM_FOCUS_WAIT)await wait(Number(process.env.SWARM_FOCUS_WAIT));
  await api.startOverlay(uri);await wait(1000);
  await api.playOverlay();await wait(600);
  let state=await api.getOverlayStatus();
  console.log('OVERLAY_FIRST',JSON.stringify(state));
  assert.ok(state.lastProbe.found>0,'native pixel anchors found in actual VS Code');
  assert.ok(state.process.jobs>0,'native jobs scheduled');assert.equal(state.process.pointerSize,12);
  assert.equal(state.process.styleName,'cards');assert.ok(state.process.jobs>=20,'large paste has many assembly cards');
  assert.ok(state.process.visibleCards>=18,'a full card scene is visible');
  assert.ok(state.process.sceneDuration<3.1,'default card scene uses the faster speed');
  assert.equal(api.getStatus().panelOpen,false,'native experience opens no webview');
  assert.equal(doc.getText(),code);assert.equal(await readFile(uri.fsPath,'utf8'),code);
  console.log('PASS native overlay anchors, small pointers, no side stage, demo leaves source untouched');
  await api.playOverlay();state=await api.getOverlayStatus();assert.ok(state.process.ghosts>0,'scene handoff keeps departing cards');
  console.log('PASS floating card scene handoff preserves continuity');
  if(process.env.SWARM_VISUAL_HOLD==='1')for(let i=0;i<5;i++){await api.playOverlay();await wait(3500);}
  const editor=await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,preview:false});
  editor.revealRange(new vscode.Range(45,0,45,0),vscode.TextEditorRevealType.AtTop);await wait(250);
  state=await api.getOverlayStatus();assert.equal(state.process.visiblePointers,0);assert.equal(state.process.visible,false);
  console.log('PASS scrolling cancels stale overlay immediately');
  await editor.edit(b=>b.replace(new vscode.Range(45,0,45,doc.lineAt(45).text.length),'    return {"status": "reviewed", "task": task}'));
  api.flush();await wait(700);
  state=await api.getOverlayStatus();console.log('OVERLAY_LIVE',JSON.stringify(state));assert.ok(state.lastProbe.found>0);assert.ok(state.process.jobs>0);
  assert.equal(await readFile(uri.fsPath,'utf8'),code,'visual layer never writes buffers to disk');
  console.log('PASS actual native buffer edit triggers overlay');
  await editor.edit(b=>b.delete(new vscode.Range(45,0,46,0)));api.flush();await wait(700);
  state=await api.getOverlayStatus();assert.ok(state.process.jobs>0);
  assert.ok(api.getStatus().history.at(-1).tasks.some((t:{kind:string})=>t.kind==='delete'));
  console.log('PASS deletion replay uses a ghost fragment instead of striking live text');
  await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle','hybrid',vscode.ConfigurationTarget.Workspace);
  await api.startOverlay(uri);await wait(500);
  // Keep focus in another VS Code surface while updating a visible source document.
  await vscode.commands.executeCommand('workbench.action.chat.open');await wait(200);
  const samples:any[]=[];
  for(let i=0;i<80;i++){
    const edit=new vscode.WorkspaceEdit();
    edit.replace(uri,doc.lineAt(47).range,'# streaming: '+'x'.repeat(i+1));
    assert.ok(await vscode.workspace.applyEdit(edit));await wait(22);
    if(i===35){await vscode.commands.executeCommand('workbench.view.explorer');await wait(100);}
    if(i>0&&i%10===0)samples.push(await api.getOverlayStatus());
  }
  console.log('STREAM_DURING',JSON.stringify(samples.map(s=>({hybrid:s.hybrid,process:s.process}))));
  assert.ok(samples.some(s=>s.hybrid.batches>=3&&s.process.visiblePointers>0),'stream renders before producer stops, even with sidebar focus');
  assert.ok(samples.some(s=>s.process.typeMerges>0),'typing extends existing caret trajectories');
  assert.ok(samples.some(s=>s.process.typingFrames>20&&s.process.typingDistance>20),'typing actually advances across rendered frames during rapid updates');
  assert.ok(samples.some(s=>s.process.visuals.type>0),'stream uses typing cues');
  assert.ok(samples.every(s=>s.process.jobs<=96),'continuous rendering remains bounded');
  assert.ok(samples.at(-1).hybrid.calibrations<=6,'stream reuses geometry rather than probing every chunk');
  assert.ok(samples.at(-1).hybrid.origin.x>samples[0].hybrid.origin.x+100,'opening sidebar refreshes horizontal placement');
  assert.equal(await readFile(uri.fsPath,'utf8'),code,'stream animation never saves source');
  console.log('PASS continuous stream with chat focus and sidebar geometry refresh');
  await wait(1000);
  let edit=new vscode.WorkspaceEdit();edit.replace(uri,doc.lineAt(47).range,'# changed to something different');await vscode.workspace.applyEdit(edit);api.flush();await wait(250);
  state=await untilOverlay(api,s=>s.process.visuals?.edit>0);assert.ok(state.process.visuals.edit>0,'replacement uses selection animation');
  console.log('PASS small replacement uses selection cue');
  await wait(850);
  edit=new vscode.WorkspaceEdit();edit.delete(uri,new vscode.Range(47,0,48,0));await vscode.workspace.applyEdit(edit);api.flush();await wait(250);
  state=await untilOverlay(api,s=>s.process.visuals?.erase>0);console.log('HYBRID_DELETE',JSON.stringify(state));
  assert.ok(state.process.visuals.erase>0,'deletion uses red ghost wipe');assert.equal(state.process.visibleCards,0,'deletion never creates a floating card');
  console.log('PASS hybrid deletion has no floating card');
  await wait(950);
  edit=new vscode.WorkspaceEdit();
  edit.insert(uri,new vscode.Position(47,0),Array.from({length:12},(_,i)=>`batch_${i} = ${i}\n`).join(''));
  edit.delete(uri,new vscode.Range(41,0,42,0));
  await vscode.workspace.applyEdit(edit);api.flush();await wait(300);
  state=await untilOverlay(api,s=>s.process.visuals?.card>=12&&s.process.visuals?.erase>0);console.log('HYBRID_BULK',JSON.stringify(state));
  assert.ok(state.process.visuals.card>=12,'large insert retains a swarm of floating cards');
  assert.ok(state.process.visuals.erase>0,'deletion coexists with cards using its own visual');
  console.log('PASS one batch mixes large-paste cards with frameless deletion');
  const batchesBeforeRebind=state.hybrid.batches;
  const rebound=await vscode.languages.setTextDocumentLanguage(doc,'plaintext');await wait(100);
  assert.equal(api.getStatus().uri,uri.toString());assert.equal(api.getStatus().nativeOverlay,true,'model replacement retains watch');
  edit=new vscode.WorkspaceEdit();edit.insert(uri,new vscode.Position(47,0),'# rebound\n');await vscode.workspace.applyEdit(edit);api.flush();await wait(300);
  state=await untilOverlay(api,s=>s.hybrid.batches>batchesBeforeRebind);assert.ok(state.hybrid.batches>batchesBeforeRebind,'model replacement continues capture');
  assert.equal(rebound.getText(),api.getStatus().history.at(-1).after);
  console.log('PASS language/model replacement preserves URI watch and capture');
  await wait(6500);state=await api.getOverlayStatus();assert.equal(state.process.visiblePointers,0);assert.equal(state.process.visible,false);
  console.log('PASS completed and idle workers fully hidden');
  const tailEditor=await vscode.window.showTextDocument(rebound,{preview:false});
  tailEditor.revealRange(new vscode.Range(0,0,0,0),vscode.TextEditorRevealType.AtTop);await wait(100);
  await api.startOverlay(uri);await wait(100);
  const initialSelection=tailEditor.selection;
  const tailSamples:any[]=[];
  for(let i=0;i<120;i++){
    const burst=new vscode.WorkspaceEdit();
    burst.insert(uri,rebound.positionAt(rebound.getText().length),Array.from({length:4},(_,j)=>`# fast_stream_${i}_${j}\n`).join(''));
    assert.ok(await vscode.workspace.applyEdit(burst));await wait(8);
    if(i>0&&i%20===0)tailSamples.push(await api.getOverlayStatus());
  }
  api.flush();
  state=await untilOverlay(api,s=>s.hybrid.batches>0&&(tailEditor.visibleRanges.at(-1)?.end.line??0)>=rebound.lineCount-2);
  console.log('FOLLOW_TAIL',JSON.stringify({state,samples:tailSamples.map(s=>s.hybrid),view:tailEditor.visibleRanges.map(r=>[r.start.line,r.end.line]),lines:rebound.lineCount}));
  assert.ok(state.hybrid.followScrolls>=2,'fast multiline stream follows beyond the initial viewport');
  assert.ok(tailSamples.some(s=>s.hybrid.batches>=2&&s.process.visiblePointers>0),'visible animation runs while fast multiline producer is active');
  assert.deepEqual(tailEditor.selection,initialSelection,'follow only moves viewport, preserving real caret and selection');
  tailEditor.revealRange(new vscode.Range(0,0,0,0),vscode.TextEditorRevealType.AtTop);await wait(100);
  state=await untilOverlay(api,s=>s.hybrid.followPaused===true);
  const pausedScrolls=state.hybrid.followScrolls;
  let burst=new vscode.WorkspaceEdit();burst.insert(uri,rebound.positionAt(rebound.getText().length),'# do_not_steal_scroll\n');await vscode.workspace.applyEdit(burst);api.flush();await wait(400);
  state=await api.getOverlayStatus();assert.equal(state.hybrid.followScrolls,pausedScrolls);assert.ok(tailEditor.visibleRanges[0].start.line<5,'manual upward reading is respected');
  await vscode.commands.executeCommand('codeSwarm.resumeFollow');
  assert.ok((tailEditor.visibleRanges.at(-1)?.end.line??0)>=rebound.lineCount-2,'resume command reveals latest code');
  assert.equal(await readFile(uri.fsPath,'utf8'),code,'automatic scrolling never saves source');
  console.log('PASS fast multiline follow, actual frame progress, selection preservation, manual pause and resume');
  if(process.env.SWARM_STREAM_SCRIPT){
    const original=await readFile(process.env.SWARM_STREAM_SCRIPT);
    const external=vscode.Uri.file(join(folder,'external-generator-fixture.py'));
    await writeFile(external.fsPath,'');const externalDoc=await vscode.workspace.openTextDocument(external);
    await vscode.window.showTextDocument(externalDoc,{preview:false});await api.startOverlay(external);await wait(250);
    const child=spawn('python',[join(extension.extensionPath,'scripts','run-stream-fixture.py'),process.env.SWARM_STREAM_SCRIPT,external.fsPath,process.env.SWARM_STREAM_SPEED??'normal'],{cwd:extension.extensionPath,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let childError='',rendered=0,during=0;child.stderr.on('data',b=>{childError+=String(b);});child.stdout.resume();
    const deadline=Date.now()+180000;const externalSamples:any[]=[];
    try{
      while(child.exitCode===null&&Date.now()<deadline){
        await wait(350);const sample=await api.getOverlayStatus();during++;
        if(sample.process.visible&&sample.process.painted>0)rendered++;
        if(during%20===0){externalSamples.push({disk:sample.disk,hybrid:sample.hybrid,painted:sample.process.painted,motions:sample.process.seenMotions});console.log('EXTERNAL_PROGRESS',JSON.stringify(externalSamples.at(-1)));}
      }
      if(child.exitCode===null)throw new Error('isolated generator timed out');
      assert.equal(child.exitCode,0,childError);await wait(1500);
      state=await api.getOverlayStatus();const final=await readFile(external.fsPath,'utf8');
      console.log('EXTERNAL_FINAL',JSON.stringify({disk:state.disk,hybrid:state.hybrid,process:state.process,rendered,during,lines:final.split('\n').length,editorLines:externalDoc.lineCount}));
      assert.ok(state.disk.changes>20,'disk sampler sees real fsync writes');
      assert.ok(state.hybrid.diskBatches>5,'unsynchronized disk changes animate independently');
      assert.ok(rendered>10,'actual painter renders throughout the external producer');
      assert.ok(rendered/during>.6,'external stream is visibly rendered in most foreground samples');
      assert.ok(state.hybrid.calibrations<during*.55+5,'recalibration is rate-limited while disk streaming');
      assert.ok(state.process.seenMotions.length>=6,'real script uses diverse painted actions');
      assert.ok(state.process.originSides.length>=4,'cards originate from several nearby directions');
      assert.equal(externalDoc.getText(),final,'editor eventually synchronizes with actual disk result');
      assert.equal(externalDoc.isDirty,false,'display never turns external writes into unsaved buffer edits');
      assert.deepEqual(await readFile(process.env.SWARM_STREAM_SCRIPT),original,'user generator is unchanged');
      console.log('PASS original stream_coder pipeline against isolated target, live disk reception, varied painting and exact file synchronization');
    }finally{if(child.exitCode===null)child.kill();}
  }
  await vscode.commands.executeCommand('codeSwarm.detach');assert.equal(api.getStatus().nativeOverlay,false);
  await vscode.workspace.getConfiguration('editor').update('fontSize',undefined,vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('editor').update('lineHeight',undefined,vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle',undefined,vscode.ConfigurationTarget.Workspace);
  console.log('CODE_SWARM_NATIVE_TESTS_PASSED');
}
