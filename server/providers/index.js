// 供应商注册表。新增供应商：写一个 { id, name, fields, list(credentials) } 模块并加到这里。
import vultr from './vultr.js';
import digitalocean from './digitalocean.js';
import linode from './linode.js';
import hetzner from './hetzner.js';
import bandwagon from './bandwagon.js';
import generic from './generic.js';

export const PROVIDERS = Object.fromEntries([vultr, digitalocean, linode, hetzner, bandwagon, generic].map((p) => [p.id, p]));

export function providerMeta() {
  return Object.values(PROVIDERS).map(({ id, name, docs, fields }) => ({ id, name, docs, fields }));
}
