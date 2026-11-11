import { runTests } from '@vscode/test-electron';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
const temp=resolve('.vscode-test/native');await mkdir(resolve(temp,'workspace'),{recursive:true});await mkdir('test-results',{recursive:true});
const log=createWriteStream('test-results/native-integration.log');
const options={extensionDevelopmentPath:resolve('.'),extensionTestsPath:resolve('dist/overlay.test.cjs'),stdout:log,stderr:log,
  launchArgs:['--disable-extensions','--disable-gpu','--skip-welcome','--skip-release-notes','--disable-workspace-trust',
    '--user-data-dir',resolve(temp,'profile'),'--extensions-dir',resolve(temp,'extensions'),resolve(temp,'workspace')]};
if(process.env.VSCODE_EXECUTABLE_PATH)options.vscodeExecutablePath=process.env.VSCODE_EXECUTABLE_PATH;
try{await runTests(options);console.log('Native overlay integration passed.');}catch(e){console.error(e);process.exitCode=1;}finally{log.end();}
