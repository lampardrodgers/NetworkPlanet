// 告警通知渠道：Telegram Bot、Webhook（通用 JSON / 钉钉 / 企业微信 / 飞书 / Bark）。
// 返回每个渠道的结果，便于「发送测试通知」时把错误显示给用户。

async function post(url, body) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await res.text().catch(() => '');
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
  // 钉钉 / 企业微信 / 飞书即使出错也返回 200，需要看 errcode / code
  try {
    const j = JSON.parse(text);
    if ((j.errcode && j.errcode !== 0) || (j.code && j.code !== 0 && j.code !== 200)) throw new Error(j.errmsg || j.msg || text.slice(0, 160));
  } catch (e) {
    if (!(e instanceof SyntaxError)) throw e;
  }
}

function webhookBody(type, title, text) {
  const content = `${title}\n${text}`;
  switch (type) {
    case 'dingtalk':
    case 'wecom':
      return { msgtype: 'text', text: { content } };
    case 'feishu':
      return { msg_type: 'text', content: { text: content } };
    case 'bark':
      return { title, body: text, group: 'Network Planet' };
    default:
      return { source: 'network-planet', title, text, ts: Date.now() };
  }
}

export async function notify(channels, title, text) {
  const jobs = [];
  const tg = channels?.telegram;
  if (tg?.enabled && tg.botToken && tg.chatId) {
    jobs.push(['Telegram', post(`https://api.telegram.org/bot${tg.botToken}/sendMessage`, { chat_id: tg.chatId, text: `${title}\n${text}`, disable_web_page_preview: true })]);
  }
  const wh = channels?.webhook;
  if (wh?.enabled && wh.url) jobs.push(['Webhook', post(wh.url, webhookBody(wh.type, title, text))]);
  const results = await Promise.allSettled(jobs.map(([, p]) => p));
  return results.map((r, i) => ({ channel: jobs[i][0], ok: r.status === 'fulfilled', error: r.status === 'rejected' ? r.reason.message : null }));
}
