// 浏览器身份仅用于关联本机报告；不读取硬件标识。
export function currentDeviceId(){
 try{let id=localStorage.getItem('np.deviceId');if(!id){id=crypto.randomUUID();localStorage.setItem('np.deviceId',id);}return id;}catch{return null;}
}
export function devicePreferences(){try{return JSON.parse(localStorage.getItem('np.deviceConfig')||'{}');}catch{return {};}}
export function saveDevicePreferences(value){try{localStorage.setItem('np.deviceConfig',JSON.stringify(value));}catch{}}
export function trackDeviceTask(id){try{localStorage.setItem('np.pendingDeviceTask',id);}catch{}}
export function receivedDeviceTask(runs){try{const id=localStorage.getItem('np.pendingDeviceTask');const run=runs.find(r=>r.id===id);if(run){localStorage.removeItem('np.pendingDeviceTask');return run;}}catch{}return null;}
