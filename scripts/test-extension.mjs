import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
const temp=resolve('.vscode-test');await mkdir(temp,{recursive:true});
await mkdir(resolve(temp,'workspace'),{recursive:true});
const options={extensionDevelopmentPath:resolve('.'),extensionTestsPath:resolve('dist/extension.test.cjs'),
  launchArgs:['--disable-extensions','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
    '--user-data-dir',resolve(temp,'user-data'),'--extensions-dir',resolve(temp,'extensions'),resolve(temp,'workspace')]};
if(process.env.VSCODE_EXECUTABLE_PATH)options.vscodeExecutablePath=process.env.VSCODE_EXECUTABLE_PATH;
try{await runTests(options);}catch(e){console.error(e);process.exitCode=1;}
