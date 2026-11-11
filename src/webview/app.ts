import { demoReplays } from '../core/demo';
import { lines, Replay, SwarmTask } from '../core/model';

declare function acquireVsCodeApi(): { postMessage(message: object): void; getState(): unknown; setState(state: object): void };
const bridge = typeof acquireVsCodeApi === 'function' ? acquireVsCodeApi() : undefined;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const canvas = $<HTMLCanvasElement>('stage');
const ctx = canvas.getContext('2d')!;
const viewport = $('viewport');
const palette = ['#d1f879','#7ad9e8','#b59aff','#f6b779','#ff8ea6','#7db4fc','#a6dfbb','#e4a8e5'];
const kindName = {insert:'生成',replace:'修改',delete:'删除',move:'搬运'};
const names = ['Atlas','Nova','Iris','Echo','Lyra','Orion','Sage','Vega'];
interface Job { task: SwarmTask; worker: number; start: number; end: number }
let history: Replay[] = [], current: Replay | undefined, jobs: Job[] = [];
let count = 32, time = 0, duration = 1, running = false, speed = 1, follow = true;
let scrollY = 0, scrollX = 0, width = 800, height = 600, raf = 0, last = 0, uiAt = 0;
let mode = 'idle', beforeLines: string[] = [], afterLines: string[] = [], rafFrames = 0;
let batchesDropped = 0;
let workerNodes: HTMLElement[] = [];
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const lineHeight = 21, fontSize = 12, gutter = 57;

function send(type: string) {
  if (bridge) bridge.postMessage({ type });
  else if (type === 'demo') loadState({mode:'demo',history:demoReplays(),cursorCount:32});
  else if (type === 'detach') loadState({mode:'idle',history:[],cursorCount:32});
  else $('notice').textContent = '这是浏览器预览。监听与补丁提交请在 VS Code 扩展中使用。';
}
for (const id of ['demo','attach','detach','import','apply','reveal']) $(id).addEventListener('click', () => send(id));
$('start-demo').addEventListener('click', () => send('demo'));
$('play').addEventListener('click', () => { if (!current) return; if (time >= duration) time = 0; running = !running; updateUI(); wake(); });
$('restart').addEventListener('click', () => { time = 0; scrollY = 0; running = !reduced; updateUI(); wake(); });
$('stop').addEventListener('click', () => { time = 0; running = false; scrollY = 0; updateUI(); draw(); });
$('skip').addEventListener('click', () => { time = duration; running = false; updateUI(); draw(); });
$<HTMLInputElement>('scrub').addEventListener('input', e => { time = Number((e.target as HTMLInputElement).value) / 1000 * duration; running = false; updateUI(); draw(); });
$<HTMLSelectElement>('speed').addEventListener('change', e => { speed = Number((e.target as HTMLSelectElement).value); });
$('follow').addEventListener('click', () => { follow = !follow; updateUI(); wake(); });
$<HTMLSelectElement>('history').addEventListener('change', e => { const r = history.find(r => r.id === (e.target as HTMLSelectElement).value); if (r) select(r); });
viewport.addEventListener('wheel', e => { e.preventDefault(); follow = false; if (e.shiftKey) scrollX = Math.max(0, scrollX + e.deltaY); else scrollY = Math.max(0, Math.min(maxScroll(), scrollY + e.deltaY)); updateUI(); draw(); }, {passive:false});
viewport.addEventListener('keydown', e => {
  if (!['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Home','End',' '].includes(e.key)) return;
  e.preventDefault();
  if (e.key === ' ') { $('play').click(); return; }
  follow = false;
  if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') scrollX = Math.max(0,scrollX + (e.key === 'ArrowRight' ? 60 : -60));
  else scrollY = e.key === 'Home' ? 0 : e.key === 'End' ? maxScroll() : Math.max(0,Math.min(maxScroll(),scrollY+(e.key === 'ArrowDown'?63:-63)));
  updateUI(); draw();
});
document.addEventListener('visibilitychange', () => { last = 0; if (document.hidden) {cancelAnimationFrame(raf);raf=0;} else wake(); });
new ResizeObserver(() => { const rect=viewport.getBoundingClientRect();width=rect.width;height=rect.height;const dpr=Math.min(devicePixelRatio||1,2);canvas.width=Math.round(width*dpr);canvas.height=Math.round(height*dpr);ctx.setTransform(dpr,0,0,dpr,0,0);draw(); }).observe(viewport);

function setupWorkers() {
  $('count').textContent = String(count); $('agents').replaceChildren(); workerNodes = [];
  for(let i=0;i<count;i++) {const el=document.createElement('div');el.className='agent';el.textContent=String(i+1).padStart(2,'0');el.title=`${names[i%8]}-${i+1}`;el.style.setProperty('--agent-color',palette[i%8]);$('agents').append(el);workerNodes.push(el);}
}
function loadState(data: {mode:string; history:Replay[];cursorCount:number;watching?:string|null;proposal?:{label:string;agent:string;version:number}|null}) {
  mode=data.mode; count=Math.max(8,Math.min(50,Math.round(data.cursorCount||32)));setupWorkers();
  const same = current && data.history.some(r=>r.id===current!.id);
  history=data.history.slice(-12); updateHistory();
  $('mode').textContent = mode==='live' ? `监听中 · ${data.watching??''}` : '本地演示 · 无需 API Key';
  setProposal(data.proposal);
  if (!same) { if(history.length) select(mode==='live'?history[history.length-1]:history[0]); else clear(); }
  updateUI();
}
function append(record: Replay) {
  history.push(record);
  if(history.length>12) {
    const removed=history.shift()!;
    if(removed.id===current?.id) {batchesDropped++;select(history[0]);$('notice').textContent=`变化过快，已丢弃 ${batchesDropped} 个最旧回放片段；文件内容不受影响。`;}
  }
  updateHistory();
  if(!current || (time>=duration && !running)) select(record);
  updateUI();
}
function setProposal(p?:{label:string;agent:string;version:number}|null) {
  $<HTMLButtonElement>('apply').disabled=!p;
  if(p) $('notice').textContent=`${p.agent} · ${p.label} · 基于文档 v${p.version}，已打开差异预览，尚未写入文件。`;
}
window.addEventListener('message', e => {
  const data=e.data;if(!data||typeof data.type!=='string')return;
  if(data.type==='state')loadState(data);
  if(data.type==='append')append(data.record);
  if(data.type==='notice')$('notice').textContent=data.text;
  if(data.type==='proposal')setProposal(data.proposal);
});
function clear() {current=undefined;jobs=[];beforeLines=[];afterLines=[];running=false;time=0;duration=1;$('empty').hidden=false;$('snapshot').textContent='';draw();}
function updateHistory() {
  const selectEl=$<HTMLSelectElement>('history');selectEl.replaceChildren();
  for(const r of history){const o=document.createElement('option');o.value=r.id;o.textContent=r.label;selectEl.append(o);}
  if(current)selectEl.value=current.id;
}
function select(record: Replay) {
  current=record;beforeLines=lines(record.before);afterLines=lines(record.after);time=0;scrollY=0;scrollX=0;
  const availability=Array(count).fill(0);
  jobs=record.tasks.map((task,i)=>{
    const earliest=Math.min(...availability);const worker=availability.indexOf(earliest);
    const start=earliest+(earliest===0?(i%count)*.035:.18);
    const end=start+1.9+Math.min(1.7,task.newLines.join('\n').length/100)+(task.kind==='move'?1.3:0);
    availability[worker]=end;return{task,worker,start,end};
  });
  duration=Math.max(.1,...jobs.map(j=>j.end))+.7;
  if(!jobs.length)time=duration;
  running=jobs.length>0&&!reduced;
  $('empty').hidden=true;$('filename').textContent=record.file;$('record-label').textContent=record.label;
  $('source').textContent=record.source.toUpperCase();$('snapshot').textContent=record.after;
  $('stage-label').textContent=record.attribution==='Unattributed'?'来源未知 · 差异合成动画':record.source==='demo'?'DEMO / SYNTHETIC WORKERS':`${record.attribution} / SNAPSHOT REPLAY`;
  $<HTMLSelectElement>('history').value=record.id;
  if(reduced)$('notice').textContent='已遵循系统减少动态效果设置。可手动播放，或直接跳到最终快照。';
  updateUI();wake();
}
function maxScroll(){return Math.max(0,Math.max(beforeLines.length,afterLines.length)*lineHeight+60-height);}
const clamp=(v:number,a=0,b=1)=>Math.max(a,Math.min(b,v));
const smooth=(v:number)=>{v=clamp(v);return v*v*(3-2*v);};
const lerp=(a:number,b:number,t:number)=>a+(b-a)*t;
function activeJobs(){return jobs.filter(j=>time>=j.start&&time<j.end);}
function progress(j:Job){return clamp((time-j.start)/(j.end-j.start));}
function wake(){if(!raf&&!document.hidden)raf=requestAnimationFrame(frame);}
function frame(now:number){raf=0;rafFrames++;const dt=last?Math.min(.05,(now-last)/1000):0;last=now;
  if(running){time=Math.min(duration,time+dt*speed);if(time>=duration){running=false;updateUI();const idx=history.findIndex(r=>r.id===current?.id);if(idx>=0&&idx<history.length-1){select(history[idx+1]);return;}}}
  if(follow&&running){const active=activeJobs();if(active.length){const goal=active.reduce((n,j)=>n+j.task.toLine,0)/active.length*lineHeight-height*.4;scrollY=lerp(scrollY,clamp(goal,0,maxScroll()),Math.min(1,dt*2));}}
  draw();if(now-uiAt>100){updateUI();uiAt=now;}if(running)wake();else last=0;
}
function updateUI(){
  const active=activeJobs(),finished=jobs.filter(j=>time>=j.end).length;
  $('done').textContent=String(finished);$('total').textContent=String(jobs.length);$('active').textContent=String(active.length);
  $('phase').textContent=!current?'READY':running?'IN MOTION':time>=duration?'COMPLETE':'PAUSED';
  $('play').textContent=running?'Ⅱ':'▶';$<HTMLInputElement>('scrub').value=String(Math.round(time/duration*1000));
  const fmt=(t:number)=>`00:${Math.floor(t).toString().padStart(2,'0')}`;$('time').textContent=`${fmt(time)} / ${fmt(duration)}`;
  $('follow').textContent=`跟随视角 ${follow?'ON':'OFF'}`;$('follow').setAttribute('aria-pressed',String(follow));
  const idx=history.findIndex(r=>r.id===current?.id);$('queue').textContent=`${Math.max(0,history.length-idx-1)} 等待`;
  for(let i=0;i<workerNodes.length;i++)workerNodes[i].classList.toggle('busy',active.some(j=>j.worker===i));
  $('tasks').replaceChildren();
  for(const job of active.slice(0,4)){
    const row=document.createElement('div');row.className='task';
    const dot=document.createElement('span');dot.className='task-dot';dot.style.background=palette[job.worker%8];
    const text=document.createElement('div'),strong=document.createElement('strong'),small=document.createElement('small');
    strong.textContent=`${names[job.worker%8]}-${String(job.worker+1).padStart(2,'0')}`;
    small.textContent=`L${job.task.toLine+1} · ${job.task.agent==='Demo workers'?'演示分工':job.task.agent}`;text.append(strong,small);
    const label=document.createElement('span');label.className='task-kind';label.textContent=kindName[job.task.kind];row.append(dot,text,label);$('tasks').append(row);
  }
  if(!active.length){const p=document.createElement('p');p.className='muted';p.textContent=time>=duration&&current?'快照重建完成。可重播，或选择其他片段。':'等待调度 · 代码文件不受动画影响';$('tasks').append(p);}
  bridge?.setState({speed,follow,selected:current?.id});
}
function code(text:string,x:number,y:number,alpha=1){
  ctx.globalAlpha=alpha;ctx.font=`${fontSize}px Consolas, "Courier New", monospace`;ctx.textBaseline='middle';
  // Lightweight highlighting; text is drawn, never interpreted as HTML.
  const tokens=text.replace(/\t/g,'    ').match(/\/\/.*$|'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`[^`]*`|\b(?:export|function|return|const|let|type|if|else|async|await|new|void|string|number|boolean)\b|\b\d+\b|[^'"`\w]+|\w+/g)??[];
  for(const token of tokens){ctx.fillStyle=token.startsWith('//')?'#687e8c':/^['"`]/.test(token)?'#d2dd9c':/^(export|function|return|const|let|type|if|else|async|await|new)$/.test(token)?'#ba9cf4':/^(string|number|boolean|void)$/.test(token)?'#7ad9e8':/^\d+$/.test(token)?'#f6b779':'#bed0df';ctx.fillText(token,x,y);x+=ctx.measureText(token).width;}
  ctx.globalAlpha=1;
}
function draw(){
  ctx.clearRect(0,0,width,height);if(!current)return;
  ctx.font=`${fontSize}px Consolas, "Courier New", monospace`;ctx.textBaseline='middle';
  const baseX=gutter-scrollX;
  ctx.strokeStyle='#24303b';ctx.beginPath();ctx.moveTo(gutter-13,0);ctx.lineTo(gutter-13,height);ctx.stroke();
  const complete=time>=duration;
  if(time===0&&!running){
    for(let i=Math.max(0,Math.floor(scrollY/lineHeight));i<Math.min(beforeLines.length,Math.ceil((scrollY+height)/lineHeight));i++){lineNumber(i);code(beforeLines[i],baseX,28+i*lineHeight-scrollY);}
  }else{
    for(let i=Math.max(0,Math.floor(scrollY/lineHeight)-1);i<Math.min(afterLines.length,Math.ceil((scrollY+height)/lineHeight));i++){
      lineNumber(i);let text=afterLines[i],alpha=1;
      const job=jobs.find(j=>j.task.kind!=='delete'&&i>=j.task.toLine&&i<j.task.toLine+j.task.newLines.length);
      if(job&&!complete){const p=progress(job);if(p<.38){text='';alpha=.2;}else if(job.task.kind!=='move'){
        const full=job.task.newLines.join('\n'),chars=Math.floor(full.length*smooth((p-.38)/.5));
        const prior=job.task.newLines.slice(0,i-job.task.toLine).join('\n').length+(i>job.task.toLine?1:0);
        text=Array.from(text).slice(0,Math.max(0,chars-prior)).join('');
      }else alpha=smooth((p-.7)/.2);}
      if(job&&!complete&&progress(job)>.28&&progress(job)<.95){ctx.fillStyle=palette[job.worker%8]+'0d';ctx.fillRect(gutter-4,18+i*lineHeight-scrollY,width-gutter-14,lineHeight);}
      code(text,baseX,28+i*lineHeight-scrollY,alpha);
    }
  }
  if(!complete&&(running||time>0)){
    for(const j of jobs){const p=progress(j);if(time<j.start||p>=1)continue;drawJob(j,p,baseX);}
  }
  drawMinimap();
}
function lineNumber(i:number){ctx.font='9px Consolas, monospace';ctx.fillStyle='#4f6273';ctx.textAlign='right';ctx.fillText(String(i+1).padStart(2,'0'),gutter-23,28+i*lineHeight-scrollY);ctx.textAlign='left';}
function drawJob(j:Job,p:number,baseX:number){
  const color=palette[j.worker%8],t=j.task;
  const sourceY=28+t.fromLine*lineHeight-scrollY,targetY=28+t.toLine*lineHeight-scrollY;
  const sourceX=baseX+((t.oldLines[0]?.match(/^\s*/)?.[0].length??0)*7.2);
  const targetX=baseX+((t.newLines[0]?.match(/^\s*/)?.[0].length??0)*7.2);
  const homeX=lerp(32,width-36,(j.worker+.5)/count),homeY=j.worker%2?height-35:15;
  let x=lerp(homeX,targetX,smooth(p/.3)),y=lerp(homeY,clamp(targetY,25,height-40),smooth(p/.3));
  const blockHeight=Math.max(1,t.oldLines.length)*lineHeight;
  if(t.kind==='delete'||t.kind==='replace'||t.kind==='move'){
    const selected=smooth((p-.18)/.22),sy=clamp(sourceY,28,height-50),boxWidth=Math.min(width-gutter-30,Math.max(115,...t.oldLines.map(s=>s.length*7.2)));
    if(p<.6){ctx.globalAlpha=1-smooth((p-.48)/.12);ctx.fillStyle=color+'19';ctx.fillRect(sourceX-4,sy-10,boxWidth*selected,Math.min(blockHeight,height-sy-30));ctx.strokeStyle=color+'77';ctx.setLineDash([3,3]);ctx.strokeRect(sourceX-4,sy-10,boxWidth*selected,Math.min(blockHeight,height-sy-30));ctx.setLineDash([]);for(let k=0;k<t.oldLines.length;k++)if(sy+k*lineHeight<height-25)code(t.oldLines[k],sourceX,sy+k*lineHeight,.6);ctx.globalAlpha=1;}
    if(t.kind==='move'){
      const travel=smooth((p-.35)/.4);x=lerp(sourceX,clamp(targetX+40,gutter,width-180),travel);y=lerp(sy,clamp(targetY,30,height-100),travel)-Math.sin(travel*Math.PI)*60;
      if(p>.3&&p<.85){ctx.shadowColor=color+'44';ctx.shadowBlur=15;ctx.fillStyle='#202a36';ctx.fillRect(x-5,y+12,Math.min(330,boxWidth),Math.min(90,blockHeight+8));ctx.shadowBlur=0;ctx.strokeStyle=color;ctx.strokeRect(x-5,y+12,Math.min(330,boxWidth),Math.min(90,blockHeight+8));for(let k=0;k<Math.min(3,t.oldLines.length);k++)code(t.oldLines[k].slice(0,43),x+4,y+26+k*lineHeight,.95);}
      ctx.strokeStyle=color+'55';ctx.setLineDash([4,5]);ctx.beginPath();ctx.moveTo(gutter,clamp(targetY+10,20,height-25));ctx.lineTo(width-30,clamp(targetY+10,20,height-25));ctx.stroke();ctx.setLineDash([]);
    }else if(t.kind==='delete'){x=sourceX+boxWidth*selected;y=sy+Math.min(blockHeight*.6,35);if(p>.4&&p<.8){ctx.strokeStyle='#fa8b98';ctx.beginPath();ctx.moveTo(sourceX,sy);ctx.lineTo(sourceX+boxWidth,sy);ctx.stroke();}}
  }
  if(t.kind==='insert'||t.kind==='replace'){
    const typed=smooth((p-.38)/.5)*t.newLines.join('\n').length;let remain=typed,row=0;
    while(row<t.newLines.length-1&&remain>t.newLines[row].length){remain-=t.newLines[row].length+1;row++;}
    if(p>.3){x=baseX+Math.max(0,remain)*7.2;y=clamp(targetY+row*lineHeight,25,height-40);ctx.fillStyle=color;ctx.fillRect(clamp(x,gutter,width-30),y-9,1.5,18);}
  }
  if(p>.92){const returning=smooth((p-.92)/.08);x=lerp(x,homeX,returning);y=lerp(y,homeY,returning);}
  x=clamp(x,15,width-25);y=clamp(y,20,height-30);
  // A short motion trail and a distinct pointer for every scheduled worker.
  ctx.strokeStyle=color+'44';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(lerp(homeX,x,.8),lerp(homeY,y,.8));ctx.quadraticCurveTo(x+14,y-14,x,y);ctx.stroke();
  pointer(x,y,color);
}
function pointer(x:number,y:number,color:string,alpha=1){
  ctx.save();ctx.globalAlpha=alpha;ctx.translate(x,y);ctx.scale(.5,.5);ctx.rotate(-.14);ctx.shadowColor='#0008';ctx.shadowBlur=3;ctx.beginPath();ctx.moveTo(0,0);ctx.lineTo(0,18);ctx.lineTo(5,13);ctx.lineTo(9,20);ctx.lineTo(12,18);ctx.lineTo(8,11);ctx.lineTo(15,10);ctx.closePath();ctx.fillStyle=color;ctx.fill();ctx.strokeStyle='#10151c';ctx.lineWidth=1.2;ctx.stroke();ctx.restore();
}
function drawMinimap(){
  const n=Math.max(1,afterLines.length),x=width-18,h=height-44;
  ctx.fillStyle='#1c2833';ctx.fillRect(x,18,9,h);
  for(const j of jobs){ctx.fillStyle=palette[j.worker%8]+'88';ctx.fillRect(x+2,18+j.task.toLine/n*h,5,Math.max(2,j.task.newLines.length/n*h));}
  ctx.strokeStyle='#93a7b866';ctx.strokeRect(x-2,18+scrollY/(n*lineHeight)*h,13,Math.min(h,height/(n*lineHeight)*h));
}

setupWorkers();
if(bridge){const saved=bridge.getState() as {speed?:number;follow?:boolean}|undefined;if(saved){speed=saved.speed??1;follow=saved.follow??true;$<HTMLSelectElement>('speed').value=String(speed);}bridge.postMessage({type:'ready'});}
else if(new URLSearchParams(location.search).has('demo'))send('demo');

// Read-only diagnostics used by browser verification; no file-writing bridge exposed.
Object.defineProperty(window,'swarmDiagnostics',{get:()=>({recordId:current?.id,label:current?.label,time,duration,running,workers:count,active:activeJobs().length,visiblePointers:current&&time<duration&&(running||time>0)?activeJobs().length:0,pointerScale:.5,finished:jobs.filter(j=>time>=j.end).length,tasks:jobs.length,history:history.length,frames:rafFrames,after:current?.after,scrollY})});
