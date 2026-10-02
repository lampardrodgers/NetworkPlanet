// 标签总开关优先于悬停、选中和线路模式；未测的本地分段仅保留连线。
export function showLinkLabel(edge, enabled) {
  if (!enabled) return false;
  return !!edge.statusText || !edge.link?.compact || Number.isFinite(edge.measured?.rtt) || Number.isFinite(edge.estimate);
}
