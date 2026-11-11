import { replay } from './planner';
import { Replay } from './model';

const header = '// A tiny agent task router · Code Swarm demo\n';
const helpers = `export function taskId(index: number): string {
  return \`task-\${String(index).padStart(3, '0')}\`;
}

export function isReady(task: Task): boolean {
  return task.status === 'queued';
}
`;
const types = `type Status = 'queued' | 'running' | 'done';
type Task = { id: string; title: string; status: Status };

const workers = ['Atlas', 'Nova', 'Iris', 'Echo'];
const queue: Task[] = [];
`;
const funcs = Array.from({length: 20}, (_, i) => `export function ${['enqueue', 'dispatch', 'assign', 'inspect', 'complete', 'retry', 'cancel', 'prioritize', 'schedule', 'observe', 'summarize', 'archive', 'validate', 'recover', 'balance', 'release', 'suspend', 'resume', 'report', 'cleanup'][i]}(task: Task): Task {
  console.info('${['queue', 'route', 'worker', 'review', 'done', 'retry', 'stop', 'sort', 'clock', 'watch', 'report', 'store', 'check', 'restore', 'spread', 'free', 'wait', 'wake', 'stats', 'clear'][i]}', task.id);
  return { ...task, status: '${i % 3 === 0 ? 'running' : 'queued'}' };
}
`).join('\n');
const beforeMove = header + types + '\n' + funcs + '\n' + helpers;
const afterMove = header + types + '\n' + helpers + '\n' + funcs;
const final = afterMove.replace("  console.info('watch', task.id);", '  // Stream task progress to the activity panel.\n  publish({ taskId: task.id, event: \'observed\' });')
  .replace("  console.info('stop', task.id);\n", '') + '\nfunction publish(event: unknown): void {\n  console.debug(event);\n}\n';
export function demoReplays(): Replay[] {
  return [
    replay({ label: '01 / BUILD · 从零生成任务路由器', file: 'agent-router.ts', before: '', after: beforeMove, source: 'demo', attribution: 'Demo workers' }),
    replay({ label: '02 / MOVE · 搬运工具函数', file: 'agent-router.ts', before: beforeMove, after: afterMove, source: 'demo', attribution: 'Demo workers' }),
    replay({ label: '03 / REFINE · 修改、删除、补充', file: 'agent-router.ts', before: afterMove, after: final, source: 'demo', attribution: 'Demo workers' })
  ];
}
