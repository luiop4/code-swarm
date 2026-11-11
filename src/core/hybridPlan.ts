import { FloatingCard, planFloatingCards } from './cardPlan';
import { Replay } from './model';

export type VisualAction = 'type' | 'edit' | 'erase' | 'card' | 'outline' | 'stamp' | 'trace';
export interface HybridAction extends FloatingCard { visual: VisualAction }
export function visualColumns(text:string){let n=0;for(const c of text){if(c==='\t')n+=4-n%4;else if(!/\p{Mark}/u.test(c))n+=(c.codePointAt(0)??0)>255?2:1;}return n;}

/** Route by edit meaning, rather than turning every edit into a card. */
export function planHybrid(record:Replay,visible:(line:number)=>boolean,streaming=false):HybridAction[]{
  if(record.source==='demo')return planFloatingCards(record,visible).cards.map(c=>({...c,visual:c.kind==='delete'?'erase':'card'}));
  const inserted=record.tasks.filter(t=>t.kind==='insert'||t.kind==='replace').reduce((n,t)=>n+t.newLines.length,0);
  const bulkInsert=!streaming&&inserted>=8;
  const result:HybridAction[]=[];
  for(const task of record.tasks){
    if(task.kind==='move'||((task.kind==='insert'||task.kind==='replace')&&bulkInsert)){
      const subset={...record,tasks:[task],source:'observed' as const};
      for(const card of planFloatingCards(subset,visible).cards)result.push({...card,visual:'card'});
      continue;
    }
    const content=task.kind==='delete'?task.oldLines:task.newLines;
    content.forEach((text,index)=>{
      const line=task.kind==='delete'?task.toLine:task.toLine+index;
      if(!visible(line)||!text.trim())return;
      const oldText=task.oldLines[index]??'';
      let visual:VisualAction=task.kind==='delete'?'erase':task.kind==='insert'?'type':'edit';
      if(visual==='type'&&streaming)visual=(['type','trace','outline','stamp','card','type'] as VisualAction[])[line%6];
      let column=0,shown=text;
      if(task.kind==='replace'&&text.startsWith(oldText)&&text.length>oldText.length){visual='type';column=visualColumns(oldText);shown=text.slice(oldText.length);}
      else{const indent=text.match(/^\s*/)?.[0]??'';column=visualColumns(indent);shown=text.slice(indent.length);}
      result.push({id:`cue-${result.length}`,visual,kind:task.kind,toLine:line,fromLine:task.fromLine+index,column,text:shown.slice(0,240),oldText:oldText.trimStart().slice(0,240)});
    });
  }
  return streaming?result.slice(-96):result.slice(0,96);
}
