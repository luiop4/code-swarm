import { execFileSync } from 'node:child_process';
import { mkdirSync, copyFileSync, existsSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
const base='C:/Windows/Microsoft.NET/Framework64/v4.0.30319';
export function buildNative(){
  if(process.platform!=='win32')return;
  mkdirSync('dist/native',{recursive:true});
  const source='native/Overlay.cs',output='dist/native/CodeSwarmOverlay.exe';
  if(!existsSync(output)||statSync(source).mtimeMs>statSync(output).mtimeMs){
    const refs=['System.dll','System.Core.dll','System.Xaml.dll','System.Drawing.dll','System.Web.Extensions.dll','WPF/WindowsBase.dll','WPF/PresentationCore.dll','WPF/PresentationFramework.dll'];
    execFileSync(`${base}/csc.exe`,['/nologo','/target:exe','/optimize+','/out:'+resolve(output),...refs.map(r=>'/reference:'+resolve(base,r)),resolve(source)],{stdio:'inherit',windowsHide:true});
  }
  copyFileSync('native/Overlay.exe.config','dist/native/CodeSwarmOverlay.exe.config');
}
if(process.argv[1]?.endsWith('build-native.mjs'))buildNative();
