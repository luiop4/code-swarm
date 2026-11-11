export type TaskKind = 'insert' | 'replace' | 'delete' | 'move';
export interface SwarmTask {
  id: string;
  kind: TaskKind;
  fromLine: number;
  toLine: number;
  oldLines: string[];
  newLines: string[];
  agent: string;
}
export interface Replay {
  id: string;
  label: string;
  file: string;
  before: string;
  after: string;
  source: 'demo' | 'observed' | 'proposal';
  attribution: string;
  tasks: SwarmTask[];
  createdAt: number;
}
export const MAX_TEXT = 120_000;
export const MAX_LINES = 2000;
export function assertText(text: unknown): asserts text is string {
  if (typeof text !== 'string') throw new Error('代码内容必须是字符串。');
  if (text.length > MAX_TEXT || text.split('\n').length > MAX_LINES) {
    throw new Error('原型最多支持 120,000 个 UTF-16 字符、2,000 行，请选择较小的文件。');
  }
  if (text.includes('\0')) throw new Error('不支持二进制文件。');
}
export function lines(text: string): string[] {
  return text === '' ? [] : text.replace(/\r\n/g, '\n').split('\n');
}
