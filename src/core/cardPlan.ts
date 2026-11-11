import { lines, Replay, TaskKind } from './model';

export interface FloatingCard {
  id: string;
  kind: TaskKind;
  toLine: number;
  fromLine: number;
  column: number;
  text: string;
  oldText: string;
}
function columns(text: string) {
  let result=0;
  for(const char of text){if(char==='\t')result+=4-result%4;else if(!/\p{Mark}/u.test(char))result+=(char.codePointAt(0)??0)>255?2:1;}
  return result;
}
/** Visual assembly pieces only. Never applied as file edits. */
export function planFloatingCards(record: Replay, visible: (line:number)=>boolean, capacity=80): {cards:FloatingCard[];reconstruction:boolean} {
  const after=lines(record.after);
  const changed=record.tasks.reduce((n,t)=>n+t.newLines.length+t.oldLines.length,0);
  const reconstruction=(record.source==='demo'||changed>=20)&&after.some(text=>text.trim());
  const input: {kind:TaskKind;toLine:number;fromLine:number;text:string;oldText:string}[]=[];
  if(reconstruction){
    after.forEach((text,line)=>{if(visible(line)&&text.trim())input.push({kind:'insert',toLine:line,fromLine:line,text,oldText:''});});
  }else{
    for(const task of record.tasks){
      const content=task.kind==='delete'?task.oldLines:task.newLines;
      content.forEach((text,index)=>{
        const line=task.kind==='delete'?task.toLine:task.toLine+index;
        if(visible(line)&&text.trim())input.push({kind:task.kind,toLine:line,fromLine:task.fromLine+index,text,oldText:task.oldLines[index]??''});
      });
    }
  }
  const cards:FloatingCard[]=[];
  for(const item of input){
    const indent=item.text.match(/^\s*/)?.[0]??'';
    const body=Array.from(item.text.slice(indent.length));
    let offset=0;
    while(offset<body.length&&cards.length<capacity){
      let end=Math.min(body.length,offset+24);
      if(end<body.length){for(let i=end;i>offset+12;i--)if(/[\s,;(){}]/.test(body[i-1])){end=i;break;}}
      const segment=body.slice(offset,end).join('');
      if(segment.trim())cards.push({...item,id:`card-${cards.length}`,column:columns(indent+body.slice(0,offset).join('')),text:segment.trimEnd()});
      offset=end;
    }
    if(cards.length>=capacity)break;
  }
  return {cards,reconstruction};
}
