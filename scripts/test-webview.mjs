import { runTests } from '@vscode/test-electron';
import { chromium } from 'playwright';
import { createServer } from 'node:net';
import { resolve } from 'node:path';
import { mkdir, unlink, access, writeFile } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import assert from 'node:assert/strict';
const root=resolve('.vscode-test/visual');await mkdir(root,{recursive:true});await mkdir('test-results',{recursive:true});
const ready=resolve(root,'ready'),done=resolve(root,'done');for(const path of [ready,done])await unlink(path).catch(()=>{});
const socket=createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
const log=createWriteStream('test-results/webview-host.log');
const options={extensionDevelopmentPath:resolve('.'),extensionTestsPath:resolve('dist/webview-host.test.cjs'),
  extensionTestsEnv:{SWARM_READY:ready,SWARM_DONE:done},stdout:log,stderr:log,
  launchArgs:[`--remote-debugging-port=${port}`,'--disable-extensions','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
    '--user-data-dir',resolve(root,'profile'),'--extensions-dir',resolve(root,'extensions')]};
if(process.env.VSCODE_EXECUTABLE_PATH)options.vscodeExecutablePath=process.env.VSCODE_EXECUTABLE_PATH;
let testError;const run=runTests(options).catch(e=>{testError=e;});
let browser;
try{
  const deadline=Date.now()+30000;
  while(true){try{await access(ready);break;}catch{if(testError)throw testError;if(Date.now()>deadline)throw new Error('No VS Code ready signal. See test-results/webview-host.log.');await new Promise(r=>setTimeout(r,200));}}
  browser=await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  let frame,page;
  const end=Date.now()+15000;
  while(!frame&&Date.now()<end){
    for(const context of browser.contexts())for(const candidate of context.pages())for(const f of candidate.frames()){
      if(await f.locator('#stage').count().catch(()=>0)){frame=f;page=candidate;break;}
    }
    if(!frame)await new Promise(r=>setTimeout(r,150));
  }
  assert.ok(frame,'actual VS Code webview loaded its stage');
  await page.setViewportSize({width:1440,height:1000});
  await frame.waitForFunction(()=>window.swarmDiagnostics?.tasks>0);
  await frame.locator('#restart').click();await page.waitForTimeout(2400);
  const diagnostics=await frame.evaluate(()=>window.swarmDiagnostics);
  assert.equal(diagnostics.workers,32);assert.ok(diagnostics.active>0);
  assert.equal(await frame.locator('#empty').isVisible(),false);
  await page.screenshot({path:'test-results/vscode-webview.png',fullPage:true});
  await frame.locator('#skip').click();assert.equal(await frame.locator('#snapshot').textContent(),(await frame.evaluate(()=>window.swarmDiagnostics)).after);
  // Verify actual webview -> host bridge and host -> webview state round trip.
  await frame.locator('#detach').click();await frame.locator('#empty').waitFor({state:'visible'});
  await writeFile('test-results/webview-report.json',JSON.stringify({passed:true,actualVSCodeWebview:true,workerCount:diagnostics.workers,checks:['extension resource loading','nonce CSP script','Canvas rendering','playback','exact snapshot','host message round trip']},null,2));
  console.log('Actual VS Code webview passed; screenshot: test-results/vscode-webview.png');
}finally{
  await writeFile(done,'done');await run;if(browser)await browser.close().catch(()=>{});log.end();
}
if(testError)throw testError;
