// 极简 DOM 工具：模板 → 元素、弹窗、提示、确认框。
export function html(str) {
  const t = document.createElement('template');
  t.innerHTML = str.trim();
  return t.content.firstElementChild;
}

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function toast(msg, type = 'info', ms = 3200) {
  const el = html(`<div class="toast ${type}"></div>`);
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.classList.add('out'), ms);
  setTimeout(() => el.remove(), ms + 400);
}

const stack = [];

/**
 * 打开弹窗。content 为 HTML 字符串；返回 { el, close }。
 * onClose 在关闭时调用（Esc / 点遮罩 / 关闭按钮 / close()）。
 */
export function openModal({ title, content, wide = false, onClose }) {
  const el = html(`
    <div class="modal-backdrop">
      <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
        <div class="modal-head"><h3></h3><button class="icon-btn" data-close title="关闭">✕</button></div>
        <div class="modal-body">${content}</div>
      </div>
    </div>`);
  $('h3', el).textContent = title;
  $('#modal-root').appendChild(el);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    el.remove();
    stack.splice(stack.indexOf(m), 1);
    onClose?.();
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.target === el) el._downOnBackdrop = true;
  });
  el.addEventListener('click', (e) => {
    if (e.target === el && el._downOnBackdrop) close();
    el._downOnBackdrop = false;
    if (e.target.closest('[data-close]')) close();
  });
  const m = { el, close, hide: (v) => el.classList.toggle('hidden', v) };
  stack.push(m);
  requestAnimationFrame(() => $('input:not([type=hidden]):not([type=checkbox]), select, textarea', el)?.focus());
  return m;
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && stack.length && !stack[stack.length - 1].el.classList.contains('hidden')) stack[stack.length - 1].close();
});

export const hasOpenModal = () => stack.some((m) => !m.el.classList.contains('hidden'));

export function confirmDialog(message, { okText = '确定', danger = false } = {}) {
  return new Promise((resolve) => {
    let ok = false;
    const m = openModal({
      title: '请确认',
      content: `<p class="confirm-msg"></p><div class="form-actions"><button class="btn" data-close>取消</button><button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${okText}</button></div>`,
      onClose: () => resolve(ok),
    });
    $('.confirm-msg', m.el).textContent = message;
    $('[data-ok]', m.el).addEventListener('click', () => {
      ok = true;
      m.close();
    });
    $('[data-ok]', m.el).focus();
  });
}

/** 读取表单为对象（支持 name="specs.cpu" 这样的嵌套） */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name || el.disabled) continue;
    const v = el.type === 'checkbox' ? el.checked : el.value;
    const path = el.name.split('.');
    let o = out;
    while (path.length > 1) {
      const k = path.shift();
      o = o[k] ||= {};
    }
    o[path[0]] = v;
  }
  return out;
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制', 'ok', 1500);
  } catch {
    toast('复制失败，请手动选择复制', 'warn');
  }
}

/** 迷你折线图（canvas），用于详情面板 */
export function sparkline(canvas, values, { color = '#38bdf8', min = 0, max = null, fill = true } = {}) {
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  if (!w || !h) return;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const g = canvas.getContext('2d');
  g.scale(dpr, dpr);
  g.clearRect(0, 0, w, h);
  const vals = values.filter((v) => v != null);
  if (vals.length < 2) {
    g.fillStyle = 'rgba(148,163,184,.5)';
    g.font = '11px system-ui';
    g.fillText('等待数据…', 6, h / 2 + 4);
    return;
  }
  const hi = max ?? (Math.max(...vals) * 1.15 || 1);
  const lo = min;
  const n = values.length;
  const x = (i) => (i / (n - 1)) * w;
  const y = (v) => h - 2 - ((v - lo) / (hi - lo || 1)) * (h - 4);
  g.beginPath();
  let started = false;
  values.forEach((v, i) => {
    if (v == null) return (started = false);
    started ? g.lineTo(x(i), y(v)) : g.moveTo(x(i), y(v));
    started = true;
  });
  g.strokeStyle = color;
  g.lineWidth = 1.5;
  g.stroke();
  if (fill) {
    g.lineTo(w, h);
    g.lineTo(x(values.findIndex((v) => v != null)), h);
    g.closePath();
    const grd = g.createLinearGradient(0, 0, 0, h);
    grd.addColorStop(0, color + '55');
    grd.addColorStop(1, color + '00');
    g.fillStyle = grd;
    g.fill();
  }
}
