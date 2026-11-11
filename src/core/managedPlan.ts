import { assertText } from './model';

export interface InputChange {offset:number;length:number;text:string;oldText:string;kind:'insert'|'delete'|'replace'}
const segmenter=new Intl.Segmenter(undefined,{granularity:'grapheme'});
const low=(code:number)=>code>=0xdc00&&code<=0xdfff;

/** One bounded edit, preserving an exact prefix/suffix and Unicode boundaries. */
export function nextInputChange(before:string,desired:string):InputChange|undefined{
  assertText(before);assertText(desired);if(before===desired)return;
  let start=0,oldEnd=before.length,newEnd=desired.length;
  while(start<oldEnd&&start<newEnd&&before[start]===desired[start])start++;
  if(start>0&&(low(before.charCodeAt(start))||low(desired.charCodeAt(start))))start--;
  while(oldEnd>start&&newEnd>start&&before[oldEnd-1]===desired[newEnd-1]){oldEnd--;newEnd--;}
  if(low(before.charCodeAt(oldEnd))||low(desired.charCodeAt(newEnd))){oldEnd++;newEnd++;}
  let text='',rows=0;
  for(const {segment} of segmenter.segment(desired.slice(start,newEnd))){
    if(text.length&&text.length+segment.length>8192)break;
    text+=segment;rows+=(segment.match(/\n/g)??[]).length;if(rows>=4)break;
  }
  const length=oldEnd-start;
  return {offset:start,length,text,oldText:before.slice(start,oldEnd),kind:!length?'insert':!text?'delete':'replace'};
}

export function inputBoundaries(text:string,steps:number){
  const ends=[...segmenter.segment(text)].map(s=>s.index+s.segment.length);
  return Array.from({length:steps},(_,i)=>ends[Math.max(0,Math.ceil(ends.length*(i+1)/steps)-1)]??0);
}

export function applyInputChange(before:string,change:InputChange,text=change.text){return before.slice(0,change.offset)+text+before.slice(change.offset+change.length);}

export type InputVisual='type'|'trace'|'outline'|'stamp'|'card';
export function inputVisual(line:number,text=''):InputVisual{
  let hash=Math.imul(line+1,0x9e3779b1);
  for(const ch of text.trim())hash=Math.imul(hash^ch.charCodeAt(0),16777619);
  const code=text.trim();
  const actions:InputVisual[]=['card','card','outline','card','stamp','card','type','card'];
  if(/^(?:async\s+)?(?:class|def|function|interface)\b/.test(code))return ((hash>>>0)%3===0?'outline':'card');
  if(/^(?:#|\/\/)/.test(code))return ((hash>>>0)%2===0?'trace':'type');
  return actions[((hash^(hash>>>16))>>>0)%actions.length];
}
export function parallelInputText(text:string,step:number,steps:number,startLine:number){
  const fraction=step/steps;let row=0;
  return text.split(/(\r\n|\n|\r)/).map(part=>{
    if(/^(\r\n|\n|\r)$/.test(part)){row++;return part;}
    const role=inputVisual(startLine+row);
    const progress=role==='card'||role==='stamp'?(step===steps?1:0):role==='outline'?Math.max(0,(fraction-.25)/.75):fraction;
    const ends=[...segmenter.segment(part)].map(s=>s.index+s.segment.length);
    const count=Math.min(ends.length,Math.floor(ends.length*progress));return part.slice(0,count?ends[count-1]:0);
  }).join('');
}
