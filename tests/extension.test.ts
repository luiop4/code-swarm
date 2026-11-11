import * as vscode from 'vscode';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mkdtemp, writeFile, readFile } from 'node:fs/promises';

export async function run() {
  const dir=await mkdtemp(join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath??tmpdir(),'code-swarm-test-'));
  const uri=vscode.Uri.file(join(dir,'fixture.ts'));
  const original='export const value = 1;\n';await writeFile(uri.fsPath,original);
  const extension=vscode.extensions.getExtension('code-swarm-local.code-swarm-prototype');
  assert.ok(extension,'extension registered');
  const api=await extension.activate();
  await vscode.commands.executeCommand('codeSwarm.demo');
  assert.equal(api.getStatus().history.length,3);
  assert.equal(await readFile(uri.fsPath,'utf8'),original);
  console.log('PASS demo does not write files');

  const doc=await vscode.workspace.openTextDocument(uri);
  await api.attach(uri);assert.equal(api.getStatus().history.length,1);
  let editor=await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,preview:false});
  assert.equal(await editor.edit(b=>b.insert(doc.positionAt(doc.getText().length),'// human edit\n')),true);
  api.flush();assert.equal(api.getStatus().history.at(-1).attribution,'Unattributed');
  assert.equal(api.getStatus().history.at(-1).after,doc.getText());
  console.log('PASS native edit observed without attribution invention');

  const previewText='export const value = 42;\n';
  const baseline=doc.getText();
  await api.previewEdit({uri:uri.toString(),expectedVersion:doc.version,afterText:previewText,agent:'Claude (test adapter)',label:'test patch'});
  assert.equal(doc.getText(),baseline,'preview is read-only');assert.equal(api.getStatus().pending,true);
  assert.equal(await vscode.commands.executeCommand('codeSwarm.applyProposal'),true);
  assert.equal(doc.getText(),previewText);assert.equal(api.getStatus().pending,false);
  assert.equal(api.getStatus().history.at(-1).attribution,'Claude (test adapter)');
  assert.equal(await readFile(uri.fsPath,'utf8'),original,'extension never called save or raw write');
  await vscode.commands.executeCommand('undo');
  assert.equal(doc.getText(),baseline,'one native undo restores pre-proposal buffer');
  console.log('PASS preview, commit, attribution, no implicit save and single-step undo');

  const staleVersion=doc.version;
  await api.previewEdit({uri:uri.toString(),expectedVersion:doc.version,afterText:previewText,agent:'Codex (test adapter)'});
  editor=await vscode.window.showTextDocument(doc,{viewColumn:vscode.ViewColumn.One,preview:false});
  await editor.edit(b=>b.insert(new vscode.Position(0,0),'// concurrent human edit\n'));
  const edited=doc.getText();
  await assert.rejects(async()=>await vscode.commands.executeCommand('codeSwarm.applyProposal'));
  assert.equal(doc.getText(),edited,'stale proposal never overwrites concurrent edit');
  await assert.rejects(()=>api.previewEdit({uri:uri.toString(),expectedVersion:staleVersion,afterText:'bad'}));
  await assert.rejects(()=>api.previewEdit({uri:vscode.Uri.file(join(dir,'other.ts')).toString(),expectedVersion:doc.version,afterText:'bad'}));
  console.log('PASS stale and wrong-target proposals rejected');

  const concurrentPreview=api.previewEdit({uri:uri.toString(),expectedVersion:doc.version,afterText:previewText,agent:'first'});
  await assert.rejects(()=>api.previewEdit({uri:uri.toString(),expectedVersion:doc.version,afterText:'second',agent:'second'}));
  await concurrentPreview;
  assert.equal(doc.getText(),edited,'concurrent previews do not write');
  console.log('PASS overlapping previews rejected to preserve review identity');

  // Clean on-disk fixture: verify external writes surface through VS Code document reload events.
  const externalUri=vscode.Uri.file(join(dir,'external.ts'));await writeFile(externalUri.fsPath,'const external = 1;\n');
  const external=await vscode.workspace.openTextDocument(externalUri);
  await vscode.window.showTextDocument(external);await api.attach(externalUri);
  await new Promise(r=>setTimeout(r,1500)); // Allow VS Code's native disk watcher to register.
  await writeFile(externalUri.fsPath,'const external = 2;\n');
  const deadline=Date.now()+12000;
  while(!external.getText().includes('= 2')&&Date.now()<deadline)await new Promise(r=>setTimeout(r,100));
  assert.ok(external.getText().includes('= 2'),'VS Code reloaded clean external change');
  api.flush();assert.ok(api.getStatus().history.at(-1).after.includes('= 2'));
  console.log('PASS external clean-file modification captured');

  editor=await vscode.window.showTextDocument(external,{viewColumn:vscode.ViewColumn.One,preview:false});
  await editor.edit(b=>b.insert(new vscode.Position(0,0),'// unsaved work\n'));
  const dirtyText=external.getText();
  await writeFile(externalUri.fsPath,'const external = 999;\n');
  await new Promise(r=>setTimeout(r,600));
  assert.equal(external.getText(),dirtyText,'external write does not cause the extension to revert a dirty buffer');
  assert.equal(await readFile(externalUri.fsPath,'utf8'),'const external = 999;\n','animation does not rewrite external disk content');
  console.log('PASS dirty-buffer external conflict never auto-reverted or overwritten');

  // The webview toolbar must be able to attach the visible source even with webview focus.
  const sourceEditor=await vscode.window.showTextDocument(external,{viewColumn:vscode.ViewColumn.One,preview:false});
  await vscode.commands.executeCommand('workbench.action.focusSecondEditorGroup');
  await vscode.commands.executeCommand('codeSwarm.attach');
  assert.equal(api.getStatus().uri,sourceEditor.document.uri.toString());
  console.log('PASS attach command resolves visible source while stage has focus');

  await vscode.commands.executeCommand('codeSwarm.detach');
  assert.equal(api.getStatus().uri,undefined);assert.equal(api.getStatus().history.length,0);
  console.log('PASS detach clears captured code snapshots');
  console.log('CODE_SWARM_EXTENSION_TESTS_PASSED');
}
