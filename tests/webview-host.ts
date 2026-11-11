import * as vscode from 'vscode';
import { writeFile, access } from 'node:fs/promises';
export async function run() {
  await vscode.commands.executeCommand('workbench.action.closeSidebar');
  await vscode.commands.executeCommand('codeSwarm.demo');
  await writeFile(process.env.SWARM_READY!, 'ready');
  const deadline=Date.now()+45_000;
  while(Date.now()<deadline){
    try{await access(process.env.SWARM_DONE!);return;}catch{}
    await new Promise(r=>setTimeout(r,150));
  }
  throw new Error('Webview verification timed out.');
}
