import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
export async function serve(port=0) {
  const root=resolve('dist');
  const server=http.createServer(async(req,res)=>{
    const path=new URL(req.url,'http://localhost').pathname;
    if(path==='/favicon.ico'){res.writeHead(204);res.end();return;}
    const file=path==='/'?'index.html':path.slice(1);
    if(!['index.html','app.js','app.js.map','style.css'].includes(file)){res.writeHead(404);res.end();return;}
    try {
      let content=await readFile(resolve(root,file));
      if(file==='index.html')content=Buffer.from(content.toString().replaceAll('{{CSP}}',"default-src 'none'; script-src 'nonce-preview'; style-src 'self'; connect-src 'none';").replaceAll('{{NONCE}}','preview').replaceAll('{{SCRIPT}}','/app.js').replaceAll('{{STYLE}}','/style.css'));
      res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'text/html; charset=utf-8');res.end(content);
    } catch{res.writeHead(500);res.end('Build first.');}
  });
  await new Promise(r=>server.listen(port,'127.0.0.1',r));
  return{server,url:`http://127.0.0.1:${server.address().port}`};
}
