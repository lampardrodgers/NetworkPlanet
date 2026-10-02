#!/usr/bin/env node
// 仅由本地测量 SSH 调用。密码不进入命令行、网页或日志。
import fs from 'node:fs';
if (!/password/i.test(process.argv.slice(2).join(' ')) || /passphrase|authenticity/i.test(process.argv.slice(2).join(' '))) process.exit(1);
try {
 const vault=JSON.parse(fs.readFileSync(process.env.NP_PASSWORD_FILE,'utf8'));
 const password=vault.passwords?.[process.env.NP_PASSWORD_ID];
 if(typeof password!=='string'||!password)process.exit(1);
 process.stdout.write(password+'\n');
} catch {process.exit(1);}
