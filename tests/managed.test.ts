import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir,readFile,writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const wait=(n:number)=>new Promise(r=>setTimeout(r,n));
async function until(predicate:()=>boolean,timeout=5000){const end=Date.now()+timeout;while(!predicate()&&Date.now()<end)await wait(30);assert.ok(predicate(),'timed out waiting for managed input');}

export async function run(){
  const extension=vscode.extensions.getExtension('code-swarm-local.code-swarm-prototype')!,api=await extension.activate();
  await vscode.workspace.getConfiguration('editor').update('fontSize',19,vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('editor').update('lineHeight',23,vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('files').update('autoSave','off',vscode.ConfigurationTarget.Workspace);
  await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle','hybrid',vscode.ConfigurationTarget.Workspace);
  const folder=vscode.workspace.workspaceFolders![0].uri.fsPath;
  if(process.env.SWARM_CMD_ONLY){
    const profile=join(folder,'cmd-profile');
    await mkdir(join(profile,'Desktop'),{recursive:true});
    const uri=vscode.Uri.file(join(profile,'Desktop','ytg.py'));
    const original='# CMD original\n';
    await writeFile(uri.fsPath,original);
    const doc=await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc,{preview:false});
    await api.startOverlay(uri);
    const child=spawn('python',[process.env.SWARM_CMD_SCRIPT!,'--speed','turbo'],{
      env:{...process.env,USERPROFILE:profile,PYTHONIOENCODING:'utf-8'},windowsHide:true
    });
    child.stdout.resume();let errors='';child.stderr.on('data',chunk=>errors+=chunk);
    const timer=setTimeout(()=>child.kill(),360000);
    const started=Date.now();
    try{
      const code=await new Promise<number|undefined>((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      assert.equal(code,0,errors);
    }finally{clearTimeout(timer);}
    const result=api.getStatus().animatedInput;
    console.log('CMD_STREAM_RESULT',JSON.stringify({elapsedMs:Date.now()-started,lines:doc.lineCount,...result}));
    assert.equal(result.state,'completed');
    assert.ok(result.metrics.received>35&&result.metrics.edits>100);
    assert.ok(doc.lineCount>1500);
    assert.equal(await readFile(uri.fsPath,'utf8'),original);
    return;
  }
  const uri=vscode.Uri.file(join(folder,'animated-real-input.py'));
  const original='# ORIGINAL PRESERVED\nseed = 7\n';await writeFile(uri.fsPath,original);
  const doc=await vscode.workspace.openTextDocument(uri);let editor=await vscode.window.showTextDocument(doc,{preview:false});
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  if(process.env.SWARM_FOCUS_WAIT)await wait(Number(process.env.SWARM_FOCUS_WAIT));
  const info=await api.beginAnimatedInput({uri:uri.toString(),expectedVersion:doc.version});
  const changes:string[]=[];let ungated=false;
  const observation=vscode.workspace.onDidChangeTextDocument(e=>{if(e.document===doc&&e.contentChanges.length){changes.push(doc.getText());if(!api.getStatus().animatedInput.metrics.signals)ungated=true;}});
  const desired=original+Array.from({length:30},(_,i)=>`value_${i} = "中文😀_${i}"\n`).join('');
  api.updateAnimatedInput(info.id,desired);assert.equal(doc.getText(),original,'offered input is held before animation');
  const diagnostic=setInterval(()=>{console.log('MANAGED_WAIT',JSON.stringify(api.getStatus().animatedInput));void api.getOverlayStatus().then((s:unknown)=>console.log('MANAGED_OVERLAY',JSON.stringify(s)));},2000);
  const completed=await Promise.race([api.finishAnimatedInput(info.id),wait(20000).then(()=>{throw new Error('managed input timeout');})]).finally(()=>clearInterval(diagnostic));observation.dispose();
  console.log('MANAGED_COMPLETE',JSON.stringify(completed));
  assert.equal(completed.state,'completed');assert.equal(doc.getText(),desired);assert.equal(ungated,false);
  assert.ok(changes.length>1);assert.ok(changes.some(s=>s.length>original.length&&s.length<desired.length),'real buffer contains intermediate typing states');
  assert.equal(await readFile(uri.fsPath,'utf8'),original,'managed input does not save target');
  assert.equal(await readFile(vscode.Uri.parse(info.backup).fsPath,'utf8'),original);
  await vscode.commands.executeCommand('codeSwarm.openInputBackup');assert.equal(vscode.window.activeTextEditor?.document.uri.scheme,'code-swarm-preview');assert.equal(vscode.window.activeTextEditor?.document.getText(),original);
  editor=await vscode.window.showTextDocument(doc,{preview:false});
  let overlay=await api.getOverlayStatus();assert.ok(overlay.process.performedActs>=1);assert.ok(overlay.process.actSignals>0);
  assert.ok(overlay.process.seenMotions.length>=5,'classic mixed choreography is preserved');assert.ok(overlay.process.maxActive>=8,'many cursors work in parallel');
  await vscode.commands.executeCommand('undo');assert.equal(doc.getText(),original,'one undo restores entire input session');
  console.log('PASS held input, native-paint checkpoints, intermediate real edits, exact Unicode, backup, no implicit save and one undo');

  const interrupted=await api.beginAnimatedInput({uri:uri.toString(),expectedVersion:doc.version});
  api.updateAnimatedInput(interrupted.id,desired.repeat(5));await until(()=>api.getStatus().animatedInput.metrics.edits>0);
  await editor.edit(b=>b.insert(new vscode.Position(0,0),'# HUMAN EDIT\n'));
  const human=doc.getText();await wait(400);
  assert.equal(api.getStatus().animatedInput.state,'conflict');assert.equal(doc.getText(),human,'concurrent human edit is retained');
  console.log('PASS concurrent human editing stops queued writes without rollback');

  const diskUri=vscode.Uri.file(join(folder,'animated-disk-conflict.py'));await writeFile(diskUri.fsPath,original);
  const diskDoc=await vscode.workspace.openTextDocument(diskUri);await vscode.window.showTextDocument(diskDoc,{preview:false});
  const conflict=await api.beginAnimatedInput({uri:diskUri.toString(),expectedVersion:diskDoc.version});
  api.updateAnimatedInput(conflict.id,desired.repeat(4));await until(()=>api.getStatus().animatedInput.metrics.edits>0);
  await writeFile(diskUri.fsPath,'# EXTERNAL DISK VERSION\n');await wait(350);
  await vscode.commands.executeCommand('codeSwarm.resumeAnimatedInput');await wait(150);
  assert.equal(await readFile(diskUri.fsPath,'utf8'),'# EXTERNAL DISK VERSION\n');assert.equal(api.getStatus().animatedInput.state,'conflict');
  console.log('PASS external disk collision halts animation without overwriting disk');

  const script=join(folder,'tiny-producer.py'),protectedPath=join(folder,'producer-original-target.py');await writeFile(protectedPath,'PROTECTED ORIGINAL TARGET');
  const finalText='class LiveInput:\n    greeting = "hello 😀"\n    ready = True\n';
  await writeFile(script,`import time\nTARGET_FILE = ${JSON.stringify(protectedPath)}\ndef run_streaming_pipeline():\n    with open(TARGET_FILE, 'w', encoding='utf-8') as f:\n        f.write('')\n    time.sleep(.15)\n    with open(TARGET_FILE, 'a', encoding='utf-8') as f:\n        for line in ${JSON.stringify(finalText)}.splitlines(True):\n            f.write(line)\n            f.flush()\n            time.sleep(.03)\n`);
  const scriptUri=vscode.Uri.file(join(folder,'animated-script-output.py'));await writeFile(scriptUri.fsPath,original);
  const scriptDoc=await vscode.workspace.openTextDocument(scriptUri);await vscode.window.showTextDocument(scriptDoc,{preview:false});
  await api.startAnimatedScript({uri:scriptUri.toString(),expectedVersion:scriptDoc.version,script});
  await until(()=>!['running','paused'].includes(api.getStatus().animatedInput.state),10000);
  assert.equal(api.getStatus().animatedInput.state,'completed');assert.equal(scriptDoc.getText(),finalText);
  assert.equal(await readFile(protectedPath,'utf8'),'PROTECTED ORIGINAL TARGET');assert.equal(await readFile(scriptUri.fsPath,'utf8'),original);
  console.log('PASS producer is redirected before target writes, genuine animated input changes only editor buffer');

  await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle','cards',vscode.ConfigurationTarget.Workspace);
  const cards=await api.beginAnimatedInput({uri:scriptUri.toString(),expectedVersion:scriptDoc.version});
  api.updateAnimatedInput(cards.id,finalText+'# controlled regardless of observer style\n');
  const cardsDone=await Promise.race([api.finishAnimatedInput(cards.id),wait(10000).then(()=>{throw new Error('cards setting interrupted controlled input');})]);
  assert.equal(cardsDone.state,'completed');await vscode.workspace.getConfiguration('codeSwarm').update('animationStyle','hybrid',vscode.ConfigurationTarget.Workspace);
  console.log('PASS controlled input is independent of observer animation style');

  const stagedTarget=vscode.Uri.file(join(folder,'general-input.ts'));
  await writeFile(stagedTarget.fsPath,'// start\n');
  const stagedDoc=await vscode.workspace.openTextDocument(stagedTarget);
  await vscode.window.showTextDocument(stagedDoc,{preview:false});
  const previousClipboard=await vscode.env.clipboard.readText();
  await vscode.commands.executeCommand('codeSwarm.startStaging');
  const stagedPath=await vscode.env.clipboard.readText();
  await vscode.env.clipboard.writeText(previousClipboard);
  assert.notEqual(stagedPath,stagedTarget.fsPath);
  const generated='// start\n'+Array.from({length:36},(_,i)=>`const item${i} = ${i};\n`).join('');
  await writeFile(stagedPath,generated);
  await until(()=>stagedDoc.getText()!=='// start\n'&&stagedDoc.getText()!==generated,10000);
  const stagedResult:any=await vscode.commands.executeCommand('codeSwarm.finishStaging');
  assert.equal(stagedResult.state,'completed');
  assert.equal(stagedDoc.getText(),generated);
  assert.equal(await readFile(stagedTarget.fsPath,'utf8'),'// start\n');
  console.log('PASS generic staged external write, incremental editor input, exact final content');
  if(process.env.SWARM_CMD_SCRIPT){
    const profile=join(folder,'cmd-profile');
    await mkdir(join(profile,'Desktop'),{recursive:true});
    const uri=vscode.Uri.file(join(profile,'Desktop','ytg.py'));
    await writeFile(uri.fsPath,original);
    const doc=await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc,{preview:false});
    await api.startOverlay(uri);
    const child=spawn('python',[process.env.SWARM_CMD_SCRIPT,'--speed','turbo'],{
      env:{...process.env,USERPROFILE:profile,PYTHONIOENCODING:'utf-8'},windowsHide:true
    });
    child.stdout.resume();
    let errors='';child.stderr.on('data',chunk=>errors+=chunk);
    const timer=setTimeout(()=>child.kill(),360000);
    try{
      const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
      assert.equal(code,0,errors);
    }finally{clearTimeout(timer);}
    const result=api.getStatus().animatedInput;
    console.log('CMD_RESULT',JSON.stringify(result));
    assert.equal(result.state,'completed');
    assert.ok(result.metrics.received>35);
    assert.ok(result.metrics.edits>100&&doc.lineCount>1500);
    assert.equal(await readFile(uri.fsPath,'utf8'),original);
    console.log('CMD_COMPLETE',JSON.stringify({lines:doc.lineCount,...result.metrics}));
  }
  if(process.env.SWARM_MANAGED_SCRIPT){
    const source=process.env.SWARM_MANAGED_SCRIPT,sourceBytes=await readFile(source);
    const fullUri=vscode.Uri.file(join(folder,'animated-full-pipeline.py'));await writeFile(fullUri.fsPath,original);
    const fullDoc=await vscode.workspace.openTextDocument(fullUri);await vscode.window.showTextDocument(fullDoc,{preview:false});
    await api.startAnimatedScript({uri:fullUri.toString(),expectedVersion:fullDoc.version,script:source,speed:'turbo'});
    const end=Date.now()+180000;let samples=0,intermediate=0;
    while(['running','paused'].includes(api.getStatus().animatedInput.state)&&Date.now()<end){
      await wait(350);samples++;if(fullDoc.getText()!==original&&api.getStatus().animatedInput.queued)intermediate++;
      if(samples%25===0)console.log('MANAGED_PROGRESS',JSON.stringify(api.getStatus().animatedInput));
      if(api.getStatus().animatedInput.state==='paused'){
        await wait(350);
        if(api.getStatus().animatedInput.state==='paused'&&!api.getStatus().animatedInput.pausedForFocus){console.log('MANAGED_PAUSED_OVERLAY',JSON.stringify(await api.getOverlayStatus()));assert.fail('input unexpectedly paused: '+JSON.stringify(api.getStatus().animatedInput));}
      }
    }
    const result=api.getStatus().animatedInput;console.log('MANAGED_FULL_FINAL',JSON.stringify({...result,lines:fullDoc.lineCount,samples,intermediate}));
    assert.equal(result.state,'completed');const inbox=await readFile(vscode.Uri.parse(result.incoming).fsPath,'utf8');
    assert.equal(fullDoc.getText(),inbox.replace(/\r\n|\r|\n/g,fullDoc.eol===vscode.EndOfLine.CRLF?'\r\n':'\n'));
    assert.ok(fullDoc.lineCount>1500);assert.ok(result.metrics.edits>100);assert.ok(intermediate>10);
    assert.equal(await readFile(fullUri.fsPath,'utf8'),original);assert.deepEqual(await readFile(source),sourceBytes);
    await vscode.commands.executeCommand('undo');assert.equal(fullDoc.getText(),original);
    console.log('PASS full original producer, intercepted target writes, animated real buffer, exact final content, original disk unchanged and one undo');
  }
  await vscode.commands.executeCommand('codeSwarm.detach');
  console.log('CODE_SWARM_MANAGED_TESTS_PASSED');
}

