import dotenv from 'dotenv';
import {spawn} from 'node:child_process';
dotenv.config({quiet:true});
if(process.env.MCP_BRIDGE_ENABLED==='true'){
 const child=spawn('npm',['run','dev','-w','@orchestrator/bridge'],{stdio:'inherit',env:process.env});
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));
 child.on('exit',code=>process.exit(code??0));
}else console.log('MCP bridge disabled; run npm run setup:bridge to configure local development.');
