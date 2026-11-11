import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertText, MAX_TEXT, Replay } from '../src/core/model';
import { plan, replay, ReplayHistory, validateProposal } from '../src/core/planner';
import { demoReplays } from '../src/core/demo';
import { planFloatingCards } from '../src/core/cardPlan';
import { planHybrid } from '../src/core/hybridPlan';
import { DiskStream } from '../src/diskStream';
import { mkdtemp,writeFile,appendFile,rename,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nextInputChange,applyInputChange,inputBoundaries,parallelInputText,inputVisual } from '../src/core/managedPlan';

test('diff planner covers generation, replacement, deletion and exact moves', () => {
  assert.equal(plan('', 'const a = 1;')[0].kind, 'insert');
  assert.equal(plan('const a = 1;', 'const a = 2;')[0].kind, 'replace');
  assert.equal(plan('const a = 1;', '')[0].kind, 'delete');
  const moved=demoReplays()[1].tasks;
  assert.ok(moved.some(t => t.kind === 'move'), JSON.stringify(moved));
  assert.ok(demoReplays()[2].tasks.some(t => t.kind === 'delete' || t.kind === 'replace'));
});
test('snapshots preserve CRLF, tabs, emoji and trailing newline exactly', () => {
  const before='\t// 中文 🐝\r\n',after='\tconst x = "<script>alert(1)</script>🐝";\r\n';
  const r=replay({before,after,file:'unicode.ts',label:'unicode',source:'observed',attribution:'Unattributed'});
  assert.equal(r.before,before);assert.equal(r.after,after);assert.ok(r.tasks.length);
  assert.deepEqual(plan(after,after),[]);
});
test('oversized, binary and wrong-type content is rejected before diffing', () => {
  assert.throws(()=>assertText('x'.repeat(MAX_TEXT+1)));
  assert.throws(()=>assertText('\n'.repeat(2001)));
  assert.throws(()=>assertText('abc\0def'));
  assert.throws(()=>assertText({}));
});
test('proposal validation rejects stale versions, missing versions and no-op changes', () => {
  assert.equal(validateProposal('a',4,4,'b'),'b');
  assert.throws(()=>validateProposal('a',4,3,'b'));
  assert.throws(()=>validateProposal('a',4,undefined,'b'));
  assert.throws(()=>validateProposal('a',4,4,'a'));
});
test('history is bounded and detached copies cannot grow the store', () => {
  const history=new ReplayHistory(3);
  for(let i=0;i<8;i++)history.push({id:String(i)} as Replay);
  assert.deepEqual(history.all().map(r=>r.id),['5','6','7']);
  history.all().push({id:'9'} as Replay);assert.equal(history.all().length,3);
  history.clear();assert.equal(history.all().length,0);
});
test('planner stays bounded on completely different 2,000-line files', () => {
  const before=Array.from({length:2000},(_,i)=>`old_${i}`).join('\n');
  const after=Array.from({length:2000},(_,i)=>`new_${i}`).join('\n');
  const started=performance.now();const tasks=plan(before,after);
  assert.ok(tasks.length>0);assert.ok(performance.now()-started<1500);
});
test('large paste becomes many floating cards, clipped to visible lines',()=>{
  const after=Array.from({length:100},(_,i)=>`def worker_${i}(task): return {"id": ${i}, "task": task, "ready": True}`).join('\n');
  const record=replay({before:'',after,file:'paste.py',label:'paste',source:'observed',attribution:'Unattributed'});
  const {cards,reconstruction}=planFloatingCards(record,line=>line<30);
  assert.equal(reconstruction,true);assert.ok(cards.length>=50);assert.ok(cards.length<=80);assert.ok(cards.every(c=>c.toLine<30));
  assert.ok(cards.some(c=>c.column>0),'long lines become multiple assembly pieces');
});
test('small edits keep their semantics and Unicode card text remains intact',()=>{
  const record=replay({before:'old = 1\n',after:'new = "中文🐝"\n',file:'u.py',label:'edit',source:'observed',attribution:'Unattributed'});
  const result=planFloatingCards(record,()=>true);
  assert.equal(result.reconstruction,false);assert.ok(result.cards.some(c=>c.kind==='replace'));assert.ok(result.cards.some(c=>c.text.includes('🐝')));
});
test('deleting a full file still creates removal cards for its old code',()=>{
  const before=Array.from({length:30},(_,i)=>`old_value_${i} = ${i}`).join('\n');
  const record=replay({before,after:'',file:'gone.py',label:'delete',source:'observed',attribution:'Unattributed'});
  const result=planFloatingCards(record,line=>line===0);
  assert.equal(result.reconstruction,false);assert.ok(result.cards.length>=20);assert.ok(result.cards.every(c=>c.kind==='delete'));
});

test('hybrid dispatch keeps deletion frameless and distinguishes typing, edit and bulk cards',()=>{
  const r=(before:string,after:string)=>replay({before,after,file:'hybrid.py',label:'hybrid',source:'observed',attribution:'Unattributed'});
  assert.ok(planHybrid(r('old = 1\n',''),()=>true).every(t=>t.visual==='erase'));
  const typed=planHybrid(r('hello','hello world'),()=>true);assert.equal(typed[0].visual,'type');assert.equal(typed[0].column,5);assert.equal(typed[0].text,' world');
  assert.equal(planHybrid(r('value = 1','value = 2'),()=>true)[0].visual,'edit');
  const paste=r('',Array.from({length:30},(_,i)=>`value_${i} = ${i}`).join('\n'));
  assert.ok(planHybrid(paste,()=>true).every(t=>t.visual==='card'));
  assert.ok(new Set(planHybrid(paste,()=>true,true).map(t=>t.visual)).size>=5,'stream uses several choreographies');
  assert.ok(planHybrid({...demoReplays()[1],source:'observed'},()=>true).some(t=>t.kind==='move'&&t.visual==='card'));
});

test('disk stream captures real external writes and survives atomic replacement',async()=>{
  const folder=await mkdtemp(join(tmpdir(),'code-swarm-disk-test-')),file=join(folder,'source.py');
  const seen:string[]=[];const feed=new DiskStream(file,(_before,after)=>seen.push(after));
  const delay=(n:number)=>new Promise(r=>setTimeout(r,n));
  const until=async(text:string)=>{for(let i=0;i<40&&!seen.includes(text);i++)await delay(25);assert.ok(seen.includes(text));};
  try{
    await writeFile(file,'base\n');await feed.start();
    await appendFile(file,'next\n');await until('base\nnext\n');
    const replacement=join(folder,'replacement.py');await writeFile(replacement,'replaced\n');await rename(replacement,file);await until('replaced\n');
    assert.ok(feed.metrics.changes>=2);feed.dispose();const count=seen.length;
    await appendFile(file,'after stop\n');await delay(120);assert.equal(seen.length,count);
  }finally{feed.dispose();await rm(folder,{recursive:true,force:true});}
});

test('animation input reaches exact snapshots through bounded Unicode-safe edits',()=>{
  const cases:[string,string][]=[['','😀中文\r\n'.repeat(120)],['a😀 tail','b😃 tail'],['old\r\nbody\r\n','new\r\nbody\r\nend'],['delete me',''],['prefix\n'+'old\n'.repeat(80)+'suffix','prefix\n'+'new\n'.repeat(200)+'suffix']];
  for(const [original,desired] of cases){
    let current=original,iterations=0;
    while(current!==desired){
      const change=nextInputChange(current,desired)!;assert.ok(change);assert.ok(change.text.length<=770);
      const base=current;
      for(const end of inputBoundaries(change.text,change.kind==='insert'?8:1)){
        const frame=applyInputChange(base,change,change.text.slice(0,end));
        assert.ok(Array.from(frame).every(c=>c.length!==1||c.charCodeAt(0)<0xd800||c.charCodeAt(0)>0xdfff),'never split a surrogate pair');
      }
      current=applyInputChange(current,change);assert.ok(++iterations<200);
    }
    assert.equal(current,desired);
  }
});

test('input choreography is content-driven instead of cycling in the same row order',()=>{
  const rows=['class Store:','def load(self):','  return cache','  value = 12','  return value','# build index','async def run():','  await load()','  return result','class Worker:','  pass','// dispatch work'];
  const actions=rows.map((row,line)=>inputVisual(line,row));
  assert.ok(new Set(actions).size>=3);
  assert.ok(actions.filter(action=>action==='card').length>=4);
  assert.notDeepEqual(actions,Array.from({length:rows.length},(_,line)=>inputVisual(line%6,rows[line])));
});

test('parallel animated input keeps card rows empty until landing and types other rows together',()=>{
  const text=Array.from({length:12},(_,i)=>`row_${i} = "中文😀"`).join('\r\n');
  const middle=parallelInputText(text,4,8,0).split('\r\n');
  assert.equal(middle.length,12);
  for(let i=0;i<12;i++){
    if(['card','stamp'].includes(inputVisual(i)))assert.equal(middle[i],'');
    else assert.ok(middle[i].length>0&&middle[i].length<text.split('\r\n')[i].length);
  }
  assert.equal(parallelInputText(text,8,8,0),text);
});
