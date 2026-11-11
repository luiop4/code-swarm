import { diffArrays } from 'diff';
import { assertText, lines, Replay, SwarmTask } from './model';

/** This planner produces pictures, never edits. Exact snapshots remain authoritative. */
export function plan(before: string, after: string, agent = 'Unattributed'): SwarmTask[] {
  assertText(before); assertText(after);
  if (before === after) return [];
  const changes = diffArrays(lines(before), lines(after), { timeout: 60 });
  if (!changes) return [{ id: 'summary', kind: 'replace', fromLine: 0, toLine: 0,
    oldLines: lines(before), newLines: lines(after), agent }];
  const tasks: SwarmTask[] = [];
  let oldAt = 0, newAt = 0;
  for (let i = 0; i < changes.length; i++) {
    const c = changes[i];
    if (!c.added && !c.removed) { oldAt += c.value.length; newAt += c.value.length; continue; }
    const removed = c.removed ? c.value : [];
    let added = c.added ? c.value : [];
    if (c.removed && changes[i + 1]?.added) added = changes[++i].value;
    const span = Math.max(removed.length, added.length);
    // Small chunks distribute typing work across the swarm.
    for (let j = 0; j < span; j += 3) {
      const oldLines = removed.slice(j, j + 3), newLines = added.slice(j, j + 3);
      tasks.push({ id: `t${tasks.length}`, kind: !oldLines.length ? 'insert' : !newLines.length ? 'delete' : 'replace',
        fromLine: oldAt + Math.min(j, removed.length), toLine: newAt + Math.min(j, added.length), oldLines, newLines, agent });
    }
    oldAt += removed.length; newAt += added.length;
  }
  // Only exact, meaningful block matches count as inferred moves. No AST claims.
  const deleted = tasks.filter(t => t.kind === 'delete');
  const used = new Set<string>();
  for (const add of tasks.filter(t => t.kind === 'insert')) {
    const key = add.newLines.join('\n');
    if (key.trim().length < 12) continue;
    const del = deleted.find(t => !used.has(t.id) && t.oldLines.join('\n') === key);
    if (del) { add.kind = 'move'; add.fromLine = del.fromLine; add.oldLines = del.oldLines; used.add(del.id); }
  }
  return tasks.filter(t => !used.has(t.id));
}
let sequence = 0;
export function replay(input: Omit<Replay, 'id' | 'tasks' | 'createdAt'>): Replay {
  return { ...input, id: `r${Date.now()}-${sequence++}`, createdAt: Date.now(), tasks: plan(input.before, input.after, input.attribution) };
}

export function validateProposal(before: string, version: number, expectedVersion: unknown, after: unknown) {
  assertText(before); assertText(after);
  if (!Number.isInteger(expectedVersion) || expectedVersion !== version) throw new Error('文档版本已变化，请重新生成并预览补丁。');
  if (before === after) throw new Error('补丁没有任何变化。');
  return after;
}

export class ReplayHistory {
  private entries: Replay[] = [];
  constructor(private readonly capacity = 12) {}
  push(record: Replay) { this.entries = [...this.entries, record].slice(-this.capacity); }
  all() { return this.entries.slice(); }
  clear() { this.entries = []; }
}
