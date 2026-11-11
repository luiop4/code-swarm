import { watch, FSWatcher } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { basename, dirname } from 'node:path';
import { assertText, MAX_TEXT } from './core/model';

/** Read-only sampling of one explicitly watched local file, independent of editor reloads. */
export class DiskStream {
  private watcher?:FSWatcher;
  private interval?:ReturnType<typeof setInterval>;
  private timer?:ReturnType<typeof setTimeout>;
  private busy=false;
  private stopped=false;
  private previous?:string;
  readonly metrics={samples:0,changes:0,readErrors:0,lastBytes:0};
  constructor(private readonly path:string,private readonly changed:(before:string,after:string)=>void){}
  async start(){
    try{const value=await readFile(this.path,'utf8');assertText(value);this.previous=value;}catch{}
    if(this.stopped)return;
    try{this.watcher=watch(dirname(this.path),(_event,file)=>{if(!file||String(file).toLowerCase()===basename(this.path).toLowerCase())this.schedule();});this.watcher.on('error',()=>{this.metrics.readErrors++;});}catch{}
    // Directory watches may coalesce events or be unavailable; polling remains bounded.
    this.interval=setInterval(()=>void this.sample(),80);this.interval.unref();
  }
  private schedule(){if(!this.timer&&!this.stopped)this.timer=setTimeout(()=>{this.timer=undefined;void this.sample();},35);}
  private async sample(){
    if(this.stopped||this.busy)return;this.busy=true;
    try{
      const before=await stat(this.path);if(before.size>MAX_TEXT*4)return;
      const bytes=await readFile(this.path);const after=await stat(this.path);
      if(this.stopped||before.size!==after.size||before.mtimeMs!==after.mtimeMs||bytes.length!==after.size)return;
      const text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);assertText(text);
      this.metrics.samples++;this.metrics.lastBytes=bytes.length;
      const previous=this.previous;this.previous=text;
      if(previous!==undefined&&previous!==text){this.metrics.changes++;this.changed(previous,text);}
    }catch{this.metrics.readErrors++;}finally{this.busy=false;}
  }
  dispose(){this.stopped=true;this.watcher?.close();clearInterval(this.interval);clearTimeout(this.timer);this.previous=undefined;}
}
