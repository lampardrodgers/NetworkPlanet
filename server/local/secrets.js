import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
export function secretPath(db, dataDir) {
  const name = db.localSecretsFile;
  if (name && !/^vaults\/[a-f0-9]{64}\.json$/.test(name)) throw new Error('凭据文件引用无效');
  return path.join(dataDir, name || 'local-secrets.json');
}
export function readSecrets(db, dataDir) {
  try { return JSON.parse(fs.readFileSync(secretPath(db, dataDir), 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return {}; throw new Error('本地凭据文件无法读取'); }
}

export function writeSecrets(db, dataDir, vault) {
  const text=JSON.stringify(vault);
  const name=db.localSecretsFile?'vaults/'+crypto.createHash('sha256').update(text).digest('hex')+'.json':null;
  const file=name?path.join(dataDir,name):secretPath(db,dataDir);
  fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file+'.tmp',text,{mode:0o600});fs.renameSync(file+'.tmp',file);
  if(name)db.localSecretsFile=name;
}
