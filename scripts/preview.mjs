import { serve } from './preview-server.mjs';
const {url}=await serve(Number(process.env.PORT||4173));
console.log(`Code Swarm visual preview: ${url}/?demo (Ctrl+C to stop)`);
console.log('Read-only preview. File capture and proposal apply only work inside VS Code.');
