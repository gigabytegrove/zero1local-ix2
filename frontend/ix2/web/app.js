const app = document.getElementById('app');
const UI_BUILD_VERSION = '1.4.0';
const IX2_HARDWARE_PORT = true; // This build targets ARMv5 ix2-ng; do not disable protected APIs.

const CLIENT_RESPONSE_CACHE_ENABLED = true;
let currentVersion = '';
let currentSession = {username:'admin', role:'administrator', root:true};
let fileClipboard = null;
let selectedFileRow = null;
let selectedFileRows = new Set();
let fileSelectionAnchor = null;
let bootStatus = {};
let modalState = null;
let busyDepth = 0;
let authRedirecting = false;
const apiMemo = new Map();
const apiInflight = new Map();
const routeSnapshots = new Map();
const routePerformance = [];
const recentAPITimings = [];
function trackBrowserAPIRequest(url, startedAt, routePath) {
  const elapsed = performance.now() - startedAt;
  let endpoint = '';
  try { endpoint = new URL(url, location.origin).pathname; } catch (_) { endpoint = String(url).split('?')[0]; }
  recentAPITimings.unshift({ route: routePath, at: startedAt, endpoint, elapsed_ms: Math.round(elapsed * 10) / 10 });
  if (recentAPITimings.length > 160) recentAPITimings.length = 160;
}
let activeRouteController = null;
let routeRequestSignal = null;
let idlePrefetchHandle = null;
// Page snapshots and stale API bodies stay disabled: no outdated controls.
const ROUTE_SNAPSHOT_MAX_AGE = 0;
const API_STALE_MAX_AGE = 0;
const RESPONSIVE_READ_PATHS = new Set(['/api/system','/api/storage','/api/storage/health','/api/shares','/api/network','/api/network/listeners','/api/docker','/api/services','/api/nfs/exports','/api/hardware','/api/replication','/api/backups']);

function rememberRoutePerformance(path, metric) {
  routePerformance.unshift({ path, at: Date.now(), ...metric });
  if (routePerformance.length > 40) routePerformance.length = 40;
}
function browserPerformanceRows() {
  return routePerformance.slice(0, 12);
}
function routeSnapshotKey(path) {
  const p = normalizedPath(path);
  // Every query-driven owner view gets an independent snapshot. File Manager
  // share/folder locations, logs filters, SMB/NFS views and workflow tabs must
  // never reuse HTML cached for another query on the same pathname.
  if (normalizedPath(location.pathname) === p && location.search) return p + location.search;
  return p;
}
function routeSnapshot(path) {
  if (!CLIENT_RESPONSE_CACHE_ENABLED || ROUTE_SNAPSHOT_MAX_AGE <= 0) return null;
  const item = routeSnapshots.get(routeSnapshotKey(path));
  if (!item || (Date.now() - item.at) > ROUTE_SNAPSHOT_MAX_AGE) return null;
  return item;
}
function storeRouteSnapshot(path) {
  if (!CLIENT_RESPONSE_CACHE_ENABLED || ROUTE_SNAPSHOT_MAX_AGE <= 0) return;
  const content = document.getElementById('content');
  if (!content) return;
  routeSnapshots.set(routeSnapshotKey(path), { at: Date.now(), html: content.innerHTML });
}
function clearRouteSnapshots() { routeSnapshots.clear(); }

const POWER_PENDING_KEY = 'zero1local.pending-power-action';
function loadPendingPowerAction() {
  try { return JSON.parse(localStorage.getItem(POWER_PENDING_KEY) || 'null'); } catch (_) { return null; }
}
function savePendingPowerAction(value) {
  try { localStorage.setItem(POWER_PENDING_KEY, JSON.stringify(value)); } catch (_) {}
}
function clearPendingPowerAction() {
  try { localStorage.removeItem(POWER_PENDING_KEY); } catch (_) {}
}
function completedPowerMessage(status) {
  const pending = loadPendingPowerAction();
  if (!pending || pending.action !== 'reboot' || !pending.boot_id || !status?.boot_id || pending.boot_id === status.boot_id) return '';
  clearPendingPowerAction();
  return `NAS restart completed. Kernel boot ID changed from ${pending.boot_id.slice(0,8)}… to ${String(status.boot_id).slice(0,8)}…. Zero1Local returned on v${releaseDisplayVersion(status.version || currentVersion)}.`;
}
async function monitorOrderlyReboot(previousBootID) {
  showGlobalBusy('Restarting NAS… waiting for the operating system to leave the network.');
  let sawOffline = false;
  const started = Date.now();
  while (Date.now() - started < 6 * 60 * 1000) {
    await new Promise(resolve => setTimeout(resolve, 1800));
    try {
      const response = await fetch('/api/status?power-reconnect=' + Date.now(), { credentials:'same-origin', cache:'no-store' });
      if (!response.ok) continue;
      const status = await response.json();
      if (status.boot_id && previousBootID && status.boot_id !== previousBootID) {
        location.reload();
        return;
      }
      if (!sawOffline) continue;
    } catch (_) {
      sawOffline = true;
      const busy = document.querySelector('[data-busy-text]');
      if (busy) busy.textContent = 'NAS is offline for restart… waiting for Zero1Local to return.';
    }
  }
  hideGlobalBusy();
  flash('The reboot request was recorded, but this browser could not prove that the NAS returned within six minutes. Check the appliance before retrying.', 'warn');
}

function apiCacheTTL(url) {
  if (!CLIENT_RESPONSE_CACHE_ENABLED) return 0;
  let path = String(url || '');
  try { path = new URL(path, location.origin).pathname; } catch (_) {}
  const ttls = {
    '/api/system': 30000,
    '/api/storage': 30000,
    '/api/storage/health': 60000,
    '/api/shares': 30000,
    '/api/users': 30000,
    '/api/groups': 30000,
    '/api/docker': 30000,
    '/api/network': 30000,
    '/api/action-center': 15000,
    '/api/notifications': 15000,
    '/api/tasks': 1200,
    '/api/services': 30000,
    '/api/hardware': 60000,
    '/api/power/ups': 30000,
    '/api/security/center': 60000,
    '/api/nfs/exports': 30000,
    '/api/docker/stats': 5000,
    '/api/docker/stacks': 15000,
    '/api/backups': 15000,
    '/api/backup-targets': 30000,
    '/api/snapshots': 15000,
    '/api/replication': 15000,
    '/api/replication/jobs': 15000,
    '/api/desktop-integration': 30000,
    '/api/files/workspace': 60000,
    '/api/files/recent': 10000,
    '/api/files/favorites': 60000,
    '/api/network/v025': 15000,
    '/api/storage/health-history': 30000,
    '/api/security/v025': 30000,
    '/api/update/status': 30000,
    '/api/security': 30000,
    '/api/audit': 10000,
    '/api/security/api-keys': 15000,
    '/api/security/sessions': 5000,
    '/api/security/ssh-keys': 30000,
    '/api/security/certificate': 60000,
    '/api/security/firewall': 30000,
    '/api/account-capabilities': 30000,
    '/api/users/profiles': 30000,
    '/api/storage/analytics': 30000,
    '/api/storage/replacement': 15000,
    '/api/shares/insights': 30000,
    '/api/network/advanced': 15000,
    '/api/network/safety': 15000,
    '/api/hardware/led-settings': 30000,
    '/api/hardware/profiles': 60000,
    '/api/diagnostics': 15000,
    '/api/diagnostics/performance': 5000,
    '/api/recovery': 15000,
    '/api/recovery/key': 60000,
    '/api/logs': 5000,
    '/api/files': 15000,
    '/api/files/trash': 10000,
    '/api/apps/catalog': 15000,
    '/api/office/settings': 30000,
    '/api/maintenance': 30000,
    '/api/power/ups-policy': 30000,
    '/api/files/recycle-settings': 30000,
    '/api/notifications/delivery': 30000,
    '/api/security/admins': 15000,
    '/api/network/listeners': 5000,
    '/api/notifications/delivery/history': 5000
  };
  return RESPONSIVE_READ_PATHS.has(path) ? Math.min(ttls[path] || 0, 10000) : 0;
}
function clearAPIMemo() { apiMemo.clear(); clearRouteSnapshots(); }
function apiMemoPath(key) {
  const raw = String(key || '').replace(/^(GET|HEAD)\s+/, '');
  try { return new URL(raw, location.origin).pathname; } catch (_) { return raw.split('?')[0]; }
}
function clientMutationCachePrefixes(url) {
  let path = String(url || '');
  try { path = new URL(path, location.origin).pathname; } catch (_) { path = path.split('?')[0]; }
  // Account changes must never retain memoized data from an earlier session.
  if (path === '/api/login' || path === '/api/logout') return null;
  if (path === '/api/setup' || path === '/api/system/config-restore' || path.startsWith('/api/recovery/restore') || path.startsWith('/api/recovery/clean-takeover')) return null;
  if (path.startsWith('/api/files/')) return ['/api/files','/api/storage','/api/storage/analytics','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/shares')) return ['/api/shares','/api/files','/api/nfs/exports','/api/desktop-integration','/api/snapshots','/api/storage/analytics','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/users')) return ['/api/users','/api/groups','/api/shares','/api/files','/api/nfs/exports','/api/account-capabilities','/api/desktop-integration','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/groups')) return ['/api/groups','/api/users','/api/shares','/api/files','/api/nfs/exports','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/nfs')) return ['/api/nfs/exports','/api/shares','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/docker')) return ['/api/docker','/api/docker/stats','/api/services','/api/system','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/network')) return ['/api/network','/api/system','/api/security/center','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/storage')) return ['/api/storage','/api/storage/health','/api/storage/analytics','/api/shares','/api/files','/api/nfs/exports','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/services')) return ['/api/services','/api/system','/api/shares','/api/files','/api/docker','/api/network','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/security')) return ['/api/security','/api/security/center','/api/system','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/hardware') || path.startsWith('/api/power')) return ['/api/hardware','/api/system','/api/action-center','/api/notifications'];
  if (path.startsWith('/api/notifications')) return ['/api/notifications','/api/action-center'];
  if (path.startsWith('/api/update')) return ['/api/update/status'];
  return null;
}
function invalidateClientCachesForMutation(url) {
  const prefixes = clientMutationCachePrefixes(url);
  if (prefixes === null) { clearAPIMemo(); return; }
  if (!prefixes.length) return;
  for (const key of [...apiMemo.keys()]) {
    const path = apiMemoPath(key);
    if (prefixes.some(prefix => path === prefix || path.startsWith(prefix + '/'))) apiMemo.delete(key);
  }
  clearRouteSnapshots();
}

function showGlobalBusy(message = 'Loading…') {
  busyDepth += 1;
  const el = document.getElementById('globalBusy');
  if (!el) return;
  const text = el.querySelector('[data-busy-text]');
  if (text) text.textContent = message;
  el.classList.add('show');
  el.setAttribute('aria-hidden', 'false');
}
function hideGlobalBusy() {
  busyDepth = Math.max(0, busyDepth - 1);
  if (busyDepth !== 0) return;
  const el = document.getElementById('globalBusy');
  if (!el) return;
  el.classList.remove('show');
  el.setAttribute('aria-hidden', 'true');
}

function apiErrorMessage(data = {}, fallback = 'Request failed') {
  const err = data?.error;
  if (typeof err === 'string' && err.trim()) return err.trim();
  if (err && typeof err.message === 'string' && err.message.trim()) return err.message.trim();
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  return fallback;
}

function sessionAuthenticationRequired(url, response, data = {}) {
  if (response?.status !== 401 || String(url || '').startsWith('/api/login')) return null;
  if (!authRedirecting) {
    authRedirecting = true;
    clearAPIMemo();
    closeModal();
    busyDepth = 0;
    const busy = document.getElementById('globalBusy');
    busy?.classList.remove('show');
    busy?.setAttribute('aria-hidden', 'true');
    authLogin('', true);
  }
  const err = new Error(apiErrorMessage(data, 'authentication required'));
  err.name = 'Zero1AuthRequired';
  return err;
}

async function refreshAPIMemo(url, fetchOpt, memoKey, cacheTTL) {
  if (apiInflight.has(memoKey)) return apiInflight.get(memoKey);
  const headers = { 'Content-Type': 'application/json', ...(fetchOpt.headers || {}) };
  const request = (async () => {
    const response = await fetch(url, { credentials: 'same-origin', cache:'no-store', ...fetchOpt, signal: undefined, headers });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    const authErr = sessionAuthenticationRequired(url, response, data);
    if (authErr) throw authErr;
    if (!response.ok) {
      const err = new Error(apiErrorMessage(data, `Request failed (${response.status})`));
      err.status = response.status;
      err.code = data?.error_code || data?.error?.code || '';
      err.data = data;
      throw err;
    }
    apiMemo.set(memoKey, { at: Date.now(), data });
    return data;
  })();
  apiInflight.set(memoKey, request);
  try { return await request; }
  finally { apiInflight.delete(memoKey); }
}

async function api(url, opt = {}) {
  const { busy = true, fresh = false, stale = true, ...fetchOpt } = opt;
  const method = (fetchOpt.method || 'GET').toUpperCase();
  const headers = { 'Content-Type': 'application/json', ...(fetchOpt.headers || {}) };
  const mutation = method !== 'GET' && method !== 'HEAD';
  const cacheTTL = method === 'GET' && !fresh ? apiCacheTTL(url) : 0;
  const memoKey = method + ' ' + String(url);

  if (cacheTTL > 0) {
    const cached = apiMemo.get(memoKey);
    if (cached) {
      const age = Date.now() - cached.at;
      if (age < cacheTTL) return cached.data;
      if (stale && age < API_STALE_MAX_AGE) {
        refreshAPIMemo(url, fetchOpt, memoKey, cacheTTL).catch(() => {});
        return cached.data;
      }
    }
    if (apiInflight.has(memoKey)) return apiInflight.get(memoKey);
  }

  if (mutation) {
    headers['X-Zero1Local-Request'] = '1';
    if (busy) showGlobalBusy('Applying changes…');
  }

  const effectiveOpt = { ...fetchOpt };
  if (!mutation && !effectiveOpt.signal && routeRequestSignal) effectiveOpt.signal = routeRequestSignal;
  const requestStartedAt = performance.now();
  const routeAtRequest = normalizedPath();
  const request = (async () => {
    const response = await fetch(url, { credentials: 'same-origin', cache:'no-store', ...effectiveOpt, headers });
    let data = {};
    try { data = await response.json(); } catch (_) {}
    const authErr = sessionAuthenticationRequired(url, response, data);
    if (authErr) throw authErr;
    if (!response.ok) {
      const err = new Error(apiErrorMessage(data, `Request failed (${response.status})`));
      err.status = response.status;
      err.code = data?.error_code || data?.error?.code || '';
      err.data = data;
      throw err;
    }
    if (cacheTTL > 0) apiMemo.set(memoKey, { at: Date.now(), data });
    if (mutation) invalidateClientCachesForMutation(url);
    return data;
  })();

  if (cacheTTL > 0) apiInflight.set(memoKey, request);
  try { return await request; }
  finally {
    if (!mutation) trackBrowserAPIRequest(url, requestStartedAt, routeAtRequest);
    if (cacheTTL > 0) apiInflight.delete(memoKey);
    if (mutation && busy) hideGlobalBusy();
  }
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function attr(value) { return esc(value); }
function fmtBytes(value) {
  let n = Number(value || 0);
  if (!Number.isFinite(n)) return String(value ?? '');
  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i += 1; }
  const digits = i === 0 || n >= 100 ? 0 : n >= 10 ? 1 : 2;
  return `${n.toFixed(digits)} ${units[i]}`;
}
function fmtRate(value) {
  const n=Number(value||0);
  return Number.isFinite(n)&&n>0?`${fmtBytes(n)}/s`:'Calculating…';
}
function fmtETA(seconds) {
  let n=Math.max(0,Math.round(Number(seconds||0)));
  if(!Number.isFinite(n)||n<=0)return 'Calculating…';
  const d=Math.floor(n/86400);n%=86400;const h=Math.floor(n/3600);n%=3600;const m=Math.floor(n/60);const s=n%60;
  if(d)return `~${d}d ${h}h`;
  if(h)return `~${h}h ${m}m`;
  if(m)return `~${m}m ${s}s`;
  return `~${s}s`;
}
function miniSparkline(values,width=150,height=34){const nums=list(values).map(Number).filter(Number.isFinite);if(nums.length<2)return '<span class="subtle">History collecting</span>';const min=Math.min(...nums),max=Math.max(...nums),span=Math.max(1,max-min);const pts=nums.map((v,i)=>`${(i/(nums.length-1)*width).toFixed(1)},${(height-3-((v-min)/span)*(height-6)).toFixed(1)}`).join(' ');return `<svg class="mini-sparkline" viewBox="0 0 ${width} ${height}" role="img" aria-label="Recent trend"><polyline points="${pts}"></polyline></svg>`}
function interfaceTrafficDelta(points){const p=list(points);if(p.length<2)return null;const a=p[0],b=p[p.length-1];return {rx:Math.max(0,Number(b.rx_bytes||0)-Number(a.rx_bytes||0)),tx:Math.max(0,Number(b.tx_bytes||0)-Number(a.tx_bytes||0)),drops:Math.max(0,Number(b.rx_dropped||0)-Number(a.rx_dropped||0))+Math.max(0,Number(b.tx_dropped||0)-Number(a.tx_dropped||0))}}

function fmtDate(value) {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toLocaleString();
}
function pct(value) { return Math.max(0, Math.min(100, Number(value) || 0)); }
function list(value) { return Array.isArray(value) ? value : []; }
function boolText(value) { return value ? 'Yes' : 'No'; }
function csv(value) { return String(value || '').split(',').map(x => x.trim()).filter(Boolean); }
function pathUnderDisk0(path) { return path === '/disk0' || String(path || '').startsWith('/disk0/'); }
function friendlyStoragePath(path) {
  const p = String(path || '').replace(/\/+$/, '') || '/disk0';
  const friendlyUnder = (root) => {
    if (p === root) return 'Main Storage';
    if (!p.startsWith(root + '/')) return null;
    const rel = p.slice((root + '/').length).split('/').filter(Boolean).join(' / ');
    return rel ? `Main Storage / ${rel}` : 'Main Storage';
  };
  // Hide implementation-only folder roots so factory and Zero1Local-created shares
  // present as the same class of Main Storage folder to the owner.
  for (const root of ['/disk0/zero1-shares', '/disk0/deepnas/home', '/merge_disk/deepnas/home']) {
    const label = friendlyUnder(root);
    if (label) return label;
  }
  if (p === '/disk0') return 'Main Storage';
  if (p.startsWith('/disk0/')) return 'Main Storage / ' + p.slice('/disk0/'.length).split('/').filter(Boolean).join(' / ');
  return 'Other storage';
}

function friendlyShareLocation(sh) {
  if (!sh?.path) return 'Location discovered from the running SMB service';
  return friendlyStoragePath(sh.path);
}
function resolverAddresses(raw) {
  return String(raw || '').split(/\r?\n/).map(x=>x.trim()).filter(x=>x.startsWith('nameserver ')).map(x=>x.split(/\s+/)[1]).filter(Boolean);
}
function windowsShare(name) { return `\\\\${location.hostname}\\${name}`; }
function nfsNetworkPath(exportDef) { return String(exportDef?.nfs_path || `${location.hostname}:${exportDef?.path || ''}`); }
function nfsMount(exportDef) { return `mount -t nfs -o vers=3,nolock,proto=tcp ${nfsNetworkPath(exportDef)} /mnt/${slug(exportDef.share_name) || 'share'}`; }
function nfsFstab(exportDef) { return `${nfsNetworkPath(exportDef)} /mnt/${slug(exportDef.share_name) || 'share'} nfs vers=3,nolock,proto=tcp,_netdev 0 0`; }

function releaseDisplayVersion(value=currentVersion){
  return String(value||'').replace(/-B\d+$/,'');
}
function releaseBuildLabel(value=currentVersion){
  const m=String(value||'').match(/-(B\d+)$/); return m?m[1]:'';
}
function parseEffectiveSMBShares(text) {
  const rows=[]; let current=null;
  const finish=()=>{if(current?.name && current.path && !['global','printers','print$','ipc$'].includes(current.name.toLowerCase())) rows.push(current); current=null;};
  for(const raw of String(text||'').split(/\r?\n/)){
    const section=raw.match(/^\s*\[([^\]]+)\]\s*$/);
    if(section){finish();current={name:section[1].trim(),path:'',valid_users:[],write_users:[],browseable:true,guest_ok:false,read_only:false,live_detected:true,detected_only:true,manageable:false,remove_allowed:false};continue;}
    if(!current)continue;
    const kv=raw.match(/^\s*([^=]+?)\s*=\s*(.*?)\s*$/);if(!kv)continue;
    const key=kv[1].trim().toLowerCase(), value=kv[2].trim();
    const yes=/^(yes|true|1)$/i.test(value), no=/^(no|false|0)$/i.test(value);
    const names=v=>String(v||'').split(/[\s,]+/).map(x=>x.trim()).filter(Boolean);
    if(key==='path')current.path=value;
    else if(key==='comment')current.comment=value;
    else if(key==='valid users')current.valid_users=names(value);
    else if(key==='write list'||key==='write users')current.write_users=names(value);
    else if(key==='guest ok')current.guest_ok=yes;
    else if(key==='read only')current.read_only=yes;
    else if(key==='browseable'||key==='browsable')current.browseable=!no;
    else if(key==='force user')current.force_user=value;
  }
  finish(); return rows;
}
function mergedSMBShareInventory(data){
  const managed=list(data?.active).map(x=>({...x,detected_only:false}));
  const known=new Set(managed.map(x=>String(x.name||'').toLowerCase()));
  const detected=parseEffectiveSMBShares(data?.factory_testparm).filter(x=>!known.has(String(x.name||'').toLowerCase()));
  return {shares:[...managed,...detected],detected};
}
function detectedSMBAdoptable(share){
  const path=String(share?.path||'').replace(/\/+$/,'');
  return !!share?.detected_only && (path==='/disk0'||path.startsWith('/disk0/'));
}
function slug(s) { return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''); }
function safeId(s) { return String(s || '').replace(/[^A-Za-z0-9_-]/g, '_'); }

function toneFor(state) {
  const s = String(state || '').toLowerCase();
  if (['healthy', 'active', 'running', 'up', 'online', 'ready', 'enabled', 'clean', 'ok'].some(x => s.includes(x))) return 'good';
  if (['failed', 'degraded', 'down', 'offline', 'error', 'missing'].some(x => s.includes(x))) return 'bad';
  if (['warning', 'pending', 'inactive', 'stopped', 'exited', 'disabled'].some(x => s.includes(x))) return 'warn';
  return 'neutral';
}
function statusPill(text, tone = toneFor(text)) { return `<span class="state state-${tone}"><i></i>${esc(text || 'Unknown')}</span>`; }
function icon(name, size = 20) {
  const aliases = { smb:'shares', nfs:'shares', system:'settings', services:'settings', protocols:'shares', volume:'storage', factory:'recovery', readiness:'check' };
  name = aliases[name] || name;
  const paths = {
    overview: '<path d="M3 11.5 12 4l9 7.5"/><path d="M5.5 10.5V20h13v-9.5"/><path d="M9 20v-6h6v6"/>',
    storage: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6"/>',
    files: '<path d="M3 7.5h7l2-2h9v13.5H3z"/><path d="M3 9.5h18"/>',
    shares: '<circle cx="8" cy="9" r="3"/><circle cx="17" cy="8" r="2.5"/><path d="M2.5 20c.5-4 2.4-6 5.5-6s5 2 5.5 6"/><path d="M13.5 14.2c2.8-.7 6 .9 6.8 4.3"/>',
    protection: '<path d="M12 3 20 6v6c0 5.1-3.4 8.2-8 9-4.6-.8-8-3.9-8-9V6z"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
    docker: '<rect x="3" y="4" width="7" height="7" rx="1"/><rect x="14" y="4" width="7" height="7" rx="1"/><rect x="3" y="15" width="7" height="5" rx="1"/><rect x="14" y="15" width="7" height="5" rx="1"/>',
    settings: '<path d="M4 6h10"/><path d="M18 6h2"/><circle cx="16" cy="6" r="2"/><path d="M4 12h2"/><path d="M10 12h10"/><circle cx="8" cy="12" r="2"/><path d="M4 18h8"/><path d="M16 18h4"/><circle cx="14" cy="18" r="2"/>',
    actions: '<path d="M12 3 22 20H2z"/><path d="M12 9v5"/><path d="M12 17.5h.01"/>',
    disks: '<rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="12" cy="11" r="5"/><circle cx="12" cy="11" r="1"/><path d="M7 18h2"/>',
    raid: '<path d="M4 7h12"/><path d="m13 4 3 3-3 3"/><path d="M20 17H8"/><path d="m11 14-3 3 3 3"/>',
    analytics: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
    replace: '<path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M18.2 9a7 7 0 0 0-11.8-2.4L4 9"/><path d="M5.8 15a7 7 0 0 0 11.8 2.4L20 15"/>',
    backups: '<path d="M12 3v12"/><path d="m7 10 5 5 5-5"/><path d="M4 19h16"/>',
    snapshots: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/><path d="M5 5 3 8h4"/>',
    replication: '<path d="M4 7h13"/><path d="m14 4 3 3-3 3"/><path d="M20 17H7"/><path d="m10 14-3 3 3 3"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M3 20c.5-4.3 2.6-6.5 6-6.5s5.5 2.2 6 6.5"/><path d="M17 8h4"/><path d="M19 6v4"/>',
    groups: '<circle cx="8" cy="8" r="3"/><circle cx="17" cy="9" r="2.5"/><path d="M2.5 20c.4-4.2 2.3-6.5 5.5-6.5s5.1 2.3 5.5 6.5"/><path d="M13.5 15c3.2-.5 5.6 1.1 6.2 4"/>',
    desktop: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/>',
    remote: '<path d="M8.5 15.5 4 20"/><path d="M15.5 8.5 20 4"/><path d="M14 4h6v6"/><path d="M10 20H4v-6"/><path d="M8 8l8 8"/>',
    network: '<circle cx="12" cy="12" r="3"/><path d="M4.9 4.9a10 10 0 0 1 14.2 0"/><path d="M7.8 7.8a6 6 0 0 1 8.4 0"/><path d="M4.9 19.1a10 10 0 0 0 14.2 0"/>',
    hardware: '<rect x="5" y="5" width="14" height="14" rx="2"/><path d="M9 9h6v6H9z"/><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3"/>',
    security: '<rect x="5" y="10" width="14" height="10" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/>',
    diagnostics: '<path d="M4 4h16v16H4z"/><path d="M8 8h8M8 12h5M8 16h7"/>',
    recovery: '<path d="M5 7v5h5"/><path d="M19 17v-5h-5"/><path d="M7 16a7 7 0 0 0 11.5-3"/><path d="M17 8A7 7 0 0 0 5.5 11"/>',
    logs: '<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    about: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><path d="M12 7h.01"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    tasks: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    notifications: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 7-3 9h18c0-2-3-2-3-9"/><path d="M10 21h4"/>',
    theme: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>',
    account: '<circle cx="12" cy="8" r="4"/><path d="M4.5 21c.7-5 3.2-7.5 7.5-7.5s6.8 2.5 7.5 7.5"/>',
    power: '<path d="M12 2v9"/><path d="M7.1 5.6A8 8 0 1 0 16.9 5.6"/>',
    menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    folder: '<path d="M3 7h7l2-2h9v14H3z"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
    check: '<path d="m5 12 4 4 10-10"/>',
    warning: '<path d="M12 3 22 20H2z"/><path d="M12 9v5M12 17.5h.01"/>',
    star: '<path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9z"/>',
    history: '<path d="M4 4v5h5"/><path d="M5.2 15a8 8 0 1 0 .8-8"/><path d="M12 7v5l3 2"/>',
    update: '<path d="M20 7h-6V1"/><path d="m20 1-6 6"/><path d="M4 17h6v6"/><path d="m4 23 6-6"/><path d="M19 13a7 7 0 0 1-12 4"/><path d="M5 11A7 7 0 0 1 17 7"/>'
  };
  const body = paths[name] || paths.about;
  return `<svg class="ui-icon" width="${Number(size)||20}" height="${Number(size)||20}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

function activeBrandLogoAsset(theme = document.documentElement.dataset.theme || preferredTheme()) {
  return theme === 'dark' ? '/assets/zero1-local-logo-dark.png' : '/assets/zero1-local-logo-light.png';
}
function brandLogoHTML(context = 'default') {
  const cls = `brand-logo brand-logo-${slug(context) || 'default'}`;
  return `<span class="${cls}" role="img" aria-label="Zero1Local NAS management"><img class="brand-logo-image" data-zero1-brand-logo src="${activeBrandLogoAsset()}" alt=""></span>`;
}

// Owner-facing information architecture follows actual tasks across the appliance.
// Existing routes remain valid and are intentionally not removed; advanced/detail
// routes are reached contextually instead of claiming permanent navigation space.
const applications = [
  { id:'home', label:'Home', href:'/', icon:'overview', match:['/','/action-center','/tasks','/notifications'] },
  { id:'files', label:'Files & Sharing', href:'/files', icon:'files', match:['/files','/shares','/smb','/nfs','/office'] },
  { id:'people', label:'Users & Groups', href:'/users', icon:'account', match:['/users','/groups'] },
  { id:'storage', label:'Storage', href:'/storage', icon:'storage', match:['/storage'] },
  { id:'protection', label:'Sync & Backup', href:'/protection', icon:'protection', match:['/protection','/synchronization','/backups','/snapshots','/replication','/offsite','/phone-transfer','/mobile-offload'] },
  { id:'connectivity', label:'Connectivity', href:'/network', icon:'network', match:['/network','/desktop-integration'] },
  { id:'system', label:'System', href:'/settings', icon:'settings', match:['/settings','/services','/protocols','/system','/hardware','/security','/diagnostics','/readiness','/logs','/recovery','/factory','/about','/automation','/setup-assistant'] },
  { id:'help', label:'Help', href:'/help', icon:'about', match:['/help'] },
  { id:'updates', label:'Updates', href:'/updates', icon:'update', match:['/updates'] },
];

const applicationTabs = {
  home: [
    ['/', 'Overview'], ['/action-center', 'Action Center'], ['/notifications', 'Notifications']
  ],
  files: [
    ['/files', 'Browse'], ['/shares', 'Shared Folders'], ['/files/links', 'Secure Links']
  ],
  people: [ ['/users', 'Users'], ['/groups', 'Groups'], ['/users/profiles', 'Account policies'] ],
  storage: [
    ['/storage', 'Overview'], ['/storage/disks', 'Drives'], ['/storage/raid', 'Drive Protection'], ['/storage?view=usb', 'USB Drives'], ['/storage/analytics', 'Analytics']
  ],
  protection: [
    ['/protection', 'Overview'], ['/replication', 'Replication'], ['/backups', 'Backups'], ['/protection/restore', 'Restore'], ['/phone-transfer', 'Phone Transfer']
  ],
  apps: [
    ['/apps/catalog', 'Catalog'], ['/docker', 'App Containers'], ['/docker/stacks', 'Docker Compose']
  ],
  connectivity: [
    ['/network', 'Network'], ['/network/vlans', 'VLANs'], ['/network/advanced', 'Advanced'], ['/desktop-integration', 'Windows & Mac']
  ],
  system: [
    ['/settings', 'Overview'], ['/system', 'System & Power'], ['/hardware', 'Hardware'], ['/security', 'Security'], ['/recovery/system', 'Recovery Tools']
  ],
  help: [
    ['/help', 'Overview'], ['/help/getting-started', 'Getting Started'], ['/help/storage', 'Storage & Drives'], ['/help/accounts', 'Accounts & Quotas'], ['/help/network', 'Network & Ports'], ['/help/lights', 'Status Lights'], ['/help/recovery', 'Recovery Environment'], ['/help/sync', 'Sync & Backup'], ['/help/apps', 'Apps'], ['/help/troubleshooting', 'Troubleshooting']
  ],
  updates: [ ['/updates', 'Software Updates'] ]
};

function normalizedForApp(path) {
  const p = String(path || '/').replace(/\/$/, '') || '/';
  if (p === '/smb/shares' || p === '/nfs/shares') return '/shares';
  if (p === '/users/profiles') return '/users';
  if (p === '/backups/targets') return '/backups';
  if (p === '/hardware/profiles') return '/hardware';
  if (p === '/protocols') return '/settings';
  if (p === '/readiness') return '/diagnostics';
  if (p === '/mobile-offload') return '/phone-transfer';
  if (p === '/remote-access' || p.startsWith('/zero1connect')) return '/';
  if (p === '/storage/replacement') return '/storage/raid';
  if (p === '/recovery' || p === '/factory') return '/recovery/system';
  if (p.startsWith('/storage/disk0')) return '/storage';
  return p;
}
function currentApplication(path = location.pathname) {
  const p = String(path || '/').replace(/\/$/, '') || '/';
  if (p === '/') return applications[0];
  const candidates = applications.filter(app => app.match.some(prefix => prefix !== '/' && (p === prefix || p.startsWith(prefix + '/'))));
  return candidates.sort((a,b) => Math.max(...b.match.map(x=>x.length))-Math.max(...a.match.map(x=>x.length)))[0] || applications[0];
}
function appTabActive(path, href) {
  const target = new URL(href, location.origin);
  // Distinct user-management pages must not both inherit the /users active tab.
  // Preserve route aliases for other sections without collapsing Account Policies.
  const actualPath = normalizedPath(path), actualTarget = normalizedPath(target.pathname);
  if ((actualPath === '/users/profiles' || actualTarget === '/users/profiles') && actualPath !== actualTarget) return false;
  const p = normalizedForApp(path), h = normalizedForApp(target.pathname);
  if (h === '/') return p === '/';
  if (p !== h) return false;
  const targetView = target.searchParams.get('view') || '';
  const currentView = (normalizedPath(path) === normalizedPath(location.pathname)) ? routeView() : '';
  if (targetView) return currentView === targetView;
  if (currentView && h === '/storage') return false;
  return true;
}
function applicationBar(path = location.pathname) {
  const appDef = currentApplication(path);
  const tabs = applicationTabs[appDef.id] || [];
  if (!tabs.length) return '';
  return `<div class="application-bar"><div class="application-bar-inner"><div class="application-identity"><span>${icon(appDef.icon,18)}</span><b>${esc(appDef.label)}</b></div><nav class="application-tabs" aria-label="${attr(appDef.label)} sections">${tabs.map(([href,label])=>`<a href="${href}" class="${appTabActive(path,href)?'active':''}">${esc(label)}</a>`).join('')}</nav></div></div>`;
}
function activeFor(path, href) { return currentApplication(path).id === currentApplication(href).id; }

function preferredTheme() {
  const stored = localStorage.getItem('zero1-theme');
  // v0.1.22 wrote `system` automatically on first launch. It was not an
  // explicit owner choice, so v0.1.24 migrates that legacy default to Light.
  return stored === 'dark' ? 'dark' : 'light';
}
function applyTheme(theme = preferredTheme()) {
  const resolved = theme === 'dark' ? 'dark' : 'light';
  document.documentElement.dataset.theme = resolved;
  document.documentElement.dataset.themePreference = theme;
  localStorage.setItem('zero1-theme', theme);
  document.querySelectorAll('[data-zero1-brand-logo]').forEach(img => {
    const next = activeBrandLogoAsset(resolved);
    if (img.getAttribute('src') !== next) img.setAttribute('src', next);
  });
  const btn = document.querySelector('[data-action="toggle-theme"]');
  if (btn) btn.setAttribute('aria-label', resolved === 'dark' ? 'Use light appearance' : 'Use dark appearance');
}
function cycleTheme() {
  const current = document.documentElement.dataset.theme || 'light';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}
function stopTaskDrawerPolling(){if(window.__zero1TaskDrawerTimer){clearTimeout(window.__zero1TaskDrawerTimer);window.__zero1TaskDrawerTimer=null;}}
function stopNotificationDrawerPolling(){if(window.__zero1NotificationDrawerTimer){clearTimeout(window.__zero1NotificationDrawerTimer);window.__zero1NotificationDrawerTimer=null;}}
function renderTaskDrawerData(d){
  const drawer=document.getElementById('chromeDrawer');
  if(!drawer?.classList.contains('open')||drawer.dataset.kind!=='tasks')return;
  const body=drawer.querySelector('.chrome-drawer-body'),tasks=list(d.tasks).slice(0,12),running=Number(d.running||list(d.tasks).filter(x=>taskActiveStatus(x.status)).length||0);
  if(body)body.innerHTML=tasks.length?`<div class="drawer-list">${tasks.map(x=>`<a href="/tasks?task=${encodeURIComponent(x.id||'')}" class="drawer-item"><span class="drawer-status ${toneFor(x.status)}">${icon('tasks',17)}</span><div><b>${esc(x.title||x.kind||'Task')}</b><small>${esc(x.status||'Unknown')}${x.progress!=null?` · ${pct(x.progress)}%`:''}</small></div></a>`).join('')}</div><a class="drawer-footer-link" href="/tasks">Open Task Center ${icon('chevron',15)}</a>`:emptyState('No active tasks','Long-running operations will appear here.');
  const badge=document.querySelector('[data-task-count]');if(badge){badge.textContent=String(running);badge.classList.toggle('hidden',running===0);}
}
async function pollTaskDrawer(){
  stopTaskDrawerPolling();
  const drawer=document.getElementById('chromeDrawer');
  if(document.hidden||!drawer?.classList.contains('open')||drawer.dataset.kind!=='tasks')return;
  try{renderTaskDrawerData(await api('/api/tasks',{busy:false,fresh:true,stale:false}));}catch(_){}
  if(drawer?.classList.contains('open')&&drawer.dataset.kind==='tasks')window.__zero1TaskDrawerTimer=setTimeout(pollTaskDrawer,1500);
}
function renderNotificationDrawerData(d){
  const drawer=document.getElementById('chromeDrawer'); if(!drawer||drawer.dataset.kind!=='notifications')return;
  const body=drawer.querySelector('.chrome-drawer-body'),notes=visibleUnreadNotices(d).slice(0,12);
  if(body)body.innerHTML=notes.length?`<div class="drawer-list">${notes.map(x=>`<article class="drawer-item drawer-notice"><span class="drawer-status ${noticeTone(x.severity)}">${icon(x.severity==='critical'?'warning':'notifications',17)}</span><div class="drawer-notice-main"><a href="${attr(x.action_href||'/notifications')}" class="drawer-notice-link"><b>${esc(x.title||'Notification')}</b><small>${esc(x.detail||x.severity||'')}</small></a><div class="drawer-notice-actions"><button class="drawer-action" data-action="notification-state" data-state="read" data-notification="${attr(x.id)}">Mark read</button><button class="drawer-action" data-action="notification-state" data-state="dismissed" data-notification="${attr(x.id)}">Dismiss</button><button class="drawer-action" data-action="notification-state" data-state="ignored" data-notification="${attr(x.id)}">Don't remind me again</button></div></div></article>`).join('')}</div><a class="drawer-footer-link" href="/notifications">Open Notification Center ${icon('chevron',15)}</a>`:emptyState('No unread notifications','Zero1Local has nothing new to report.');
  const badge=document.querySelector('[data-notification-count]');if(badge){const unread=visibleUnreadNotices(d).length;badge.textContent=String(unread);badge.classList.toggle('hidden',unread===0);}
}
async function pollNotificationDrawer(){
  stopNotificationDrawerPolling(); const drawer=document.getElementById('chromeDrawer');
  if(document.hidden||!drawer?.classList.contains('open')||drawer.dataset.kind!=='notifications')return;
  try{renderNotificationDrawerData(await api('/api/notifications',{busy:false,fresh:true,stale:false}));}catch(_){}
  if(drawer?.classList.contains('open')&&drawer.dataset.kind==='notifications')window.__zero1NotificationDrawerTimer=setTimeout(pollNotificationDrawer,3000);
}
function closeChromeDrawer() {
  stopTaskDrawerPolling();
  stopNotificationDrawerPolling();
  const drawer = document.getElementById('chromeDrawer');
  if (!drawer) return;
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden','true');
  delete drawer.dataset.kind;
  drawer.innerHTML = '';
}
async function openChromeDrawer(kind) {
  stopTaskDrawerPolling();
  stopNotificationDrawerPolling();
  const drawer = document.getElementById('chromeDrawer');
  if (!drawer) return;
  drawer.dataset.kind=kind;
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden','false');
  drawer.innerHTML = `<header><div><small>${kind==='tasks'?'ACTIVITY':'NOTIFICATIONS'}</small><h2>${kind==='tasks'?'Tasks':'Notifications'}</h2></div><button class="icon-btn" data-action="chrome-drawer-close" aria-label="Close">${icon('close')}</button></header><div class="chrome-drawer-body"><div class="loading"><span class="spinner"></span>Loading…</div></div>`;
  const body = drawer.querySelector('.chrome-drawer-body');
  try {
    if (kind === 'tasks') {
      renderTaskDrawerData(await api('/api/tasks',{busy:false,fresh:true,stale:false}));
      window.__zero1TaskDrawerTimer=setTimeout(pollTaskDrawer,1500);
    } else {
      renderNotificationDrawerData(await api('/api/notifications',{busy:false,fresh:true,stale:false}));
      window.__zero1NotificationDrawerTimer=setTimeout(pollNotificationDrawer,3000);
    }
  } catch (err) { body.innerHTML = `<div class="drawer-error"><b>Unable to load</b><span>${esc(err.message)}</span></div>`; }
}
function toggleAccountMenu() {
  const menu = document.getElementById('accountMenu');
  menu?.classList.toggle('open');
}
function contextHelpModel(path=location.pathname){
  const appDef=currentApplication(path); const p=normalizedForApp(path);
  const base={title:appDef.label,summary:'Zero1Local keeps common owner tasks in the main workflow and moves implementation details behind contextual or advanced controls.',links:[]};
  const models={
    home:{title:'Home & Action Center',summary:'Use Home for appliance posture and Action Center for conditions that actually need intervention. Tasks and notifications are activity surfaces, not separate configuration areas.',links:[]},
    files:{title:'Files & Sharing',summary:'Browse owner data through active shared folders. Shared-folder definitions and access identities live beside File Manager because they describe who can reach the same data.',links:[]},
    storage:{title:'Storage',summary:'Storage covers the physical disks, RAID and filesystem capacity underneath your shared folders. File operations and protection policies stay in their own workflows.',links:[]},
    protection:{title:'Sync & Backup',summary:'Synchronization, Phone Transfer, restore, backups and snapshots live here. Direction and deletion behavior are explicit per workflow.',links:[]},
    connect:{title:'Experimental remote access',summary:'Remote pairing and tunnels are unavailable in this Zero1Local release.',links:[]},
    apps:{title:'Apps',summary:'Use the Catalog for normal application installs. Containers and Docker Compose remain available for direct Docker administration.',links:[]},
    people:{title:'Users & Groups',summary:'Manage the accounts and groups that can access shared folders.',links:[]},
    updates:{title:'Software Updates',summary:'Install, review and recover updates from this screen.',links:[]},
    connectivity:{title:'Connectivity',summary:'Network, VLANs and desktop integration are managed here. Review your management network and firewall rules here.',links:[]},
    system:{title:'System',summary:'System owns appliance-wide administration, access, security, automation, recovery and advanced statistics. Feature-specific settings stay with the feature they govern.',links:[]},
    help:{title:'Help Center',summary:'The Help Center explains Zero1Local features in owner-facing language and links directly to the controls used for each workflow.',links:[]}
  };
  const m=models[appDef.id]||base;
  if(p==='/security')m.note='Security focuses on sign-in protection, firewall policy, certificates and exposure. SSH, API keys and browser sessions live under System → Access & API.';
  if(p==='/system/access')m.note='Access & API centralizes browser sessions, SSH administration and API credentials.';
  if(p==='/office')m.note='Collabora is optional. For HTTPS browser access, terminate TLS at a trusted reverse proxy instead of directly exposing this NAS.';
  return m;
}
function openContextHelp(){const m=contextHelpModel();openModal(`Help · ${m.title}`,'Contextual Zero1Local guidance for the screen you are using.',`<div class="help-panel"><p>${esc(m.summary)}</p>${m.note?`<div class="notice notice-info"><b>Good to know</b><span>${esc(m.note)}</span></div>`:''}${list(m.links).length?`<div class="help-link-grid">${list(m.links).map(([href,label])=>`<a href="${attr(href)}">${esc(label)} ${icon('chevron',15)}</a>`).join('')}</div>`:''}<div class="context-note">${icon('about',16)}<span>If a setting changes only one feature, Zero1Local keeps it with that feature instead of adding another permanent System section.</span></div></div>`,'<button class="btn btn-primary" data-action="close-modal">Done</button>')}
function layout() {
  const path = location.pathname.replace(/\/$/, '') || '/';
  const activeApp = currentApplication(path);
  applyTheme(preferredTheme());
  app.innerHTML = `<div class="app-frame">
    <aside class="sidebar" aria-label="Applications">
      <a class="side-brand" href="/" aria-label="Zero1Local home">${brandLogoHTML('side')}</a>
      <nav class="application-rail">${applications.map(item=>`<a href="${item.href}" class="app-nav-item ${item.id===activeApp.id?'active':''}" data-app="${item.id}"><span class="app-nav-icon">${icon(item.icon,21)}</span><span>${esc(item.label)}</span></a>`).join('')}</nav>
      <div class="side-footer"><span class="local-dot"></span><div><b>Zero1Local</b><small>NAS management</small></div></div>
    </aside>
    <div class="workspace">
      <header class="topbar">
        <div class="topbar-left"><button class="chrome-button mobile-nav" data-action="toggle-nav" aria-label="Open application navigation">${icon('menu')}</button><div><strong id="topDevice">Zero1Local</strong><small id="topContext">${esc(activeApp.label)}</small></div></div>
        <div class="topbar-search"><span class="search-glyph">${icon('search',17)}</span><input id="globalSearch" type="search" placeholder="Search settings, users, shares and disks" autocomplete="off" aria-label="Search Zero1Local"><kbd>/</kbd><div id="globalSearchResults" class="global-search-results hidden"></div></div>
        <div class="topbar-right">
          
          <button class="chrome-button" id="notificationChrome" data-action="toggle-notification-drawer" aria-label="Open notifications">${icon('notifications')}<span class="chrome-count hidden" data-notification-count></span></button>
          <button class="chrome-button" data-action="refresh-current" aria-label="Refresh current page">${icon('replace')}</button><button class="chrome-button" data-action="context-help" aria-label="Help for this page">${icon('about')}</button>
          <button class="chrome-button" data-action="toggle-theme" aria-label="Toggle appearance">${icon('theme')}</button>
          <div class="account-control"><button class="account-button" data-action="toggle-account-menu" aria-label="Administrator menu"><span class="account-avatar">${esc(String(currentSession.username||'root').slice(0,1).toUpperCase())}</span><span class="account-name">${esc(currentSession.username||'root')}</span><span class="account-caret">⌄</span></button><div id="accountMenu" class="account-menu"><div class="account-summary"><b>${esc(currentSession.username||'root')}</b><span>${esc(currentSession.root?'Appliance administrator':String(currentSession.role||'auditor').replace(/-/g,' '))}</span><small>Zero1Local v${esc(releaseDisplayVersion())}${releaseBuildLabel()?` · build ${esc(releaseBuildLabel())}`:''}</small></div><a href="/system">${icon('power',17)} System & power</a><a href="/recovery/system">${icon('recovery',17)} Recovery</a><button data-action="sign-out">${icon('account',17)} Sign out</button></div></div>
        </div>
      </header>
      <div id="applicationBar">${applicationBar(path)}</div>
      <main class="page"><div id="flash" class="flash" aria-live="polite"></div><div id="content"><div class="loading"><span class="spinner"></span>Loading…</div></div></main>
    </div>
    <aside id="chromeDrawer" class="chrome-drawer" aria-hidden="true"></aside>
    <div id="globalBusy" class="global-busy" aria-live="polite" aria-hidden="true"><div class="global-busy-card"><span class="spinner"></span><div><b data-busy-text>Working…</b><small>Zero1Local is applying this change.</small></div></div></div>
    <div id="modalRoot"></div>
  </div>`;
}

function flash(message, kind = 'good') {
  const el = document.getElementById('flash');
  if (!el) return;
  el.innerHTML = `<div class="toast toast-${kind}"><b>${kind === 'bad' ? 'Action failed' : kind === 'warn' ? 'Attention' : 'Done'}</b><span>${esc(message)}</span></div>`;
  clearTimeout(flash._timer);
  flash._timer = setTimeout(() => { if (el) el.innerHTML = ''; }, 7000);
}
function pageError(err) {
  const c = document.getElementById('content');
  if (!c) return;
  c.innerHTML = `<section class="screen"><div class="page-heading"><div><div class="kicker">Zero1Local</div><h1>Unable to load this page</h1><p>${esc(err.message)}</p></div><button class="btn" data-action="reload">Try again</button></div></section>`;
}
const FRIENDLY_TITLE_MAP={
  'RAID':'Drive Protection','RAID1':'Drive Protection','VLANs':'VLANs','VLAN':'VLAN',
  'Synchronization':'Sync Jobs','Snapshots':'Restore Points','Compose':'Docker Compose','Docker Compose':'Docker Compose',
  'Containers':'App Containers','Diagnostics':'Advanced Stats','Services':'Background Services','Logs & Events':'Activity & Logs',
  'Recovery':'Recovery Tools','Logs':'Activity Logs','Phone Transfer':'Phone Transfer','Production qualification':'Full system check','Update readiness':'Ready for an update',
  'NFS exports':'Linux shared folders','SMB shared folders':'Windows shared folders','API keys':'App access keys'
};
const UI_HELP={
  'Drive Protection':'Keeps your data available if one protected drive fails. Zero1Local uses RAID1 mirroring where supported.',
  'Windows File Sharing':'Lets computers browse NAS folders using SMB, the standard Windows file-sharing protocol.',
  'Windows shared folders':'Folders shared to Windows, macOS and Linux computers using SMB.',
  'Linux File Sharing':'Lets Linux and Unix systems connect to NAS folders using NFS.',
  'Linux shared folders':'Folders shared to Linux and Unix systems using NFS.',
  'App Containers':'Runs packaged apps separately from the base NAS system. The underlying technology is Docker.',
  'Restore Points':'Point-in-time copies that can help recover an older version of data.',
  'Sync Jobs':'Automatically copies changes between the NAS and another location.',
  'Advanced Stats':'Shows appliance performance and history. Feature checks stay collapsed unless you need them.',
  'Background Services':'Programs that run behind the scenes to provide NAS features.',
  'Activity & Logs':'Recent NAS events. Raw technical logs remain available under Advanced.',
  'Activity Logs':'Recent NAS events. Raw technical logs remain available under Advanced.',
  'Phone Transfer':'Copies photos and files from supported phones to the NAS. Move mode verifies the NAS copy before removing the phone copy.',
  'Recovery Tools':'Independent tools for getting back into or repairing Zero1Local when the main web interface has a problem.',
  'Recovery Key':'A separate emergency key used by the independent Recovery service. Store it somewhere outside this NAS.',
  'Two-step verification':'Adds a one-time authenticator code after your normal password.',
  'App access keys':'Secret keys used by trusted apps or automations to connect to Zero1Local without using your normal web password.',
  'SSH keys':'A secure way for advanced users to sign in to the NAS command line without typing the root password.',
  'Firewall protection':'Controls which incoming network connections are allowed to reach the NAS.',
  'Automatic HTTPS certificate':'Creates or renews a trusted web certificate automatically when the NAS hostname can be validated.',
  'Remote Access VPN':'Creates a private encrypted connection back to your NAS when you are away from home.',
  'Network range':'A compact way to describe a group of IP addresses. The technical format is CIDR.',
  'Web gateway':'A reverse proxy sits in front of a web service and safely forwards approved browser traffic to it.',
  'Drive health':'Reads the drive\'s built-in health information and warning indicators.',
  'User ID':'Linux stores file ownership using a number called a UID.',
  'Group ID':'Linux identifies each local group using a number called a GID.',
  'Unique ID':'A stable identifier used internally so Zero1Local can keep track of an item even if its display name changes.'
};
function friendlyTitle(title){return FRIENDLY_TITLE_MAP[String(title||'')]||String(title||'')}
function infoTip(text,label='More information'){
  if(!text)return '';
  return `<span class="info-tip-wrap"><span class="info-tip" role="button" tabindex="0" aria-label="${attr(label)}" data-ui-help>i</span><span class="info-popover" role="tooltip">${esc(text)}</span></span>`;
}
function helpForLabel(text){
  const raw=String(text||'').trim();
  if(UI_HELP[raw])return UI_HELP[raw];
  for(const [key,value] of Object.entries(UI_HELP))if(raw===key||raw.startsWith(key+' ')||raw.startsWith(key+' ·'))return value;
  return '';
}
function heading(kicker, title, description, actions = '') {
  const appDef = currentApplication();
  const context = appDef ? appDef.label : String(kicker||'Zero1Local');
  const shown=friendlyTitle(title),help=helpForLabel(shown);
  return `<div class="page-heading"><div><div class="kicker">${esc(context)}</div><h1>${esc(shown)}${infoTip(help,`About ${shown}`)}</h1>${description ? `<p>${esc(description)}</p>` : ''}</div>${actions ? `<div class="page-actions">${actions}</div>` : ''}</div>`;
}
function sectionTitle(title, note = '', actions = '') {
  const shown=friendlyTitle(title),help=helpForLabel(shown);
  return `<div class="section-title"><div><h2>${esc(shown)}${infoTip(help,`About ${shown}`)}</h2>${note ? `<p>${esc(note)}</p>` : ''}</div>${actions}</div>`;
}

const FRIENDLY_TEXT_REPLACEMENTS=[
  [/\bProduction qualification\b/gi,'Full system check'],[/\bqualification evidence\b/gi,'feature checks'],[/\bqualification\b/gi,'system check'],[/\bqualified\b/gi,'tested'],[/\bqualify\b/gi,'test'],
  [/\bRAID1\b/gi,'Drive Protection'],[/\bRAID\b/gi,'Drive Protection'],[/\bCIDRs\b/gi,'network ranges'],[/\bCIDR\b/gi,'network range'],
  [/\bSMB shared folders\b/gi,'Windows shared folders'],[/\bSMB shares\b/gi,'Windows shared folders'],[/\bSMB users\b/gi,'file-sharing users'],[/\bSMB user\b/gi,'file-sharing user'],[/\bSMB password\b/gi,'file-sharing password'],[/\bSMB login\b/gi,'file-sharing login'],[/\bSMB\b/g,'Windows file sharing'],
  [/\bNFS exports\b/gi,'Linux shared folders'],[/\bNFS export\b/gi,'Linux shared folder'],[/\bNFS shares\b/gi,'Linux shared folders'],[/\bNFS\b/g,'Linux file sharing'],
  /* Docker Compose and technical Docker terms retain their proper product names. */
  [/\bAPI keys\b/gi,'App access keys'],[/\bAPI key\b/gi,'App access key'],[/\b2FA\b/g,'two-step verification'],[/\bTOTP\b/g,'authenticator code'],
  [/\bACME\b/g,'automatic HTTPS certificate'],[/\bWireGuard\b/g,'Remote Access VPN'],[/\breverse proxy\b/gi,'web gateway'],
  [/\bsnapshots\b/gi,'restore points'],[/\bsnapshot\b/gi,'restore point'],[/\brollback protection\b/gi,'previous-version protection'],[/\brollback\b/gi,'previous version'],
  [/\btransactional installer\b/gi,'protected installer'],[/\btransactional\b/gi,'protected'],[/\bpreflight\b/gi,'safety check'],
  [/\bS\.M\.A\.R\.T\.\b/gi,'drive health'],[/\bSMART\b/g,'drive health'],[/\bmanagement UI\b/gi,'web interface'],[/\bmanagement service\b/gi,'web service'],[/\bmanagement listener\b/gi,'web service'],[/\bmanagement address\b/gi,'NAS address'],
  [/\bappliance\b/gi,'NAS'],[/\bdaemon\b/gi,'background service'],[/\brclone authorization\b/gi,'provider authorization'],[/\brclone\b/gi,'cloud connector'],[/\blibmtp\b/gi,'Android USB transfer'],[/\bMTP\b/g,'Android USB file transfer'],[/\bAFC\b/g,'Apple USB file transfer'],[/\bSHA-256 verification\b/gi,'file integrity check'],[/\bSHA-256\b/g,'integrity check'],
  [/\bUID\b/g,'User ID'],[/\bGID\b/g,'Group ID'],[/\bUUID\b/g,'Unique ID']
];
const friendlyProcessedText=new WeakMap();
function humanizeTextValue(value){
  const original=String(value||''),trimmed=original.trim();
  let out=original;
  if(trimmed&&FRIENDLY_TITLE_MAP[trimmed])out=original.replace(trimmed,FRIENDLY_TITLE_MAP[trimmed]);
  for(const [pattern,replacement] of FRIENDLY_TEXT_REPLACEMENTS)out=out.replace(pattern,replacement);
  return out
}
function shouldKeepTechnicalText(node){const el=node?.parentElement;return !!el?.closest('code,pre,textarea,script,style,.advanced,.technical,.log-console,[data-preserve-technical],.info-popover')}
function humanizeVisibleTerminology(root=document.body){
  if(!root)return;
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
  const nodes=[];while(walker.nextNode())nodes.push(walker.currentNode);
  for(const node of nodes){
    if(shouldKeepTechnicalText(node))continue;
    const before=node.nodeValue||'';
    if(friendlyProcessedText.get(node)===before)continue;
    const after=humanizeTextValue(before);
    if(after!==before)node.nodeValue=after;
    friendlyProcessedText.set(node,after);
  }
}
function humanizeVisibleAttributes(root=document.body){
  if(!root?.querySelectorAll)return;
  const items=[];if(root.nodeType===1)items.push(root);items.push(...root.querySelectorAll('[title],[aria-label],[placeholder]'));
  for(const el of items){
    if(el.closest?.('code,pre,textarea,script,style,.advanced,.technical,.log-console,[data-preserve-technical],.info-popover'))continue;
    for(const name of ['title','aria-label','placeholder']){const before=el.getAttribute?.(name);if(!before)continue;const after=humanizeTextValue(before);if(after!==before)el.setAttribute(name,after)}
  }
}
function addContextHelp(root=document.body){
  if(!root?.querySelectorAll)return;
  const selectors='h1,h2,h3,.settings-row b,.integration-strip b,.form-section-title b,.table-toolbar b,th,summary';
  for(const el of root.querySelectorAll(selectors)){
    if(el.closest('.advanced,.technical,.info-tip-wrap')||el.dataset.uiHelpAdded==='1')continue;
    const help=helpForLabel(el.textContent||'');if(!help)continue;
    el.dataset.uiHelpAdded='1';el.insertAdjacentHTML('beforeend',infoTip(help,`About ${friendlyTitle(el.textContent||'this setting')}`));
  }
}
let friendlyUIQueued=false;
function refreshFriendlyUI(root=document.body){humanizeVisibleTerminology(root);humanizeVisibleAttributes(root);addContextHelp(root)}

function officialLayoutPolish(root = document.getElementById('content')) {
  if (!root) return;
  const excluded = new Set(['whole-appliance-panel','readiness-hero','volume-hero','service-hero','action-hero','update-hero','update-progress-card']);
  const canCluster = node => {
    if (!(node instanceof HTMLElement) || node.tagName !== 'SECTION' || !node.classList.contains('content-panel')) return false;
    if (node.classList.contains('cluster-section')) return false;
    for (const name of excluded) if (node.classList.contains(name)) return false;
    return true;
  };
  root.querySelectorAll('.screen').forEach(screen => {
    if (screen.dataset.officialPolish === '1') return;
    const children = [...screen.children];
    let run = [];
    const flush = () => {
      if (run.length >= 2) {
        const cluster = document.createElement('div');
        cluster.className = 'section-cluster';
        run[0].before(cluster);
        run.forEach(section => { section.classList.add('cluster-section'); cluster.append(section); });
      }
      run = [];
    };
    for (const child of children) {
      if (canCluster(child)) run.push(child);
      else flush();
    }
    flush();
    screen.dataset.officialPolish = '1';
  });
  root.querySelectorAll('.entity-list,.service-cards,.compact-list,.task-list,.runtime-policy').forEach(list => list.classList.add('grouped-rows'));
}
function scheduleFriendlyUI(root=document.body){if(friendlyUIQueued)return;friendlyUIQueued=true;queueMicrotask(()=>{friendlyUIQueued=false;refreshFriendlyUI(root)})}
const friendlyUIObserver=new MutationObserver(records=>{
  for(const r of records){
    if(r.type==='characterData'){scheduleFriendlyUI(r.target.parentElement);continue}
    if(r.type==='attributes'){scheduleFriendlyUI(r.target);continue}
    for(const n of r.addedNodes){if(n.nodeType===1||n.nodeType===3)scheduleFriendlyUI(n.nodeType===1?n:n.parentElement)}
  }
});
friendlyUIObserver.observe(document.documentElement,{subtree:true,childList:true,characterData:true,attributes:true,attributeFilter:['title','aria-label','placeholder']});
function emptyState(title, description, action = '') {
  return `<div class="empty"><span class="empty-icon">${icon('folder',22)}</span><h3>${esc(title)}</h3><p>${esc(description)}</p>${action}</div>`;
}

function openModal(title, subtitle, body, footer = '') {
  modalState = { title };
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-label="${attr(title)}" data-modal-panel>
    <header><div><h2>${esc(title)}</h2>${subtitle ? `<p>${esc(subtitle)}</p>` : ''}</div><button class="icon-btn" data-action="close-modal" aria-label="Close">×</button></header>
    <div class="modal-body">${body}</div>${footer ? `<footer>${footer}</footer>` : ''}
  </section></div>`;
  document.body.classList.add('modal-open');
}
function closeModal() {
  stopTaskDetailPolling();
  void closeMobileManualSession();
  const root = document.getElementById('modalRoot');
  if (root) root.innerHTML = '';
  document.body.classList.remove('modal-open');
  modalState = null;
}

async function authSetup() {
  applyTheme(preferredTheme());
  let d = { existing_nas:false, recommended_mode:'fresh', active_shares:[], docker_containers:0, owner_data:[], factory_data:[], legacy_zero1local_data:[] };
  try { d = await api('/api/setup/discovery'); } catch (_) {}
  const existing = d.existing_nas === true;
  const recommended = ['adopt','fresh'].includes(d.recommended_mode) ? d.recommended_mode : (existing ? 'adopt' : 'fresh');
  const modeCard = (mode,title,desc,badge='') => `<label class="setup-mode ${mode===recommended?'recommended':''}"><input type="radio" name="setupMode" value="${mode}" ${mode===recommended?'checked':''}><span><b>${esc(title)} ${badge?`<em>${esc(badge)}</em>`:''}</b><small>${esc(desc)}</small></span></label>`;
  app.innerHTML = `<div class="auth-shell"><section class="auth-card auth-card-wide"><div class="auth-brand">${brandLogoHTML('auth')}<h2>${existing?'Existing NAS detected':'Set up your NAS'}</h2><p>${existing?'Zero1Local found existing shares, files or applications. The recommended path adopts them in place without changing file ownership or moving your files just to fit Zero1Local.':'Zero1Local configures this NAS locally without requiring an external activation account.'}</p><div class="setup-discovery-summary"><div><b>${list(d.active_shares).length}</b><span>shared folders found</span></div><div><b>${Number(d.docker_containers||0)}</b><span>apps and containers</span></div><div><b>${list(d.owner_data).length}</b><span>data folders</span></div></div></div><div class="auth-form"><span class="auth-step">Zero1Local adaptive setup</span><h1>Choose how this NAS starts</h1><div class="setup-modes">${modeCard('adopt','Use My Existing NAS','Keep your files, shared folders, user accounts, permissions and existing apps in place. Zero1Local takes over management without rebuilding your storage.','Recommended for used NAS')}${modeCard('fresh','Set Up as a New NAS','Walk through storage protection, user accounts, shared folders and networking like a new NAS. Nothing is erased automatically.')}</div><div class="notice notice-info"><b>No blind deletion</b><span>Existing files and shared folders are preserved. Zero1Local does not erase storage as part of normal setup.</span></div><label>Administrator</label><input value="root" disabled><label>Web password</label><input id="setupPw" type="password" autocomplete="new-password"><label>Confirm password</label><input id="setupPw2" type="password"><div class="field-grid"><div><label>Device name</label><input id="setupName" value="${attr(location.hostname)}"></div><div><label>Timezone</label><input id="setupTz" value="America/New_York"></div></div><div id="authError"></div><div class="auth-actions"><button class="btn btn-primary btn-wide" data-action="setup-submit">Continue with Zero1Local</button></div></div></section></div>`;
}
function authLogin(powerCompletion = '', sessionExpired = false) {
  applyTheme(preferredTheme());
  const totp = bootStatus?.totp_enabled === true;
  app.innerHTML = `<div class="auth-shell"><section class="auth-card"><div class="auth-brand">${brandLogoHTML('auth')}<h2>Welcome back.</h2><p>Sign in to manage your NAS, shared folders and applications.</p></div><div class="auth-form"><span class="auth-step">Local management</span><h1>Sign in</h1><p>Manage storage, file sharing, users, networking and the appliance itself.</p>${sessionExpired?'<div class="notice notice-warn"><b>Session expired</b><span>Sign in again to continue. Zero1Local will return you to the page you were using.</span></div>':''}${powerCompletion?`<div class="notice notice-info"><b>Restart completed</b><span>${esc(powerCompletion)}</span></div>`:''}<label>Administrator</label><input id="loginUser" value="admin" autocomplete="username"><label>Web password</label><input id="loginPw" type="password" autocomplete="current-password">${totp?'<label>Authenticator code</label><input id="loginTotp" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="000000"><small class="field-help">Enter the 6-digit code from your authenticator app.</small>':''}<div id="authError"></div><div class="auth-actions"><button class="btn btn-primary btn-wide" data-action="login-submit">Sign in</button></div></div></section></div>`;
}
async function loginSubmit() {
  const button = document.querySelector('[data-action="login-submit"]');
  if (button) { button.disabled = true; button.textContent = 'Signing in…'; }
  try {
    const login = await api('/api/login', { method: 'POST', busy:false, body: JSON.stringify({ Username: document.getElementById('loginUser').value, Password: document.getElementById('loginPw').value, TOTP: document.getElementById('loginTotp')?.value || '' }) });
    currentSession = {username:login.username||document.getElementById('loginUser').value||'admin', role:login.role||'administrator', root:login.role==='administrator' || !login.role};
    authRedirecting = false;
    layout();
    await renderCurrentRoute({scroll:false, allowSnapshot:false});
  } catch (e) {
    showAuthError(e.message);
    if (button) { button.disabled = false; button.textContent = 'Sign in'; }
  }
}
function showAuthError(message) { const el = document.getElementById('authError'); if (el) el.innerHTML = `<div class="form-error">${esc(message)}</div>`; }
async function completeSetupTransition(nextHref = '/') {
  const next = String(nextHref || '/').startsWith('/') ? String(nextHref || '/') : '/';
  clearAPIMemo();
  bootStatus = { ...(bootStatus || {}), setup_required:false };
  currentSession = { username:'root', role:'administrator', root:true };
  history.replaceState({}, '', next);
  layout();
  try {
    await renderCurrentRoute({scroll:false, allowSnapshot:false});
  } catch (err) {
    // Setup already succeeded server-side and the session cookie is established.
    // A client-render failure must not leave the owner stranded on the installer.
    window.location.replace(next);
  }
}

function usageVisual(usage, label) {
  if (!usage || usage.error) return `<div class="storage-visual unavailable"><div class="donut" style="--used:0"></div><div><strong>${esc(label)}</strong><p>Capacity unavailable</p></div></div>`;
  const used = pct(usage.percent);
  return `<div class="storage-visual"><div class="donut" style="--used:${used}"><div><b>${used.toFixed(0)}%</b><span>used</span></div></div><div class="storage-copy"><strong>${esc(label)}</strong><p>${fmtBytes(usage.used)} used of ${fmtBytes(usage.total)}</p><div class="capacity-line"><i style="width:${used}%"></i></div><small>${fmtBytes(usage.available)} available · ${esc(usage.fstype || '')}</small></div></div>`;
}
function raidPlain(raid) {
  if (!raid) return { title: 'Single-disk Main Storage', detail: 'Main Storage is available without a software RAID array. Backups or replication provide protection from a drive failure.', tone: 'neutral' };
  const level=String(raid.level||'').toLowerCase();
  if (raid.health === 'healthy' && level === 'raid1') return { title: 'Your data is mirrored', detail: 'RAID1 keeps the same data on both drives. One drive can fail without immediately losing the array.', tone: 'good' };
  if (raid.health === 'healthy' && level === 'raid0') return { title: 'Striped Main Storage', detail: 'RAID0 combines both drives for capacity/performance but has no drive-failure redundancy. Backups or replication are strongly recommended.', tone: 'warn' };
  if (raid.health === 'healthy') return { title: 'Main Storage array is healthy', detail: `${String(raid.level||'Software RAID').toUpperCase()} is online and backing Main Storage.`, tone: 'good' };
  if (raid.health === 'degraded' && level === 'raid1') return { title: 'RAID1 needs attention', detail: 'One side of the mirror is missing or unhealthy. Main Storage may remain available for recovery, but replace the failed member before relying on redundancy.', tone: 'bad' };
  if (raid.health === 'degraded') return { title: 'RAID needs attention', detail: 'The array is incomplete or unhealthy. Avoid unnecessary changes until the failed member is identified.', tone: 'bad' };
  return { title: 'RAID state needs review', detail: raid.status || 'Zero1Local cannot confidently classify the array.', tone: 'warn' };
}
function smartHealth(item) {
  const passed = item?.smart_status?.passed;
  if (passed === true) return ['Healthy', 'good'];
  if (passed === false) return ['SMART warning', 'bad'];
  return [item?.error ? 'Unavailable' : 'Not reported', item?.error ? 'warn' : 'neutral'];
}
function diskName(item) {
  return item?.model || item?.model_name || item?.device?.name || item?.device || 'Disk';
}
function diskSerial(item) { return item?.serial_number || item?.serial || 'Serial not reported'; }
function diskTemp(item) { const n = item?.temperature?.current; return Number.isFinite(Number(n)) ? `${Number(n)}°C` : '—'; }
function diskCapacity(item, lsblkDisk) { return item?.user_capacity?.bytes || lsblkDisk?.size || 0; }
function raidMemberNames(storage) {
  const names = new Set();
  list(storage?.raid).forEach(r => list(r.members).forEach(m => { const n = String(m || '').replace(/\[.*$/, '').trim(); if (n) names.add(n); }));
  return names;
}
function dataDisks(storage) {
  const members = raidMemberNames(storage);
  const all = list(storage?.block_devices?.blockdevices).filter(x => x.type === 'disk');
  const matched = all.filter(x => members.has(String(x.name || '')) || members.has(String(x.path || '').replace(/^\/dev\//,'')));
  if (matched.length) return matched;
  return all.filter(x => /^sd[a-z]+$/.test(String(x.name || '')));
}
function systemEMMC(storage) { return list(storage?.block_devices?.blockdevices).find(x => x.name === 'mmcblk0') || null; }
function smartForDisk(storage, disk) { return list(storage?.smart).find(x => String(x.device || '') === String(disk?.path || `/dev/${disk?.name || ''}`)) || {}; }
function driveDisplayLabel(disk, index) { return `Data drive ${index + 1}`; }
function smartPresentation(sm) {
  const policy=String(sm?.zero1_health||'').toLowerCase();
  if(policy==='healthy') return ['Healthy','good'];
  if(policy==='warning') return ['Needs attention','warn'];
  if(policy==='failed') return ['Critical SMART warning','bad'];
  if(policy==='unknown'&&sm?.zero1_health_detail) return ['SMART status unknown','neutral'];
  const [health,tone]=smartHealth(sm);
  if (health === 'Unavailable') return ['Drive online · SMART unavailable', 'neutral'];
  return [health,tone];
}
function smartReason(sm){
  const reasons=list(sm?.zero1_health_reasons).filter(Boolean);
  if(reasons.length)return reasons.join(' · ');
  return String(sm?.zero1_health_detail||'').trim();
}

async function dashboard() {
  const [sys, storage, shares, nfs, docker, network, tasks, notifications, users, backups, offsite, replication, updates, securityCenter, services] = await Promise.all([
    api('/api/system'), api('/api/storage'), api('/api/shares').catch(() => ({ active: [] })), api('/api/nfs/exports').catch(() => ({})), api('/api/docker').catch(() => ({})), api('/api/network').catch(() => ({})), api('/api/tasks').catch(()=>({tasks:[],running:0})), api('/api/notifications').catch(()=>({unread:0,notifications:[]})), api('/api/users').catch(()=>({users:[]})), api('/api/backups').catch(()=>({jobs:[]})), Promise.resolve({jobs:[]}), api('/api/replication').catch(()=>({jobs:[]})), api('/api/update/status').catch(()=>({})), api('/api/security/center').catch(()=>({})), api('/api/services').catch(()=>({services:[]}))
  ]);
  const ownerUnread=visibleUnreadNotices(notifications).length;
  const actionable=visibleUnreadNotices(notifications).filter(n=>['warning','critical'].includes(String(n.severity||'').toLowerCase()));
  const actions={healthy:actionable.length===0,action_count:actionable.length,actions:actionable};
  const raid=list(storage.raid)[0];
  const raidInfo=raidPlain(raid);
  const activeShares=mergedSMBShareInventory(shares).shares;
  const disks=dataDisks(storage);
  const temps=list(sys.temperatures).map(x=>Number(x.celsius)).filter(Number.isFinite);
  const hottest=temps.length?Math.max(...temps):null;
  const primary=network.primary||{};
  const lan=primary.address||String(primary.address_cidr||'').split('/')[0]||location.hostname;
  const smbInventory=shares.inventory||{};
  const memTotal=parseInt(String(sys.memory?.MemTotal||'0').replace(/\D/g,''),10)*1024;
  const memAvail=parseInt(String(sys.memory?.MemAvailable||'0').replace(/\D/g,''),10)*1024;
  const memUsed=Math.max(0,memTotal-memAvail);
  const memPct=memTotal?Math.max(0,Math.min(100,memUsed*100/memTotal)):0;
  const serviceList=list(services.services), failedServices=serviceList.filter(x=>x.active==='failed');
  const protectionJobs=[...list(backups.jobs),...list(replication.jobs)];
  const protectionFailed=protectionJobs.some(x=>String(x.last_status||x.status||'').toLowerCase()==='failed');
  const ownerUsers=list(users.users).filter(x=>!x.legacy);
  const securityAttention=String(securityCenter.status||securityCenter.summary||'').toLowerCase().includes('attention');
  const dockerAttention=docker.installed&&docker.service_active===false;
  const storagePercent=Number(storage.data_usage?.percent||0);
  const ring=(label,value,detail,tone='good')=>`<div class="dashboard-ring-block"><div class="dashboard-ring tone-${tone}" style="--ring:${Math.max(0,Math.min(100,Number(value)||0))}"><div><b>${Math.round(Number(value)||0)}%</b><span>${esc(label)}</span></div></div><small>${esc(detail)}</small></div>`;
  const workspace=(href,iconName,kicker,title,detail,state,tone)=>`<a href="${href}" class="dashboard-workspace-card"><span class="dashboard-workspace-icon">${icon(iconName,20)}</span><div><small>${esc(kicker)}</small><b>${esc(title)}</b><p>${esc(detail)}</p></div>${statusPill(state,tone)}</a>`;
  const activity=(href,iconName,label,value,detail,tone='neutral')=>`<a href="${href}" class="dashboard-activity-row"><span class="dashboard-activity-icon tone-${tone}">${icon(iconName,17)}</span><div><b>${esc(label)}</b><small>${esc(detail)}</small></div><strong>${esc(value)}</strong>${icon('chevron',14)}</a>`;
  document.getElementById('topDevice').textContent=sys.hostname||'Zero1Local';
  document.getElementById('content').innerHTML=`<section class="screen dashboard-screen">
    ${heading('Overview',sys.hostname||'Zero1Local','Storage, system health and recent activity.')}


    <div class="dashboard-primary-grid">
      <section class="content-panel dashboard-storage-card">
        ${sectionTitle('Main Storage',raidInfo.detail,'<a class="text-link" href="/storage">Storage Manager →</a>')}
        <div class="dashboard-storage-body">${usageVisual(storage.data_usage,'Main Storage')}<div class="dashboard-storage-facts"><div><span>Protection</span><b>${String(raid?.level||'').toLowerCase()==='raid1'?'Mirrored RAID1':String(raid?.level||'').toLowerCase()==='raid0'?'Striped RAID0':'Single disk'}</b></div><div><span>Drive health</span><b>${disks.length} data drive${disks.length===1?'':'s'} · ${esc(raidInfo.title)}</b></div><div><span>Temperature</span><b>${hottest===null?'Not reported':hottest.toFixed(1)+'°C hottest sensor'}</b></div><div><span>Shared folders</span><b>${activeShares.length} active</b></div></div></div>
      </section>
      <div class="dashboard-side-stack">
        <section class="content-panel dashboard-system-card">
          ${sectionTitle('System','Live capacity and runtime health.','<a class="text-link" href="/system">System & Power →</a>')}
          <div class="dashboard-system-visual">${ring('Memory',memPct,memTotal?`${fmtBytes(memAvail)} available`:'Usage unavailable',memPct>90?'bad':memPct>80?'warn':'good')}<div class="dashboard-system-facts"><div><span>Uptime</span><b>${esc(sys.uptime||'—')}</b></div><div><span>Services</span><b>${failedServices.length?`${failedServices.length} need attention`:`${serviceList.filter(x=>x.active==='active').length} running`}</b></div><div><span>Software</span><b>v${esc(releaseDisplayVersion())}</b></div></div></div>
        </section>
        <section class="content-panel dashboard-network-card">
          ${sectionTitle('Network','How this NAS is reached.','<a class="text-link" href="/network">Connectivity →</a>')}
          <div class="dashboard-network-address"><small>PRIMARY LAN</small><b>${esc(lan)}</b>${primary.speed_mbps?`<span>${esc(primary.speed_mbps)} Mbps${primary.duplex?` · ${esc(primary.duplex)}`:''}</span>`:''}</div>
          <div class="dashboard-network-facts"><div><span>Gateway</span><b>${esc(primary.gateway||'Not reported')}</b></div></div>
        </section>
      </div>
    </div>

    <section class="dashboard-workspaces-panel">
      <div class="dashboard-section-heading"><div><h2>Workspaces</h2><p>Each area owns one job. Open the area you actually need instead of hunting through System.</p></div></div>
      <div class="dashboard-workspaces-grid">
        ${workspace('/files','files','FILES & SHARING',`${activeShares.length} shared folder${activeShares.length===1?'':'s'}`,`${ownerUsers.length} owner account${ownerUsers.length===1?'':'s'} · ${list(nfs.exports).length} NFS export${list(nfs.exports).length===1?'':'s'}`,shares.service_active===false?'Attention':'Ready',shares.service_active===false?'bad':'good')}
        ${workspace('/protection','protection','SYNC & BACKUP',`${protectionJobs.length} configured job${protectionJobs.length===1?'':'s'}`,'Backup, synchronization, restore and replication',protectionFailed?'Attention':'Ready',protectionFailed?'bad':'good')}
        ${workspace('/apps/catalog','docker','APPS',`${list(docker.containers).length} container${list(docker.containers).length===1?'':'s'}`,docker.installed?(docker.service_active===false?'Docker engine is offline':'Catalog, containers and Compose'):'Docker is not available',dockerAttention?'Attention':'Ready',dockerAttention?'bad':'good')}
        ${workspace('/security','security','SECURITY',securityCenter.status||securityCenter.summary||'Security Center','Firewall, sessions and sign-in protection',securityAttention?'Attention':'Protected',securityAttention?'warn':'good')}
        ${workspace('/settings','settings','SYSTEM',updates.available?'Software update available':'Appliance administration','Hardware, updates, power, recovery and diagnostics',updates.available?'Update':'Ready',updates.available?'warn':'good')}
      </div>
    </section>

    <div class="dashboard-lower-grid">
      <section class="content-panel dashboard-shares-card">
        ${sectionTitle('Shared folders',activeShares.length?'Live SMB shares available from Main Storage.':'No SMB share is currently available.','<a class="btn btn-small" href="/shares">Manage shares</a>')}
        ${activeShares.length?`<div class="dashboard-share-list">${activeShares.slice(0,6).map(sh=>`<a href="/shares"><span class="dashboard-share-icon">${icon('folder',17)}</span><div><b>${esc(sh.name)}</b><small>${esc(windowsShare(sh.name))}</small></div><span>${esc(permissionSummary(sh))}</span>${icon('chevron',14)}</a>`).join('')}</div>`:`<div class="inventory-warning"><div><b>${shares.service_active===false?'SMB service is not running.':'SMB inventory returned no shares.'}</b><p>${esc(list(smbInventory.warnings).join(' ')||'Open Shared Folders to create or inspect a share.')}</p></div><a class="btn btn-small" href="/shares">Open Shared Folders</a></div>`}
      </section>
      <section class="content-panel dashboard-activity-card">
        ${sectionTitle('Activity & attention','The small set of things worth checking now.')}
        <div class="dashboard-activity-list">
          
          ${activity('/notifications','notifications','Notifications',Number(tasks.running||0)?`${Number(tasks.running||0)} running`:ownerUnread?`${ownerUnread} unread`:'Caught up',Number(tasks.running||0)?'Background work is in progress':ownerUnread?'New messages to review':'No new messages',ownerUnread?'warn':'good')}
          ${activity('/updates','update','Software Update',updates.available?'Available':'Current',updates.available?`v${esc(updates.available.version||'new release')} is ready`:`v${esc(releaseDisplayVersion())} is installed`,updates.available?'warn':'good')}
          ${activity('/storage/disks','disks','Drive Health',raidInfo.tone==='bad'?'Attention':raidInfo.tone==='warn'?'Review':'Ready',`${disks.length} data drive${disks.length===1?'':'s'} · ${raidInfo.title}`,raidInfo.tone)}
        </div>
      </section>
    </div>
  </section>`;
}

async function readinessPage() {
  if(normalizedPath(location.pathname)==='/readiness') history.replaceState({},'', '/diagnostics'+location.search);
  return diagnosticsPage();
}

async function storageOverview() {
  if(isUSBDrivesView()) return usbDrivesPage();
  const [d,sharesData] = await Promise.all([api('/api/storage'),api('/api/shares').catch(()=>({active:[]}))]);
  const raid = list(d.raid)[0];
  const info = raidPlain(raid);
  const disks = dataDisks(d);
  const emmc = systemEMMC(d);
  const shares=list(sharesData.active);
  const fs=String(d.data_usage?.fstype||'—').toUpperCase();
  const source=d.data_usage?.source||'Not reported';
  const usage=d.data_usage||{};
  document.getElementById('content').innerHTML = `<section class="screen storage-manager-screen">
    ${heading('Storage Manager','Storage Manager','Physical drives, RAID, filesystem capacity and storage health in one view.','<a class="btn" href="/files">Open File Manager</a>')}
    <div class="storage-stat-strip">
      <div>${icon('storage',22)}<span>Available space</span><b>${fmtBytes(usage.free)}</b></div>
      <div>${icon('disks',22)}<span>Data drives</span><b>${disks.length}</b></div>
      <div>${icon('raid',22)}<span>Drive protection</span><b>${esc(info.title)}</b></div>
      <div>${icon('folder',22)}<span>Shared folders</span><b>${shares.length}</b></div>
    </div>
    <div class="storage-manager-grid">
      <section class="content-panel chassis-panel">${sectionTitle('Drive bays',`${disks.length} removable data drive${disks.length===1?'':'s'} detected.`,'<a class="btn btn-small" href="/storage/disks">Drive details</a>')}
        <div class="nas-chassis"><div class="chassis-label"><b>${esc(d.model||'Zero1Local NAS')}</b><span>DATA BAYS</span></div><div class="chassis-bays">${[0,1].map(i=>{const disk=disks[i];if(!disk)return `<div class="physical-bay empty-bay"><div class="bay-number">${i+1}</div><div><b>Empty bay</b><small>No data drive detected</small></div><span class="bay-led off"></span></div>`;const sm=smartForDisk(d,disk),[health,tone]=smartPresentation(sm);return `<a class="physical-bay" href="/storage/disks"><div class="bay-number">${i+1}</div><div class="bay-drive-copy"><b>${esc(disk.model||disk.name)}</b><small>${fmtBytes(disk.size)} · ${esc(diskTemp(sm))}</small><span>${esc(disk.serial||disk.path||'Serial unavailable')}</span></div><span class="bay-health bay-${tone}"></span><div class="bay-state">${statusPill(health,tone)}</div></a>`}).join('')}</div></div>
        <div class="chassis-system-media"><span>${icon('hardware',17)}</span><div><b>Internal eMMC</b><small>System storage · ${fmtBytes(emmc?.size||0)}</small></div>${statusPill('System','neutral')}</div>
      </section>
      <section class="content-panel storage-logical-panel">${sectionTitle('Main Storage',info.detail,'<a class="btn btn-small" href="/storage/raid">RAID details</a>')}
        <div class="logical-storage-stack"><div class="logical-node"><span>${icon('disks',18)}</span><div><small>PHYSICAL</small><b>${disks.length} data drives</b></div></div><span class="logical-arrow">${icon('chevron',15)}</span><div class="logical-node"><span>${icon('raid',18)}</span><div><small>LAYOUT</small><b>${raid?.level?esc(String(raid.level).toUpperCase()):'SINGLE DISK'}</b></div>${statusPill(raid?.health||'Available',info.tone)}</div><span class="logical-arrow">${icon('chevron',15)}</span><div class="logical-node"><span>${icon('storage',18)}</span><div><small>FILESYSTEM</small><b>${esc(fs)} · /disk0</b></div></div></div>
        <div class="capacity-meter"><div class="capacity-meter-head"><div><b>Main Storage</b><small>${esc(source)}</small></div><strong>${usage.percent!=null?`${pct(usage.percent)}% used`:'Capacity unavailable'}</strong></div><div class="capacity-track"><i style="width:${pct(usage.percent)}%"></i></div><div class="capacity-legend"><span>${fmtBytes(usage.used)} used</span><span>${fmtBytes(usage.free)} available</span><span>${fmtBytes(usage.total)} total</span></div></div>
        <div class="storage-health-line"><div><span class="health-dot ${info.tone}"></span><div><b>${esc(info.title)}</b><small>${shares.length} active shared folder${shares.length===1?'':'s'} on Main Storage</small></div></div><a href="/storage/analytics">View usage analytics ${icon('chevron',14)}</a></div>
      </section>
    </div>
    <section class="content-panel admin-section">${sectionTitle('Shared storage',`${shares.length} shared folder${shares.length===1?'':'s'} currently use this appliance storage.`,'<a class="btn btn-small" href="/shares">Manage shares</a>')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Shared folder</th><th>Location</th><th>Network path</th><th>Access</th></tr></thead><tbody>${shares.map(sh=>`<tr><td><b>${esc(sh.name)}</b></td><td>${esc(friendlyShareLocation(sh))}</td><td><code>${esc(windowsShare(sh.name))}</code></td><td>${esc(permissionSummary(sh))}</td></tr>`).join('')||'<tr><td colspan="4">No active shared folders.</td></tr>'}</tbody></table></div></section>
  </section>`;
}

async function dataVolume() {
  const d = await api('/api/storage');
  const raid = list(d.raid)[0];
  const info = raidPlain(raid);
  const mounts = d.mounts?.filesystems || [];
  const mount = mounts.find(x => x.target === '/disk0') || {};
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Storage / Main Storage', 'Main Storage', 'This is where your shared folders and files live.', '<a class="btn btn-primary" href="/files">Browse files</a>')}
    <section class="content-panel volume-hero"><div>${usageVisual(d.data_usage, 'Main Storage')}</div><div class="volume-details"><div><span>Storage type</span><b>${String(raid?.level||'').toLowerCase()==='raid1'?'Mirrored RAID1':String(raid?.level||'').toLowerCase()==='raid0'?'Striped RAID0':'Single disk'}</b></div><div><span>Drives</span><b>${list(raid?.members).length || (d.data_usage?.source?1:'—')}</b></div><div><span>Status</span><b>${esc(info.title)}</b></div><div><span>Used for</span><b>Files & shared folders</b></div></div></section>
    <div class="explain explain-${info.tone}"><div class="explain-icon">${icon('raid')}</div><div><b>${esc(info.title)}</b><p>${esc(info.detail)}</p></div><a href="/storage/raid">Open RAID</a></div>
    <section class="content-panel">${sectionTitle('What uses Main Storage', 'Shared-folder services and the file browser all use the same Main Storage.')}<div class="link-grid"><a href="/smb/shares"><span>${icon('smb')}</span><b>SMB shares</b><small>Windows and network file sharing</small></a><a href="/nfs/shares"><span>${icon('nfs')}</span><b>NFS shares</b><small>Linux/Unix network mounts</small></a><a href="/files"><span>${icon('files')}</span><b>File browser</b><small>Browse Main Storage</small></a></div></section>
    <details class="advanced"><summary>Advanced storage details</summary><div class="advanced-body"><div class="capability-table"><div><span>Filesystem</span><b>${esc(d.data_usage?.fstype || mount.fstype || '—').toUpperCase()}</b></div><div><span>Linux device</span><b>${esc(d.data_usage?.source || mount.source || '—')}</b></div><div><span>Mount point</span><b>/disk0</b></div><div><span>RAID level</span><b>${raid?.level?esc(String(raid.level).toUpperCase()):'None'}</b></div></div></div></details>
  </section>`;
}

function raidConsistencyPanel(st={}){
  if(!st.available)return '<div class="notice notice-warn"><b>Consistency status unavailable</b><span>The md127 kernel maintenance controls are not available on this appliance.</span></div>';
  if(!st.running)return `<div class="maintenance-live idle"><div><b>Consistency check</b><small>Idle · last mismatch count ${esc(st.mismatch_count||'0')}</small></div>${statusPill('Ready','good')}</div>`;
  const pct=Math.max(0,Math.min(100,Number(st.percent_complete||0)));
  return `<div class="maintenance-live running"><div class="maintenance-live-head"><div><span class="spinner"></span><div><b>Checking RAID consistency</b><small>${esc(st.action||'check')} · ${pct}% complete</small></div></div><strong>${pct}%</strong></div><div class="task-progress"><i style="width:${pct}%"></i></div><small>${esc(st.completed||st.detail||'The RAID array remains online while this check runs.')}</small></div>`;
}
async function refreshRaidConsistencyProgress(){
  if(location.pathname!=='/storage/raid')return;
  try{
    const st=await api('/api/storage/raid1/status',{busy:false,fresh:true});
    const box=document.getElementById('raidConsistencyLive');if(box)box.innerHTML=raidConsistencyPanel(st);
    const btn=document.querySelector('[data-action="raid-scrub"]');if(btn){btn.disabled=!!st.running;btn.textContent=st.running?'Consistency check running…':'Check consistency';}
    window.__zero1RaidPollTimer=setTimeout(refreshRaidConsistencyProgress,st.running?3000:10000);
  }catch{window.__zero1RaidPollTimer=setTimeout(refreshRaidConsistencyProgress,10000)}
}

async function raidPage() {
  clearTimeout(window.__zero1RaidPollTimer);
  const [d,replacement,maintenance,consistency]=await Promise.all([api('/api/storage'),api('/api/storage/replacement').catch(()=>({})),api('/api/maintenance').catch(()=>({policy:{}})),api('/api/storage/raid1/status',{fresh:true}).catch(()=>({available:false}))]);
  const arrays=list(d.raid), disks=list(d?.block_devices?.blockdevices).filter(x=>x.type==='disk'&&/^sd[a-z]+$/.test(String(x.name||'')));
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Storage Manager','RAID','Inspect, maintain and replace drives in Main Storage from one place.',!arrays.length?'<button class="btn btn-danger" data-action="raid-create">Create RAID1 Main Storage</button>':'')}${storageTabs('raid')}
    ${arrays.map(r=>{const info=raidPlain(r),raid1=String(r.level||'').toLowerCase()==='raid1',degraded=String(replacement.degraded||'0').trim()!=='0'||r.health==='degraded';return `<section class="content-panel raid-detail"><div class="raid-summary"><div class="raid-ring raid-${info.tone}"><span>${r.health==='healthy'?'✓':'!'}</span></div><div><h2>${raid1?'Mirrored storage':String(r.level||'').toLowerCase()==='raid0'?'Striped storage · no redundancy':'Software RAID'}</h2><p>${esc(info.detail)}</p>${statusPill(r.health,info.tone)}</div></div><div class="member-list">${list(r.members).map((m,i)=>`<div><span class="member-icon">${i+1}</span><b>${esc(m.replace(/\[.*$/,''))}</b><small>${raid1?'Mirror member':'Array member'}</small><span>${statusPill(m.includes('_')?'Missing':'Online',m.includes('_')?'bad':'good')}</span></div>`).join('')}</div>${raid1?`<div id="raidConsistencyLive">${raidConsistencyPanel(consistency)}</div><div class="raid-management-actions"><div><b>${degraded?'Drive replacement required':'RAID1 maintenance'}</b><small>${degraded?'Choose a replacement drive and Zero1Local will add it to the existing mirror.':'Consistency checking and drive replacement are managed here without recreating Main Storage.'}</small></div><div class="row-actions"><button class="btn btn-small" data-action="raid-scrub" ${consistency.running?'disabled':''}>${consistency.running?'Consistency check running…':'Check consistency'}</button><button class="btn btn-small ${degraded?'btn-primary':''}" data-action="replacement-add">${degraded?'Replace failed drive':'Replace a drive'}</button></div></div>`:''}<details class="advanced"><summary>Advanced RAID details</summary><div class="advanced-body"><pre>${esc(r.status||d.mdstat||'')}</pre>${raid1?`<div class="capability-table"><div><span>Maintenance schedule</span><b>${maintenance.policy?.raid_scrub_day?`${esc(maintenance.policy.raid_scrub_day)} · ${esc(maintenance.policy.raid_scrub_time||'scheduled')}`:'Not scheduled'}</b></div><div><span>Candidate data drives</span><b>${disks.map(x=>x.path||`/dev/${x.name}`).join(', ')||'None detected'}</b></div><div><span>Creation format</span><b>XFS on RAID1</b></div></div><a class="btn btn-small" href="/automation">Maintenance schedule</a>`:''}</div></details></section>`}).join('')||emptyState('No RAID array detected','For a fresh appliance, create a two-drive RAID1 here. Zero1Local will never format an existing mounted Main Storage automatically.')}
  </section>`;
  window.__zero1RaidPollTimer=setTimeout(refreshRaidConsistencyProgress,consistency.running?3000:10000);
}

function smartTestByDevice(data){return new Map(list(data?.tests).map(x=>[String(x.device||''),x]));}
function smartTestProgressHTML(st){
  if(!st?.running)return '<div class="smart-test-idle"><small>No self-test running</small></div>';
  const pct=Math.max(0,Math.min(100,Number(st.percent_complete||0)));
  return `<div class="smart-test-live"><div><span class="spinner"></span><b>Self-test running</b><strong>${pct}%</strong></div><div class="task-progress"><i style="width:${pct}%"></i></div><small>${Number(st.remaining_percent||0)}% remaining · ${esc(st.detail||'Drive firmware is running the test.')}</small></div>`;
}
async function refreshSmartTestProgress(){
  if(location.pathname!=='/storage/disks')return;
  try{
    const data=await api('/api/storage/smart-tests',{busy:false,fresh:true}),states=smartTestByDevice(data);
    document.querySelectorAll('[data-smart-state]').forEach(box=>{const st=states.get(box.dataset.smartState)||{};box.innerHTML=smartTestProgressHTML(st);});
    document.querySelectorAll('[data-action="smart-test"]').forEach(btn=>{const st=states.get(btn.dataset.device)||{};btn.disabled=!!st.running;});
    const running=list(data.tests).some(x=>x.running);
    window.__zero1SmartPollTimer=setTimeout(refreshSmartTestProgress,running?3000:10000);
  }catch{window.__zero1SmartPollTimer=setTimeout(refreshSmartTestProgress,10000)}
}

async function disksPage() {
  clearTimeout(window.__zero1SmartPollTimer);
  const [d,deep,history,testData] = await Promise.all([api('/api/storage'),api('/api/storage/health').catch(()=>({disks:[]})),api('/api/storage/health-history').catch(()=>({drives:{}})),api('/api/storage/smart-tests',{fresh:true}).catch(()=>({tests:[]}))]);
  const disks = dataDisks(d),testByDevice=smartTestByDevice(testData);
  const deepByName=new Map(list(deep.disks).map(x=>[String(x.name||''),x]));
  const emmc = systemEMMC(d);
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Storage / Drives', 'Drives', 'The removable data drives are shown separately from the internal system storage.')}${storageTabs('disks')}
    <section class="content-panel">${sectionTitle('Data drives', 'RAID members and their current health. SMART self-tests are non-destructive drive diagnostics.')}
      <div class="disk-table-wrap"><table class="data-table"><thead><tr><th>Drive</th><th>Model / Serial</th><th>Capacity</th><th>Health</th><th>Temperature</th><th>Diagnostics</th></tr></thead><tbody>${disks.map((disk, i) => { const sm = smartForDisk(d, disk); const [health, tone] = smartPresentation(sm); const dev=disk.path || `/dev/${disk.name}`,st=testByDevice.get(dev)||{}; return `<tr><td><span class="drive-id">${esc(driveDisplayLabel(disk,i))}</span><small>Protects Main Storage</small></td><td><b>${esc(disk.model || 'Data drive')}</b><small>${esc(disk.serial || 'Serial not reported')}</small></td><td>${fmtBytes(disk.size)}</td><td><div class="drive-health-inline">${statusPill(health, tone)}${smartReason(sm)?`<small>${esc(smartReason(sm))}</small>`:''}</div></td><td>${esc(diskTemp(sm))}</td><td><div class="smart-diagnostic-cell"><div class="row-actions">${d.smart_available?`<button class="btn btn-small btn-quiet" data-action="smart-test" data-device="${attr(dev)}" data-test="short" ${st.running?'disabled':''}>Short test</button><button class="btn btn-small btn-quiet" data-action="smart-test" data-device="${attr(dev)}" data-test="long" ${st.running?'disabled':''}>Long test</button>`:'<span class="locked-label">SMART unavailable</span>'}</div><div data-smart-state="${attr(dev)}">${smartTestProgressHTML(st)}</div></div></td></tr>`; }).join('')}</tbody></table></div>
    </section>
    <section class="content-panel">${sectionTitle('Drive health details','Plain-language SMART assessment, identity, lifetime and temperature details reported directly by each drive.')}<div class="drive-health-grid">${disks.map((disk,i)=>{const x=deepByName.get(String(disk.name||''))||{};const sm=x.smart||{};const health=String(x.health||'unknown');return `<article class="drive-health-card"><header><span>${i+1}</span><div><h3>${esc(driveDisplayLabel(disk,i))}</h3><small>${esc(x.model||disk.model||'Data drive')} · ${esc(x.serial||disk.serial||'serial unavailable')}</small></div>${statusPill(health,health==='healthy'?'good':health==='failed'?'bad':health==='warning'?'warn':'neutral')}</header><p>${esc(x.health_detail||'Detailed SMART telemetry is not available for this drive.')}</p><div class="drive-health-facts"><div><span>Temperature</span><b>${x.temperature_celsius!=null?esc(x.temperature_celsius)+'°C':'—'}</b></div><div><span>Power-on hours</span><b>${x.power_on_hours!=null?Number(x.power_on_hours).toLocaleString():'—'}</b></div><div><span>Capacity</span><b>${fmtBytes(disk.size)}</b></div></div><div class="trend-row"><div><span>7-day temperature trend</span><small>10-minute samples</small></div>${miniSparkline(list(history.drives?.[disk.name]).map(p=>p.temperature_c))}</div><details class="advanced"><summary>Full SMART report</summary><pre>${esc(JSON.stringify(sm,null,2))}</pre></details></article>`}).join('')}</div></section>
    <section class="content-panel system-media">${sectionTitle('Internal system storage', 'Built-in eMMC stores the NAS operating system and Zero1Local. It is not one of the removable data-drive bays.')}<div class="media-row"><span class="media-icon">eMMC</span><div><b>Internal system storage</b><small>Reserved for the NAS operating system</small></div><strong>${fmtBytes(emmc?.size || 0)}</strong>${statusPill('System','neutral')}</div></section>
    ${!d.smart_available ? `<div class="notice notice-warn"><b>SMART tools are not installed</b><span>The drives are still online RAID members. Detailed SMART telemetry and self-tests are unavailable until smartmontools is present.</span></div>` : '<div class="notice notice-info"><b>SMART tests do not erase data</b><span>If a test is already running, Zero1Local attaches to it instead of forcing or aborting it. Progress updates automatically while you stay on this page.</span></div>'}
    <details class="advanced"><summary>Advanced block-device details</summary><pre>${esc(JSON.stringify(d.block_devices, null, 2))}</pre></details>
  </section>`;
  window.__zero1SmartPollTimer=setTimeout(refreshSmartTestProgress,list(testData.tests).some(x=>x.running)?3000:10000);
}

function permissionSummary(sh) {
  const valid = list(sh.valid_users), write = list(sh.write_users);
  if (sh.guest_ok) return 'Guest access allowed';
  if (!valid.length) return sh.force_user ? `Current SMB policy (${sh.force_user})` : 'Current SMB access policy';
  if (write.length === valid.length && valid.every(u => write.includes(u))) return `${valid.length} user${valid.length === 1 ? '' : 's'} · read/write`;
  return `${valid.length} allowed · ${write.length} can write`;
}
function smbPermissionRows(users, valid = [], write = [], prefix = 'perm') {
  const allowed = new Set(valid), writers = new Set(write);
  return `<div class="permission-editor"><div class="permission-search"><input type="search" placeholder="Search users…" data-filter-permissions="${attr(prefix)}"><span>${users.length} SMB user${users.length === 1 ? '' : 's'}</span></div><div class="permission-list" data-permission-list="${attr(prefix)}">${users.map(u => { let level = 'none'; if (writers.has(u.username)) level = 'write'; else if (allowed.has(u.username)) level = 'read'; return `<div class="permission-user" data-permission-user="${attr(prefix)}" data-search="${attr((u.username + ' ' + (u.gecos || '')).toLowerCase())}"><div class="avatar">${esc(u.username.slice(0, 2).toUpperCase())}</div><div><b>${esc(u.username)}</b><small>${u.legacy ? 'Factory ownership identity' : u.managed ? 'Zero1Local user' : 'Existing NAS user'}</small></div><select data-permission-select="${attr(prefix)}" data-user="${attr(u.username)}"><option value="none" ${level === 'none' ? 'selected' : ''}>No access</option><option value="read" ${level === 'read' ? 'selected' : ''}>Read only</option><option value="write" ${level === 'write' ? 'selected' : ''}>Read & write</option></select></div>`; }).join('') || `<div class="permission-empty">No file-sharing users exist yet. Create a user and allow SMB access first.</div>`}</div></div>`;
}
function collectPermissions(prefix) {
  const valid = [], write = [];
  document.querySelectorAll(`[data-permission-select="${CSS.escape(prefix)}"]`).forEach(sel => {
    if (sel.value === 'read' || sel.value === 'write') valid.push(sel.dataset.user);
    if (sel.value === 'write') write.push(sel.dataset.user);
  });
  return { valid, write };
}


function storageTabs(active='overview') { return ''; }
function accessTabs(active='users') { return ''; }
function applianceTabs(active='settings') { return ''; }

function shareTabs(active='smb') {
  return `<div class="page-tabs" role="tablist" aria-label="Share type"><a href="/shares?tab=smb" class="${active==='smb'?'active':''}">Windows (SMB)</a><a href="/shares?tab=nfs" class="${active==='nfs'?'active':''}">Linux (NFS)</a></div>`;
}
async function sharesPage(){
  const tab=new URLSearchParams(location.search).get('tab')==='nfs'?'nfs':'smb';
  if(tab==='nfs') return nfsShares(true);
  return smbShares(true);
}
async function smbShares(unified = false) {
  const [d,usersData]=await Promise.all([api('/api/shares'),api('/api/users')]);
  const merged=mergedSMBShareInventory(d);
  const shares=merged.shares, detectedShares=merged.detected, smbUsers=list(usersData.users).filter(u=>u.smb_enabled&&!u.legacy), inv=d.inventory||{};
  window.__zero1SMB={shares,smbUsers,detectedShares};
  const invSource=inv.source==='testparm-effective-config'?'Current SMB settings':inv.source==='config-files'?'Saved SMB settings':String(inv.source||'').startsWith('smbclient')?'Running SMB service':'Automatic discovery';
  const warning=list(inv.warnings).join(' ');
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Shares & Access','Shared Folders','Create, manage and delete folders shared from Main Storage. Deleted shared-folder contents go to the Recycle Bin by default.','<button class="btn btn-primary" data-action="smb-create">'+icon('plus',15)+' New shared folder</button>')}${shareTabs('smb')}
    <div class="integration-strip"><div><b>SMB service</b><small>${esc(invSource)} · ${shares.length} live shared folder${shares.length===1?'':'s'}${detectedShares.length?` · ${detectedShares.length} discovered outside the managed list`:''}</small>${statusPill(d.service_active?'Running':'Stopped',d.service_active?'good':'bad')}</div><div><b>Authentication</b><small>${smbUsers.length} SMB-enabled account${smbUsers.length===1?'':'s'}</small>${statusPill(smbUsers.length?'Ready':'No users',smbUsers.length?'good':'warn')}</div></div>
    ${warning?`<div class="notice ${shares.length?'notice-info':'notice-warn'}"><b>Share discovery detail</b><span>${esc(warning)}</span></div>`:''}
    <section class="admin-section"><div class="table-toolbar"><div><b>SMB shared folders</b><small>Windows path, access policy and current availability.</small></div><div class="searchbox"><span>${icon('search',15)}</span><input id="shareSearch" type="search" placeholder="Filter shared folders or users"></div></div><div class="table-frame"><table class="data-table" id="shareTable"><thead><tr><th>Shared folder</th><th>Location</th><th>Access</th><th>Availability</th><th></th></tr></thead><tbody>${shares.map(sh=>`<tr data-share-search="${attr((sh.name+' '+(sh.path||'')+' '+list(sh.valid_users).join(' ')).toLowerCase())}"><td><div class="identity-cell"><span class="table-object-icon">${icon('folder',17)}</span><div><b>${esc(sh.name)}</b><small><code>${esc(windowsShare(sh.name))}</code>${sh.detected_only?' · Existing SMB share':''}</small></div></div></td><td>${esc(friendlyShareLocation(sh))}</td><td><b>${esc(permissionSummary(sh))}</b><small>${list(sh.write_users).length?`Writers: ${esc(list(sh.write_users).join(', '))}`:sh.read_only?'Read only':sh.detected_only?'Loaded from the live Samba configuration':'Current access rules'}</small></td><td>${statusPill(sh.detected_only?'Live / existing':'Available',sh.detected_only?'neutral':'good')}<small>${sh.browseable?'Visible in browse lists':'Hidden from browse lists'}</small></td><td class="row-actions">${sh.detected_only?(detectedSMBAdoptable(sh)?`<button class="btn btn-small btn-primary" data-action="smb-adopt" data-share="${attr(sh.name)}">Manage in Zero1Local</button>`:`<span class="locked-label">Existing Samba definition</span>`):`<button class="btn btn-small" data-action="share-insights" data-share="${attr(sh.name)}">Details</button>${sh.manageable?`<button class="btn btn-small" data-action="smb-edit" data-share="${attr(sh.name)}">Permissions</button><details class="row-action-menu"><summary aria-label="Actions for ${attr(sh.name)}">${icon('more',18)}</summary><div><button data-action="smb-nfs-enable" data-share="${attr(sh.name)}">Enable NFS for this share</button>${sh.remove_allowed?`<button data-action="smb-detach" data-share="${attr(sh.name)}">Stop sharing, keep files</button><button class="danger-text" data-action="smb-remove" data-share="${attr(sh.name)}">Delete shared folder</button>`:''}</div></details>`:`<span class="locked-label">${sh.path?'Other storage':'Path unknown'}</span>`}`}</td></tr>`).join('')||'<tr><td colspan="5">No SMB shared folders were discovered.</td></tr>'}</tbody></table></div></section>
    <div class="context-note">${icon('about',16)}<span><b>Delete shared folder</b> moves its contents to the Recycle Bin before removing network access. Recycled data still uses Main Storage until it expires or you empty the Recycle Bin. Use <b>Stop sharing, keep files</b> when you only want to remove network access.</span></div>
    <details class="advanced"><summary>Advanced discovery diagnostics</summary><div class="advanced-body"><div class="capability-table"><div><span>Inventory source</span><b>${esc(inv.source||'unknown')}</b></div><div><span>Samba config path</span><b>${esc(inv.config_path||'unknown')}</b></div><div><span>Config files read</span><b>${esc(list(inv.config_files).join(', ')||'none')}</b></div><div><span>testparm error</span><b>${esc(inv.testparm_error||'none')}</b></div></div>${inv.testparm_stderr?`<h3>testparm diagnostics</h3><pre>${esc(inv.testparm_stderr)}</pre>`:''}</div></details>
  </section>`;
}
function openSMBModal(mode, share = null) {
  const ctx = window.__zero1SMB || { smbUsers: [] };
  const users = ctx.smbUsers;
  const editing = mode === 'edit';
  let valid = list(share?.valid_users), write = list(share?.write_users);
  if (editing && !valid.length && share?.force_user && users.some(u => u.username.toLowerCase() === String(share.force_user).toLowerCase())) {
    const exact = users.find(u => u.username.toLowerCase() === String(share.force_user).toLowerCase()).username;
    valid = [exact];
    if (!share.read_only) write = [exact];
  }
  const prefix = 'smbModalPerm';
  const body = `<div class="form-stack">${!editing ? `<div><label>Shared folder name</label><input id="smbName" placeholder="Documents" autocomplete="off"><small class="field-help">This is the name people will see when they browse this NAS.</small></div><div class="storage-choice"><div><span class="folder-icon">${icon('folder',16)}</span><div><b>Main Storage</b><small>Your mirrored data storage. Zero1Local chooses the Linux location automatically.</small></div>${statusPill('Recommended','good')}</div></div><label>Folder</label><select id="smbFolderMode"><option value="new">Create a new folder automatically</option><option value="existing">Use an existing folder</option></select><div id="smbNewFolderNote" class="notice notice-info"><b>No path needed</b><span>Zero1Local will create a dedicated folder in Main Storage using the shared-folder name.</span></div><div id="smbExistingFolderPanel" class="folder-picker-wrap hidden"><input id="smbPath" type="hidden"><div class="selected-folder" id="smbSelectedFolder"><span>No folder selected</span></div><div id="smbFolderBrowser" class="folder-browser"><div class="loading"><span class="spinner"></span>Loading folders…</div></div></div>` : `<div class="selected-share"><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(share.name)}</b><small>${esc(friendlyShareLocation(share))}</small></div></div>`}
    <div class="form-section"><div class="form-section-title"><b>Who can use this share?</b><span>Choose access for each user who can sign in to file sharing.</span></div>${smbPermissionRows(users, valid, write, prefix)}</div>
    <label class="checkline"><input id="smbBrowseable" type="checkbox" ${share?.browseable !== false ? 'checked' : ''}><span><b>Show this share when browsing the NAS</b><small>Turning this off hides the share from browse lists; users can still connect if they know its name.</small></span></label>
    ${editing && String(share?.name||'').toLowerCase()==='u1000' ? `<div class="notice notice-info"><b>Existing folder ownership is preserved, not required for sign-in</b><span>Assign one or more Zero1Local SMB users here. When U1000 is no longer in any share access list, Zero1Local disables its old SMB login while keeping the Linux UID intact so existing file ownership remains valid.</span></div>` : ''}
    ${editing ? `<div class="notice notice-info"><b>Data stays where it is</b><span>Saving permissions changes only the SMB access policy. Zero1Local does not move, rename, or delete this folder or its files.</span></div>` : ''}
  </div>`;
  openModal(editing ? `Permissions for ${share.name}` : 'Create shared folder', editing ? 'Change who can read and write this shared folder.' : 'Create a shared folder without needing to know Linux paths or storage internals.', body, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="smb-modal-save" data-mode="${mode}" data-share="${attr(share?.name || '')}">${editing ? 'Save permissions' : 'Create shared folder'}</button>`);
}

function openSMBAdoptModal(share){
  const users=list(window.__zero1SMB?.smbUsers), safe=detectedSMBAdoptable(share), prefix='smbAdoptPerm';
  if(!safe){flash('Zero1Local will only adopt an existing SMB definition after its data path is proven to be on Main Storage.','warn');return;}
  const valid=list(share.valid_users).filter(u=>users.some(x=>String(x.username).toLowerCase()===String(u).toLowerCase()));
  const write=list(share.write_users).filter(u=>users.some(x=>String(x.username).toLowerCase()===String(u).toLowerCase()));
  const body=`<div class="form-stack"><div class="selected-share"><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(share.name)}</b><small>Existing folder on Main Storage · ${esc(friendlyStoragePath(share.path))}</small></div></div><div class="notice notice-info"><b>No data will be moved or recreated</b><span>Zero1Local will adopt the live Samba definition around the existing folder, then manage its access policy normally. The backend re-validates the path before making any change.</span></div><div class="form-section"><div class="form-section-title"><b>Who can use this share?</b><span>Choose at least one SMB-enabled Zero1Local account.</span></div>${smbPermissionRows(users,valid,write,prefix)}</div><label class="checkline"><input id="smbAdoptBrowseable" type="checkbox" ${share.browseable!==false?'checked':''}><span><b>Show this share when browsing the NAS</b></span></label>${String(share.name||'').toLowerCase()==='u1000'?`<div class="notice notice-info"><b>U1000 becomes an ordinary owner-managed share</b><span>The existing Linux UID can remain for file ownership and rollback evidence. It does not need to remain a user-facing SMB login.</span></div>`:''}</div>`;
  openModal(`Manage existing share · ${share.name}`,'Adopt this existing Main Storage share into Zero1Local management without touching its files.',body,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="smb-adopt-save" data-share="${attr(share.name)}" data-path="${attr(share.path)}" ${users.length?'':'disabled'}>Manage this share</button>`);
}

async function loadSMBFolderBrowser(path = '/disk0') {
  const box = document.getElementById('smbFolderBrowser');
  if (!box) return;
  box.innerHTML = '<div class="loading"><span class="spinner"></span>Loading folders…</div>';
  try {
    const d = await api('/api/storage/folders?path=' + encodeURIComponent(path));
    const dirs = list(d.entries).filter(e => e.directory && !e.symlink && e.name !== '.zero1-recycle');
    const parent = d.path === '/disk0' ? '' : d.path.split('/').slice(0,-1).join('/') || '/disk0';
    box.innerHTML = `<div class="folder-picker-head"><div><b>${esc(friendlyStoragePath(d.path))}</b><small>Choose this folder or open another folder.</small></div><button class="btn btn-small btn-primary" data-action="smb-folder-select" data-path="${attr(d.path)}">Choose this folder</button></div><div class="folder-picker-list">${parent ? `<button data-action="smb-folder-nav" data-path="${attr(parent)}"><span>↑</span><div><b>Up one level</b><small>${esc(friendlyStoragePath(parent))}</small></div></button>` : ''}${dirs.map(e => `<button data-action="smb-folder-nav" data-path="${attr(e.path)}"><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(e.name)}</b><small>Open folder</small></div></button>`).join('') || '<div class="folder-picker-empty">No subfolders here. You can choose this folder.</div>'}</div>`;
  } catch (e) { box.innerHTML = `<div class="notice notice-bad"><b>Unable to browse folders</b><span>${esc(e.message)}</span></div>`; }
}
function toggleSMBFolderMode() {
  const existing = document.getElementById('smbFolderMode')?.value === 'existing';
  document.getElementById('smbExistingFolderPanel')?.classList.toggle('hidden', !existing);
  document.getElementById('smbNewFolderNote')?.classList.toggle('hidden', existing);
  if (existing) loadSMBFolderBrowser(document.getElementById('smbPath')?.value || '/disk0');
}
function selectSMBFolder(path) {
  const input = document.getElementById('smbPath');
  if (input) input.value = path;
  const selected = document.getElementById('smbSelectedFolder');
  if (selected) selected.innerHTML = `<span class="folder-icon">${icon('folder',16)}</span><div><b>Selected folder</b><small>${esc(friendlyStoragePath(path))}</small></div>`;
}

async function saveSMBModal(button) {
  const mode = button.dataset.mode;
  const shareName = button.dataset.share;
  const perm = collectPermissions('smbModalPerm');
  if (!perm.valid.length) { flash('Select at least one user for this share.', 'bad'); return; }
  button.disabled = true;
  try {
    if (mode === 'create') {
      const folderMode = document.getElementById('smbFolderMode')?.value || 'new';
      const selectedPath = folderMode === 'existing' ? (document.getElementById('smbPath')?.value || '') : '';
      if (folderMode === 'existing' && !selectedPath) { flash('Choose an existing folder, or select “Create a new folder automatically.”', 'bad'); button.disabled = false; return; }
      await api('/api/shares', { method: 'POST', body: JSON.stringify({ Name: document.getElementById('smbName').value, Path: selectedPath, ValidUsers: perm.valid, WriteUsers: perm.write, Browseable: document.getElementById('smbBrowseable').checked, CreateDirectory: folderMode === 'new' }) });
      flash('Shared folder created and file sharing updated.');
    } else {
      const result = await api('/api/shares/' + encodeURIComponent(shareName), { method: 'PUT', body: JSON.stringify({ ValidUsers: perm.valid, WriteUsers: perm.write, Browseable: document.getElementById('smbBrowseable').checked }) });
      if (result.factory_login_retire_warning) flash(`Permissions updated for ${shareName}, but a reserved SMB login could not be retired: ${result.factory_login_retire_warning}`, 'warn');
      else if (result.factory_login_retired) flash(`Permissions updated for ${shareName}. The previous SMB login was retired; its Linux ownership identity was preserved.`);
      else flash(`Permissions updated for ${shareName}.`);
    }
    closeModal();
    await smbShares();
  } catch (e) { flash(e.message, 'bad'); button.disabled = false; }
}

async function nfsShares(unified = false) {
  const d=await api('/api/nfs/exports'); window.__zero1NFS=d;
  const exports=list(d.exports), candidates=list(d.shares).filter(sh=>sh.nfs_eligible===true), installed=!!d.installed;
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Shares & Access','Shared Folders','NFS exports use the same Main Storage folders as SMB. This appliance uses Zero1Local-managed userspace NFSv3.',installed&&candidates.length?'<button class="btn btn-primary" data-action="nfs-create">'+icon('plus',15)+' New NFS export</button>':'')}${shareTabs('nfs')}
    <div class="integration-strip"><div><b>NFS service</b><small>${installed?'Userspace NFSv3 backend installed':'NFS backend not installed'}</small>${statusPill(installed?(d.service_active?'Running':'Ready'):'Unavailable',d.service_active?'good':installed?'neutral':'warn')}</div><div><b>Protocol</b><small>TCP · NFSv3 · nolock client recommendation</small>${statusPill(installed?'Supported':'Off',installed?'good':'neutral')}</div></div>
    <div id="nfsInstallProgress"></div>
    ${!installed?`<section class="content-panel"><div class="settings-row"><div><b>Enable NFS file sharing</b><small>Installs and configures Zero1Local's guarded userspace NFSv3 service without changing stored files.</small></div><button class="btn btn-primary" data-action="nfs-enable">Enable NFS</button></div></section>`:''}
    ${installed?`<section class="admin-section"><div class="section-heading"><div><h2>NFS exports</h2><p>${exports.length?`${exports.length} configured export${exports.length===1?'':'s'}.`:'No NFS exports configured.'}</p></div>${candidates.length?'<button class="btn btn-small" data-action="nfs-create">Create export</button>':''}</div><div class="table-frame"><table class="data-table"><thead><tr><th>Shared folder</th><th>NFS path</th><th>Allowed clients</th><th>Access</th><th>Linux mount command</th><th></th></tr></thead><tbody>${exports.map(ex=>`<tr><td><div class="identity-cell"><span class="table-object-icon">${icon('folder',17)}</span><div><b>${esc(ex.share_name)}</b><small>${esc(friendlyStoragePath(ex.path))}</small></div></div></td><td><code>${esc(nfsNetworkPath(ex))}</code><small>Use this address from another NFSv3 client</small></td><td>${esc(list(ex.clients).join(', ')||'—')}</td><td><b>${ex.access==='RO'?'Read only':'Read & write'}</b><small>${ex.squash==='no_root_squash'?'Remote root retained':ex.squash==='all_squash'?'All identities mapped':'Remote root restricted'}</small></td><td><code>${esc(nfsMount(ex))}</code></td><td class="row-actions"><button class="btn btn-small" data-action="copy-text" data-copy="${attr(nfsNetworkPath(ex))}">Copy path</button><button class="btn btn-small" data-action="copy-text" data-copy="${attr(nfsMount(ex))}">Copy mount</button><button class="btn btn-small" data-action="copy-text" data-copy="${attr(nfsFstab(ex))}">Copy fstab</button><button class="btn btn-small" data-action="nfs-edit" data-id="${attr(ex.id)}">Edit</button><details class="row-action-menu"><summary aria-label="Actions for ${attr(ex.share_name)}">${icon('more',18)}</summary><div><button class="danger-text" data-action="nfs-delete" data-id="${attr(ex.id)}" data-name="${attr(ex.share_name)}">Remove export</button></div></details></td></tr>`).join('')||`<tr><td colspan="6">${candidates.length?'No NFS exports configured.':'Create an SMB shared folder first; the same folder can then be exported over NFS.'}</td></tr>`}</tbody></table></div></section>`:''}
    <details class="advanced"><summary>Compatibility details</summary><div class="advanced-body"><p>The vendor kernel does not provide the in-kernel NFS server or CONFIG_FHANDLE. Zero1Local therefore uses UNFS3 in userspace and serves NFSv3 over TCP. Linux clients should use <code>vers=3,nolock,proto=tcp</code>.</p><p>Backend: <b>${esc(d.backend_mode||'not installed')}</b></p></div></details>
  </section>`;
}
function openNFSModal(preferredShare='') {
  const d = window.__zero1NFS || {};
  const candidates = list(d.shares).filter(sh => sh.nfs_eligible === true);
  const body = `<div class="form-stack"><label>Folder to share</label><select id="nfsShare">${candidates.map(sh => `<option value="${attr(sh.name)}">${esc(sh.name)} — ${esc(friendlyShareLocation(sh))}</option>`).join('')}</select><label>Who can connect?</label><select id="nfsClientMode"><option value="local">Devices on my local network (recommended)</option><option value="device">One specific computer or device</option><option value="custom">A custom network (advanced)</option></select><input id="nfsLocalNetwork" type="hidden" value="${attr(d.suggested_client_cidr || '')}"><div id="nfsDeviceWrap" class="hidden"><label>Computer name or IP address</label><input id="nfsDevice" placeholder="192.168.0.50 or media-pc"></div><div id="nfsCustomWrap" class="hidden"><label>Network</label><input id="nfsCustom" placeholder="192.168.20.0/24"><small class="field-help">Advanced: enter an IP network in CIDR notation.</small></div><div><label>Access</label><select id="nfsAccess"><option value="RW">Read & write</option><option value="RO">Read only</option></select></div><details class="advanced form-advanced"><summary>Advanced NFS security</summary><div class="advanced-body"><label>Remote administrator handling</label><select id="nfsSquash"><option value="root_squash">Restrict remote root (recommended)</option><option value="no_root_squash">Allow remote root as root</option><option value="all_squash">Map all remote users</option></select><p>NFSv3 uses Linux numeric user/group IDs instead of SMB passwords. Use NFS only on networks you trust.</p></div></details><div class="notice notice-info"><b>Recommended for most home and small-office networks</b><span>Use “Devices on my local network” and keep remote-root restriction enabled unless you have a specific reason to change it.</span></div></div>`;
  openModal('Create NFS share', 'Share an existing folder with trusted Linux, Unix or appliance clients.', body, '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="nfs-modal-save">Create NFS share</button>');
  const selector=document.getElementById('nfsShare');
  if(selector && preferredShare && [...selector.options].some(x=>x.value===preferredShare))selector.value=preferredShare;
  toggleNFSClientMode();
}
function openNFSEditModal(ex) {
  if (!ex) return;
  const body = `<div class="form-stack"><div class="selected-share"><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(ex.share_name)}</b><small>${esc(friendlyStoragePath(ex.path))}</small></div></div><label>Allowed clients or networks</label><input id="nfsEditClients" value="${attr(list(ex.clients).join(', '))}" placeholder="192.168.0.0/24"><small class="field-help">Comma-separate multiple IP addresses or CIDR networks.</small><label>Access</label><select id="nfsEditAccess"><option value="RW" ${ex.access === 'RW' ? 'selected' : ''}>Read & write</option><option value="RO" ${ex.access === 'RO' ? 'selected' : ''}>Read only</option></select><details class="advanced form-advanced"><summary>Advanced NFS security</summary><div class="advanced-body"><label>Remote administrator handling</label><select id="nfsEditSquash"><option value="root_squash" ${ex.squash === 'root_squash' ? 'selected' : ''}>Restrict remote root (recommended)</option><option value="no_root_squash" ${ex.squash === 'no_root_squash' ? 'selected' : ''}>Allow remote root as root</option><option value="all_squash" ${ex.squash === 'all_squash' ? 'selected' : ''}>Map all remote users</option></select></div></details></div>`;
  openModal(`Edit NFS share · ${ex.share_name}`, 'Update client access without recreating the export.', body, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="nfs-edit-save" data-id="${attr(ex.id)}">Save changes</button>`);
}
function toggleNFSClientMode(){const m=document.getElementById('nfsClientMode')?.value||'local';document.getElementById('nfsDeviceWrap')?.classList.toggle('hidden',m!=='device');document.getElementById('nfsCustomWrap')?.classList.toggle('hidden',m!=='custom');}
function nfsClientValue(){const m=document.getElementById('nfsClientMode')?.value||'local';if(m==='device')return document.getElementById('nfsDevice')?.value.trim()||'';if(m==='custom')return document.getElementById('nfsCustom')?.value.trim()||'';return document.getElementById('nfsLocalNetwork')?.value.trim()||'';}

async function startNFSInstall() {
  const button = document.querySelector('[data-action="nfs-enable"]');
  const box = document.getElementById('nfsInstallProgress');
  if (button) { button.disabled = true; button.textContent = 'Starting…'; }
  if (box) box.innerHTML = `<div class="install-progress"><div><span class="spinner"></span><div><b>Starting a fresh NFS installation attempt</b><p>Previous installation details were cleared. New output will follow below.</p></div></div><details open><summary>Installation details</summary><pre id="nfsInstallLog"></pre></details></div>`;
  try {
    await api('/api/nfs/install', { method: 'POST', body: '{}' });
    pollNFSInstall();
  } catch (e) { flash(e.message, 'bad'); if (button) { button.disabled = false; button.textContent = 'Turn on NFS'; } }
}
async function pollNFSInstall() {
  const box = document.getElementById('nfsInstallProgress');
  if (!box) return;
  try {
    const previous = box.querySelector('details');
    const previousOpen = previous ? previous.open : true;
    const d = await api('/api/nfs/install-status');
    if (d.installed) { flash('NFS file sharing is ready.'); if(normalizedPath()==='/settings') await settingsPage(); else await nfsShares(); return; }
    const failed = !!d.failed;
    const running = !!d.running || d.state?.status === 'running';
    const phase = String(d.phase || 'starting').replace(/[-_]+/g, ' ');
    const message = d.message || (failed ? 'The guarded installer stopped before NFS was exposed.' : 'The guarded installer is preparing NFSv3 support.');
    const detailsOpen = previousOpen;
    const title = failed ? 'NFS installation stopped' : running ? `Enabling NFS · ${phase}` : 'Waiting for NFS installer';
    box.innerHTML = `<div class="install-progress ${failed ? 'install-failed' : ''}"><div><span class="spinner ${failed ? 'hidden' : ''}"></span><div><b>${esc(title)}</b><p>${esc(message)}</p></div></div><details ${detailsOpen ? 'open' : ''}><summary>Installation details</summary><pre id="nfsInstallLog">${esc(d.log || JSON.stringify(d.systemd || {}, null, 2))}</pre></details></div>`;
    const log = box.querySelector('#nfsInstallLog');
    if (log) log.scrollTop = log.scrollHeight;
    if (!failed) setTimeout(pollNFSInstall, 1800);
  } catch (e) { box.innerHTML = `<div class="notice notice-bad"><b>Unable to read NFS installer</b><span>${esc(e.message)}</span></div>`; }
}

async function usersPage({fresh = false} = {}) {
  const readOpt = fresh ? { fresh:true, stale:false } : {};
  const [d, groups, caps] = await Promise.all([api('/api/users', readOpt), api('/api/groups', readOpt), api('/api/account-capabilities', readOpt)]);
  const allUsers = list(d.users), users=allUsers.filter(u=>!u.legacy);
  window.__zero1Users = { users: allUsers, groups: list(groups.groups), caps };
  const blocked = !caps.account_database_writable || !caps.samba_identity_writable;
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Shares & Access','Users','Manage accounts for shared folders and NAS access.','<div class="row-actions"><a class="btn" href="/users/profiles">Account policies</a><button class="btn btn-primary" data-action="user-create">+ New user</button></div>')}
    ${blocked?`<div class="inline-capability warning"><span>${icon('warning',17)}</span><div><b>Account management needs attention</b><small>${esc(caps.detail||caps.samba_identity_detail||'A local account database is not writable.')}</small></div></div>`:''}
    <section class="content-panel admin-section">${sectionTitle('Users',`${users.length} owner-facing account${users.length===1?'':'s'}.`)}<div class="table-toolbar"><div class="searchbox compact"><span>${icon('search',15)}</span><input id="userSearch" type="search" placeholder="Search users"></div></div><div class="table-frame borderless"><table class="data-table"><thead><tr><th>User</th><th>SMB access</th><th>Groups</th><th>Ownership</th><th></th></tr></thead><tbody>${users.map(u=>`<tr data-user-search="${attr((u.username+' '+list(u.groups).join(' ')).toLowerCase())}"><td><div class="identity-cell"><span class="avatar">${esc(u.username.slice(0,2).toUpperCase())}</span><div><b>${esc(u.username)}</b><small>${u.managed?'Zero1Local-managed account':'Existing local account'}</small></div></div></td><td>${statusPill(u.smb_enabled?'Enabled':'Disabled',u.smb_enabled?'good':'neutral')}</td><td>${list(u.groups).length?list(u.groups).map(g=>`<span class="tag">${esc(g)}</span>`).join(' '):'<span class="subtle">None</span>'}</td><td>${u.managed?statusPill('Managed','good'):statusPill('Protected','neutral')}</td><td class="row-actions">${u.managed?`<button class="btn btn-small" data-action="user-edit" data-user="${attr(u.username)}">Manage</button><details class="row-action-menu"><summary aria-label="User actions">${icon('more',18)}</summary><div><button class="danger-text" data-action="user-delete" data-user="${attr(u.username)}">Remove</button></div></details>`:'<span class="locked-label">Protected</span>'}</td></tr>`).join('')||`<tr><td colspan="5">${emptyState('No NAS users','Create a local user to grant individual shared-folder access.','<button class="btn btn-primary" data-action="user-create">Create user</button>')}</td></tr>`}</tbody></table></div></section>
    <div class="context-note">${icon('security',16)} <span>Device-maintenance accounts remain protected and are not shown here. Accounts you create through Zero1Local use <code>nologin</code> unless SSH is explicitly enabled under Account Policies.</span></div>
  </section>`;
}

function openUserCreate() {
  const groups = list(window.__zero1Users?.groups).filter(g => g.managed);
  const caps = window.__zero1Users?.caps || {};
  const smbReady = !!caps.samba_identity_writable;
  const body = `<div class="form-stack"><div class="field-grid"><div><label>Username</label><input id="newUsername" placeholder="alex"></div><div><label>SMB password</label><input id="newUserPassword" type="password" autocomplete="new-password" placeholder="Required only for SMB login" ${smbReady ? '' : 'disabled'}></div></div><label class="checkline ${smbReady ? '' : 'disabled-setting'}"><input id="newUserSMB" type="checkbox" ${smbReady ? 'checked' : 'disabled'}><span><b>Allow this user to sign in to SMB shares</b><small>${smbReady ? 'Creates a Samba password using the password above.' : 'Samba identity storage is currently blocked. The Linux NAS user can still be created without SMB login.'}</small></span></label>${smbReady ? '' : `<div class="notice notice-bad"><b>SMB identities need attention</b><span>${esc(caps.samba_identity_detail || 'Samba passdb is not writable from the management service.')}</span></div>`}<div class="form-section"><div class="form-section-title"><b>Groups</b><span>Optional Zero1Local-managed groups.</span></div><div class="check-grid">${groups.map(g => `<label class="mini-check"><input type="checkbox" data-new-user-group value="${attr(g.name)}"><span>${esc(g.name)}</span></label>`).join('') || '<span class="subtle">No Zero1Local-managed groups yet.</span>'}</div></div></div>`;
  openModal('Create NAS user', 'This creates a local file-sharing identity, not an SSH account.', body, '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="user-create-save">Create user</button>');
}
function openUserEdit(username) {
  const ctx = window.__zero1Users || {};
  const user = list(ctx.users).find(u => u.username === username && u.managed);
  if (!user) return;
  const groups = list(ctx.groups).filter(g => g.managed);
  const current = new Set(list(user.groups));
  const body = `<div class="form-stack"><div class="selected-share"><div class="avatar">${esc(username.slice(0,2).toUpperCase())}</div><div><b>${esc(username)}</b><small>NAS account</small></div></div><label class="checkline"><input id="editUserSMB" type="checkbox" ${user.smb_enabled ? 'checked' : ''}><span><b>Allow SMB login</b><small>Turn this off to remove the Samba login while keeping the local NAS account and file ownership.</small></span></label><label>New SMB password <small>(optional)</small></label><input id="editUserPassword" type="password" autocomplete="new-password" placeholder="Leave blank to keep the current password"><small class="field-help">A password is required if SMB login is currently disabled and you enable it.</small><div class="form-section"><div class="form-section-title"><b>Groups</b><span>Change Zero1Local-managed group membership.</span></div><div class="check-grid">${groups.map(g => `<label class="mini-check"><input type="checkbox" data-edit-user-group value="${attr(g.name)}" ${current.has(g.name) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('') || '<span class="subtle">No Zero1Local-managed groups yet.</span>'}</div></div></div>`;
  openModal(`Edit user · ${username}`, 'Update SMB access, password and group membership in one place.', body, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="user-edit-save" data-user="${attr(username)}">Save changes</button>`);
}
function openUserGroups(username) {
  const ctx = window.__zero1Users || {};
  const user = list(ctx.users).find(u => u.username === username);
  const groups = list(ctx.groups).filter(g => g.managed);
  const current = new Set(list(user?.groups));
  const body = `<div class="form-stack"><div class="selected-share"><div class="avatar">${esc(username.slice(0,2).toUpperCase())}</div><div><b>${esc(username)}</b><small>Zero1Local user</small></div></div><div class="check-grid">${groups.map(g => `<label class="mini-check"><input type="checkbox" data-edit-user-group value="${attr(g.name)}" ${current.has(g.name) ? 'checked' : ''}><span>${esc(g.name)}</span></label>`).join('') || '<span class="subtle">Create a Zero1Local group first.</span>'}</div></div>`;
  openModal(`Groups for ${username}`, 'Select the Zero1Local-managed groups this user belongs to.', body, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="user-groups-save" data-user="${attr(username)}">Save groups</button>`);
}

async function groupsPage({fresh = false} = {}) {
  const d = await api('/api/groups', fresh ? { fresh:true, stale:false } : {}), groups=list(d.groups); window.__zero1Groups=groups;
  const reserved=new Set(['u1000','linaro','deepnas']);
  const visibleMembers=g=>list(g.members).filter(m=>!reserved.has(String(m||'').toLowerCase()));
  const nas=groups.filter(g=>!reserved.has(String(g.name||'').toLowerCase())&&(g.managed||visibleMembers(g).length)).map(g=>({...g,members:visibleMembers(g)}));
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Shares & Access','Groups','Reusable local groups for shared-folder permissions.','<button class="btn btn-primary" data-action="group-create">+ New group</button>')}
    <section class="content-panel admin-section">${sectionTitle('Groups',`${nas.length} access group${nas.length===1?'':'s'}.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Group</th><th>GID</th><th>Members</th><th>Ownership</th><th></th></tr></thead><tbody>${nas.map(g=>`<tr><td><div class="identity-cell"><span class="avatar">${esc(g.name.slice(0,2).toUpperCase())}</span><b>${esc(g.name)}</b></div></td><td>${esc(g.gid)}</td><td>${list(g.members).length?list(g.members).map(m=>`<span class="tag">${esc(m)}</span>`).join(' '):'<span class="subtle">No members</span>'}</td><td>${g.managed?statusPill('Managed','good'):statusPill('Existing','neutral')}</td><td class="row-actions">${g.managed?`<button class="btn btn-small" data-action="group-edit" data-group="${attr(g.name)}">Rename</button><details class="row-action-menu"><summary aria-label="Group actions">${icon('more',18)}</summary><div><button class="danger-text" data-action="group-delete" data-group="${attr(g.name)}">Remove</button></div></details>`:'<span class="locked-label" title="The current Zero1Local service can only delete groups it created or adopted.">Existing system group</span>'}</td></tr>`).join('')||`<tr><td colspan="5">${emptyState('No access groups','Create a group to assign the same permissions to several users.','<button class="btn btn-primary" data-action="group-create">Create group</button>')}</td></tr>`}</tbody></table></div></section>
  </section>`;
}

function openGroupEdit(name) {
  const group = list(window.__zero1Groups).find(g => g.name === name && g.managed);
  if (!group) return;
  const body = `<div class="form-stack"><label>Group name</label><input id="editGroupName" value="${attr(group.name)}"><small class="field-help">Renaming keeps the same Linux GID and existing memberships.</small></div>`;
  openModal(`Edit group · ${group.name}`, 'Rename this Zero1Local-managed group without recreating it.', body, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="group-edit-save" data-group="${attr(group.name)}">Save changes</button>`);
}

function dockerPortRow(row = {}) {
  return `<div class="docker-port-row" data-docker-port-row><div><label>Host IP</label><input data-port-host-ip placeholder="All interfaces" value="${attr(row.host_ip || '')}"></div><div><label>Host port</label><input data-port-host type="number" min="1" max="65535" placeholder="8080" value="${attr(row.host_port || '')}"></div><span class="port-arrow">→</span><div><label>Container port</label><input data-port-container type="number" min="1" max="65535" placeholder="80" value="${attr(row.container_port || '')}"></div><div><label>Protocol</label><select data-port-protocol><option value="tcp" ${(row.protocol||'tcp')==='tcp'?'selected':''}>TCP</option><option value="udp" ${row.protocol==='udp'?'selected':''}>UDP</option><option value="sctp" ${row.protocol==='sctp'?'selected':''}>SCTP</option></select></div><button class="icon-btn docker-port-remove" data-action="docker-port-remove" type="button" aria-label="Remove port mapping">×</button></div>`;
}
function dockerPortEditor(id, bindings = [], {blankWhenEmpty = true} = {}) {
  const rows = list(bindings).length ? list(bindings) : (blankWhenEmpty ? [{}] : []);
  return `<div class="docker-port-editor"><div class="docker-port-editor-head"><div><b>Published ports</b><small>Map a NAS port to the port the application listens on inside the container.</small></div><button class="btn btn-small btn-quiet" type="button" data-action="docker-port-add" data-port-target="${attr(id)}">+ Add port</button></div><div id="${attr(id)}" class="docker-port-rows">${rows.map(dockerPortRow).join('')}</div></div>`;
}
function dockerPortMappingsFromEditor(id) {
  const rows = Array.from(document.querySelectorAll(`#${CSS.escape(id)} [data-docker-port-row]`));
  return rows.map(row => {
    const hostIP = row.querySelector('[data-port-host-ip]').value.trim();
    const host = row.querySelector('[data-port-host]').value.trim();
    const container = row.querySelector('[data-port-container]').value.trim();
    const protocol = row.querySelector('[data-port-protocol]').value;
    if (!host && !container && !hostIP) return '';
    const hp = Number(host), cp = Number(container);
    if (!Number.isInteger(hp) || hp < 1 || hp > 65535 || !Number.isInteger(cp) || cp < 1 || cp > 65535) throw new Error('Each port mapping needs a valid host port and container port from 1 to 65535.');
    let prefix = '';
    if (hostIP) prefix = hostIP.includes(':') && !hostIP.startsWith('[') ? `[${hostIP}]:` : `${hostIP}:`;
    return `${prefix}${hp}:${cp}/${protocol}`;
  }).filter(Boolean);
}
function dockerPortChips(bindings) {
  const ports = list(bindings);
  if (!ports.length) return '<span class="subtle">No published ports</span>';
  return `<div class="docker-port-chips">${ports.map(p => `<span class="docker-port-chip"><b>${esc(p.host_ip && p.host_ip!=='0.0.0.0' ? p.host_ip + ':' : '')}${esc(p.host_port)}</b><span>→ ${esc(p.container_port)}/${esc((p.protocol||'tcp').toUpperCase())}</span></span>`).join('')}</div>`;
}
function dockerImageChoice() {
  const select = document.getElementById('dockerCreateImageSelect');
  const custom = document.getElementById('dockerCreateImageCustom');
  return select?.value === '__custom' ? String(custom?.value || '').trim() : String(select?.value || custom?.value || '').trim();
}
function toggleDockerCustomImage() {
  const select = document.getElementById('dockerCreateImageSelect');
  const custom = document.getElementById('dockerCreateImageCustom');
  if (!select || !custom) return;
  custom.classList.toggle('hidden', select.value !== '__custom');
  if (select.value === '__custom') custom.focus();
}
function dockerPullState(job) {
  const kind = job.status === 'complete' ? 'good' : job.status === 'failed' ? 'bad' : 'warn';
  const label = job.status === 'complete' ? 'Complete' : job.status === 'failed' ? 'Failed' : job.status === 'queued' ? 'Queued' : 'Pulling';
  return statusPill(label, kind);
}

async function dockerPage() {
  const [d,statsData] = await Promise.all([api('/api/docker'),api('/api/docker/stats').catch(()=>({stats:[]}))]); window.__zero1Docker=d;
  const statsByName=new Map(list(statsData.stats).map(x=>[String(x.Name||x.Container||''),x]));
  const containers=list(d.containers), images=list(d.images), networks=list(d.networks), volumes=list(d.volumes), pullJobs=list(d.pull_jobs);
  const activePulls=pullJobs.filter(j=>j.status==='queued'||j.status==='running');
  document.getElementById('content').innerHTML = `<section class="screen docker-screen">
    ${heading('Apps','Containers','Run and manage applications using the Docker engine already present on this NAS.',d.installed&&d.service_active?'<div class="row-actions"><button class="btn" data-action="docker-pull">Pull image</button><button class="btn btn-primary" data-action="docker-create">+ Create container</button></div>':'')}
    <div class="engine-strip"><div><span class="engine-icon">${icon('docker',20)}</span><div><b>Docker Engine</b><small>${d.engine_owner==='Zero1Local'?'Boot lifecycle managed by Zero1Local.':'Adopted local Docker engine.'}</small></div></div>${statusPill(d.installed?(d.service_active?'Running':'Stopped'):'Not installed',d.installed&&d.service_active?'good':d.installed?'warn':'neutral')}</div>
    ${d.installed&&!d.service_active?`<div class="notice notice-warn"><b>Docker engine is offline</b><span>Docker is installed, but the daemon is not accepting requests. Zero1Local can start its owned Docker engine service without re-enabling IronCow application userspace.</span><button class="btn btn-small btn-primary" data-action="docker-engine-start">Start Docker</button></div>`:''}
    ${activePulls.length?`<section class="content-panel admin-section">${sectionTitle('Image downloads',`${activePulls.length} active download${activePulls.length===1?'':'s'}.`)}<div class="settings-list">${activePulls.map(j=>`<div class="settings-row"><div><b>${esc(j.image)}</b><small>Started ${esc(fmtDate(j.started_at))}</small></div><div class="row-actions">${dockerPullState(j)}<button class="btn btn-small" data-action="docker-pull-view" data-job="${attr(j.id)}">Progress</button></div></div>`).join('')}</div></section>`:''}
    ${d.installed?`<section class="content-panel admin-section">${sectionTitle('Containers',`${containers.length} container${containers.length===1?'':'s'} discovered.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Image</th><th>State</th><th>Live use</th><th>Published ports</th><th>Network</th><th>Restart policy</th><th></th></tr></thead><tbody>${containers.map(c=>`<tr><td><div class="container-name"><span class="docker-state-dot ${c.state==='running'?'is-running':'is-stopped'}"></span><div><b>${esc(c.name)}</b><small>${esc(c.id)}</small></div></div></td><td><code>${esc(c.image)}</code></td><td>${statusPill(c.state||c.status,c.state==='running'?'good':'warn')}</td><td>${(()=>{const st=statsByName.get(c.name)||{};return c.state==='running'?`<b>${esc(st.CPUPerc||'—')}</b><small>${esc(st.MemPerc||'—')} memory · ${esc(st.NetIO||'—')} net</small>`:'—'})()}</td><td>${dockerPortChips(c.port_bindings)}</td><td>${esc(c.network_mode||'default')}</td><td>${esc(c.restart_policy||'no')}</td><td class="row-actions"><button class="btn btn-small" data-action="docker-inspect" data-container="${attr(c.name)}">Details</button><details class="row-action-menu"><summary aria-label="Container actions">${icon('more',18)}</summary><div><button data-action="docker-logs" data-container="${attr(c.name)}">Logs</button><button data-action="docker-edit" data-container="${attr(c.name)}">Edit & ports</button><span></span>${c.state==='running'?`<button data-action="docker-action" data-container="${attr(c.name)}" data-docker-action="restart">Restart</button><button class="danger-text" data-action="docker-action" data-container="${attr(c.name)}" data-docker-action="stop">Stop</button>`:`<button data-action="docker-action" data-container="${attr(c.name)}" data-docker-action="start">Start</button><button class="danger-text" data-action="docker-remove-container" data-container="${attr(c.name)}">Remove</button>`}</div></details></td></tr>`).join('')||`<tr><td colspan="8">${emptyState('No containers','Create a container from a local image, or pull an image first.','<button class="btn btn-primary" data-action="docker-create">Create container</button>')}</td></tr>`}</tbody></table></div></section>
    <details class="advanced resource-details"><summary>Docker resources · ${images.length} images · ${networks.length} networks · ${volumes.length} volumes</summary><div class="advanced-body docker-resource-tables"><section>${sectionTitle('Images','Local Docker images.','<button class="btn btn-small" data-action="docker-pull">Pull image</button>')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Image</th><th>Size</th><th>Created</th><th></th></tr></thead><tbody>${images.map(i=>`<tr><td><code>${esc(i.name)}</code></td><td>${esc(i.size)}</td><td>${esc(i.created)}</td><td><button class="btn btn-small btn-quiet" data-action="docker-remove-image" data-image="${attr(i.id||i.name)}">Remove</button></td></tr>`).join('')||'<tr><td colspan="4">No local images.</td></tr>'}</tbody></table></div></section><section>${sectionTitle('Networks','Docker-managed networks.','<button class="btn btn-small" data-action="docker-network-create">Create network</button>')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Driver</th><th>Scope</th><th></th></tr></thead><tbody>${networks.map(n=>`<tr><td><code>${esc(n.name)}</code></td><td>${esc(n.driver)}</td><td>${esc(n.scope||'—')}</td><td>${['bridge','host','none'].includes(n.name)?'<span class="locked-label">Built in</span>':`<button class="btn btn-small btn-quiet" data-action="docker-network-delete" data-network="${attr(n.name)}">Remove</button>`}</td></tr>`).join('')}</tbody></table></div></section><section>${sectionTitle('Volumes','Docker persistent volumes.','<button class="btn btn-small" data-action="docker-volume-create">Create volume</button>')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Driver</th><th>Mountpoint</th><th></th></tr></thead><tbody>${volumes.map(v=>`<tr><td><code>${esc(v.name)}</code></td><td>${esc(v.driver)}</td><td><code>${esc(v.mountpoint||'—')}</code></td><td><button class="btn btn-small btn-quiet" data-action="docker-volume-delete" data-volume="${attr(v.name)}">Remove</button></td></tr>`).join('')||'<tr><td colspan="4">No named volumes.</td></tr>'}</tbody></table></div></section></div></details>
    <div class="context-note">${icon('about',16)} <span>Named volumes and bind mounts persist independently of a container. Port remaps retain the stopped original until the replacement is created, reconnected and restarted successfully.</span></div>`:emptyState('Docker is not available','Zero1Local did not find the Docker CLI on this appliance.')}
  </section>`;
}

function openDockerPullModal(job = null) {
  const running = !!job;
  openModal('Pull Docker image', 'Download an image into the local Docker engine and watch each layer as Docker reports it.', `<div class="form-stack"><label>Image reference</label><input id="dockerPullImage" placeholder="nginx:latest" value="${attr(job?.image||'')}" ${running?'disabled':''}><small class="field-help">Examples: nginx:latest, ghcr.io/owner/image:tag</small><div id="dockerPullProgress" class="docker-pull-progress ${running?'':'hidden'}"><div class="docker-pull-progress-head"><div><b data-pull-title>${running?esc(job.image):'Preparing download'}</b><small data-pull-time>${running?'Started '+esc(fmtDate(job.started_at)):''}</small></div><span data-pull-state>${running?dockerPullState(job):''}</span></div><pre data-pull-output>${esc(job?.output||'Waiting for Docker…')}</pre><div class="docker-pull-error hidden" data-pull-error></div></div></div>`, `<button class="btn btn-quiet" data-action="close-modal">Close</button><button class="btn btn-primary ${running?'hidden':''}" data-action="docker-pull-save">Pull image</button>`);
  if (job) pollDockerPullJob(job.id).catch(e=>flash(e.message,'bad'));
}
function openDockerCreateModal() {
  const nets=list(window.__zero1Docker?.networks), imgs=list(window.__zero1Docker?.images).filter(i=>i.name&&i.name!=='<none>:<none>');
  const imageField = `<div><label>Image</label><select id="dockerCreateImageSelect"><option value="" disabled ${imgs.length?'selected':''}>Choose a local image</option>${imgs.map(i=>`<option value="${attr(i.name)}">${esc(i.name)}</option>`).join('')}<option value="__custom" ${imgs.length?'':'selected'}>Other image reference…</option></select><input id="dockerCreateImageCustom" class="${imgs.length?'hidden':''}" placeholder="linuxserver/plex:latest"><small class="field-help">Local images are listed first. Choose Other to use another image reference.</small></div>`;
  openModal('Create container','Create a container using the existing Docker engine. Published ports use structured mappings instead of raw Docker syntax.',`<div class="form-stack"><div class="field-grid"><div><label>Name</label><input id="dockerCreateName" placeholder="plex"></div>${imageField}</div><div class="field-grid"><div><label>Restart policy</label><select id="dockerCreateRestart"><option value="unless-stopped">unless-stopped</option><option value="always">always</option><option value="on-failure">on-failure</option><option value="no">no</option></select></div><div><label>Network</label><select id="dockerCreateNetwork"><option value="">Docker default</option>${nets.map(n=>`<option value="${attr(n.name)}">${esc(n.name)}</option>`).join('')}</select></div></div>${dockerPortEditor('dockerCreatePortRows')}<label>Environment variables</label><textarea id="dockerCreateEnv" placeholder="TZ=America/New_York&#10;PUID=1000"></textarea><small class="field-help">One NAME=value entry per line.</small><label>Volumes / bind mounts</label><textarea id="dockerCreateVolumes" placeholder="plex-config:/config&#10;/disk0/Media:/media:ro"></textarea><small class="field-help">Named volumes are supported. New host bind sources must be inside Main Storage.</small><label>Command arguments <small>(optional)</small></label><input id="dockerCreateCommand" placeholder="--example value"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="docker-create-save">Create container</button>`);
}
async function openDockerEditModal(name){
  const d=await api('/api/docker/containers/'+encodeURIComponent(name)+'/inspect'); const rp=d.restart_policy?.Name||'no';
  openModal(`Edit ${name}`,'Name and restart policy update in place. Published-port changes use a guarded replacement with automatic rollback if the replacement cannot be created or started.',`<div class="form-stack"><div class="field-grid"><div><label>Container name</label><input id="dockerEditName" value="${attr(name)}"></div><div><label>Restart policy</label><select id="dockerEditRestart">${['no','always','unless-stopped','on-failure'].map(x=>`<option value="${x}" ${x===rp?'selected':''}>${x}</option>`).join('')}</select></div></div>${dockerPortEditor('dockerEditPortRows',d.port_bindings,{blankWhenEmpty:false})}<div class="notice notice-warn compact-notice"><b>Changing ports recreates the container definition</b><span>Zero1Local preserves the current image, environment, mounts, restart policy, networks and command, and restores the old container automatically if the replacement fails.</span></div><details class="advanced"><summary>Current mounts and environment</summary><div class="advanced-body"><pre>${esc(JSON.stringify({mounts:d.mounts,env:d.env},null,2))}</pre></div></details></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="docker-edit-save" data-container="${attr(name)}">Save changes</button>`);
}
function openDockerResourceModal(kind){ const network=kind==='network'; openModal(network?'Create Docker network':'Create Docker volume','Create a persistent Docker resource managed by the existing engine.',`<div class="form-stack"><label>Name</label><input id="dockerResourceName" placeholder="${network?'app-network':'app-data'}">${network?'<label>Driver</label><select id="dockerNetworkDriver"><option>bridge</option><option>macvlan</option><option>ipvlan</option></select>':''}</div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="docker-resource-save" data-kind="${kind}">Create</button>`); }

async function pollDockerPullJob(id) {
  while (true) {
    const job = await api('/api/docker/images/pull/' + encodeURIComponent(id));
    const root = document.getElementById('dockerPullProgress');
    if (root) {
      root.classList.remove('hidden');
      const title=root.querySelector('[data-pull-title]'), state=root.querySelector('[data-pull-state]'), output=root.querySelector('[data-pull-output]'), tm=root.querySelector('[data-pull-time]'), err=root.querySelector('[data-pull-error]');
      if(title) title.textContent=job.image; if(state) state.innerHTML=dockerPullState(job); if(tm) tm.textContent=`Started ${fmtDate(job.started_at)}${job.completed_at?' · Finished '+fmtDate(job.completed_at):''}`; if(output){output.textContent=job.output||'Waiting for Docker…';output.scrollTop=output.scrollHeight;}
      if(err){err.textContent=job.error||'';err.classList.toggle('hidden',!job.error);}
    }
    if (job.status === 'complete') { flash(`Docker image ${job.image} pulled.`); await dockerPage(); return job; }
    if (job.status === 'failed') throw new Error(job.error ? `Docker pull failed: ${job.error}` : 'Docker pull failed.');
    await new Promise(resolve=>setTimeout(resolve,700));
  }
}

async function networkPage() {
  const [d, vd, listeners] = await Promise.all([api('/api/network'), api('/api/network/vlans').catch(()=>({available:false,vlans:[]})), api('/api/network/listeners').catch(()=>({listeners:[],firewall_enabled:false}))]);
  window.__zero1Network = d;
  window.__zero1VLANs = vd;
  window.__zero1Listeners = listeners;
  const primary = d.primary || {};
  const dns = d.dns_config || {};
  const dnsServers = list(dns.servers).length ? list(dns.servers) : resolverAddresses(d.dns);
  const resolverServers = list(dns.resolver_servers);
  const sameDNSPath = dnsServers.length === resolverServers.length && dnsServers.every((v,i)=>v===resolverServers[i]);
  const dnsSourceLabel = dns.mode === 'manual' ? 'Chosen by you' : dns.automatic_source === 'dhcp' ? 'Supplied by DHCP' : dns.automatic_source === 'networkmanager' ? 'NetworkManager runtime view' : 'Resolver fallback';
  const ifs = Array.isArray(d.interfaces) ? d.interfaces : [];
  const routes = Array.isArray(d.routes) ? d.routes : [];
  const mainIf = ifs.find(i => i.ifname === primary.device);
  const virtualNames = /^(lo|docker\d*|br-|veth|dummy|virbr|tun|tap)/;
  const physical = ifs.filter(i => i.ifname !== primary.device && !virtualNames.test(String(i.ifname||'')));
  const inherited114 = dnsServers.includes('114.114.114.114');
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Appliance / Network', 'Network', 'The Ethernet connection clients use to reach this NAS, plus DNS and optional VLANs.', '<div class="row-actions"><button class="btn btn-primary" data-action="dns-edit" '+(dns.writable?'':'disabled')+'>Change DNS</button></div>')}${applianceTabs('network')}
    <section class="network-hero content-panel"><div class="network-hero-icon">◎</div><div><span class="metric-label">Primary connection</span><h2>Ethernet</h2><strong>${esc(primary.address || 'No IPv4 address')}</strong><p>${primary.speed_mbps ? `${esc(primary.speed_mbps)} Mbps link` : 'Wired network connection'}</p></div><div class="network-hero-state">${statusPill(primary.state === 'up' ? 'Connected' : primary.state || 'Unknown', primary.state === 'up' ? 'good' : 'warn')}</div></section>
    <div class="network-facts"><div><span>IP address</span><b>${esc(primary.address || '—')}</b></div><div><span>Gateway</span><b>${esc(primary.gateway || '—')}</b></div><div><span>VLANs</span><b>${list(vd.vlans).length}</b><small>${vd.available?'Available':'Control unavailable'}</small></div><div><span>DNS</span><b>${esc(dnsServers.join(', ') || 'Automatic / not reported')}</b><small>${esc(dnsSourceLabel)}</small></div></div>
    ${inherited114 ? `<div class="notice notice-warn"><b>114.114.114.114 is currently in the effective resolver list</b><span>Zero1Local is not yet controlling the resolver on this installation. Save either Automatic or Manual DNS once to replace outdated resolver settings.</span></div>` : ''}
    ${!dns.writable ? `<div class="notice notice-warn"><b>DNS profile is currently read-only</b><span>Zero1Local could not identify a safe active NetworkManager profile to change. Resolver details remain visible below.</span></div>` : ''}
    <section class="content-panel">${sectionTitle('DNS', dns.mode === 'manual' ? 'Using only the DNS servers you chose.' : 'Using upstream DNS supplied by your network.', dns.writable ? '<button class="btn btn-small" data-action="dns-edit">Change DNS</button>' : '')}<div class="fact-list"><div><div><b>Mode</b><small>${dns.owned?'Managed by Zero1Local':'System resolver'}</small></div><span>${dns.mode === 'manual' ? 'Manual' : 'Automatic'}</span></div><div><div><b>Upstream servers</b><small>${esc(dnsSourceLabel)}</small></div><span>${esc(dnsServers.join(', ') || 'Not reported')}</span></div>${list(dns.profile_dns).length ? `<div><div><b>Profile override</b><small>Explicit DNS saved in NetworkManager</small></div><span>${esc(list(dns.profile_dns).join(', '))}</span></div>` : ''}</div></section>
    <section class="content-panel network-listeners-panel">${sectionTitle('Listening services','Active TCP and UDP sockets. Standard port names are hints when Linux does not report the owning process; check the firewall for actual access.','<a class="btn btn-small" href="/security">Firewall policy</a>')}<div class="table-frame"><table class="data-table"><thead><tr><th>Service</th><th>Port</th><th>Bind</th><th>Firewall guidance</th><th></th></tr></thead><tbody>${list(listeners.listeners).map(x=>`<tr><td><b>${esc(x.owner||x.process||'Listener')}</b><small>${esc(x.process||'Process not reported by Linux')}${x.description?` · ${esc(x.description)}`:''}</small></td><td><code>${esc(String(x.port))}/${esc(String(x.protocol||'tcp').toUpperCase())}</code></td><td>${statusPill(x.bind==='loopback'?'Local only':x.bind==='all-interfaces'?'All interfaces':'Specific address',x.bind==='loopback'?'good':x.bind==='all-interfaces'?'warn':'neutral')}<small>${esc(x.address||'')}</small></td><td>${esc(x.scope||'Review')}</td><td>${String(x.protocol||'').toLowerCase()==='tcp'&&['Zero1Local Management','Docker Application'].includes(x.owner)?`<button class="btn btn-small" data-action="proxy-helper" data-port="${Number(x.port)}" data-service="${attr(x.owner)}">NPM helper</button>`:''}</td></tr>`).join('')||'<tr><td colspan="5">No listening sockets were reported by ss.</td></tr>'}</tbody></table></div><div class="context-note">${icon('security',16)}<span>${esc(listeners.policy||'Zero1Local remains an internal-only appliance.')} ${listeners.firewall_enabled?'The Zero1Local host firewall is enabled.':'The Zero1Local host firewall is currently disabled; upstream firewall policy is therefore especially important.'}</span></div></section>
    <section class="content-panel">${sectionTitle('VLANs', list(vd.vlans).length ? 'Tagged networks configured on this NAS.' : 'Optional: add this NAS to another tagged network.', vd.available?'<button class="btn btn-small" data-action="vlan-create">+ Add VLAN</button>':'')} ${list(vd.vlans).length ? `<div class="table-frame borderless"><table class="data-table"><thead><tr><th>VLAN</th><th>Address setup</th><th>Status</th><th></th></tr></thead><tbody>${list(vd.vlans).map(v=>`<tr><td><span class="vlan-badge">${esc(v.id||'—')}</span><b>${esc(v.name)}</b></td><td><b>${String(v.method).toLowerCase()==='auto'?'Automatic (DHCP)':'Manual'}</b><small>${esc(String(v.addresses||'Address assigned automatically').replace(/;$/,''))}</small></td><td>${statusPill(v.active?'Active':'Inactive',v.active?'good':'neutral')}</td><td class="row-actions">${v.managed?`<button class="btn btn-small btn-quiet" data-action="vlan-edit" data-vlan="${attr(v.name)}">Edit</button><button class="btn btn-small danger-soft" data-action="vlan-delete" data-vlan="${attr(v.name)}">Remove</button>`:'<span class="locked-label">Existing · view only</span>'}</td></tr>`).join('')}</tbody></table></div>` : '<p class="human-note">Most people do not need VLANs. Add one only when your network switch is already configured to carry tagged networks to this NAS.</p>'}</section>
    ${physical.length ? `<section class="content-panel">${sectionTitle('Additional physical interfaces', 'Interfaces that are not the current default route.')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Interface</th><th>State</th><th>Addresses</th></tr></thead><tbody>${physical.map(i=>`<tr><td><b>${esc(i.ifname)}</b><small>${esc(i.address||'')}</small></td><td>${statusPill(i.operstate||'unknown',i.operstate==='UP'?'good':'neutral')}</td><td>${list(i.addr_info).filter(a=>a.family==='inet').map(a=>`${esc(a.local)}/${esc(a.prefixlen)}`).join('<br>')||'—'}</td></tr>`).join('')}</tbody></table></div></section>`:''}
    <div class="network-details-grid"><section class="content-panel network-details-panel">${sectionTitle("Interface details","Connection and address settings")}<div class="capability-table"><div><span>Linux interface</span><b>${esc(primary.device || '—')}</b></div><div><span>Address / prefix</span><b>${esc(primary.address_cidr || primary.address || '—')}</b></div><div><span>MTU</span><b>${esc(primary.mtu || mainIf?.mtu || '—')}</b></div><div><span>Network manager</span><b>${d.networkmanager ? 'NetworkManager' : 'System networking'}</b></div></div></section><section class="content-panel network-details-panel">${sectionTitle("Resolver & routes","Effective DNS settings and routing")}<h3>Resolver configuration</h3><pre class="resolver-box">${esc(d.dns || 'No resolver configuration reported.')}</pre><p>Docker bridges, loopback and virtual Ethernet devices are normal Linux internals and are intentionally kept out of the primary network view.</p><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Destination</th><th>Gateway</th><th>Interface</th><th>Metric</th></tr></thead><tbody>${routes.map(r => `<tr><td>${esc(r.dst || 'default')}</td><td>${esc(r.gateway || 'Direct')}</td><td>${esc(r.dev || '—')}</td><td>${esc(r.metric ?? '—')}</td></tr>`).join('')}</tbody></table></div></section></div>
  </section>`;
}

function proxyHelperModal(port,service){const host=location.hostname;openModal('NGINX Proxy Manager helper',`Recommended reverse-proxy settings for ${service||'this web service'}. Zero1Local does not create public DNS, NAT, or firewall mappings.`,`<div class="proxy-helper"><div class="settings-list"><div class="settings-row"><div><b>Forward hostname / IP</b><small>Use the NAS address reachable from your NPM host.</small></div><code>${esc(host)}</code></div><div class="settings-row"><div><b>Forward port</b><small>Internal application listener</small></div><code>${Number(port)}</code></div><div class="settings-row"><div><b>Scheme</b><small>TLS should normally terminate at NPM.</small></div><code>http</code></div><div class="settings-row"><div><b>WebSockets</b><small>Enable for Collabora and applications that require them.</small></div><span>${String(service||'').toLowerCase().includes('office')?'Required':'Enable when the app documents a need'}</span></div></div><div class="notice notice-warn"><b>Use an NPM Access List</b><span>Limit the proxy host to the CIDRs/IPs that actually need access. Do not expose SMB, NFS, SSH, Recovery, or the raw NAS management plane directly to the Internet.</span></div><div class="context-note">${icon('security',16)}<span>Add the NPM server's address/CIDR under System → Security → Firewall & Network Protection only when it is a trusted reverse proxy.</span></div></div>`,'<button class="btn btn-primary" data-action="close-modal">Done</button>')}

function openDNSEditModal() {
  const dns = window.__zero1Network?.dns_config || {};
  if (!dns.writable) { flash('DNS settings are not safely writable on the active network profile.', 'warn'); return; }
  const mode = dns.mode === 'manual' ? 'manual' : 'automatic';
  const saved = list(dns.profile_dns).length ? list(dns.profile_dns) : list(dns.servers);
  const body = `<div class="form-stack"><label>DNS source</label><select id="dnsMode"><option value="automatic" ${mode === 'automatic' ? 'selected' : ''}>Automatic from network</option><option value="manual" ${mode === 'manual' ? 'selected' : ''}>Manual override</option></select><div id="dnsManualWrap" class="${mode === 'manual' ? '' : 'hidden'}"><label>DNS servers</label><input id="dnsServers" value="${attr(saved.join(', '))}" placeholder="1.1.1.1, 9.9.9.9"><small class="field-help">Manual mode ignores DNS supplied by DHCP or the factory network profile, including 114.114.114.114.</small></div><div class="notice notice-info"><b>This changes DNS only</b><span>The NAS IP address, gateway and management connection remain unchanged. Failed NetworkManager changes are rolled back.</span></div></div>`;
  openModal('DNS settings', 'Choose whether this NAS accepts automatic DNS or uses only the servers you specify.', body, '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="dns-save">Save DNS</button>');
  toggleDNSMode();
}
function toggleDNSMode() { document.getElementById('dnsManualWrap')?.classList.toggle('hidden', document.getElementById('dnsMode')?.value !== 'manual'); }

async function vlanPage() {
  const d = await api('/api/network/vlans');
  window.__zero1VLANs = d;
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Appliance / Network', 'VLANs', 'Add this NAS to tagged networks while keeping its normal Ethernet connection in place.', d.available?'<button class="btn btn-primary" data-action="vlan-create">+ Create VLAN</button>':'')}${applianceTabs('network')}
    ${!d.available?'<div class="notice notice-bad"><b>VLAN management is unavailable</b><span>The NAS networking service needed for safe VLAN changes is not available.</span></div>':''}
    <section class="content-panel">${sectionTitle('Configured VLANs', `${list(d.vlans).length} VLAN${list(d.vlans).length===1?'':'s'} configured.`)}${list(d.vlans).length?`<div class="table-frame borderless"><table class="data-table"><thead><tr><th>VLAN</th><th>Connection</th><th>IP settings</th><th>Status</th><th></th></tr></thead><tbody>${list(d.vlans).map(v=>`<tr><td><span class="vlan-badge">${esc(v.id||'—')}</span><b>${esc(v.name)}</b></td><td><b>Ethernet</b><small>Tagged network</small></td><td><b>${String(v.method).toLowerCase()==='auto'?'Automatic (DHCP)':'Manual'}</b><small>${esc(String(v.addresses||'Address assigned automatically').replace(/;$/,''))}</small></td><td>${statusPill(v.active?'Active':'Inactive',v.active?'good':'neutral')}</td><td class="row-actions">${v.managed?`<button class="btn btn-small btn-quiet" data-action="vlan-edit" data-vlan="${attr(v.name)}">Edit</button><button class="btn btn-small danger-soft" data-action="vlan-delete" data-vlan="${attr(v.name)}">Remove</button>`:'<span class="locked-label">Existing · view only</span>'}</td></tr>`).join('')}</tbody></table></div>`:emptyState('No VLANs configured','Create a tagged VLAN when your switch port is configured as a trunk and the NAS needs another network.')}</section>
    <div class="notice notice-info"><b>Lockout protection</b><span>A Zero1Local-managed VLAN is added beside the normal LAN instead of replacing it. Zero1Local verifies that your existing management route did not change; failed VLAN creation is automatically rolled back.</span></div>
  </section>`;
}
function vlanValue(v,key){return String(v?.[key]??'').replace(/;$/,'');}
function splitVLANAddress(value){const raw=String(value||'').split(',')[0].replace(/;$/,'').trim();const i=raw.lastIndexOf('/');return i>0?{ip:raw.slice(0,i),prefix:raw.slice(i+1)}:{ip:raw,prefix:'24'};}
function vlanSubnetOptions(selected){
  const choices=[['24','255.255.255.0 (/24)'],['23','255.255.254.0 (/23)'],['22','255.255.252.0 (/22)'],['21','255.255.248.0 (/21)'],['20','255.255.240.0 (/20)'],['16','255.255.0.0 (/16)'],['8','255.0.0.0 (/8)']];
  if(selected&&!choices.some(x=>x[0]===String(selected)))choices.push([String(selected),`Custom subnet (/${selected})`]);
  return choices.map(([v,l])=>`<option value="${v}" ${String(selected||'24')===v?'selected':''}>${l}</option>`).join('');
}
function openVLANModal(mode,v=null){
  const primary=window.__zero1VLANs?.primary||{}; const editing=mode==='edit'; const method=String(v?.method||'auto').toLowerCase()==='manual'?'manual':'auto'; const addr=splitVLANAddress(vlanValue(v,'addresses'));
  const body=`<div class="form-stack">${editing?'':`<input id="vlanParent" type="hidden" value="${attr(primary.device||'')}"><div class="storage-choice"><div><span class="network-choice-icon">◎</span><div><b>Ethernet</b><small>Use the NAS's current wired network port for this VLAN.</small></div>${statusPill(primary.state==='up'?'Connected':'Detected',primary.state==='up'?'good':'neutral')}</div></div><div class="field-grid"><div><label>VLAN ID</label><input id="vlanId" type="number" min="1" max="4094" placeholder="20"><small class="field-help">Use the VLAN number configured on your network switch.</small></div><div><label>Name</label><input id="vlanLabel" placeholder="Servers"><small class="field-help">A friendly name shown only in Zero1Local.</small></div></div>`}<div><label>IP address setup</label><select id="vlanMethod"><option value="auto" ${method==='auto'?'selected':''}>Automatic (DHCP)</option><option value="manual" ${method==='manual'?'selected':''}>Set an address manually</option></select></div><div id="vlanStatic" class="${method==='manual'?'':'hidden'}"><div class="field-grid"><div><label>IP address</label><input id="vlanAddressIp" value="${attr(addr.ip)}" placeholder="192.168.20.10"></div><div><label>Subnet</label><select id="vlanPrefix">${vlanSubnetOptions(addr.prefix)}</select></div></div></div><details class="advanced form-advanced"><summary>Advanced network setting</summary><div class="advanced-body"><label>MTU <small>(blank = automatic)</small></label><input id="vlanMtu" type="number" min="576" max="9000" value="${attr(vlanValue(v,'mtu')==='0'?'':vlanValue(v,'mtu'))}" placeholder="Automatic"></div></details><div class="notice notice-info"><b>Your normal NAS connection stays in place</b><span>Zero1Local will not let this VLAN replace the primary gateway or DNS.</span></div><div class="notice notice-info"><b>Your switch must already allow this VLAN</b><span>The Ethernet switch port connected to the NAS must carry the VLAN tag you enter here.</span></div></div>`;
  openModal(editing?`Edit VLAN ${v.id}`:'Create VLAN',editing?`Update the IP settings for VLAN ${v.id}. The VLAN number and Ethernet port stay unchanged.`:'Add a tagged network beside the NAS\'s normal Ethernet connection.',body,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="vlan-save" data-mode="${mode}" data-vlan="${attr(v?.name||'')}">${editing?'Save settings':'Create and activate'}</button>`); toggleVLANStatic();
}
function toggleVLANStatic(){const m=document.getElementById('vlanMethod');document.getElementById('vlanStatic')?.classList.toggle('hidden',m?.value!=='manual');}
function composedVLANAddress(){if(document.getElementById('vlanMethod')?.value!=='manual')return '';const ip=document.getElementById('vlanAddressIp')?.value.trim()||'';const prefix=document.getElementById('vlanPrefix')?.value||'24';return ip?`${ip}/${prefix}`:'';}


function settingsTabs(active='sharing') {
  return `<div class="page-tabs"><a href="/settings?tab=sharing" class="${active==='sharing'?'active':''}">File Sharing</a><a href="/settings?tab=services" class="${active==='services'?'active':''}">System Services</a></div>`;
}
function friendlyServiceCategory(cat){return ({'Core NAS':'NAS essentials','File Sharing':'File sharing','Containers':'Apps & containers','Network':'Networking','Hardware':'Hardware support','Vendor / Legacy':'Internal appliance services','System':'Other system services'})[cat]||cat;}
function friendlyServiceName(s){
  const u=String(s.unit||'').toLowerCase();
  if(u==='smbd.service')return 'SMB file sharing'; if(u.includes('zero1-unfs3'))return 'NFS file sharing'; if(u==='docker.service')return 'Docker'; if(u==='containerd.service')return 'Container runtime'; if(u==='avahi-daemon.service')return 'Network discovery'; if(u==='dnsmasq.service')return 'Local DNS helper'; if(u==='smartmontools.service')return 'Drive health monitoring'; if(u==='mdmonitor.service')return 'RAID monitoring'; return s.description||s.unit;
}
async function settingsPage(){
  const [servicesData,protocols,nfs,system,network,security]=await Promise.all([
    api('/api/services').catch(()=>({services:[]})), api('/api/protocols').catch(()=>({})), api('/api/nfs/exports').catch(()=>({})),
    api('/api/system').catch(()=>({})), api('/api/network').catch(()=>({})), api('/api/security/center').catch(()=>({score:0,status:'Unknown',checks:[]}))
  ]);
  const services=list(servicesData.services).filter(x=>x.category!=='Vendor / Legacy'), running=services.filter(x=>x.active==='active').length, failed=services.filter(x=>x.active==='failed').length;
  const smb=protocols.smb||{}, nfsCap=protocols.nfs||{};
  const groups=[
    ['Appliance',[
      ['/updates','Software Updates','Check for new versions, review changes and install safely.','update',''],
      ['/system','System & Power','Runtime health, hostname, power and UPS status.','power',system.hostname||system.device_name||''],
      ['/hardware','Hardware','Chassis, thermals, LEDs and hardware capability.','hardware',''],
      ['/setup-assistant','Setup Assistant','Review the core appliance setup in a safe, guided order.','check','']
    ]],
    ['Administration',[
      ['/system/access','Access & API','Browser sessions, SSH administration and API credentials.','remote',''],
      ['/security/admins', 'Administrators','Independent web logins with server-enforced roles and 2FA policy.','users',''],
      ['/automation','Automation & Alerts','Recycle retention, UPS policy, maintenance and outbound notifications.','tasks','']
    ]],
    ['Security',[
      ['/security','Security','Sign-in protection, firewall policy, certificates and exposure.','security',`${Number(security.score||0)}/100`]
    ]],
    ['Support & Recovery',[
      ['/diagnostics','Advanced Stats','Performance, restart history, feature checks and sanitized support bundles.','diagnostics',''],
      ['/recovery/system','Recovery','Independent local recovery environment and recovery key.','recovery','Port 8089'],
      ['/logs', 'Logs', 'Audit logs and administrator change evidence.','System logs and administrator change evidence.','logs','']
    ]],
    ['Advanced',[
      ['/services','System Services','Advanced service inventory and runtime controls.','services',`${running} running${failed?` · ${failed} failed`:''}`],
      ['/about','About & Credits','Version, licensing, project information and platform details.','about','']
    ]]
  ];
  document.getElementById('content').innerHTML=`<section class="screen control-panel-screen">
    ${heading('System','System','Appliance-wide security, automation, support, recovery and advanced runtime policy. Feature-specific settings stay with Files, Storage, Protection, Apps or Connectivity.')}
    <div class="control-overview"><div><b>${esc(system.device_name||system.hostname||location.hostname)}</b><span>Zero1Local ${esc(releaseDisplayVersion())}${releaseBuildLabel()?` · ${esc(releaseBuildLabel())}`:''}</span></div><div>${statusPill(failed?'Attention':'Operational',failed?'warn':'good')}<span>${running} services running</span></div></div>
    <div class="control-groups">${groups.map(([group,items])=>`<section class="control-group"><h2>${esc(group)}</h2><div class="control-links">${items.map(([href,title,desc,ico,meta])=>`<a class="control-link" href="${href}"><span class="control-link-icon">${icon(ico,20)}</span><span class="control-link-copy"><b>${esc(title)}</b><small>${esc(desc)}</small></span>${meta?`<span class="control-link-meta">${esc(meta)}</span>`:''}<span class="control-link-arrow">${icon('chevron',16)}</span></a>`).join('')}</div></section>`).join('')}</div>
    <div class="context-note">${icon('about',16)}<span>Advanced service controls remain available under <a href="/services">System Services</a>. Routine NAS administration should not require managing Linux units directly, and feature-specific settings intentionally stay with the feature they control.</span></div>
  </section>`;
}

function serviceActionButtons(s) {
  const manageable = s.manageable === 'true';
  const protectedReason = s.protection_reason || '';
  if (!manageable) return `<span class="locked-label" title="${attr(protectedReason)}">Protected${protectedReason ? ` · ${esc(protectedReason)}` : ''}</span>`;
  const active = s.active === 'active';
  const masked = String(s.enabled || '').startsWith('masked');
  const enabled = ['enabled','enabled-runtime','linked','linked-runtime','alias'].includes(String(s.enabled || ''));
  if (masked) return `<button class="btn btn-small" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="unmask">Unmask</button>`;
  return `${active ? `<button class="btn btn-small btn-quiet" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="restart">Restart</button><button class="btn btn-small danger-soft" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="stop">Stop</button>` : `<button class="btn btn-small" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="start">Start</button>`}<button class="btn btn-small btn-quiet" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="${enabled ? 'disable' : 'enable'}">${enabled ? 'Disable' : 'Enable'}</button><button class="btn btn-small danger-soft" data-action="service-action" data-service="${attr(s.unit)}" data-service-action="mask">Mask</button>`;
}

async function servicesPage(){
  const servicesData=await api('/api/services');
  const services=list(servicesData.services).filter(x=>x.category!=='Vendor / Legacy');
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Control Panel','System Services','Advanced runtime inventory. Protected appliance and recovery services cannot be disabled from the web interface.')}
    <section class="admin-section"><div class="table-toolbar"><div><b>Service inventory</b><small>${services.filter(x=>x.active==='active').length} running · ${services.length} discovered</small></div><div class="searchbox"><span>${icon('search',15)}</span><input id="serviceSearch" type="search" placeholder="Filter services"></div></div><div class="table-frame"><table class="data-table"><thead><tr><th>Service</th><th>Purpose</th><th>State</th><th>Startup</th><th>Category</th><th>Controls</th></tr></thead><tbody>${services.map(x=>`<tr data-service-search="${attr((x.unit+' '+x.description+' '+x.category).toLowerCase())}"><td><code>${esc(x.unit)}</code></td><td><b>${esc(friendlyServiceName(x))}</b><small>${esc(x.description||'')}</small></td><td>${statusPill(x.active==='active'?'Running':x.active==='failed'?'Failed':'Stopped',x.active==='active'?'good':x.active==='failed'?'bad':'neutral')}</td><td>${esc(x.enabled||'—')}</td><td>${esc(friendlyServiceCategory(x.category||'System'))}</td><td class="row-actions">${serviceActionButtons(x)}</td></tr>`).join('')}</tbody></table></div></section>
    <details class="advanced"><summary>File-sharing capability details</summary><div class="advanced-body"><p class="human-note">SMB and NFS configuration is managed from Shares & Access. This screen exposes the underlying service state only for diagnostics and advanced administration.</p></div></details>
  </section>`;
}


let updatePagePollTimer = null;
let updateCheckInFlight = false;
function stopUpdatePagePolling(){ if(updatePagePollTimer){clearTimeout(updatePagePollTimer);updatePagePollTimer=null;} }
function updateChannelName(v){return ({stable:'Stable',beta:'Beta / Release Candidate',alpha:'Alpha'})[String(v||'stable').toLowerCase()]||'Stable';}
function relativeWhen(value){
  if(!value)return 'Never'; const d=new Date(value); if(Number.isNaN(d.getTime()))return String(value);
  const sec=Math.round((Date.now()-d.getTime())/1000),abs=Math.abs(sec); let n,label;
  if(abs<60)return sec>=0?'Just now':'In a moment';
  if(abs<3600){n=Math.round(abs/60);label=`${n} minute${n===1?'':'s'}`;}
  else if(abs<86400){n=Math.round(abs/3600);label=`${n} hour${n===1?'':'s'}`;}
  else {n=Math.round(abs/86400);label=`${n} day${n===1?'':'s'}`;}
  return sec>=0?`${label} ago`:`In ${label}`;
}
function safeReleaseNotes(markdown){
  const lines=String(markdown||'').replace(/\r/g,'').split('\n'),out=[]; let inList=false,inCode=false,code=[];
  const inline=(v)=>esc(v).replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>').replace(/`([^`]+)`/g,'<code>$1</code>');
  const closeList=()=>{if(inList){out.push('</ul>');inList=false;}};
  for(const raw of lines){const line=raw.trimEnd(); if(/^```/.test(line.trim())){closeList();if(inCode){out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);code=[];inCode=false}else inCode=true;continue;} if(inCode){code.push(raw);continue;}
    const h=line.match(/^#{1,4}\s+(.+)$/); if(h){closeList();out.push(`<h4>${inline(h[1])}</h4>`);continue;}
    const b=line.match(/^[-*]\s+(.+)$/); if(b){if(!inList){out.push('<ul>');inList=true;}out.push(`<li>${inline(b[1])}</li>`);continue;}
    if(!line.trim()){closeList();continue;} closeList();out.push(`<p>${inline(line.trim())}</p>`);
  }
  closeList(); if(inCode)out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  return out.join('')||'<p>No release notes were provided for this version.</p>';
}
function updateCheckSummary(u){
  if(updateCheckInFlight)return {tone:'checking',label:'Checking now',title:'Looking for updates',detail:'Contacting the official Zero1Local releases on GitHub…'};
  if(u.last_error)return {tone:'warn',label:'Check needs attention',title:"We couldn't check for updates",detail:u.last_error};
  if(u.available)return {tone:'available',label:'Update available',title:`Zero1Local v${u.available.version} is ready`,detail:`This NAS is running v${u.installed_version}. Review what changed, then install when you’re ready.`};
  if(u.last_success_at)return {tone:'good',label:"You're up to date",title:`Zero1Local v${u.installed_version}`,detail:`This NAS is running the newest ${updateChannelName(u.channel)} release found on GitHub.`};
  return {tone:'neutral',label:'Not checked yet',title:`Zero1Local v${u.installed_version}`,detail:'Check GitHub to see whether a newer Zero1Local release is available.'};
}
function updateApplyDismissKey(x){
  if(!x)return '';
  return String(x.id||`${x.status||''}|${x.version||''}|${x.started_at||''}|${x.updated_at||''}`);
}
function updateApplyIsDismissed(x){
  if(!x||(x.status!=='failed'&&x.status!=='completed'))return false;
  try{return localStorage.getItem('zero1local.updateApplyDismissed')===updateApplyDismissKey(x)}catch{return false}
}
function updateApplyView(u){
  const x=u.update_apply;if(!x)return '';
  const active=x.status==='preparing'||x.status==='applying',failed=x.status==='failed',done=x.status==='completed';
  if(done)return '';
  if(failed&&updateApplyIsDismissed(x))return '';
  const progress=pct(x.progress||(done?100:active?5:0));
  const title=failed?'Update did not finish':done?'Update installed':`Updating to v${esc(x.version)}`;
  const detail=failed?'Zero1Local stopped the update. The transactional installer keeps or restores the previous working release when rollback is possible.':done?'The package passed installation and health checks.':esc(x.stage||'Working on the update…');
  const byteLine=x.total_bytes?`${fmtBytes(x.downloaded_bytes||0)} of ${fmtBytes(x.total_bytes)} downloaded`:'';
  const dismiss=failed?`<div class="row-actions update-terminal-actions"><button class="btn" data-action="update-apply-dismiss">Dismiss</button></div>`:'';
  return `<section class="update-progress-card ${failed?'is-failed':done?'is-complete':'is-active'}"><div class="update-progress-head"><div><span class="update-eyebrow">${failed?'UPDATE STOPPED':done?'UPDATE COMPLETE':'UPDATE IN PROGRESS'}</span><h2>${title}</h2><p>${detail}</p></div><strong>${Math.round(progress)}%</strong></div><div class="update-progress-track" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(progress)}"><i style="width:${progress}%"></i></div><div class="update-progress-meta"><span>${esc(x.stage||x.status||'')}</span>${byteLine?`<span>${esc(byteLine)}</span>`:''}<span>${x.started_at?`Started ${esc(relativeWhen(x.started_at))}`:''}</span></div>${failed&&x.error?`<details class="advanced update-error-detail"><summary>Show technical details</summary><pre>${esc(String(x.error).slice(0,8000))}</pre></details>`:''}${active?`<div class="update-do-not-power">${icon('warning',16)}<span>Keep the NAS powered on. The web interface may briefly disconnect while Zero1Local restarts.</span></div>`:''}${dismiss}</section>`;
}
function updateSafetyChecks(u){
  const checks=list(u.checks); if(!checks.length)return '';
  return `<div class="update-safety-list">${checks.map(c=>`<div class="${c.ok?'ok':'bad'}"><span>${c.ok?icon('check',16):icon('warning',16)}</span><div><b>${esc(c.label)}</b><small>${c.ok?'Ready':'Needs attention before installation'}</small></div></div>`).join('')}</div>`;
}
function releaseHistoryView(u){
  const rows=list(u.release_history).slice(0,8); if(!rows.length)return '<p class="muted">Release history will appear after a successful GitHub check.</p>';
  return `<div class="update-history-list">${rows.map(r=>{const installed=String(r.version)===String(u.installed_version),newer=compareVersionText(r.version,u.installed_version)>0;return `<article><div class="update-history-version"><b>v${esc(r.version)}</b>${installed?'<span class="update-badge subtle">Installed</span>':newer?'<span class="update-badge blue">Newer</span>':''}</div><div><span>${esc(r.name||`Zero1Local v${r.version}`)}</span><small>${r.published_at?`Published ${esc(fmtDate(r.published_at))}`:'Published release'}${r.asset_size?` · ${fmtBytes(r.asset_size)}`:''}</small></div>${r.html_url?`<a class="btn btn-small" href="${attr(r.html_url)}" target="_blank" rel="noreferrer">View on GitHub</a>`:''}</article>`}).join('')}</div>`;
}
function compareVersionText(a,b){
  const p=v=>{const m=String(v||'').trim().match(/^v?(\d+(?:\.\d+)*)/i);return m?m[1].split('.').map(x=>Number(x)||0):[];};
  const aa=p(a),bb=p(b),n=Math.max(aa.length,bb.length,1);
  for(let i=0;i<n;i++){const av=aa[i]||0,bv=bb[i]||0;if(av>bv)return 1;if(av<bv)return -1;}
  return 0;
}
function updateHeroView(u){
  const s=updateCheckSummary(u),av=u.available,latest=u.latest_seen,installable=!!(av?.asset_name&&u.ready_for_update),missingPackage=!!(av&&!av.asset_name);
  const action=updateCheckInFlight?'<button class="btn btn-primary" disabled><span class="spinner spinner-inline"></span> Checking…</button>':av&&installable?`<button class="btn btn-primary" data-action="update-install" data-version="${attr(av.version)}">Install v${esc(av.version)}</button><button class="btn" data-action="update-check-now">Check again</button>`:`<button class="btn btn-primary" data-action="update-check-now">${u.last_success_at?'Check again':'Check for updates'}</button>`;
  return `<section class="update-hero update-hero-${s.tone}"><div class="update-hero-main"><div class="update-status-mark">${s.tone==='good'?icon('check',26):s.tone==='available'?icon('update',26):s.tone==='warn'?icon('warning',26):icon('update',26)}</div><div class="update-hero-copy"><span class="update-eyebrow">${esc(s.label)}</span><h1>${esc(s.title)}</h1><p>${esc(s.detail)}</p><div class="update-version-facts"><span><b>Installed</b> v${esc(u.installed_version)}</span><span><b>Latest version</b> ${latest?`v${esc(latest.version)}`:'—'}</span><span><b>Last checked</b> ${u.last_checked_at?esc(relativeWhen(u.last_checked_at)):'Never'}</span></div><div class="row-actions update-hero-actions">${action}${av?.html_url?`<a class="btn" href="${attr(av.html_url)}" target="_blank" rel="noreferrer">View release on GitHub</a>`:''}</div></div></div>${missingPackage?`<div class="update-inline-message warn">${icon('warning',16)}<span>v${esc(av.version)} is published, but its install package is not attached yet. Check again in a moment.</span></div>`:''}${av&&!u.ready_for_update?`<div class="update-inline-message warn">${icon('warning',16)}<span>A newer version is available, but this NAS needs attention before it can install safely.</span></div>`:''}</section>`;
}
function renderUpdatesPage(u){
  u={...(u||{})};
  if(!u.installed_version){const runtimeVersion=releaseDisplayVersion(currentVersion);u.installed_version=runtimeVersion||(u.up_to_date&&u.latest_seen?.version?String(u.latest_seen.version):'Unknown');}
  window.__zero1Updates=u;
  const av=u.available,notes=av?.notes||u.latest_seen?.notes||'';
  const installMode=String(u.install_mode||'manual');
  document.getElementById('content').innerHTML=`<section class="screen updates-screen">
    ${heading('System','Software Updates','See what is installed, what is new, and exactly what happens while an update is installed.',updateCheckInFlight?'<button class="btn" disabled>Checking…</button>':'<button class="btn" data-action="update-check-now">Check now</button>')}
    ${updateHeroView(u)}
    ${updateApplyView(u)}
    ${av?`<div class="update-main-grid"><section class="content-panel update-release-card">${sectionTitle(`What’s new in v${esc(av.version)}`,av.published_at?`Published ${esc(fmtDate(av.published_at))}`:'Release notes from GitHub')}<div class="update-release-notes">${safeReleaseNotes(notes)}</div>${av.asset_name?`<div class="update-package-line"><span>${icon('check',16)}</span><div><b>Install package found</b><small>${esc(av.asset_name)}${av.asset_size?` · ${fmtBytes(av.asset_size)}`:''}</small></div></div>`:''}</section><section class="content-panel update-readiness-card">${sectionTitle('Before installing','Zero1Local checks the NAS before it changes the active version.')}${updateSafetyChecks(u)}<div class="update-rollback-copy">${icon('recovery',18)}<div><b>Rollback protection</b><small>The new version is activated transactionally. If activation or health verification fails, Zero1Local attempts to return to the previous working version.</small></div></div></section></div>`:''}
    <div class="update-secondary-grid"><section class="content-panel">${sectionTitle('Update preferences','Choose how Zero1Local checks for and installs future updates.')}<div class="settings-list"><label class="switch-row"><div><b>Check for updates automatically</b><small>Zero1Local checks GitHub in the background and lets you know when a new version is available.</small></div><span class="switch"><input id="updateAutoCheck" type="checkbox" ${u.auto_check!==false?'checked':''}><i></i></span></label><div class="settings-row"><div><b>How often should Zero1Local check?</b><small>This only checks for new versions. It does not install anything.</small></div><select id="updateInterval">${[1,3,6,12,24].map(x=>`<option value="${x}" ${Number(u.interval_hours||6)===x?'selected':''}>Every ${x} hour${x===1?'':'s'}</option>`).join('')}</select></div><div class="settings-row"><div><b>Installing updates</b><small>“Ask me first” is recommended. Automatic installation still runs safety checks and rollback protection.</small></div><select id="updateInstallMode"><option value="manual" ${installMode==='manual'?'selected':''}>Ask me first</option><option value="automatic" ${installMode==='automatic'?'selected':''}>Install automatically</option></select></div><div class="settings-row"><div><b>When should automatic updates install?</b><small>Uses the NAS local time and only applies if automatic installation is enabled.</small></div><select id="updateInstallHour" ${installMode==='automatic'?'':'disabled'}>${Array.from({length:24},(_,h)=>`<option value="${h}" ${Number(u.install_hour??3)===h?'selected':''}>${String(h).padStart(2,'0')}:00</option>`).join('')}</select></div></div><div class="panel-actions"><button class="btn btn-primary" data-action="update-settings-save">Save preferences</button></div><details class="advanced update-advanced-settings"><summary>Advanced release channel</summary><div class="advanced-body"><div class="settings-row"><div><b>Release channel</b><small>Stable is recommended for normal NAS use. Beta/RC and Alpha may be less tested.</small></div><select id="updateChannel"><option value="stable" ${u.channel==='stable'?'selected':''}>Stable (recommended)</option><option value="beta" ${u.channel==='beta'?'selected':''}>Beta / Release Candidate</option><option value="alpha" ${u.channel==='alpha'?'selected':''}>Alpha</option></select></div></div></details></section>
    <section class="content-panel">${sectionTitle('Recent releases','Versions Zero1Local most recently saw on your selected GitHub channel.')}${releaseHistoryView(u)}</section></div>
    ${u.last_error?`<section class="content-panel update-help-card">${sectionTitle('Having trouble checking for updates?','The installed version is unchanged. Try the check again or use these details for support.')}<div class="row-actions"><button class="btn btn-primary" data-action="update-check-now">Try again</button><a class="btn" href="/diagnostics">Open Diagnostics</a></div></section>`:''}
    <details class="advanced update-diagnostics"><summary>Technical update details</summary><div class="advanced-body"><div class="capability-table"><div><span>Official source</span><b>${esc(u.repo||'gigabytegrove/zero1local')}</b></div><div><span>GitHub connection</span><b>${u.last_success_at?'Last successful '+esc(fmtDate(u.last_success_at)):'Not yet successful'}</b></div><div><span>Discovery path</span><b>${esc(u.last_check_source||'Not checked')}</b></div><div><span>GitHub HTTP response</span><b>${u.last_check_http_status||'—'}</b></div><div><span>Check time</span><b>${Number(u.last_check_duration_ms||0)>0?`${Number(u.last_check_duration_ms)} ms`:'—'}</b></div><div><span>Next automatic check</span><b>${u.next_check_at?esc(fmtDate(u.next_check_at)):u.auto_check?'After the next successful check':'Automatic checks are off'}</b></div></div>${u.last_error?`<pre>${esc(u.last_error)}</pre>`:''}</div></details>
  </section>`;
}
async function refreshUpdatesFromGitHub({silent=false}={}){
  if(updateCheckInFlight)return; updateCheckInFlight=true;
  if(window.__zero1Updates)renderUpdatesPage(window.__zero1Updates);
  try{
    const previous=window.__zero1Updates||{};
    const d=await api('/api/update/check',{method:'POST',body:'{}',busy:false,fresh:true,stale:false});
    try{
      window.__zero1Updates=await api('/api/update/status',{busy:false,fresh:true,stale:false});
    }catch(_){
      window.__zero1Updates=(d?.update&&typeof d.update==='object')?{...previous,...d.update}:previous;
    }
    if(window.__zero1Updates&&!window.__zero1Updates.installed_version){const runtimeVersion=releaseDisplayVersion(currentVersion);window.__zero1Updates.installed_version=runtimeVersion||(window.__zero1Updates.up_to_date&&window.__zero1Updates.latest_seen?.version?String(window.__zero1Updates.latest_seen.version):'Unknown');}
    if(!silent)flash(window.__zero1Updates?.available?`Zero1Local v${window.__zero1Updates.available.version} is available.`:'You’re up to date.');
  }
  catch(e){if(!silent)flash(e.message,'bad');try{window.__zero1Updates=await api('/api/update/status',{busy:false,fresh:true,stale:false});if(window.__zero1Updates&&!window.__zero1Updates.installed_version){const runtimeVersion=releaseDisplayVersion(currentVersion);window.__zero1Updates.installed_version=runtimeVersion||(window.__zero1Updates.up_to_date&&window.__zero1Updates.latest_seen?.version?String(window.__zero1Updates.latest_seen.version):'Unknown');}}catch(_){}}
  finally{updateCheckInFlight=false;if(normalizedPath()==='/updates'&&window.__zero1Updates)renderUpdatesPage(window.__zero1Updates);startUpdatePagePolling();}
}
function startUpdatePagePolling(){
  stopUpdatePagePolling(); if(normalizedPath()!=='/updates')return;
  const active=window.__zero1Updates?.update_apply&&['preparing','applying'].includes(window.__zero1Updates.update_apply.status);
  if(!active)return;
  updatePagePollTimer=setTimeout(async()=>{if(normalizedPath()!=='/updates')return;try{const d=await api('/api/update/status',{busy:false,fresh:true,stale:false});window.__zero1Updates=d;announceCompletedUpdate(d);renderUpdatesPage(d);startUpdatePagePolling();}catch(_){const x=window.__zero1Updates;if(x?.update_apply){x.update_apply.stage='Zero1Local is restarting. Reconnecting to the NAS…';renderUpdatesPage(x);}updatePagePollTimer=setTimeout(startUpdatePagePolling,1800);}},1200);
}
function announceCompletedUpdate(u){
  const x=u?.update_apply;if(!x||x.status!=='completed')return;
  const key=updateApplyDismissKey(x);let seen='';try{seen=localStorage.getItem('zero1local.updateCompleteAnnounced')||''}catch{}
  if(seen===key)return;
  try{localStorage.setItem('zero1local.updateCompleteAnnounced',key)}catch{}
  flash(`Zero1Local v${x.version||releaseDisplayVersion()} installed successfully.`,'good');
}
async function updatesPage(){
  const u=await api('/api/update/status',{fresh:true,stale:false});announceCompletedUpdate(u);renderUpdatesPage(u);startUpdatePagePolling();
  const last=Date.parse(u.last_success_at||u.last_checked_at||'')||0;
  if(u.feed_ready&&!u.update_apply&&!updateCheckInFlight&&(Date.now()-last>60000))setTimeout(()=>{if(normalizedPath()==='/updates')refreshUpdatesFromGitHub({silent:true});},80);
}

function systemGauge(label,value,detail,tone='good'){
  const pctv=Math.max(0,Math.min(100,Number(value)||0));
  return `<article class="system-gauge-card tone-${tone}"><div class="system-gauge" style="--gauge:${pctv}"><div><b>${Math.round(pctv)}%</b><span>${esc(label)}</span></div></div><p>${esc(detail)}</p></article>`;
}
async function systemPage() {
  const [sys,storage,services,hardware]=await Promise.all([api('/api/system'),api('/api/storage'),api('/api/services'),api('/api/hardware').catch(()=>({}))]);window.__zero1System=sys;
  const memTotal=parseInt(String(sys.memory?.MemTotal||'0').replace(/\D/g,''),10)*1024,memAvail=parseInt(String(sys.memory?.MemAvailable||'0').replace(/\D/g,''),10)*1024,memUsed=Math.max(0,memTotal-memAvail),memPct=memTotal?memUsed*100/memTotal:0;
  const usage=storage.data_usage||{},storageTotal=Number(usage.total||0),storageUsed=Number(usage.used||0),storagePct=storageTotal?storageUsed*100/storageTotal:Number(usage.percent||0);
  const serviceList=list(services.services),running=serviceList.filter(x=>x.active==='active').length,failed=serviceList.filter(x=>x.active==='failed'),servicePct=serviceList.length?running*100/serviceList.length:100;
  const tempCandidates=[hardware.cpu_temperature_c,hardware.temperature_c,hardware.soc_temperature_c].map(Number).filter(Number.isFinite),temp=tempCandidates[0];
  const tempPct=Number.isFinite(temp)?Math.max(0,Math.min(100,temp)):0,tempTone=!Number.isFinite(temp)?'neutral':temp>=80?'bad':temp>=65?'warn':'good';
  const loadParts=String(sys.load||'').trim().split(/\s+/).slice(0,3).map(Number).filter(Number.isFinite);
  const statusTone=failed.length?'warn':'good';
  document.getElementById('content').innerHTML=`<section class="screen system-dashboard-screen">
    ${heading('System','System & Power','A visual overview of appliance health, software runtime and deliberate power controls.','<div class="row-actions"><button class="btn btn-quiet" data-action="hostname-edit">Change hostname</button><a class="btn btn-quiet" href="/diagnostics">Advanced Stats</a></div>')}
    <section class="system-visual-summary">
      ${systemGauge('Memory',memPct,`${fmtBytes(memAvail)} available`,memPct>90?'bad':memPct>80?'warn':'good')}
      ${systemGauge('Main Storage',storagePct,`${fmtBytes(Number(usage.available||0))} available`,storagePct>95?'bad':storagePct>85?'warn':'good')}
      ${systemGauge('Services',servicePct,failed.length?`${failed.length} service${failed.length===1?'':'s'} need attention`:`${running} services running`,statusTone)}
      ${Number.isFinite(temp)?systemGauge('Temperature',tempPct,`${temp.toFixed(1)}°C reported by hardware`,tempTone):`<article class="system-gauge-card tone-neutral"><div class="system-gauge unavailable"><div><b>—</b><span>Temperature</span></div></div><p>Open Hardware for thermal details.</p></article>`}
    </section>
    <section class="content-panel system-status-board">${sectionTitle('Appliance status','Identity and software health at a glance.')}<div class="system-status-grid"><div class="system-status-primary"><div class="status-emblem ${failed.length?'warn':'good'}">${icon(failed.length?'warning':'check',30)}</div><div><small>OVERALL STATUS</small><h2>${failed.length?'System needs attention':'System operating normally'}</h2><p>${failed.length?`${failed.length} background service${failed.length===1?'':'s'} reported a failure. Review Services or Action Center.`:'Core runtime services are active and no service failure is currently reported.'}</p></div></div><div class="system-load-visual system-load-bars"><span>Load average</span>${loadParts.length?loadParts.map((v,i)=>`<div><small>${['1 min','5 min','15 min'][i]}</small><div class="load-track"><i style="width:${Math.max(3,Math.min(100,v*25))}%"></i></div><b>${v.toFixed(2)}</b></div>`).join(''):'<p>Load data unavailable.</p>'}</div></div></section>
    <div class="metric-band system-metric-band"><div><span>Uptime</span><b>${esc(sys.uptime||'—')}</b><small>Since last boot</small></div><div><span>Memory</span><b>${fmtBytes(memUsed)} / ${fmtBytes(memTotal)}</b><small>${fmtBytes(memAvail)} available</small></div><div><span>Services</span><b>${running} running</b><small>${failed.length?`${failed.length} need attention`:'No failures reported'}</small></div><div><span>Main Storage</span><b>${fmtBytes(Number(usage.available||0))} free</b><small>${Math.round(storagePct||0)}% used</small></div></div>
    <div class="system-two-column">
      <section class="content-panel">${sectionTitle('Appliance identity','The software and hardware platform Zero1Local is managing.')}<div class="fact-list"><div><div><b>Hostname</b><small>Network name</small></div><span>${esc(sys.hostname)}</span></div><div><div><b>Hardware</b><small>NAS platform</small></div><span>${esc(sys.model)}</span></div><div><div><b>Software</b><small>Local management</small></div><span>Zero1Local v${esc(releaseDisplayVersion())}${releaseBuildLabel()?` <small>build ${esc(releaseBuildLabel())}</small>`:''}</span></div><div><div><b>Kernel</b><small>Operating-system runtime</small></div><span>${esc(sys.kernel)} · ${esc(sys.arch)}</span></div></div></section>
      <section class="content-panel system-shortcuts">${sectionTitle('System workspaces','Keep detailed controls in dedicated pages instead of stacking everything here.')}<div class="system-shortcut-grid"><a href="/updates">${icon('update',20)}<span><b>Software Updates</b><small>Install and review releases</small></span></a><a href="/hardware">${icon('hardware',20)}<span><b>Hardware</b><small>Thermals, fan, LEDs and chassis</small></span></a><a href="/security">${icon('security',20)}<span><b>Security</b><small>Firewall and sign-in protection</small></span></a><a href="/automation">${icon('tasks',20)}<span><b>Automation</b><small>Maintenance and notifications</small></span></a><a href="/services">${icon('settings',20)}<span><b>Services</b><small>Background runtime inventory</small></span></a><a href="/help">${icon('about',20)}<span><b>Help Center</b><small>Owner-facing documentation</small></span></a></div></section>
    </div>
    <section class="content-panel power-panel">${sectionTitle('Power','Restart or shut down the NAS safely. Active file transfers and connected apps may be interrupted.')}<div class="power-actions"><div><span class="power-symbol">↻</span><div><b>Restart NAS</b><small>Safely restarts services and reconnects when the NAS returns.</small></div><button class="btn" data-action="power-request" data-power-action="reboot">Restart</button></div><div><span class="power-symbol">⏻</span><div><b>Power Off NAS</b><small>Safely stops services and storage before shutdown.</small></div><button class="btn btn-danger" data-action="power-request" data-power-action="poweroff">Power Off</button></div></div>${sys.boot_persistence?.last_power_request?`<div class="context-note">${icon('about',16)}<span>Last power action: ${esc(sys.boot_persistence.last_power_request.action)} requested ${esc(fmtDate(sys.boot_persistence.last_power_request.requested_at))}${sys.boot_persistence.last_power_request_completed?' · completed successfully':' · completion is still being checked'}</span></div>`:''}</section>
    ${sys.apt?.debian11?`<details class="advanced"><summary>Legacy operating-system package status</summary><div class="advanced-body"><p>The preserved Debian 11 base no longer receives normal security support. Zero1Local keeps required package access functional while the platform migration path remains separate from routine administration.</p><div class="fact-list"><div><div><b>Bullseye backports</b><small>Required by some optional installs</small></div>${statusPill(sys.apt.backports_archive_ready?'Archive ready':'Needs attention',sys.apt.backports_archive_ready?'good':'bad')}</div><div><div><b>Automatic OS upgrade</b><small>Managed separately from NAS updates</small></div>${statusPill('Off','neutral')}</div></div></div></details>`:''}
    <details class="advanced"><summary>Advanced system details</summary><div class="advanced-body"><div class="capability-table"><div><span>Device-tree model</span><b>${esc(sys.model)}</b></div><div><span>Raw load average</span><b>${esc(sys.load)}</b></div><div><span>Successful starts recorded</span><b>${Number(sys.boot_persistence?.boots_observed||0)}</b></div></div><p><a href="/diagnostics">Open Advanced Stats</a> for restart history, performance and feature checks.</p></div></details>
  </section>`;
}

function openHostnameModal() {
  const current = window.__zero1System?.hostname || location.hostname;
  const body = `<div class="form-stack"><label>Hostname</label><input id="newHostname" value="${attr(current)}" maxlength="63" autocomplete="off"><small class="field-help">Letters, numbers and internal hyphens only. This changes the NAS network hostname; your current IP remains usable.</small></div>`;
  openModal('Change hostname', 'Set the local network name for this Zero1Local.', body, '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="hostname-save">Save hostname</button>');
}

function patternMatchesLED(event,p){
  const prefix=String(event).split('.')[0]; const channels=new Set(list(p.codes).map(c=>String(c)[0]));
  if(prefix==='power') return [...channels].every(c=>c==='0'||c==='1');
  if(prefix==='disk1') return [...channels].every(c=>c==='2'||c==='3');
  if(prefix==='disk2') return [...channels].every(c=>c==='4'||c==='5');
  return true;
}
function ledEventLabel(e){return ({'power.healthy':'Everything is good','power.starting':'NAS is starting up','power.internet_down':'Internet cannot be reached','power.service_issue':'A service needs attention','power.potential_issue':'Potential system issue','power.critical':'Critical system failure','disk1.idle':'Drive 1 healthy','disk1.activity':'Drive 1 activity','disk1.attention':'Drive 1 needs attention','disk1.degraded':'Drive 1 degraded / rebuilding','disk1.critical':'Drive 1 health critical','disk1.failure':'Drive 1 failed','disk2.idle':'Drive 2 healthy','disk2.activity':'Drive 2 activity','disk2.attention':'Drive 2 needs attention','disk2.degraded':'Drive 2 degraded / rebuilding','disk2.critical':'Drive 2 health critical','disk2.failure':'Drive 2 failed'})[e]||String(e).replace(/[._]/g,' ');}
function ledMeaning(color,behavior,title,description){
  const flashing=/flash|blink/i.test(behavior);
  const tempo=flashing?(/slow/i.test(behavior)?'is-slow-flashing':'is-fast-flashing'):'';
  return `<div class="led-meaning"><span aria-hidden="true" class="led-dot led-${color} ${flashing?'is-flashing':''} ${tempo}"></span><div><b>${esc(title)}</b><small>${esc(description)}</small></div><span class="led-behavior">${esc(behavior)}</span></div>`;
}
// These examples are visual only. They do not write to the chassis LED controller.
function ledReferenceHTML(){
  const sections=[
    ['Power/status light',[
      ['green','Solid','Operating normally','Power is on and the NAS is working normally.'],
      ['green','Fast flash','Starting up','The NAS is completing its startup sequence.'],
      ['yellow','Solid','Internet unavailable','Network access may still work; turn this indication off on intentionally isolated networks.'],
      ['yellow','Fast flash','Service needs attention','Open Notifications or Services to identify the affected service.'],
      ['red','Fast flash','Potential system issue','Review the active warning and check System status.'],
      ['red','Solid','Critical condition','Review the reported fault before restarting or touching storage.']
    ]],
    ['Drive lights (each bay independently)',[
      ['green','Solid','Healthy and idle','The corresponding drive is online without active disk access.'],
      ['green','Fast flash','Disk activity','The corresponding drive is reading or writing.'],
      ['yellow','Solid','Drive warning','Solid yellow means drive health needs checking. Open Storage > Drives to see the exact SMART reason before changing a disk.'],
      ['yellow','Fast flash','Degraded or rebuilding','Check RAID health and backup status before changing drives.'],
      ['red','Fast flash','Critical drive warning','Back up important data and inspect SMART diagnostics.'],
      ['red','Solid','Missing or failed drive','Identify the failed slot and confirm recovery options first.']
    ]],
    ['Phone Transfer (temporary power-light override)',[
      ['green','Fast flash','Copy in progress','An approved phone file transfer is active.'],
      ['green','Solid','Transfer completed','Success shows briefly, then normal status returns.'],
      ['yellow','Slow flash','Phone needs attention','Unlock the phone, select file access, then retry.'],
      ['red','Fast flash','Transfer failed','Check the notification; incomplete moves retain the source data.']
    ]]
  ];
  return sections.map(([title,items])=>`<section class="led-guide-group"><h3>${esc(title)}</h3><div class="led-meaning-grid">${items.map(item=>ledMeaning(...item)).join('')}</div></section>`).join('');
}
function fanReasonLabel(reason){return ({'manual':'Manual control','automatic-factory-curve':'Automatic cooling','high-temperature-failsafe':'High-temperature failsafe','thermal-sensor-failsafe':'Sensor failsafe'})[String(reason||'')]||'Cooling policy';}
function fanReasonTone(reason){return String(reason||'').includes('failsafe')?'bad':reason==='manual'?'warn':'good';}
function fanTempState(temp){const n=Number(temp);if(!Number.isFinite(n))return {label:'Sensor unavailable',tone:'bad'};if(n>80)return {label:'Critical cooling',tone:'bad'};if(n>60)return {label:'High cooling',tone:'warn'};if(n>=45)return {label:'Normal cooling',tone:'good'};return {label:'Cool / fan idle',tone:'good'};}
function fanSpeedLabel(speed){const n=Number(speed||0);return n===0?'Off':`${n}%`;}
async function refreshFanLiveStatus(){
  if(location.pathname!=='/hardware'){if(window.__zero1FanTimer){clearInterval(window.__zero1FanTimer);window.__zero1FanTimer=null;}return;}
  try{
    const fan=await api('/api/hardware/fan',{busy:false,fresh:true});window.__zero1Fan=fan;
    const temp=Number(fan.temperature_c),tempState=fanTempState(temp),reason=fanReasonLabel(fan.effective_reason);
    const tempEl=document.getElementById('fanTempValue'), tempStateEl=document.getElementById('fanTempState'), speedEl=document.getElementById('fanEffectiveSpeed'), reasonEl=document.getElementById('fanEffectiveReason'), rawEl=document.getElementById('fanHardwareRaw'), gauge=document.getElementById('fanTempGauge');
    if(tempEl)tempEl.textContent=Number.isFinite(temp)?temp.toFixed(1)+'°C':'—';
    if(tempStateEl){tempStateEl.textContent=tempState.label;tempStateEl.className=`fan-live-state tone-${tempState.tone}`;}
    if(speedEl)speedEl.textContent=fanSpeedLabel(fan.effective_speed);
    if(reasonEl)reasonEl.textContent=reason;
    if(rawEl)rawEl.textContent=fan.hardware_raw||'not reported';
    if(gauge)gauge.style.setProperty('--fan-temp',String(Math.max(0,Math.min(100,Number.isFinite(temp)?temp:100))));
  }catch(e){const tempStateEl=document.getElementById('fanTempState');if(tempStateEl){tempStateEl.textContent='Status unavailable';tempStateEl.className='fan-live-state tone-bad';}}
}
async function hardwarePage() {
  const [d,led,power]=await Promise.all([api('/api/hardware'),api('/api/hardware/led-settings'),api('/api/power/ups').catch(()=>({available:false,thermals:[]}))]); window.__zero1LED=led;
  const temps=list(d.temperatures), fan=d.fan_control||{}, settings=led.settings||{}, patterns=list(settings.patterns), custom=patterns.filter(x=>!x.built_in), assignments=settings.assignments||{}, current=led.current_events||{};
  const assignmentRows=(events)=>events.map(e=>{const options=patterns.filter(p=>patternMatchesLED(e,p));return `<tr><td><b>${esc(ledEventLabel(e))}</b>${Object.values(current).includes(e)?'<small>Current condition</small>':''}</td><td>${Object.values(current).includes(e)?statusPill('Active','good'):'—'}</td><td><select data-led-assignment="${attr(e)}">${options.map(p=>`<option value="${attr(p.name)}" ${assignments[e]===p.name?'selected':''}>${esc(p.name)}</option>`).join('')}</select></td></tr>`}).join('');
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('System','Hardware','Check your NAS hardware, cooling, temperatures and power.')}<nav class="page-tabs hardware-tabs" aria-label="Hardware sections"><a href="/hardware" class="${new URLSearchParams(location.search).get('view')==='lights'?'':'active'}">Hardware status</a><a href="/hardware?view=lights" class="${new URLSearchParams(location.search).get('view')==='lights'?'active':''}">Customize lights</a><a href="/help/lights">Light meanings</a></nav>


    <section class="content-panel hardware-lights-only">${sectionTitle('Front-panel light reference','These are animated examples of the default signals, not a test of the physical lights. Your saved custom patterns can differ.')}${ledReferenceHTML()}</section>
    <section class="content-panel hardware-lights-only">${sectionTitle('Automatic light behavior','Use the recommended meanings above or assign any built-in/custom pattern to a condition.','<button class="btn btn-small" data-action="led-pattern-create">+ Create custom pattern</button>')}<label class="switch-row"><div><b>Automatic status lights</b><small>Let Zero1Local update the power and drive lights as conditions change.</small></div><span class="switch"><input id="ledAutomatic" type="checkbox" ${settings.automatic?'checked':''}><i></i></span></label><label class="switch-row settings-indent"><div><b>Show Internet outages on the power light</b><small>When enabled, a lost Internet connection makes the power light solid yellow. Turn this off if the NAS is intentionally offline.</small></div><span class="switch"><input id="ledInternetIndicator" type="checkbox" ${settings.internet_outage_indicator!==false?'checked':''}><i></i></span></label><h3 class="subsection-heading">Power light assignments</h3><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Condition</th><th>Now</th><th>Light pattern</th></tr></thead><tbody>${assignmentRows(list(led.events).filter(e=>e.startsWith('power.')))}</tbody></table></div><h3 class="subsection-heading">Drive light assignments</h3><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Condition</th><th>Now</th><th>Light pattern</th></tr></thead><tbody>${assignmentRows(list(led.events).filter(e=>e.startsWith('disk')))}</tbody></table></div><div class="panel-actions"><button class="btn btn-primary" data-action="led-settings-save">Save light settings</button></div></section>
    ${custom.length?`<section class="content-panel hardware-lights-only">${sectionTitle('Your custom patterns','Reusable patterns you created.')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Pattern</th><th>What it does</th><th></th></tr></thead><tbody>${custom.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td>${esc(p.description||'Custom chassis-light behavior')}</td><td class="row-actions"><button class="btn btn-small" data-action="led-pattern-test" data-pattern="${attr(p.name)}">Test for 5 seconds</button><button class="btn btn-small danger-soft" data-action="led-pattern-delete" data-pattern="${attr(p.name)}">Remove</button></td></tr>`).join('')}</tbody></table></div></section>`:''}
    <section class="content-panel fan-panel hardware-overview-only">${sectionTitle('Cooling & fan','Zero1Local manages the verified chassis cooling controller. Automatic mode is recommended for normal operation.')}<div class="settings-row fan-controller-status"><div><b>Fan controller</b><small>${fan.available?'Cooling controls are available':'Verified interface is not currently available'}</small></div>${statusPill(fan.available?'Ready':'Unavailable',fan.available?'good':'bad')}</div>${fan.available?`<div class="fan-overview-grid"><div class="fan-temp-card"><div id="fanTempGauge" class="fan-temp-gauge" style="--fan-temp:${Math.max(0,Math.min(100,Number(fan.temperature_c)||0))}"><div><strong id="fanTempValue">${Number.isFinite(Number(fan.temperature_c))?Number(fan.temperature_c).toFixed(1)+'°C':'—'}</strong><span>CPU</span></div></div><div><b>Thermal status</b><span id="fanTempState" class="fan-live-state tone-${fanTempState(fan.temperature_c).tone}">${esc(fanTempState(fan.temperature_c).label)}</span><small>Automatic cooling adjusts the fan with temperature and speeds up if the NAS gets too hot.</small></div></div><div class="fan-effective-card"><span>Current fan command</span><strong id="fanEffectiveSpeed">${esc(fanSpeedLabel(fan.effective_speed))}</strong><b id="fanEffectiveReason">${esc(fanReasonLabel(fan.effective_reason))}</b><small>The fan speed shown is the setting requested by Zero1Local, not a measured fan RPM.</small></div></div><div class="fan-control-layout"><div class="fan-control-block"><h3>Control mode</h3><div class="fan-mode-options"><label class="fan-mode-option ${fan.mode==='auto'?'selected':''}"><input type="radio" name="fanMode" value="auto" ${fan.mode==='auto'?'checked':''}><span><b>Automatic</b><small>Recommended · Zero1Local adjusts cooling from CPU temperature.</small></span></label><label class="fan-mode-option ${fan.mode==='manual'?'selected':''}"><input type="radio" name="fanMode" value="manual" ${fan.mode==='manual'?'checked':''}><span><b>Manual</b><small>Hold one proven hardware level until you return to Automatic.</small></span></label></div></div><div id="fanManualControls" class="fan-control-block ${fan.mode==='manual'?'':'is-disabled'}"><h3>Manual level</h3><div class="fan-speed-options">${[0,60,80,100].map(v=>`<label class="fan-speed-option ${Number(fan.manual_speed)===v?'selected':''} ${v===0?'fan-off-option':''}"><input type="radio" name="fanSpeed" value="${v}" ${Number(fan.manual_speed)===v?'checked':''} ${fan.mode==='manual'?'':'disabled'}><b>${v===0?'Off':v+'%'}</b><small>${v===0?'Use only when intentionally testing at a safe temperature.':v===60?'Low cooling':v===80?'High cooling':'Maximum cooling'}</small></label>`).join('')}</div><div class="fan-safety-note">${icon('security',16)}<span><b>Thermal protection always wins.</b> Above 80°C—or if the thermal sensor cannot be read—Zero1Local commands the proven 100% state even when Manual is selected.</span></div></div></div><div class="fan-curve"><div class="fan-curve-head"><div><b>Automatic cooling curve</b><small>How Zero1Local adjusts cooling as the NAS warms up.</small></div></div><div class="fan-curve-track"><div><span>&lt;45°C</span><b>Off</b></div><div><span>45–60°C</span><b>60%</b></div><div><span>&gt;60–80°C</span><b>80%</b></div><div class="critical"><span>&gt;80°C</span><b>100%</b></div></div></div><div class="panel-actions fan-actions"><button class="btn btn-primary" data-action="fan-settings-save">Save cooling policy</button>${fan.mode==='manual'?'<button class="btn" data-action="fan-return-auto">Return to Automatic</button>':''}</div><details class="advanced"><summary>Advanced fan-controller details</summary><div class="advanced-body"><div class="fact-list"><div><div><b>Hardware interface</b><small>Verified Rockchip platform control</small></div><span><code>${esc(fan.interface||'')}</code></span></div><div><div><b>Raw controller state</b><small>Diagnostic value reported by the kernel interface</small></div><span><code id="fanHardwareRaw">${esc(fan.hardware_raw||'not reported')}</code></span></div></div><p>The vendor backend exposes only Off / 60 / 80 / 100. Zero1Local intentionally does not manufacture unsupported intermediate values.</p><p>${esc(fan.failsafe||'')}</p></div></details>`:`<div class="notice notice-bad"><b>Fan control unavailable</b><span>${esc(fan.unavailable_reason||'The verified IronCow Zero1 gpio_ctrl interface is missing.')}</span></div>`}</section>
    <section class="content-panel hardware-overview-only">${sectionTitle('Temperatures','Current internal temperature readings.')}<div class="temperature-grid">${temps.map(t=>{const n=Number(t.celsius),tone=n>=85?'bad':n>=75?'warn':'good';return `<div class="temperature"><div class="thermo"><i style="height:${Math.min(100,Math.max(8,n))}%"></i></div><div><b>${Number.isFinite(n)?n.toFixed(1)+'°C':'—'}</b><span>${esc(String(t.type||t.zone||'Sensor').replace(/[-_]/g,' '))}</span></div>${statusPill(tone==='good'?'Normal':tone==='warn'?'Warm':'Hot',tone)}</div>`}).join('')}</div></section>
<div class="hardware-lights-only">    <details class="advanced"><summary>Advanced light-controller details</summary><div class="advanced-body"><p>Zero1Local directly controls the physically verified Rockchip Twinkle interface at <code>${esc(led.twinkle_node)}</code>. The original IronCow drive-light polling service is no longer required.</p><p>Command format: first digit selects the red/green channel for the power light or either drive bay; second digit selects solid, off, fast flash or slow flash. Red and green together produce yellow.</p><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Pattern</th><th>Hardware commands</th><th>Description</th></tr></thead><tbody>${patterns.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td><code>${esc(list(p.codes).join(' '))}</code></td><td>${esc(p.description||'')}</td></tr>`).join('')}</tbody></table></div></div></details></div>
    <section class="content-panel hardware-overview-only">${sectionTitle('Power & UPS','Keep the NAS alive long enough to shut down cleanly and see what the connected UPS is reporting.')}<div class="ups-overview ${power.available?'ups-ready':'ups-missing'}"><span>${power.available?'⚡':'○'}</span><div><h3>${power.available?esc(power.ups?.['ups.model']||power.ups?.['ups.name']||'UPS connected'):'No managed UPS detected'}</h3><p>${power.available?`Battery ${esc(power.ups?.['battery.charge']||'—')}% · Load ${esc(power.ups?.['ups.load']||'—')}% · ${esc(power.ups?.['ups.status']||'status unavailable')}`:'Install/configure NUT with a supported UPS to expose battery, load and shutdown telemetry to Zero1Local.'}</p></div>${statusPill(power.available?'Protected':'Not detected',power.available?'good':'warn')}${power.available?'':`<button class="btn btn-small btn-quiet" data-action="notification-state" data-state="ignored" data-notification="ups-not-detected">Don't remind me again</button>`}</div>${list(power.thermals).length?`<details class="advanced"><summary>All discovered thermal sensors</summary><div class="sensor-list">${list(power.thermals).map(x=>`<div><b>${esc(x.sensor)}</b><span>${Number(x.celsius).toFixed(1)}°C</span><small>${esc(x.path)}</small></div>`).join('')}</div></details>`:''}</section>
    <section class="content-panel hardware-overview-only">${sectionTitle('Other chassis hardware','Zero1Local only changes hardware interfaces that have been positively identified.')}<div class="notice notice-info"><b>Audible alerts</b><span>No supported internal buzzer control has been proven on this chassis, so Zero1Local does not attempt beep commands.</span></div></section>
  </section>`;
  const showLights=new URLSearchParams(location.search).get('view')==='lights';
  document.querySelectorAll('.hardware-lights-only').forEach(el=>el.classList.toggle('hidden',!showLights));
  document.querySelectorAll('.hardware-overview-only').forEach(el=>el.classList.toggle('hidden',showLights));
  document.querySelectorAll('input[name="fanMode"]').forEach(x=>x.addEventListener('change',()=>{const manual=document.querySelector('input[name="fanMode"]:checked')?.value==='manual',box=document.getElementById('fanManualControls');if(box)box.classList.toggle('is-disabled',!manual);document.querySelectorAll('input[name="fanSpeed"]').forEach(r=>r.disabled=!manual);document.querySelectorAll('.fan-mode-option').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.checked));}));
  document.querySelectorAll('input[name="fanSpeed"]').forEach(x=>x.addEventListener('change',()=>document.querySelectorAll('.fan-speed-option').forEach(l=>l.classList.toggle('selected',l.querySelector('input')?.checked))));
  if(window.__zero1FanTimer)clearInterval(window.__zero1FanTimer);window.__zero1FanTimer=setInterval(refreshFanLiveStatus,10000);
}


function eventSeverity(ev) {
  const explicit = String(ev?.severity || '').trim().toLowerCase();
  const message = String(ev?.message || '').toLowerCase();
  const embedded = message.match(/(?:^|\s)level=(?:"|')?(fatal|panic|error|warning|warn|debug|info)(?:"|')?(?:\s|$)/i)?.[1]?.toLowerCase() || '';
  const level = embedded || explicit || 'info';
  if (level === 'fatal' || level === 'panic' || level === 'error') return { label:'Error', tone:'error' };
  if (level === 'warning' || level === 'warn') return { label:'Warning', tone:'warning' };
  if (level === 'debug') return { label:'Debug', tone:'debug' };
  return { label:'Info', tone:'info' };
}

async function logsPage() {
  const src = new URLSearchParams(location.search).get('source') || 'zero1';
  const d = await api('/api/logs?source=' + encodeURIComponent(src));
  const tabs = [['zero1','Zero1Local'],['samba','SMB'],['docker','Docker'],['system','System']];
  const events = list(d.events);
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('System / Logs', 'Logs & Events', 'Recent activity in a readable event list. Raw journal output is available under Advanced.')}
    <div class="log-tabs">${tabs.map(([id,label]) => `<a href="/logs?source=${id}" class="${src===id?'active':''}">${label}</a>`).join('')}</div>
    <section class="content-panel event-panel">${sectionTitle(`${tabs.find(x=>x[0]===src)?.[1] || 'Zero1Local'} events`, `${events.length} recent event${events.length===1?'':'s'}`)}${events.length ? `<div class="event-list">${events.map(ev => { const sev=eventSeverity(ev); return `<div class="event-row"><span class="event-severity sev-${sev.tone}">${esc(sev.label)}</span><time>${esc(ev.timestamp || '—')}</time><b>${esc(ev.source || src)}</b><p>${esc(ev.message || '')}</p></div>`; }).join('')}</div>` : emptyState('No recent events', 'Nothing has been recorded for this source in the selected journal window.')}</section>
    <details class="advanced"><summary>Raw journal output</summary><pre class="log-console">${esc(d.log || 'No recent log output.')}</pre></details>
  </section>`;
}

const FILE_WORKSPACE_STALE_KEY='zero1local.file-workspace-stale';
function normalizedWorkspacePath(path){return String(path||'').replace(/^\/+|\/+$/g,'').replace(/\/{2,}/g,'/');}
function workspaceLocationKey(share,path=''){return `${String(share||'').toLowerCase()}::${normalizedWorkspacePath(path)}`;}
function loadWorkspaceTombstones(){try{const v=JSON.parse(localStorage.getItem(FILE_WORKSPACE_STALE_KEY)||'[]');return new Set(Array.isArray(v)?v:[])}catch(_){return new Set()}}
function saveWorkspaceTombstones(set){try{localStorage.setItem(FILE_WORKSPACE_STALE_KEY,JSON.stringify([...set].slice(-250)))}catch(_){}}
function markWorkspaceLocationStale(share,path='',shareWide=false){if(!share)return;const set=loadWorkspaceTombstones();const key=workspaceLocationKey(share,shareWide?'':path);set.add(key+(shareWide?'::*':''));saveWorkspaceTombstones(set);}
function workspaceEntryVisible(entry,liveShareNames){const share=String(entry?.share||'');if(!share||!liveShareNames.has(share.toLowerCase()))return false;const path=normalizedWorkspacePath(entry?.path||'');const key=workspaceLocationKey(share,path);for(const stale of loadWorkspaceTombstones()){if(stale.endsWith('::*')){const base=stale.slice(0,-3);if(key.startsWith(base))return false;}else if(key===stale||key.startsWith(stale+'/'))return false;}return true;}
function clearWorkspaceLocationStale(share,path=''){if(!share)return;const key=workspaceLocationKey(share,path),set=loadWorkspaceTombstones();let changed=false;for(const stale of [...set]){const base=stale.endsWith('::*')?stale.slice(0,-3):stale;if(key===base||key.startsWith(base+'/')||base.startsWith(key+'/')){set.delete(stale);changed=true;}}if(changed)saveWorkspaceTombstones(set);}
async function pruneWorkspaceFavoritesForStale(workspace,share,path='',shareWide=false){
  const base=normalizedWorkspacePath(path);
  const stale=list(workspace?.favorites).filter(x=>String(x.share||'').toLowerCase()===String(share||'').toLowerCase()).filter(x=>{const p=normalizedWorkspacePath(x.path||'');return shareWide||p===base||p.startsWith(base+'/');});
  await Promise.all(stale.map(x=>api('/api/files/favorites?share='+encodeURIComponent(x.share)+'&path='+encodeURIComponent(x.path||''),{method:'DELETE',busy:false}).catch(()=>null)));
}
function currentFileEntryByPath(path){return list(window.__zero1Files?.entries).find(x=>String(x.path||'')===String(path||''))||null;}

function currentFileViewMode(){return localStorage.getItem('zero1-file-view')==='grid'?'grid':'list'}
function fileHasThumbnail(name){return /\.(png|jpe?g|gif|webp|bmp|pdf|mp4|mkv|mov|avi|webm|m4v)$/i.test(String(name||''))}
function fileEntryIdentity(entry,d,viewMode){
  if(entry.directory&&!entry.symlink)return `<a class="file-name" href="/files?share=${encodeURIComponent(d.share)}&rel=${encodeURIComponent(entry.relative_path)}"><span class="folder-icon"></span><div><b>${esc(entry.name)}</b><small>Folder</small></div></a>`;
  const thumb=viewMode==='grid'&&!entry.symlink&&fileHasThumbnail(entry.name);
  const kind=/\.pdf$/i.test(entry.name)?'PDF':/\.(mp4|mkv|mov|avi|webm|m4v)$/i.test(entry.name)?'Video':/\.(png|jpe?g|gif|webp|bmp)$/i.test(entry.name)?'Image':'File';
  return `<div class="file-name ${thumb?'has-thumbnail':''}">${thumb?`<span class="file-thumbnail"><img loading="lazy" src="/api/files/thumbnail?path=${encodeURIComponent(entry.path)}" alt=""></span>`:`<span class="${entry.symlink?'file-link':'file-doc'}"></span>`}<div><b>${esc(entry.name)}</b>${entry.symlink?'<small>Symbolic link · target traversal is blocked</small>':`<small>${esc(kind)}</small>`}</div></div>`;
}
function officeSupportedName(name){return /\.(docx?|odt|rtf|txt|xlsx?|ods|csv|pptx?|odp)$/i.test(String(name||''))}
function fileRowMenu(entry,d){
  const office=!entry.directory&&!entry.symlink&&officeSupportedName(entry.name)?`<button data-action="file-office" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Open in Office</button>`:'';
  const common=`${office}<button data-action="file-properties" data-path="${attr(entry.path)}">Properties</button>${!entry.directory&&!entry.symlink?`<button data-action="file-preview" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}" data-size="${Number(entry.size||0)}">Preview</button><button data-action="file-versions" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Previous Versions</button><button data-action="file-share-link" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Create Share Link</button><a href="/api/files/download?path=${encodeURIComponent(entry.path)}" download>Download</a>`:`<button data-action="file-share-link" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Create Share Link</button><button data-action="file-upload-request" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Request files here</button>`}`;
  const write=d.writable?`<span></span><button data-action="file-copy" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Copy to…</button><button data-action="file-move" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Move to…</button><button data-action="file-rename" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Rename</button><button data-action="file-archive" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Compress to ZIP</button>${!entry.directory&&entry.name.toLowerCase().endsWith('.zip')?`<button data-action="file-extract" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Extract here</button>`:''}<span></span><button class="danger-text" data-action="file-trash" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}">Move to Recycle Bin</button>`:'';
  return `<details class="row-action-menu"><summary aria-label="Actions for ${attr(entry.name)}">${icon('more',18)}</summary><div>${common}${write}</div></details>`;
}

async function filesPage() {
  const params = new URLSearchParams(location.search);
  const share = params.get('share') || '';
  const rel = params.get('rel') || '';
  const pageSize=250;
  const page=Math.max(1,Number(params.get('page')||1));
  const sortSpec=localStorage.getItem('zero1-file-sort')||'name:asc';
  const [sortField,sortOrder]=sortSpec.split(':');
  const query = share ? `?share=${encodeURIComponent(share)}&rel=${encodeURIComponent(rel)}&limit=${pageSize}&offset=${(page-1)*pageSize}&sort=${encodeURIComponent(sortField||'name')}&order=${encodeURIComponent(sortOrder||'asc')}` : '';
  const [roots,workspace] = await Promise.all([share ? api('/api/files',{fresh:true}).catch(()=>({shares:[]})) : Promise.resolve(null), api('/api/files/workspace',{fresh:true}).catch(()=>({favorites:[],recent:[]}))]);
  const rootSharesBefore=list(roots?.shares), liveShareNamesBefore=new Set(rootSharesBefore.map(x=>String(x.name||'').toLowerCase()));
  if(share && rootSharesBefore.length && !liveShareNamesBefore.has(String(share).toLowerCase())){
    markWorkspaceLocationStale(share,'',true);
    await pruneWorkspaceFavoritesForStale(workspace,share,'',true);
    history.replaceState({},'', '/files');
    flash('That shared folder no longer exists. Its old File Manager shortcut was removed.','warn');
    return filesPage();
  }
  let d;
  try{d=await api('/api/files'+query,{fresh:true});}
  catch(e){
    if(share && rel && /not found|no longer exists|unavailable|does not exist|cannot read|parent folder/i.test(String(e?.message||''))){
      markWorkspaceLocationStale(share,rel,false);
      await pruneWorkspaceFavoritesForStale(workspace,share,rel,false);
      history.replaceState({},'', `/files?share=${encodeURIComponent(share)}`);
      flash('That folder no longer exists. Returning to the shared-folder root.','warn');
      return filesPage();
    }
    throw e;
  }
  window.__zero1Files = d;
  const rootShares=list((roots||d).shares), liveShareNames=new Set(rootShares.map(x=>String(x.name||'').toLowerCase()));
  if(d.scope==='share') clearWorkspaceLocationStale(d.share,d.relative_path||'');
  const favorites=list(workspace.favorites).filter(x=>workspaceEntryVisible(x,liveShareNames)), recent=list(workspace.recent).filter(x=>workspaceEntryVisible(x,liveShareNames)); window.__zero1FileWorkspace={...workspace,favorites,recent};
  const quickAccess=[...favorites.slice(0,6).map(x=>({...x,kind:'Favorite'})),...recent.filter(r=>!favorites.some(f=>f.share===r.share&&String(f.path||'')===String(r.path||''))).slice(0,6).map(x=>({...x,kind:'Recent'}))].slice(0,10);

  if (d.scope === 'shares') {
    document.getElementById('content').innerHTML = `<section class="screen file-manager-screen">
      ${heading('File Manager', 'File Manager', 'Browse and manage files through Zero1Local shared folders and retained owner-data migration roots. Operating-system directories are never exposed here.')}
      <div class="file-manager-home">
        <aside class="file-nav-pane"><div class="file-nav-title"><b>Locations</b></div><a class="active" href="/files">${icon('folder',17)} Shared folders</a><a href="/files/trash">${icon('recovery',17)} Recycle Bin</a>${favorites.length?`<div class="file-nav-separator"></div><div class="file-nav-title"><b>Favorites</b></div>${favorites.slice(0,8).map(x=>`<a href="/files?share=${encodeURIComponent(x.share)}&rel=${encodeURIComponent(x.path||'')}">${icon('star',17)} <span>${esc(x.path?`${x.share} / ${x.path}`:x.share)}</span></a>`).join('')}`:''}${recent.length?`<div class="file-nav-separator"></div><div class="file-nav-title"><b>Recent</b></div>${recent.slice(0,6).map(x=>`<a href="/files?share=${encodeURIComponent(x.share)}&rel=${encodeURIComponent(x.path||'')}">${icon('history',17)} <span>${esc(x.path?`${x.share} / ${x.path}`:x.share)}</span></a>`).join('')}`:''}</aside>
        <section class="file-content-pane">
          <header class="file-commandbar"><div><b>Shared folders</b><small>${rootShares.length} available location${rootShares.length===1?'':'s'}</small></div><div class="file-command-actions"><a class="btn btn-small" href="/shares">Manage shared folders</a></div></header>
          ${quickAccess.length?`<section class="file-quick-access"><div class="file-quick-head"><div><b>Quick access</b><small>Favorites first, then recently opened folders.</small></div></div><div class="file-quick-grid">${quickAccess.map(x=>`<a href="/files?share=${encodeURIComponent(x.share)}&rel=${encodeURIComponent(x.path||'')}"><span class="file-quick-icon">${icon(x.kind==='Favorite'?'star':'history',18)}</span><div><b>${esc(x.path?String(x.path).split('/').pop():x.share)}</b><small>${esc(x.share)}${x.path?` / ${esc(x.path)}`:''} · ${esc(x.kind)}</small></div></a>`).join('')}</div></section>`:''}
          <div class="file-list-frame" data-file-root-zone><table class="data-table file-table"><thead><tr><th>Name</th><th>Network path</th><th>Access</th><th></th></tr></thead><tbody>${rootShares.map(sh=>`<tr tabindex="0" data-file-entry data-share-root="1" data-share="${attr(sh.name)}" data-path="${attr(sh.path||'')}" data-name="${attr(sh.name)}" data-directory="1" data-symlink="0" data-size="0" data-writable="${sh.writable?'1':'0'}"><td><a class="file-name" href="/files?share=${encodeURIComponent(sh.name)}"><span class="folder-icon"></span><div><b>${esc(sh.name)}</b><small>${sh.legacy_owner_data?'Legacy owner data · move it into a Zero1Local share before removing U1000':sh.browseable===false?'Hidden from network browse lists':'Shared folder'}</small></div></a></td><td>${sh.network_available===false?'<span class="subtle">Local migration source</span>':`<code>${esc(windowsShare(sh.name))}</code>`}</td><td>${statusPill(sh.writable?'Read & write':'Read only',sh.writable?'good':'warn')}</td><td class="file-row-open"><a class="icon-link" href="/files?share=${encodeURIComponent(sh.name)}" aria-label="Open ${attr(sh.name)}">${icon('chevron',17)}</a></td></tr>`).join('')||`<tr><td colspan="4">${emptyState('No shared folders','Create or restore a shared folder before browsing files. File Manager intentionally does not expose raw /disk0 directories.','<a class="btn btn-primary" href="/shares">Open Shares & Access</a>')}</td></tr>`}</tbody></table></div>
        </section>
      </div>
      <div class="file-safety-note">${icon('security',16)} <span><b>Share-confined access.</b> File operations are limited to active shared-folder roots. Internal appliance storage directories are intentionally hidden.</span></div>
    </section>`;
    enableFileDesktopInteractions();
    return;
  }

  const parts = String(d.relative_path || '').split('/').filter(Boolean);
  let accum = '';
  const crumbParts = parts.map(part => { accum = accum ? `${accum}/${part}` : part; return `<a href="/files?share=${encodeURIComponent(d.share)}&rel=${encodeURIComponent(accum)}">${esc(part)}</a>`; });
  const parentHref = d.relative_path ? `/files?share=${encodeURIComponent(d.share)}&rel=${encodeURIComponent(d.parent_relative_path || '')}` : '/files';
  const viewMode=currentFileViewMode();
  const entries=list(d.entries);
  const totalItems=Number(d.total??entries.length), pageCount=Math.max(1,Math.ceil(totalItems/pageSize));
  const filePageHref=p=>{const u=new URL(location.href);u.searchParams.set('page',String(Math.max(1,Math.min(pageCount,p))));return u.pathname+'?'+u.searchParams.toString()};
  const pager=pageCount>1?`<nav class="file-pager" aria-label="Folder pages"><a class="btn btn-small ${page<=1?'disabled':''}" ${page>1?`href="${attr(filePageHref(page-1))}"`:'aria-disabled="true"'}>Previous</a><span>Page <b>${page}</b> of ${pageCount} · ${totalItems.toLocaleString()} items</span><a class="btn btn-small ${page>=pageCount?'disabled':''}" ${page<pageCount?`href="${attr(filePageHref(page+1))}"`:'aria-disabled="true"'}>Next</a></nav>`:'';
  const breadcrumb = `<a href="/files?share=${encodeURIComponent(d.share)}">${esc(d.share)}</a>${crumbParts.length ? '<span>'+icon('chevron',13)+'</span>' + crumbParts.join('<span>'+icon('chevron',13)+'</span>') : ''}`;
  document.getElementById('content').innerHTML = `<section class="screen file-manager-screen">
    ${heading('File Manager', d.share, d.relative_path ? friendlyStoragePath(d.path) : 'Shared folder', '')}
    <div class="file-manager-home">
      <aside class="file-nav-pane"><div class="file-nav-title"><b>Shared folders</b></div>${rootShares.map(sh=>`<a class="${sh.name===d.share?'active':''}" href="/files?share=${encodeURIComponent(sh.name)}">${icon('folder',17)} <span>${esc(sh.name)}</span></a>`).join('')}<div class="file-nav-separator"></div><a href="/files/trash">${icon('recovery',17)} Recycle Bin</a>${favorites.length?`<div class="file-nav-separator"></div><div class="file-nav-title"><b>Favorites</b></div>${favorites.slice(0,8).map(x=>`<a href="/files?share=${encodeURIComponent(x.share)}&rel=${encodeURIComponent(x.path||'')}">${icon('star',17)} <span>${esc(x.path?`${x.share} / ${x.path}`:x.share)}</span></a>`).join('')}`:''}</aside>
      <section class="file-content-pane">
        <header class="file-commandbar"><div class="file-command-left"><a class="icon-button" href="${parentHref}" aria-label="Up one level">←</a><div class="file-breadcrumbs">${breadcrumb}</div></div><div class="file-command-actions"><button class="icon-button" data-action="file-favorite-toggle" data-favorite="${favorites.some(x=>x.share===d.share&&String(x.path||'')===String(d.relative_path||''))?'1':'0'}" aria-label="${favorites.some(x=>x.share===d.share&&String(x.path||'')===String(d.relative_path||''))?'Remove favorite':'Add favorite'}">${icon('star',16)}</button><div class="view-toggle" role="group" aria-label="File view"><button class="icon-button ${viewMode==='list'?'active':''}" data-action="file-view-mode" data-view="list" aria-label="List view">${icon('list',16)}</button><button class="icon-button ${viewMode==='grid'?'active':''}" data-action="file-view-mode" data-view="grid" aria-label="Grid view">${icon('apps',16)}</button></div><select id="fileSort" class="file-sort-select" aria-label="Sort files"><option value="name:asc" ${sortSpec==='name:asc'?'selected':''}>Name A–Z</option><option value="name:desc" ${sortSpec==='name:desc'?'selected':''}>Name Z–A</option><option value="modified:desc" ${sortSpec==='modified:desc'?'selected':''}>Newest first</option><option value="modified:asc" ${sortSpec==='modified:asc'?'selected':''}>Oldest first</option><option value="size:desc" ${sortSpec==='size:desc'?'selected':''}>Largest first</option><option value="size:asc" ${sortSpec==='size:asc'?'selected':''}>Smallest first</option></select><div class="file-search"><input id="fileSearchQuery" type="search" placeholder="Search ${attr(d.share)}"><button class="icon-button" data-action="file-search-run" aria-label="Search">${icon('search',16)}</button></div><button class="btn btn-small" data-action="file-upload" ${d.writable?'':'disabled'}>${icon('plus',15)} Upload</button><button class="btn btn-small btn-primary" data-action="file-new-folder" ${d.writable?'':'disabled'}>${icon('plus',15)} New folder</button></div></header>
        <div id="fileBatchBar" class="file-batch-bar hidden"><div><b id="fileBatchCount">0 selected</b><small>Batch actions apply to the current folder selection.</small></div><div class="row-actions"><button class="btn btn-small" data-action="file-batch-download">Download ZIP</button><button class="btn btn-small" data-action="file-batch-copy">Copy</button><button class="btn btn-small" data-action="file-batch-cut">Cut</button><button class="btn btn-small" data-action="file-batch-copy-to">Copy to…</button><button class="btn btn-small" data-action="file-batch-move-to">Move to…</button><button class="btn btn-small" data-action="file-batch-archive">Compress</button><button class="btn btn-small danger-soft" data-action="file-batch-trash">Recycle</button><button class="icon-button" data-action="file-selection-clear" aria-label="Clear selection">×</button></div></div>
        ${d.writable?'':`<div class="inline-status warning">${icon('warning',16)} <span>This location is available for browsing but is not writable by the Zero1Local management service.</span></div>`}
        <div class="file-list-frame file-view-${viewMode}" data-file-dropzone><table class="data-table file-table"><thead><tr><th>Name</th><th>Modified</th><th>Size</th><th></th></tr></thead><tbody>${entries.map(entry=>`<tr tabindex="0" data-file-entry data-path="${attr(entry.path)}" data-name="${attr(entry.name)}" data-directory="${entry.directory?'1':'0'}" data-symlink="${entry.symlink?'1':'0'}" data-size="${Number(entry.size||0)}"><td>${fileEntryIdentity(entry,d,viewMode)}</td><td>${fmtDate(entry.modified)}</td><td>${entry.directory?'—':fmtBytes(entry.size)}</td><td class="row-actions">${fileRowMenu(entry,d)}</td></tr>`).join('')||`<tr><td colspan="4">${emptyState('This folder is empty','Upload files or create a folder to begin.','<button class="btn btn-primary" data-action="file-new-folder">New folder</button>')}</td></tr>`}</tbody></table></div>
        ${pager}<footer class="file-statusbar"><span>Showing ${entries.length.toLocaleString()} of ${totalItems.toLocaleString()} item${totalItems===1?'':'s'}</span><span>${d.writable?'Read & write':'Read only'}</span><span>${friendlyStoragePath(d.path)}</span></footer>
      </section>
    </div>
  </section>`;
  enableFileDropzone();
  enableFileDesktopInteractions();
  api('/api/files/recent',{method:'POST',body:JSON.stringify({share:d.share,path:d.relative_path||''}),busy:false}).catch(()=>{});
}

function currentFileLocationLabel() {
  const d = window.__zero1Files || {};
  if (d.scope !== 'share') return 'a shared folder';
  return d.relative_path ? `${d.share} / ${d.relative_path}` : d.share;
}

function openUploadModal(){
  const d=window.__zero1Files||{};
  if(d.scope!=='share'||!d.path){flash('Open a shared folder before uploading files.','bad');return;}
  openModal('Upload files',`Destination: ${currentFileLocationLabel()}`,'<label>Select files</label><input id="fileUploadInput" type="file" multiple><div id="uploadProgress" class="upload-progress hidden"><div><i></i></div><span>Uploading…</span></div>','<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-upload-save">Upload</button>');
}
async function uploadFilesToCurrent(files,{button=null,close=true}={}){
  const d=window.__zero1Files||{};
  if(d.scope!=='share'||!d.path||!d.writable){flash('Open a writable shared folder before uploading files.','bad');return;}
  const selected=[...files];if(!selected.length){flash('Choose at least one file.','bad');return}
  const fd=new FormData();for(const f of selected)fd.append('file',f,f.name);
  if(button)button.disabled=true;document.getElementById('uploadProgress')?.classList.remove('hidden');
  try{const res=await fetch('/api/files/upload?path='+encodeURIComponent(d.path),{method:'POST',headers:{'X-Zero1Local-Request':'1'},credentials:'same-origin',body:fd});let result={};try{result=await res.json()}catch{};if(!res.ok)throw new Error(result.error||`Upload failed (${res.status})`);if(close)closeModal();flash(`${list(result.uploaded).length} file${list(result.uploaded).length===1?'':'s'} uploaded.`);await filesPage()}catch(e){flash(e.message,'bad');if(button)button.disabled=false;}
}
async function uploadSelectedFiles(button){const input=document.getElementById('fileUploadInput');if(!input?.files?.length){flash('Choose at least one file.','bad');return}await uploadFilesToCurrent(input.files,{button,close:true})}
function enableFileDropzone(){
  const d=window.__zero1Files||{},zone=document.querySelector('[data-file-dropzone]');if(!zone||d.scope!=='share'||!d.writable)return;
  let depth=0;const active=on=>zone.classList.toggle('is-drop-target',on);
  zone.addEventListener('dragenter',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();depth++;active(true)}});
  zone.addEventListener('dragover',e=>{if(e.dataTransfer?.types?.includes('Files')){e.preventDefault();e.dataTransfer.dropEffect='copy'}});
  zone.addEventListener('dragleave',()=>{depth=Math.max(0,depth-1);if(!depth)active(false)});
  zone.addEventListener('drop',e=>{e.preventDefault();depth=0;active(false);const files=e.dataTransfer?.files;if(files?.length)uploadFilesToCurrent(files,{close:false})});
}

function openFileTransferModal(kind,path,name){
  const d=window.__zero1Files||{};
  const currentPath=d.scope==='share'?d.path:'';
  const body=`<div class="form-stack"><label>Destination folder</label><input id="fileTransferDest" type="hidden" value="${attr(currentPath)}"><div id="fileTransferSelected" class="selected-folder">${currentPath?`<span class="folder-icon">${icon('folder',16)}</span><div><b>Selected destination</b><small>${esc(currentFileLocationLabel())}</small></div>`:'<span>Choose a shared folder</span>'}</div><div id="fileTransferBrowser" class="folder-browser"><div class="loading"><span class="spinner"></span>Loading shared folders…</div></div><label>New name <small>(optional)</small></label><input id="fileTransferName" value="${attr(name)}"></div>`;
  openModal(`${kind==='copy'?'Copy':'Move'} ${name}`,kind==='copy'?'Choose a destination inside any active shared folder. The original stays in place and existing files are never overwritten.':'Choose a destination inside any active shared folder.',body,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-transfer-save" data-kind="${kind}" data-path="${attr(path)}">${kind==='copy'?'Copy':'Move'}</button>`);
  loadFileTransferBrowser(d.scope==='share'?d.share:'', d.scope==='share'?(d.relative_path||''):'');
}
async function loadFileTransferBrowser(share='',rel=''){
  const box=document.getElementById('fileTransferBrowser'); if(!box)return;
  box.innerHTML='<div class="loading"><span class="spinner"></span>Loading folders…</div>';
  try{
    if(!share){
      const d=await api('/api/files');
      box.innerHTML=`<div class="folder-picker-head"><div><b>Shared folders</b><small>Choose a share, then select its root or a subfolder.</small></div></div><div class="folder-picker-list">${list(d.shares).map(sh=>`<button data-action="file-transfer-folder-nav" data-share="${attr(sh.name)}" data-rel=""><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(sh.name)}</b><small>Open shared folder</small></div></button>`).join('')||'<div class="folder-picker-empty">No shared folders are available.</div>'}</div>`;
      return;
    }
    const d=await api(`/api/files?share=${encodeURIComponent(share)}&rel=${encodeURIComponent(rel)}`);
    const dirs=list(d.entries).filter(e=>e.directory&&!e.symlink);
    const label=d.relative_path?`${d.share} / ${d.relative_path}`:d.share;
    box.innerHTML=`<div class="folder-picker-head"><div><b>${esc(label)}</b><small>Choose this folder or open another one.</small></div><button class="btn btn-small btn-primary" data-action="file-transfer-folder-select" data-path="${attr(d.path)}" data-label="${attr(label)}">Choose this folder</button></div><div class="folder-picker-list"><button data-action="file-transfer-folder-nav" data-share="${d.relative_path?attr(d.share):''}" data-rel="${d.relative_path?attr(d.parent_relative_path||''):''}"><span>↑</span><div><b>${d.relative_path?'Up one level':'Shared folders'}</b><small>${d.relative_path?esc(d.share+(d.parent_relative_path?' / '+d.parent_relative_path:'')):'Choose another share'}</small></div></button>${dirs.map(e=>`<button data-action="file-transfer-folder-nav" data-share="${attr(d.share)}" data-rel="${attr(e.relative_path)}"><span class="folder-icon">${icon('folder',16)}</span><div><b>${esc(e.name)}</b><small>Open folder</small></div></button>`).join('')||'<div class="folder-picker-empty">No subfolders here. You can choose this folder.</div>'}</div>`;
  }catch(e){box.innerHTML=`<div class="notice notice-bad"><b>Unable to browse folders</b><span>${esc(e.message)}</span></div>`;}
}
function selectFileTransferFolder(path,label){
  const input=document.getElementById('fileTransferDest'); if(input)input.value=path;
  const selected=document.getElementById('fileTransferSelected'); if(selected)selected.innerHTML=`<span class="folder-icon">${icon('folder',16)}</span><div><b>Selected destination</b><small>${esc(label||'Shared folder')}</small></div>`;
}

function openNewFolderModal() {
  const d=window.__zero1Files||{};
  if(d.scope!=='share'||!d.path){flash('Open a shared folder before creating folders.','bad');return;}
  openModal('New folder', `Create a folder inside ${currentFileLocationLabel()}.`, '<label>Folder name</label><input id="fileNewFolderName" placeholder="Photos">', '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-new-folder-save">Create folder</button>');
}
function openRenameFileModal(path, name) {
  openModal('Rename item', 'The item stays in the same shared folder. Existing files are never overwritten.', `<label>New name</label><input id="fileRenameName" value="${attr(name)}">`, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-rename-save" data-path="${attr(path)}">Rename</button>`);
}

async function fileTrashPage() {
  const [d,settings]=await Promise.all([api('/api/files/trash'),api('/api/files/recycle-settings')]);
  const days=Number(settings.retention_days||7), expires=x=>{const dt=new Date(x.expires_at||'');if(Number.isNaN(dt.getTime()))return '—';const left=Math.ceil((dt.getTime()-Date.now())/86400000);return left<=0?'Pending cleanup':left===1?'1 day':`${left} days`;};
  document.getElementById('content').innerHTML=`<section class="screen">${heading('File Sharing / Browser','Recycle Bin',`Deleted items stay on Main Storage and continue using disk space until they are permanently removed. Automatic cleanup runs after ${days} day${days===1?'':'s'}.`,list(d.entries).length?'<div class="row-actions"><a class="btn" href="/automation">Retention settings</a><button class="btn btn-danger" data-action="trash-empty">Empty Recycle Bin</button></div>':'<a class="btn" href="/automation">Retention settings</a>')}<div class="table-frame"><table class="data-table"><thead><tr><th>Item</th><th>Original location</th><th>Deleted</th><th>Auto-delete</th><th>Size</th><th></th></tr></thead><tbody>${list(d.entries).map(x=>`<tr><td><b>${esc(x.name)}</b><small>${x.directory?'Folder':'File'}</small></td><td>${esc(x.original_location||'—')}</td><td>${esc(fmtDate(x.deleted_at))}</td><td>${esc(expires(x))}<small>${Number(x.retention_days||days)}-day policy</small></td><td>${x.directory?'—':fmtBytes(x.size)}</td><td class="row-actions"><button class="btn btn-small" data-action="file-restore" data-trash-id="${attr(x.id)}" data-name="${attr(x.name)}">Restore</button><button class="btn btn-small danger-soft" data-action="trash-delete" data-trash-id="${attr(x.id)}" data-name="${attr(x.name)}">Delete permanently</button></td></tr>`).join('')||`<tr><td colspan="6">${emptyState('Recycle Bin is empty',`Items moved here are kept for ${days} day${days===1?'':'s'} unless you permanently delete them sooner.`)}</td></tr>`}</tbody></table></div><div class="notice notice-info"><b>Recycle Bin uses Main Storage</b><span>Items here are recoverable, but they still count toward used disk space. Empty the Recycle Bin to free that space immediately.</span></div><div class="notice notice-warn"><b>Permanent deletion cannot be undone</b><span>Automatic cleanup continues even when the Zero1Local dashboard is closed.</span></div></section>`;
}

async function protocolsPage(){ history.replaceState({}, '', '/shares'); return sharesPage(); }

function sessionClientLabel(ua){const s=String(ua||'');if(!s)return 'Browser not reported';let browser='Browser';if(/Edg\//.test(s))browser='Microsoft Edge';else if(/Chrome\//.test(s))browser='Chrome';else if(/Firefox\//.test(s))browser='Firefox';else if(/Safari\//.test(s))browser='Safari';let os='';if(/Windows/.test(s))os='Windows';else if(/Mac OS X|Macintosh/.test(s))os='macOS';else if(/Android/.test(s))os='Android';else if(/iPhone|iPad/.test(s))os='iOS/iPadOS';else if(/Linux/.test(s))os='Linux';return os?`${browser} · ${os}`:browser}

async function securityPage(){
  const [center,audit,sec25,certificate,firewall,exposure]=await Promise.all([api('/api/security/center').catch(()=>({score:0,status:'Unknown',checks:[]})),api('/api/audit').catch(()=>({events:[]})),api('/api/security/v025').catch(()=>({})),api('/api/security/certificate').catch(()=>({present:false})),api('/api/security/firewall').catch(()=>({available:false,enabled:false,cidrs:[]})),api('/api/security/exposure',{fresh:true}).catch(()=>({status:'Exposure check unavailable',warnings:[],addresses:[],listeners:[],ssh:{},upnp:{}}))]);
  window.__zero1SecurityV025={sec25,certificate,firewall,exposure};const checks=list(center.checks),attention=checks.filter(x=>!x.ok),warnings=list(exposure.warnings),upnp=exposure.upnp||{};
  document.getElementById('content').innerHTML=`<section class="screen security-screen">
    ${heading('System','Security','Sign-in protection, firewall policy, certificates and network exposure.','<a class="btn" href="/system/access">Access & API</a>')}
    <section class="posture-strip"><div class="posture-score"><b>${Number(center.score||0)}</b><span>/100</span></div><div><b>${esc(center.status||'Unknown')}</b><small>${attention.length?`${attention.length} security item${attention.length===1?'':'s'} need attention.`:'Current Zero1Local-managed security controls look healthy.'}</small></div>${statusPill(attention.length?'Attention':'Healthy',attention.length?'warn':'good')}</section>
    ${warnings.length?`<section class="content-panel"><div class="section-heading"><div><h2>Network exposure</h2><p>${esc(exposure.boundary_note||'Keep management access private.')}</p></div>${statusPill('Attention','warn')}</div><div class="settings-list">${warnings.map(x=>`<div class="settings-row"><div><b>${esc(x.title)}</b><small>${esc(x.detail)}</small></div>${statusPill(x.severity==='critical'?'Critical':'Review',x.severity==='critical'?'bad':'warn')}</div>`).join('')}</div></section>`:''}
    <section class="content-panel section-cluster"><div class="cluster-section">${sectionTitle('Two-factor authentication','Require a time-based authenticator code for the local web administrator.')}<div class="settings-row"><div><b>Authenticator requirement</b><small>${sec25.totp_enabled?'Password + authenticator code are required.':'Password-only web sign-in is active.'}</small></div>${statusPill(sec25.totp_enabled?'Enabled':'Not enabled',sec25.totp_enabled?'good':'warn')}</div><div class="panel-actions">${sec25.totp_enabled?'<button class="btn btn-danger" data-action="totp-disable-open">Disable 2FA</button>':'<button class="btn btn-primary" data-action="totp-setup-open">Set up 2FA</button>'}</div></div>
    <div class="cluster-section">${sectionTitle('HTTPS certificate','Certificate used by the optional Zero1Local HTTPS listener.')}<div class="settings-row"><div><b>${esc(certificate.common_name||certificate.subject||'Zero1Local certificate')}</b><small>${certificate.present?`Issuer: ${esc(certificate.issuer||'Unknown')}`:'No certificate is currently available.'}</small></div>${statusPill(certificate.present?(Number(certificate.expires_in_days||0)<30?'Expires soon':'Installed'):'Unavailable',certificate.present?(Number(certificate.expires_in_days||0)<30?'warn':'good'):'neutral')}</div><div class="panel-actions"><button class="btn" data-action="certificate-import-open" ${certificate.external_paths?'disabled':''}>Import certificate</button><button class="btn" data-action="certificate-selfsigned" ${certificate.external_paths?'disabled':''}>Generate self-signed</button>${certificate.acme_available?`<button class="btn btn-primary" data-action="certificate-acme-open" ${certificate.external_paths?'disabled':''}>Request ACME certificate</button>`:''}</div></div></section>
    <section class="content-panel settings-panel network-edge-panel">${sectionTitle('Firewall & Network Protection','Default-deny host firewall for NAS services and trusted management networks.')}<label class="switch-row"><div><b>Protect this NAS with the built-in firewall</b><small>Trusted LAN/VPN networks receive only the ports required by enabled services.</small></div><span class="switch"><input id="firewallEnabled" type="checkbox" ${firewall.enabled?'checked':''} ${firewall.available?'':'disabled'}><i></i></span></label><div class="settings-indent"><label>Trusted LAN / VPN CIDRs</label><textarea id="firewallCIDRs" rows="4" ${firewall.available?'':'disabled'}>${esc(list(firewall.cidrs).join('\n'))}</textarea><label>Trusted reverse proxy CIDRs</label><textarea id="firewallProxyCIDRs" rows="3" ${firewall.available?'':'disabled'}>${esc(list(firewall.proxy_cidrs).join('\n'))}</textarea><button class="btn btn-primary" data-action="firewall-save" ${firewall.available?'':'disabled'}>Save firewall settings</button></div>${!firewall.available?'<div class="inline-status bad"><b>Host firewall unavailable</b><span>nftables/compatible enforcement is not currently available.</span></div>':''}<details class="advanced"><summary>Managed inbound services</summary><div class="advanced-body"><div class="table-frame"><table class="data-table"><thead><tr><th>Service</th><th>Port</th><th>Protocol</th><th>Allowed scope</th></tr></thead><tbody>${list(firewall.services).map(x=>`<tr><td><b>${esc(x.service)}</b></td><td><code>${Number(x.port)}</code></td><td>${esc(String(x.protocol||'').toUpperCase())}</td><td>${esc(x.scope||'trusted')}</td></tr>`).join('')||'<tr><td colspan="4">No managed inbound services were detected.</td></tr>'}</tbody></table></div></div></details></section>
    <details class="advanced feature-checks"><summary>Feature checks</summary><div class="advanced-body"><div class="table-frame"><table class="data-table"><thead><tr><th>Check</th><th>Result</th><th>Detail</th></tr></thead><tbody>${checks.map(c=>`<tr><td><b>${esc(c.label)}</b></td><td>${statusPill(c.ok?'Passed':'Attention',c.ok?'good':'warn')}</td><td>${esc(c.detail||c.message||'—')}</td></tr>`).join('')||'<tr><td colspan="3">No security checks reported.</td></tr>'}</tbody></table></div><div class="capability-table"><div><span>Exposure status</span><b>${esc(exposure.status||'Unknown')}</b></div><div><span>UPnP / PCP / NAT-PMP</span><b>${upnp.available?(upnp.checked?'Checked':'Available'):'Unavailable'}</b></div></div></div></details>
    <details class="advanced"><summary>Recent security-related changes</summary><div class="advanced-body"><div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Operation</th><th>Source</th><th>Result</th></tr></thead><tbody>${list(audit.events).slice(0,12).map(e=>`<tr><td>${esc(fmtDate(e.timestamp))}</td><td><code>${esc(e.method)} ${esc(e.path)}</code></td><td>${esc(e.remote_ip||'local')}</td><td>${statusPill(e.ok?'Succeeded':'Failed',e.ok?'good':'bad')}</td></tr>`).join('')||'<tr><td colspan="4">No guarded changes recorded.</td></tr>'}</tbody></table></div></div></details>
  </section>`;
}

async function systemAccessPage(){
  const [d,keys,sessions,sshkeys]=await Promise.all([api('/api/security'),api('/api/security/api-keys').catch(()=>({keys:[]})),api('/api/security/sessions').catch(()=>({sessions:[]})),api('/api/security/ssh-keys').catch(()=>({keys:[]}))]);
  window.__zero1Access={d,keys,sessions,sshkeys};const rp=d.root_password_login||{};
  document.getElementById('content').innerHTML=`<section class="screen access-api-screen">
    ${heading('System','Access & API','Administrative access methods are centralized here instead of being mixed into Security.')}
    <section class="content-panel section-cluster"><div class="cluster-section"><div class="section-heading"><div><h2>Browser sessions</h2><p>Signed-in Zero1Local management sessions.</p></div></div><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Account</th><th>Source</th><th>Client</th><th>Last active</th><th>Expires</th><th></th></tr></thead><tbody>${list(sessions.sessions).map(x=>`<tr><td><b>${esc(x.username||'root')}</b><small>${esc(String(x.role||'administrator').replace(/-/g,' '))}</small></td><td><code>${esc(x.remote_ip||'Not reported')}</code></td><td><b>${esc(sessionClientLabel(x.user_agent))}</b><small>${esc(String(x.user_agent||'').slice(0,70)||'User agent not reported')}</small></td><td>${esc(fmtDate(x.last_seen||x.created_at))}</td><td>${esc(fmtDate(x.expires_at))}</td><td>${x.current?statusPill('Current','good'):`<button class="btn btn-small danger-soft" data-action="session-delete" data-session="${attr(x.id)}">Sign out</button>`}</td></tr>`).join('')||'<tr><td colspan="6">No active web sessions were reported.</td></tr>'}</tbody></table></div></div>
    <div class="cluster-section"><div class="section-heading"><div><h2>SSH administration</h2><p>SSH is an administrative access method, not a general security setting.</p></div></div><label class="switch-row"><div><b>Allow root password authentication</b><small>SSH keys remain recommended. Password login can be restricted to private/local networks.</small></div><span class="switch"><input id="sshPwEnable" type="checkbox" ${rp.enabled?'checked':''}><i></i></span></label><div class="settings-indent"><label>Allowed private/local networks</label><input id="sshCidrs" value="${attr(list(rp.cidrs).join(', '))}"><label class="checkline"><input id="sameWebPw" type="checkbox"><span><b>Use current Zero1Local web password for Linux root</b><small>Web and OS credentials otherwise remain separate.</small></span></label><div id="webPwWrap" class="hidden"><label>Current web password</label><input id="currentWebPw" type="password"></div><div id="linuxPwWrap"><label>Linux root password</label><input id="linuxRootPw" type="password"></div><label class="checkline risk"><input id="sshRisk" type="checkbox"><span><b>I understand the increased exposure of password-based root SSH access</b></span></label><button class="btn btn-primary" data-action="security-save">Save SSH policy</button></div><div class="section-heading compact"><div><h3>SSH public keys</h3><p>${list(sshkeys.keys).length} key${list(sshkeys.keys).length===1?'':'s'} installed.</p></div><button class="btn btn-small" data-action="ssh-key-add-open">Add key</button></div><div class="settings-list">${list(sshkeys.keys).map(k=>`<div class="settings-row"><div><b>${esc(k.comment||k.type||'SSH key')}</b><small><code>${esc(k.preview||'')}</code></small></div><button class="btn btn-small danger-soft" data-action="ssh-key-delete" data-key="${attr(k.id)}">Remove</button></div>`).join('')||'<div class="settings-row"><div><b>No root SSH keys</b><small>Add a public key if you use SSH administration.</small></div></div>'}</div></div></section>
    <section class="content-panel"><div class="section-heading"><div><h2>API keys</h2><p>Scoped credentials for local integrations and automation. Full tokens are shown only once.</p></div><button class="btn btn-small btn-primary" data-action="api-key-create-open">Create API key</button></div><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Prefix</th><th>Scopes</th><th>Last used</th><th>Expires</th><th></th></tr></thead><tbody>${list(keys.keys).map(k=>`<tr><td><b>${esc(k.name)}</b></td><td><code>${esc(k.prefix)}…</code></td><td>${esc(list(k.scopes).join(', '))}</td><td>${esc(fmtDate(k.last_used_at))}</td><td>${k.expires_at?esc(fmtDate(k.expires_at)):'Never'}</td><td><button class="btn btn-small danger-soft" data-action="api-key-delete" data-key="${attr(k.id)}" data-name="${attr(k.name)}">Revoke</button></td></tr>`).join('')||'<tr><td colspan="6">No API keys have been created.</td></tr>'}</tbody></table></div></section>
  </section>`;toggleSecurityPasswordFields();
}

function certificateImportModal(){openModal('Import HTTPS certificate','Paste the PEM certificate chain and matching private key. Zero1Local validates the key pair before replacing anything and restarts the management listener after a successful import.',`<div class="form-stack"><label>Certificate / full chain PEM</label><textarea id="certPEM" rows="9" spellcheck="false" placeholder="-----BEGIN CERTIFICATE-----"></textarea><label>Private key PEM</label><textarea id="certKeyPEM" rows="9" spellcheck="false" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="certificate-import-save">Validate & install</button>`)}
function certificateACMEModal(){openModal('Request ACME certificate','HTTP-01 validation requires this NAS hostname to resolve publicly to an address that forwards TCP port 80 to this Zero1Local appliance. This is optional and is not appropriate for LAN-only hostnames.',`<div class="form-stack"><label>Public DNS hostname</label><input id="acmeHostname" placeholder="nas.example.com"><label>Contact email</label><input id="acmeEmail" type="email" placeholder="admin@example.com"><div class="notice notice-warn"><b>Public reachability required</b><span>Do not expose the NAS merely to obtain a certificate. Use an imported/internal certificate for LAN-only deployments.</span></div></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="certificate-acme-save">Request certificate</button>`)}

function toggleSecurityPasswordFields() {
  const same = document.getElementById('sameWebPw');
  if (!same) return;
  document.getElementById('webPwWrap')?.classList.toggle('hidden', !same.checked);
  document.getElementById('linuxPwWrap')?.classList.toggle('hidden', same.checked);
}

async function factoryPage() {
  const d = await api('/api/vendor');
  window.__zero1Vendor = d;
  const candidates = list(d.candidate_services);
  const protectedHardware = list(d.protected_hardware_services);
  const isolated = d.isolation?.isolated === true;
  const retired = d.retirement?.retired === true;
  const evidence = list(d.process_evidence);
  const stoppedNow = list(d.runtime_stopped);
  const appRuntime = evidence.filter(x => x.factory_application === true);
  const uiPreserved = retired ? Boolean(d.retirement?.preserve_dir) : list(d.preserved_paths).some(x => x.path === '/deepnas_www' && x.exists);
  const runtimeOK = isolated && appRuntime.length===0;
  document.getElementById('content').innerHTML = `<section class="screen">
    ${heading('Support & Recovery / Original IronCow System', 'Original IronCow System', retired?'Factory application code is retired from the live OS and retained only as deliberate rollback material.':'Verify that the preserved IronCow application layer is not running while Zero1Local manages the appliance.', isolated ? '' : '<button class="btn btn-danger" data-action="factory-isolate">Re-isolate IronCow applications</button>')}
    <section class="content-panel"><div class="factory-status-grid"><div><span>${uiPreserved?'✓':'!'}</span><b>${retired?'Rollback archive':'Factory files'}</b><small>${retired?(uiPreserved?'Preserved outside active runtime paths':'Retirement archive not reported'):(uiPreserved?'Preserved on disk for rollback':'Expected web files not detected')}</small></div><div><span>${isolated?'✓':'↶'}</span><b>Runtime policy</b><small>${retired?'Factory application plane retired':isolated?'Factory application code is blocked':'Factory coexistence is enabled'}</small></div><div><span>${appRuntime.length}</span><b>Running app processes</b><small>${runtimeOK?'None detected after enforcement':appRuntime.length?'Requires attention':'Isolation is not enabled'}</small></div><div><span>${protectedHardware.length}</span><b>Protected hardware services</b><small>Kept only where hardware support is still required</small></div></div></section>
    ${isolated ? `<div class="notice ${appRuntime.length?'notice-bad':'notice-info'}"><b>${appRuntime.length?'Factory runtime isolation violation detected':retired?'Factory management plane retired':'Factory runtime isolation is enforced'}</b><span>${appRuntime.length?'One or more IronCow application processes survived the enforcement pass. They are listed below with their PID and launcher so this is visible rather than silently treated as healthy.':retired?'IronCow rc.local/cron launchers, application unit fragments, OpenResty/DeepNAS live trees and remote-connectivity application paths have been removed from the active OS. Rollback material remains under Zero1Local control.':'Zero1Local reconciles identified IronCow application services at startup and also terminates matching vendor userspace launched by generic wrappers.'}</span></div>` : `<div class="notice notice-warn"><b>Factory application coexistence is enabled</b><span>Original IronCow application processes may run alongside Zero1Local. Choose Isolate factory applications to block the application layer at runtime while preserving the original unit files, recovery files, and hardware dependencies.</span></div>`}
    ${stoppedNow.length ? `<section class="content-panel">${sectionTitle('Runtime enforcement','These vendor processes were active when this page was requested and were stopped by the current isolation policy.')}<div class="runtime-policy">${stoppedNow.map(x=>`<div class="runtime-policy-row"><span class="runtime-policy-icon">■</span><div><b>Stopped factory userspace</b><small>${esc(x)}</small></div>${statusPill('Stopped','good')}</div>`).join('')}</div></section>` : ''}
    <section class="content-panel">${sectionTitle('Factory application runtime', isolated ? 'There should be no active IronCow application process in this list while isolation is healthy.' : 'Processes observed from the original application layer.')} ${appRuntime.length ? `<div class="runtime-policy">${appRuntime.map(x=>`<div class="runtime-policy-row"><span class="runtime-policy-icon">${String(x.command||'').toLowerCase().includes('upload-module')?'UP':'■'}</span><div><b>${String(x.command||'').toLowerCase().includes('upload-module')?'upload-module':'Factory application process'}</b><small>PID ${esc(x.pid)}${x.systemd_unit?` · ${esc(x.systemd_unit)}`:''}<br>${esc(x.executable||x.command||'')}</small></div>${statusPill('Active','bad')}</div>`).join('')}</div>` : `<div class="definition-note"><b>No IronCow application process is currently running</b><span>${retired?'This is the expected state. The factory launch paths themselves are no longer present in the active OS.':isolated?'This is the expected state. Zero1Local will continue checking for unexpected factory userspace.':'No matching process was observed during this inspection.'}</span></div>`}</section>
    <section class="content-panel">${sectionTitle('Factory application services', isolated ? 'Recorded rollback state is preserved while Zero1Local-owned systemd isolation policy blocks these application services from starting.' : 'Services classified as IronCow application/UI/remote-access userspace.')}<div class="entity-list">${candidates.map(x=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">IC</div><div><b>${esc(x.unit)}</b><small>${esc(x.reason||'IronCow application service')}</small></div></div><div class="entity-detail"><span>Runtime</span>${statusPill(x.active==='active'?'Active':x.active||'Unknown',x.active==='active'?'bad':'good')}</div><div class="entity-detail"><span>Startup</span><b>${esc(x.enabled||'—')}</b></div><div class="entity-actions"><span class="locked-label">${isolated?'Isolation managed':'Factory service'}</span></div></article>`).join('') || '<div class="definition-note"><b>No named factory application service units were discovered</b><span>Process-level isolation still applies to matching vendor userspace launched by generic wrappers.</span></div>'}</div></section>
    ${protectedHardware.length ? `<section class="content-panel">${sectionTitle('Protected hardware-facing services', 'These are explicitly outside the application-isolation boundary until Zero1Local has a proven replacement.')}<div class="entity-list">${protectedHardware.map(x=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">HW</div><div><b>${esc(x.unit)}</b><small>${esc(x.reason||'Hardware dependency')}</small></div></div><div class="entity-detail"><span>Runtime</span>${statusPill(x.active||'Unknown',x.active==='active'?'good':'neutral')}</div><div class="entity-detail"><span>Startup</span><b>${esc(x.enabled||'—')}</b></div><div class="entity-actions"><span class="locked-label">Protected</span></div></article>`).join('')}</div></section>` : ''}
    <section class="content-panel">${sectionTitle(retired?'Factory retirement state':'Preserved factory assets', retired?'Factory application material is intentionally absent from its original live paths.':'Isolation changes what runs, not whether recovery material remains available.')} ${retired?`<div class="fact-list"><div><div><b>Rollback material</b><small>Zero1Local-owned preservation path</small></div><span><code>${esc(d.retirement?.preserve_dir||'not reported')}</code></span></div><div><div><b>DeepFS compatibility</b><small>Samba takeover result</small></div><span>${esc(d.retirement?.deepfs_mode||'unknown')}</span></div><div><div><b>Legacy encrypted entries</b><small>Detected at takeover</small></div><span>${Number(d.retirement?.legacy_sandbox_entries||0)}</span></div></div>`:`<div class="preserve-list">${list(d.preserved_paths).map(x => `<div><span class="preserve-icon">${x.exists?'✓':'!'}</span><div><b>${esc(x.path)}</b><small>Recovery asset</small></div>${statusPill(x.exists?'Preserved':'Missing',x.exists?'good':'warn')}</div>`).join('')}</div>`}</section>
    <details class="advanced"><summary>Factory rollback state and full process evidence</summary><div class="advanced-body">${retired?'<div class="notice notice-info"><b>Rollback only</b><span>The factory management plane is absent from the live OS. Preserved factory material can be restored only through full Zero1Local rollback/uninstall or verified Recovery; it cannot be re-enabled beside a running Zero1Local instance.</span></div>':isolated?'<div class="notice notice-warn"><b>Legacy isolation state</b><span>This appliance has not completed RC16 factory retirement. Restore is available only for deliberate rollback/reverse-engineering before retirement is committed.</span></div><div class="panel-actions"><button class="btn btn-danger" data-action="factory-restore">Restore IronCow applications</button></div>':''}<h3 class="subsection-heading">Full process evidence</h3><pre>${esc(JSON.stringify(evidence,null,2))}</pre></div></details>
  </section>`;
}

function stopUSBDrivePolling(){if(window.__zero1USBTimer){clearTimeout(window.__zero1USBTimer);window.__zero1USBTimer=null;}}
function usbDriveFingerprint(recovery,sharesData){
  const devices=list(recovery?.usb_candidates).map(x=>[x.device,x.mountpoint,x.fstype,x.size,x.serial,x.model]);
  const merged=mergedSMBShareInventory(sharesData||{}),usb=merged.shares.find(x=>String(x.name||'').toLowerCase()==='usb');
  return JSON.stringify({devices,usb:usb?{name:usb.name,path:usb.path}:null});
}
function renderUSBDrivesPage(recovery,sharesData,filesData=null){
  const devices=list(recovery.usb_candidates), merged=mergedSMBShareInventory(sharesData), usbShare=merged.shares.find(x=>String(x.name||'').toLowerCase()==='usb');
  const fileShares=list(filesData?.shares||window.__zero1USB?.shares||[]);
  window.__zero1USB={recovery,sharesData,shares:fileShares};
  window.__zero1USBFingerprint=usbDriveFingerprint(recovery,sharesData);
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Storage','USB Drives','Use removable USB storage for file offload, imports and local backup destinations. Drive state updates automatically while this page is open.','<div class="row-actions"><a class="btn" href="/files">File Manager</a><a class="btn" href="/backups">Backups</a></div>')}
    <div class="integration-strip"><div><b>Detected USB storage</b><small>${devices.length} removable device${devices.length===1?'':'s'} reported by the appliance · live refresh</small>${statusPill(devices.length?'Detected':'None connected',devices.length?'good':'neutral')}</div><div><b>File access</b><small>${usbShare?'USB storage is available through File Manager':'Connect a writable USB filesystem to make it available'}</small>${statusPill(usbShare?'Ready':'Waiting',usbShare?'good':'neutral')}</div></div>
    <section class="content-panel">${sectionTitle('Connected USB drives','Connect normal removable storage, then move files directly or use it as a backup destination.')}<div class="entity-list">${devices.map(x=>`<article class="entity-card usb-drive-card"><div class="entity-primary"><div class="avatar">USB</div><div><b>${esc(x.model||x.name||x.device||'USB drive')}</b><small>${esc(x.device||'Device')} ${x.serial?`· ${esc(x.serial)}`:''}</small></div></div><div class="entity-detail"><span>Capacity</span><b>${fmtBytes(x.size)}</b><small>${esc(x.fstype||'Filesystem not recognized')}</small></div><div class="entity-detail"><span>Status</span>${statusPill(x.mountpoint?'Connected':'Ready',x.mountpoint?'good':'neutral')}${x.mountpoint?`<small>Available to Zero1Local</small>`:'<small>Not mounted</small>'}</div><div class="entity-actions">${x.mountpoint&&usbShare?`<a class="btn btn-small btn-primary" href="/files?share=${encodeURIComponent(usbShare.name)}">Open USB Drive</a>`:x.mountpoint?`<a class="btn btn-small" href="/files">Open File Manager</a>`:`<button class="btn btn-small btn-primary" data-action="usb-mount" data-device="${attr(x.device)}">Connect drive</button>`}${x.mountpoint?`<button class="btn btn-small" data-action="usb-backup-open" data-mountpoint="${attr(x.mountpoint)}" data-label="${attr(x.model||x.name||'USB drive')}">Back up a share</button>`:`<button class="btn btn-small" disabled>Back up a share</button>`}</div></article>`).join('')||emptyState('No USB drive detected','Insert a USB drive. Zero1Local will detect it here automatically without refreshing the browser.')}</div></section>
    <section class="content-panel usb-workflow-grid"><article><span>${icon('files',20)}</span><div><b>NAS → USB</b><small>Open File Manager, select files or folders, then Copy to… or Move to… the connected USB location.</small></div></article><article><span>${icon('files',20)}</span><div><b>USB → NAS</b><small>Open the USB drive and copy or move items into any writable shared folder.</small></div></article><article><span>${icon('backups',20)}</span><div><b>Scheduled USB backup</b><small>Add the mounted USB filesystem as a local/USB destination and use normal backup scheduling.</small></div></article></section>
    <div class="notice notice-info"><b>Safe eject remains intentionally blocked</b><span>Zero1Local will not fake an eject button. A proper eject requires a server-side sync, unmount and verification action so writes cannot be stranded.</span></div>
    <details class="advanced"><summary>USB technical details</summary><div class="advanced-body"><pre>${esc(JSON.stringify(devices,null,2))}</pre></div></details>
  </section>`;
}
async function pollUSBDrives(){
  stopUSBDrivePolling();
  if(!isUSBDrivesView()||document.hidden)return;
  try{
    const [recovery,sharesData]=await Promise.all([api('/api/recovery',{busy:false,fresh:true,stale:false}),api('/api/shares',{busy:false,fresh:true,stale:false}).catch(()=>({active:[],factory_testparm:''}))]);
    const fp=usbDriveFingerprint(recovery,sharesData);
    if(fp!==window.__zero1USBFingerprint)renderUSBDrivesPage(recovery,sharesData);
  }catch(_){}
  if(isUSBDrivesView())window.__zero1USBTimer=setTimeout(pollUSBDrives,2000);
}
function usbBackupModal(mountpoint,label='USB drive'){
  const shares=list(window.__zero1USB?.shares||[]).filter(x=>String(x.name||'').toLowerCase()!=='usb');
  if(!mountpoint){flash('Connect the USB drive before creating a backup job.','warn');return;}
  if(!shares.length){flash('Create a normal shared folder before configuring USB backup.','warn');return;}
  openModal('Back up a share to USB',`Create a real Zero1Local backup job on ${label}. Runs appear in Task Center.`, `<div class="form-stack"><label>Shared folder</label><select id="usbBackupShare">${shares.map(x=>`<option value="${attr(x.name)}">${esc(x.name)}</option>`).join('')}</select><div class="field-grid"><div><label>Schedule</label><select id="usbBackupSchedule"><option value="manual">Only when I run it</option><option value="daily">Every day</option><option value="weekly">Every week</option></select></div><div><label>Run at</label><input id="usbBackupTime" type="time" value="02:00"></div></div><label>Weekly days <small>(weekly only)</small></label><input id="usbBackupDays" value="Sun" placeholder="Sun"><label>Backup copies to keep</label><input id="usbBackupRetain" type="number" min="1" max="365" value="7"><label class="checkline"><input id="usbBackupVerify" type="checkbox" checked><span><b>Verify the backup after writing it</b><small>Recommended for removable storage.</small></span></label><label class="checkline"><input id="usbBackupRunNow" type="checkbox" checked><span><b>Run the first backup now</b><small>Progress will appear in Task Center.</small></span></label><div class="notice notice-info"><b>Destination is managed automatically</b><span>Zero1Local stores this share under a dedicated backup folder on the selected USB drive. The Linux mount path is not exposed as something you need to manage.</span></div></div>`, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="usb-backup-save" data-mountpoint="${attr(mountpoint)}" data-label="${attr(label)}">Create USB backup</button>`);
}

async function usbDrivesPage(){
  const [recovery,sharesData,filesData]=await Promise.all([api('/api/recovery',{fresh:true,stale:false}),api('/api/shares',{fresh:true,stale:false}).catch(()=>({active:[],factory_testparm:''})),api('/api/files',{fresh:true,stale:false}).catch(()=>({shares:[]}))]);
  renderUSBDrivesPage(recovery,sharesData,filesData);
  stopUSBDrivePolling();window.__zero1USBTimer=setTimeout(pollUSBDrives,2000);
}

async function recoveryPage(){
  const d=await api('/api/recovery'); window.__zero1Recovery=d; const job=d.job||{}, vaults=list(d.vaults), usbs=list(d.usb_candidates), takeoverReview=list(d.clean_takeover_review);
  const storageCards=list(d.main_storage).map(x=>{const factory=x.classification==='factory-application',legacy=x.classification==='legacy-zero1local-share-root';const label=factory?'IronCow application':legacy?'Legacy Zero1Local':'Owner data';const tone=factory||legacy?'warn':'good';const behavior=factory?'Archive first, then eligible for deliberate removal':legacy?'Normalize child shares to top-level Main Storage':'Preserve in place unless an adopted share needs path normalization';return `<article class="entity-card"><div class="entity-primary"><div class="avatar">${factory?'IC':legacy?'Z1':'DATA'}</div><div><b>${esc(x.path)}</b><small>Main Storage directory</small></div></div><div class="entity-detail"><span>Classification</span>${statusPill(label,tone)}</div><div class="entity-detail"><span>Takeover behavior</span><small>${esc(behavior)}</small></div><div class="entity-actions"><span class="locked-label">${factory?'Recovery controlled':'Preserved'}</span></div></article>`}).join('');
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Support & Recovery','Recovery & Takeover','Create verified off-disk recovery media, restore preserved IronCow data, or deliberately complete a clean local takeover.')}
  <section class="content-panel">${sectionTitle('Recovery USB','A Clean Takeover is never unlocked by a data-bay disk or an unverified archive.')}<div class="entity-list">${usbs.map(x=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">USB</div><div><b>${esc(x.model||x.name||x.device)}</b><small>${esc(x.device)}${x.serial?` · ${esc(x.serial)}`:''}</small></div></div><div class="entity-detail"><span>Capacity / format</span><b>${fmtBytes(x.size)}</b><small>${esc(x.fstype||'Unformatted')}</small></div><div class="entity-detail"><span>State</span>${statusPill(x.mountpoint?'Mounted':'Ready',x.mountpoint?'good':'neutral')}${x.mountpoint?`<small>${esc(x.mountpoint)}</small>`:''}</div><div class="entity-actions">${x.mountpoint?`<button class="btn btn-small btn-primary" data-action="recovery-create" data-mount="${attr(x.mountpoint)}">Create Recovery Vault</button>`:`<button class="btn btn-small" data-action="recovery-mount" data-device="${attr(x.device)}">Mount</button>`}</div></article>`).join('')||`<div class="definition-note"><b>No removable recovery drive detected</b><span>Insert a USB drive with a writable filesystem, then refresh this page. Zero1Local will not use either data bay as recovery media.</span></div>`}</div></section>
  <section class="content-panel">${sectionTitle('Recovery Vault job',job.status==='running'?'Archive creation is running and remains visible without blocking the rest of the appliance.':'Every attempt starts with a fresh job log.')}<div class="runtime-policy"><div class="runtime-policy-row"><span class="runtime-policy-icon">↶</span><div><b>${esc(job.phase||'Recovery Vault')}</b><small>${esc(job.message||'No archive job is currently running.')}</small></div>${statusPill(job.status||'idle',job.status==='ready'?'good':job.status==='failed'?'bad':job.status==='running'?'warn':'neutral')}</div></div><details class="advanced" ${job.status==='running'||job.status==='failed'?'open':''}><summary>Recovery Vault details</summary><pre id="recoveryJobLog" class="install-log">${esc(job.log||'No recovery job output yet.')}</pre></details></section>
  <section class="content-panel">${sectionTitle('Verified Recovery Vaults','Only checksum-verified vaults can authorize destructive takeover or restore factory data.')}<div class="entity-list">${vaults.map(v=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">RV</div><div><b>${esc(v.path)}</b><small>${esc(v.created_at?`Created ${fmtDate(v.created_at)}`:'Recovery Vault')}</small></div></div><div class="entity-detail"><span>Integrity</span>${statusPill(v.verified?'Verified':'Not verified',v.verified?'good':'bad')}</div><div class="entity-detail"><span>Purpose</span><small>${v.verified?'Eligible for restore or deliberate Clean Takeover':'Cannot authorize destructive operations'}</small></div><div class="entity-actions">${v.verified?`<button class="btn btn-small btn-quiet" data-action="recovery-restore" data-vault="${attr(v.path)}">Restore factory data</button><button class="btn btn-small btn-danger" data-action="clean-takeover" data-vault="${attr(v.path)}">Start Fresh and Remove IronCow</button>`:'<span class="locked-label">Verification required</span>'}</div></article>`).join('')||`<div class="definition-note"><b>No verified Recovery Vault is mounted</b><span>Create one on removable USB media before attempting a Clean Takeover.</span></div>`}</div></section>
  ${takeoverReview.length?`<section class="content-panel">${sectionTitle('Clean Takeover review','These paths are inside known IronCow application roots but are not a complete owner-home tree or an entire active share path that Zero1Local can automatically move out.')}<div class="entity-list">${takeoverReview.map(x=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">?</div><div><b>${esc(x.path)}</b><small>Unclassified content inside ${esc(x.root||'factory application storage')}</small></div></div><div class="entity-detail"><span>Type</span><b>${x.directory?'Folder':'File'}</b></div><div class="entity-detail"><span>Takeover behavior</span><small>Included in the verified Recovery Vault, then removed with its IronCow root unless you copy it to normal Main Storage first.</small></div><div class="entity-actions"><span class="locked-label">Owner review required</span></div></article>`).join('')}</div><div class="notice notice-warn"><b>Zero1Local will not guess what this content is</b><span>Review these paths before Clean Takeover. If anything is yours, copy or move it out of the IronCow application root first. The backend requires a separate acknowledgement for this inventory.</span></div></section>`:''}
  <section class="content-panel">${sectionTitle('Main Storage classification','This is a takeover safety inventory, not a second file browser. Unknown directories are always owner data.')}<div class="entity-list">${storageCards||`<div class="definition-note"><b>No Main Storage directories reported</b><span>Check that /disk0 is mounted before attempting recovery or takeover operations.</span></div>`}</div><div class="notice notice-info"><b>Unknown means preserve</b><span>Zero1Local only removes known IronCow application roots after a verified Recovery Vault exists. Any unrecognized top-level Main Storage directory is treated as owner data. Content located inside a known IronCow root is explicitly surfaced for review before that root can be removed.</span></div></section></section>`;
  if(job.status==='running'){setTimeout(()=>{if(normalizedPath()==='/recovery')recoveryPage().catch(()=>{});},1500);setTimeout(()=>{const el=document.getElementById('recoveryJobLog');if(el)el.scrollTop=el.scrollHeight;},0)}
}

async function setupAssistantPage(){
  const [storage,users,shares,network,ready]=await Promise.all([api('/api/storage'),api('/api/users'),api('/api/shares'),api('/api/network'),api('/api/readiness')]); const raid=list(storage.raid)[0];
  const step=(n,title,detail,ok,href,action)=>`<div class="readiness-row"><div class="readiness-icon ${ok?'ok':'no'}">${ok?'✓':n}</div><div><b>${esc(title)}</b><small>${esc(detail)}</small></div>${action||`<a class="btn btn-small" href="${href}">${ok?'Review':'Configure'}</a>`}</div>`;
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Setup','Setup Assistant','Complete a fresh Zero1Local appliance in the normal order. You can leave and return; completed steps remain intact.')}<section class="content-panel">${sectionTitle('1 · Storage & RAID')}<div class="readiness-list">${step('1','Main Storage',(raid?.health==='healthy')?`${String(raid.level||'RAID').toUpperCase()} Main Storage is healthy.`:(storage.data_usage?.source&&!storage.data_usage?.error)?'Single-disk Main Storage is available.':'Create RAID1 for a fresh appliance or repair/adopt the existing data volume.',Boolean((raid?.health==='healthy')||(storage.data_usage?.source&&!storage.data_usage?.error)),'/storage/raid')}</div></section><section class="content-panel">${sectionTitle('2 · Users & groups')}<div class="readiness-list">${step('2','Owner accounts',`${list(users.users).filter(x=>!x.legacy).length} owner account(s) available.`,list(users.users).filter(x=>!x.legacy).length>0,'/users')}</div></section><section class="content-panel">${sectionTitle('3 · Shared folders')}<div class="readiness-list">${step('3','SMB shared folders',`${list(shares.active).length} active share(s).`,list(shares.active).length>0,'/shares?tab=smb')}</div></section><section class="content-panel">${sectionTitle('4 · Network')}<div class="readiness-list">${step('4','LAN and DNS',`Address ${network.primary?.address_cidr||network.primary?.address||'not reported'} · DNS ${list(network.dns_config?.servers).join(', ')||'automatic'}`,Boolean(network.primary?.address||network.primary?.address_cidr),'/network')}</div></section><section class="content-panel">${sectionTitle('5 · Final system check')}<div class="readiness-list">${step('5','Appliance health',ready.status||'Review appliance health and advanced checks.',ready.required_ready,'/diagnostics')}</div></section></section>`;
}

function aboutPage(){
  const attribution = 'Zero1Local originally created by Brad Trammell, a Gigabyte Grove project.';
  document.getElementById('content').innerHTML=`<section class="screen about-page">
    ${heading('About','About Zero1Local','Project details, licensing and the people behind Zero1Local.')}
    <section class="content-panel about-hero">
      <div class="about-brand">${brandLogoHTML('about')}<div><span class="about-project-label">A Gigabyte Grove project</span><h2>Made for the Zero1</h2><p>Manage storage, shared folders, applications and system health from one place.</p></div></div>
      <div class="about-version"><span>Installed release</span><b>v${esc(releaseDisplayVersion())}</b>${releaseBuildLabel()?`<small>Internal build ${esc(releaseBuildLabel())}</small>`:''}</div>
    </section>
    <div class="about-grid">
      <section class="content-panel">${sectionTitle('Project & authorship','The original project identity travels with Zero1Local, including modified and redistributed versions.')}
        <div class="about-facts">
          <div><span>Project</span><b>Zero1Local</b></div>
          <div><span>Project home</span><b>Gigabyte Grove</b></div>
          <div><span>Original author</span><b>Brad Trammell</b></div>
          <div><span>License</span><b>Zero1Local Free Attribution License v1.0</b></div>
        </div>
        <div class="definition-note"><b>Required original-author attribution</b><span>${esc(attribution)}</span></div>
      </section>
      <section class="content-panel">${sectionTitle('What Zero1Local stands for','The appliance is designed around ownership of the hardware and local availability of its core functions.')}
        <div class="about-principles">
          <div><b>One place for the essentials</b><span>Manage storage, network services and applications from the same interface.</span></div>
          <div><b>Owner controlled</b><span>Files, users, shares, applications, network settings, and recovery stay under the appliance owner's control.</span></div>
          <div><b>Reversible where possible</b><span>Recovery data is preserved instead of being erased during routine upgrades.</span></div>
          <div><b>Transparent boundaries</b><span>Zero1Local reports the services it manages and keeps recovery safeguards independent.</span></div>
        </div>
      </section>
    </div>
    <section class="content-panel">${sectionTitle('Zero1Local Free Attribution License','Use it, change it, redistribute it, and build on it. Keep credit with the original author.')}
      <div class="license-summary"><b>Free to use and modify.</b><span>No license fee, royalty, registration, or separate permission is required. Personal, educational, nonprofit, and commercial use are permitted.</span></div>
      <div class="license-terms">
        <article><span>01</span><div><b>Keep original credit</b><p>Redistributed copies and derivative works must clearly identify Brad Trammell as the original author and Zero1Local as a Gigabyte Grove project. Equivalent wording is acceptable as long as the attribution is clear.</p></div></article>
        <article><span>02</span><div><b>Keep the license notice</b><p>The Zero1Local Free Attribution License must remain with redistributed copies and derivative works. Additional notices may be added, but the original attribution and license may not be removed or obscured.</p></div></article>
        <article><span>03</span><div><b>Modify as much as you want</b><p>You may alter Zero1Local without restriction under the license. A modified version may not falsely claim that Brad Trammell or Gigabyte Grove authored, approved, endorsed, certified, or supports somebody else's changes.</p></div></article>
        <article><span>04</span><div><b>Provided as-is</b><p>Zero1Local is provided without warranty. The complete legal wording is included as LICENSE.txt with every official release and installed release payload.</p></div></article>
      </div>
    </section>
    <section class="content-panel">${sectionTitle('Credits','Acknowledgements for the original Zero1Local project.')}
      <div class="credits-grid">
        <div><b>Brad Trammell</b><span>Original author and project creator</span></div>
        <div><b>Gigabyte Grove</b><span>Project identity and home</span></div>
        <div><b>ChatGPT by OpenAI</b><span>Documentation assistance only</span></div>
      </div>
      <p class="about-credit-note">Public documentation was generated with ChatGPT after planning and implementation documentation was supplied. AI was not used to design or implement Zero1Local.</p>
    </section>
  </section>`;
}


function noticeTone(severity) {
  const s=String(severity||'').toLowerCase();
  return s==='critical'?'bad':s==='warning'?'warn':['info','information'].includes(s)?'neutral':'good';
}
function noticeCard(n, {ack=true}={}) {
  const tone=noticeTone(n.severity), state=n.state||(!n.acknowledged?'active':'read');
  const controls=ack?`<div class="notice-state-actions">${state==='active'?`<button class="btn btn-small btn-quiet" data-action="notification-state" data-state="read" data-notification="${attr(n.id)}">Mark read</button>`:''}<button class="btn btn-small btn-quiet" data-action="notification-state" data-state="dismissed" data-notification="${attr(n.id)}">Dismiss</button><button class="btn btn-small btn-quiet" data-action="notification-state" data-state="ignored" data-notification="${attr(n.id)}">Don't remind me again</button><details class="mini-menu"><summary class="btn btn-small btn-quiet">Remind later</summary><div><button data-action="notification-state" data-state="snoozed" data-snooze="60" data-notification="${attr(n.id)}">In 1 hour</button><button data-action="notification-state" data-state="snoozed" data-snooze="1440" data-notification="${attr(n.id)}">Tomorrow</button></div></details></div>`:'';
  return `<article class="action-card action-${tone}"><span class="action-symbol">${tone==='bad'?'!':tone==='warn'?'△':'i'}</span><div><small>${esc(String(n.severity||'information').toUpperCase())}${state!=='active'?` · ${esc(state.toUpperCase())}`:''}</small><h3>${esc(n.title)}</h3><p>${esc(n.detail||'')}</p><div class="action-card-buttons">${n.action_href?`<a class="btn btn-small ${tone==='bad'?'btn-danger':'btn-primary'}" href="${attr(n.action_href)}">${esc(n.action_label||'Open')}</a>`:''}${controls}</div></div></article>`;
}
// Use the same visible notice set for unread count and recommendations.
function dedupeNotices(items) {
  const seen = new Set();
  return list(items).filter(n => {
    // Prefer authoritative IDs: dismiss/read changes are persisted by ID.
    const key = [n.title,n.detail,n.severity,n.action_href].map(x=>String(x||'').trim().toLowerCase().replace(/\s+/g,' ')).join('|') || String(n.id || '').trim();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function visibleUnreadNotices(d){return dedupeNotices(d?.notifications).filter(x=>(x.state||'active')==='active'&&!x.acknowledged);}
function informationalNotices(d){return visibleUnreadNotices(d).filter(x=>['info','information'].includes(String(x.severity||'').toLowerCase()));}
async function actionCenterPage(){
  const [d,n,t]=await Promise.all([api('/api/action-center',{fresh:true,stale:false}),api('/api/notifications',{fresh:true,stale:false}),api('/api/tasks')]);
  const actions=list(d.actions),info=informationalNotices(n),unread=visibleUnreadNotices(n).length,running=list(t.tasks).filter(x=>taskActiveStatus(x.status));
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Overview','Action Center','Alerts that need your attention.',d.healthy?'<span class="hero-ok">✓ No action required</span>':'')}

    <section class="content-panel">${sectionTitle('Needs your attention',actions.length?'Highest-priority appliance conditions first.':'Nothing needs intervention right now.')}<div class="action-grid action-results-grid action-results-full">${actions.map(x=>noticeCard(x)).join('')||'<p class="quiet-empty">Nothing needs attention right now.</p>'}</div></section>
    ${running.length?`<section class="content-panel">${sectionTitle('In progress','Long-running work continues in the background.','<a class="text-link" href="/notifications">Open Notifications →</a>')}<div class="task-list">${running.slice(0,6).map(taskRow).join('')}</div></section>`:''}
    ${info.length?`<section class="content-panel">${sectionTitle('Recommendations','Useful improvements that are not current failures.','<a class="text-link" href="/notifications">All notifications →</a>')}<div class="action-grid compact">${info.map(x=>noticeCard(x)).join('')}</div></section>`:''}
  </section>`;
}
function taskActiveStatus(status){return ['running','pause_pending','paused','stop_pending','canceling'].includes(String(status||'').toLowerCase())}
function taskTerminalStatus(status){return ['completed','complete','success','succeeded','done','failed','error','cancelled','canceled','stopped','deferred'].includes(String(status||'').toLowerCase())}
function taskTone(t){const s=String(t?.status||'').toLowerCase();return ['failed','error'].includes(s)?'bad':['completed','complete','success','succeeded','done'].includes(s)?'good':['cancelled','canceled','stopped','deferred','paused','pause_pending','stop_pending','canceling'].includes(s)?'warn':'warn'}
function updateStageLabel(t){
  const idx=Number(t.stage_index||0),count=Number(t.stage_count||7),stage=String(t.stage||t.detail||'Preparing update');
  return idx>0?`Step ${idx} of ${count} · ${stage}`:stage;
}
function taskRow(t){
  const progress=pct(t.progress),remaining=Math.max(0,100-progress),mobile=t.kind==='mobile-transfer',update=t.kind==='system-update',active=taskActiveStatus(t.status),paused=String(t.status||'').toLowerCase()==='paused';
  const eta=paused?'Paused':active?(t.eta_seconds?fmtETA(t.eta_seconds):'ETA calculating…'):['completed','complete','success','succeeded','done'].includes(String(t.status||'').toLowerCase())?'Complete':'—';
  const rate=t.average_bytes_per_sec?fmtRate(t.average_bytes_per_sec):active?'Speed calculating…':'—';
  let detail=t.detail||'';
  if(mobile&&t.total_files)detail=`${t.completed_files||0}/${t.total_files} files · ${progress}% complete · ${remaining}% remaining · ${eta} · ${rate} avg`;
  if(update)detail=updateStageLabel(t);
  const kindLabel=update?'SOFTWARE UPDATE':String(t.kind||'task').toUpperCase();
  return `<div class="task-row ${['failed','error'].includes(String(t.status||'').toLowerCase())?'task-failed':''} ${mobile?'task-mobile':''} ${update?'task-system-update':''}"><span class="task-kind">${esc(kindLabel)}</span><div class="task-main"><div><button class="task-title-link" data-action="task-open" data-task="${attr(t.id)}">${esc(t.title)}</button><small>${esc(detail)}</small>${mobile&&t.current_file?`<small class="task-current-file">Current: ${esc(t.current_file)}</small>`:''}${t.error?`<pre class="task-error-detail">${esc(t.error)}</pre>`:''}</div><div class="task-progress"><i style="width:${progress}%"></i></div></div><div class="task-meta">${statusPill(t.status,taskTone(t))}<small>${progress}%${update&&active?` · ${esc(String(t.stage||'Working'))}`:active?` · ${remaining}% left · ${esc(eta)}`:''}</small><small>${esc(fmtDate(t.updated_at))}</small>${taskTerminalStatus(t.status)?`<button class="btn btn-small btn-quiet task-dismiss" data-action="task-dismiss" data-task="${attr(t.id)}" aria-label="Dismiss ${attr(t.title||'task')}">Dismiss</button>`:''}</div></div>`
}
function stopTaskCenterPolling(){if(window.__zero1TaskCenterTimer){clearTimeout(window.__zero1TaskCenterTimer);window.__zero1TaskCenterTimer=null;}}
function stopTaskDetailPolling(){if(window.__zero1TaskDetailTimer){clearTimeout(window.__zero1TaskDetailTimer);window.__zero1TaskDetailTimer=null;}}
function renderTaskCenterData(d){
  if(normalizedPath()!=='/tasks')return;
  const tasks=list(d.tasks), running=Number(d.running||tasks.filter(x=>taskActiveStatus(x.status)).length||0);
  const badge=document.getElementById('taskCenterRunning');
  if(badge){badge.textContent=`${running} running`;badge.classList.toggle('hidden',running===0);}
  const summary=document.querySelector('#taskCenterList')?.closest('.content-panel')?.querySelector('.section-title p');
  if(summary)summary.textContent=tasks.length?`${tasks.length} recent task${tasks.length===1?'':'s'}`:'No background tasks have run in this service session.';
  const body=document.getElementById('taskCenterList');
  if(body)body.innerHTML=tasks.map(taskRow).join('')||emptyState('No tasks yet','Long-running operations will appear here with progress, results and errors.');
  const clear=document.getElementById('taskClearFinished');if(clear)clear.classList.toggle('hidden',!tasks.some(x=>taskTerminalStatus(x.status)));
  const chrome=document.querySelector('[data-task-count]');
  if(chrome){chrome.textContent=String(running);chrome.classList.toggle('hidden',running===0);}
}
async function pollTaskCenter(){
  stopTaskCenterPolling();
  if(normalizedPath()!=='/tasks'||document.hidden)return;
  try{renderTaskCenterData(await api('/api/tasks',{busy:false,fresh:true,stale:false}));}catch(_){}
  if(normalizedPath()==='/tasks')window.__zero1TaskCenterTimer=setTimeout(pollTaskCenter,1500);
}
function taskControlButtons(t){
  if(!t?.controllable||!taskActiveStatus(t.status))return '';
  const paused=t.status==='paused'||t.status==='pause_pending';
  return `<div class="task-control-bar">${paused?`<button class="btn btn-primary" data-action="task-control" data-task="${attr(t.id)}" data-control="resume">Resume</button>`:`<button class="btn" data-action="task-control" data-task="${attr(t.id)}" data-control="pause">Pause</button>`}<button class="btn" data-action="task-control" data-task="${attr(t.id)}" data-control="stop">Stop after current file</button><button class="btn btn-danger" data-action="task-control" data-task="${attr(t.id)}" data-control="cancel">Cancel now</button></div>`;
}
function systemUpdateTaskDetailMarkup(d){
  const t=d.task||{},p=pct(t.progress),idx=Number(t.stage_index||0),count=Number(t.stage_count||7),active=taskActiveStatus(t.status);
  const stages=['Downloading update','Opening update package','Verifying package','Checking this NAS','Installing update','Restarting Zero1Local','Verifying and cleaning up'];
  const steps=stages.map((name,i)=>{const n=i+1,state=t.status==='completed'?'done':n<idx?'done':n===idx&&active?'current':n===idx&&t.status==='failed'?'failed':'upcoming';return `<div class="update-task-step is-${state}"><span>${state==='done'?'✓':state==='failed'?'!':n}</span><div><b>${esc(name)}</b><small>${state==='done'?'Finished':state==='current'?'In progress':state==='failed'?'Stopped here':'Waiting'}</small></div></div>`}).join('');
  const packageProgress=t.total_bytes>0?`${fmtBytes(Number(t.completed_bytes||0))} / ${fmtBytes(Number(t.total_bytes||0))}`:t.package_name||'GitHub release package';
  const error=t.error?`<div class="update-task-error"><b>The update did not finish.</b><p>${esc(t.error)}</p><a class="btn" href="/updates">Open Software Updates</a></div>`:'';
  return `<div class="task-detail-view update-task-detail" data-task-detail="${attr(t.id)}"><div class="task-detail-hero"><div><small>SOFTWARE UPDATE</small><h3>${esc(t.title||'Zero1Local update')}</h3><p>${esc(t.stage||t.detail||'Preparing update')}</p></div>${statusPill(t.status,taskTone(t))}</div><div class="task-detail-meter"><div><i style="width:${p}%"></i></div><b>${p}% complete</b><span>${idx>0?`Step ${idx} of ${count}`:'Getting ready'}${t.target_version?` · Updating to v${esc(t.target_version)}`:''}</span></div><div class="update-task-summary"><div><small>Target version</small><b>${t.target_version?`v${esc(t.target_version)}`:'—'}</b></div><div><small>Update package</small><b>${esc(t.package_name||'Production package')}</b><span>${esc(packageProgress)}</span></div><div><small>Started</small><b>${esc(fmtDate(t.started_at))}</b></div><div><small>Last activity</small><b>${esc(fmtDate(t.updated_at))}</b></div></div>${error}<section class="update-task-timeline"><div class="section-heading"><div><h3>Update progress</h3><p>Zero1Local performs each safety step in order. The management page may reconnect briefly while the service restarts.</p></div></div><div class="update-task-steps">${steps}</div></section><div class="task-update-actions"><a class="btn btn-primary" href="/updates">Open Software Updates</a></div></div>`;
}
function taskDetailMarkup(d){
  if(d.task?.kind==='system-update')return systemUpdateTaskDetailMarkup(d);
  const t=d.task||{},p=pct(t.progress),remainingPct=Math.max(0,100-p),totalFiles=Number(t.total_files||0),doneFiles=Number(t.completed_files||0),remainFiles=Math.max(0,totalFiles-doneFiles),currentPct=t.current_file_bytes>0?Math.max(0,Math.min(100,Math.round(Number(t.current_file_done||0)*100/Number(t.current_file_bytes)))):0,paused=String(t.status||'').toLowerCase()==='paused';
  const eta=paused?'Paused':t.eta_seconds?fmtETA(t.eta_seconds):taskActiveStatus(t.status)?'Calculating…':'—',etaNote=paused?'Resume to continue ETA':t.eta_confidence==='stable'?'Smoothed from recent + overall throughput':t.eta_confidence==='estimated'?'Estimate is still settling':'Collecting transfer samples';
  const rows=list(d.remaining).map(f=>`<div class="task-file-row ${f.status==='running'?'is-current':''}"><span>${Number(f.index||0).toLocaleString()}</span><div><b>${esc(f.name||'File')}</b><small>${f.status==='running'?'Currently transferring':'Queued'}${f.size?` · ${fmtBytes(f.size)}`:''}</small></div></div>`).join('');
  return `<div class="task-detail-view" data-task-detail="${attr(t.id)}"><div class="task-detail-hero"><div><small>${esc(String(t.kind||'TASK').toUpperCase())}</small><h3>${esc(t.title||'Task')}</h3><p>${esc(t.detail||'')}</p></div>${statusPill(t.status,taskTone(t))}</div><div class="task-detail-meter"><div><i style="width:${p}%"></i></div><b>${p}% complete</b><span>${remainingPct}% remaining · ${esc(eta)}</span></div><div class="task-metric-grid"><div><small>Files</small><b>${doneFiles.toLocaleString()} / ${totalFiles.toLocaleString()}</b><span>${remainFiles.toLocaleString()} remaining</span></div><div><small>Data</small><b>${fmtBytes(Number(t.completed_bytes||0)+Number(t.current_file_done||0))}${t.total_bytes?` / ${fmtBytes(t.total_bytes)}`:''}</b><span>${t.total_bytes?`${fmtBytes(Math.max(0,Number(t.total_bytes||0)-Number(t.completed_bytes||0)-Number(t.current_file_done||0)))} remaining`:'Size calculating…'}</span></div><div><small>Current file</small><b>${esc(t.current_file||'—')}</b><span>${t.current_file?`${currentPct}% of current file`:taskActiveStatus(t.status)?'Waiting for next file':'No active file'}</span></div><div><small>Average speed</small><b>${t.average_bytes_per_sec?fmtRate(t.average_bytes_per_sec):'Calculating…'}</b><span>Effective rate including verification</span></div><div><small>Estimated remaining</small><b>${esc(eta)}</b><span>${esc(etaNote)}</span></div></div>${taskControlButtons(t)}<section class="task-remaining"><div class="section-heading"><div><h3>Remaining files</h3><p>${Number(d.remaining_total||0).toLocaleString()} file${Number(d.remaining_total||0)===1?'':'s'} remaining in original selection order.</p></div></div><div class="task-file-list" id="taskRemainingFiles">${rows||emptyState('Queue complete','No files remain in this task.')}</div>${d.has_more?`<button class="btn task-load-more" data-action="task-load-more" data-task="${attr(t.id)}" data-offset="${Number(d.next_offset||0)}">Load more remaining files</button>`:''}</section></div>`;
}
async function refreshTaskDetail(taskID,{offset=0,append=false}={}){
  const d=await api(`/api/tasks/${encodeURIComponent(taskID)}?offset=${Number(offset||0)}&limit=250`,{busy:false,fresh:true,stale:false});
  const holder=document.querySelector('[data-task-detail]');
  if(!holder||holder.dataset.taskDetail!==String(taskID))return d;
  if(append){const listEl=document.getElementById('taskRemainingFiles');const rows=list(d.remaining).map(f=>`<div class="task-file-row ${f.status==='running'?'is-current':''}"><span>${Number(f.index||0).toLocaleString()}</span><div><b>${esc(f.name||'File')}</b><small>${f.status==='running'?'Currently transferring':'Queued'}${f.size?` · ${fmtBytes(f.size)}`:''}</small></div></div>`).join('');if(listEl)listEl.insertAdjacentHTML('beforeend',rows);document.querySelector('.task-load-more')?.remove();if(d.has_more)holder.querySelector('.task-remaining')?.insertAdjacentHTML('beforeend',`<button class="btn task-load-more" data-action="task-load-more" data-task="${attr(taskID)}" data-offset="${Number(d.next_offset||0)}">Load more remaining files</button>`);}else holder.outerHTML=taskDetailMarkup(d);
  return d;
}
async function pollTaskDetail(taskID){
  stopTaskDetailPolling();
  if(!document.querySelector(`[data-task-detail="${CSS.escape(String(taskID))}"]`))return;
  try{const d=await api(`/api/tasks/${encodeURIComponent(taskID)}?offset=0&limit=250`,{busy:false,fresh:true,stale:false});const holder=document.querySelector('[data-task-detail]');if(holder&&holder.dataset.taskDetail===String(taskID))holder.outerHTML=taskDetailMarkup(d);if(taskActiveStatus(d.task?.status))window.__zero1TaskDetailTimer=setTimeout(()=>pollTaskDetail(taskID),1000);}catch(_){}
}
async function openTaskDetail(taskID){
  stopTaskDetailPolling();
  const d=await api(`/api/tasks/${encodeURIComponent(taskID)}?offset=0&limit=250`,{fresh:true});
  openModal(d.task?.kind==='system-update'?'Software update':d.task?.kind==='mobile-transfer'?'Mobile transfer':'Task details',d.task?.kind==='system-update'?'Follow the update from download through final health checks.':'Live task progress and available controls.',taskDetailMarkup(d),'<button class="btn btn-primary" data-action="close-modal">Close</button>');
  if(taskActiveStatus(d.task?.status))window.__zero1TaskDetailTimer=setTimeout(()=>pollTaskDetail(taskID),1000);
}
async function tasksPage() {
  // Keep existing task links and bookmarks working, but use one Activity inbox.
  history.replaceState({}, '', '/notifications' + location.search + location.hash);
  return notificationsPage();
}
async function notificationsPage() {
  const [n,t] = await Promise.all([
    api('/api/notifications?include_suppressed=1',{fresh:true,stale:false}),
    api('/api/tasks',{fresh:true,stale:false}).catch(()=>({tasks:[],running:0}))
  ]);
  const all=dedupeNotices(n.notifications);
  const current=all.filter(x=>(x.state||'active')==='active');
  const unread=visibleUnreadNotices({notifications:current}).length;
  const history=all.filter(x=>!['active'].includes(x.state||'active'));
  const tasks=list(t.tasks), active=tasks.filter(x=>taskActiveStatus(x.status));
  const failed=tasks.filter(x=>['failed','error'].includes(String(x.status||'').toLowerCase()));
  const finished=tasks.filter(x=>taskTerminalStatus(x.status)&&!failed.includes(x));
  const pending=[...active,...failed];
  const historyCards=history.map(x=>noticeCard(x,{ack:false})).join('');
  document.getElementById('content').innerHTML=`<section class="screen unified-notifications-screen">
    ${heading('Home','Notifications','Messages and background activity in one place.',
      `<div class="row-actions"><a class="btn" href="/automation">Delivery settings</a>${unread?`<button class="btn" data-action="notification-dismiss-all">Mark all read (${unread})</button>`:''}</div>`)}
    ${pending.length?`<section class="content-panel">${sectionTitle('In progress & issues',
      `${active.length} running · ${failed.length} need review`)}
      <div class="task-list">${pending.map(taskRow).join('')}</div></section>`:''}
    <section class="content-panel">${sectionTitle('Messages',current.length?`${unread} unread · ${current.length} current`:'You are all caught up')}
      <div class="action-grid notification-grid">${current.map(x=>noticeCard(x,{ack:true})).join('')||
        emptyState('No new messages','Important updates and background work will appear here.')}</div>
    </section>
    ${history.length||finished.length?`<details class="advanced notification-history"><summary>Previously read & completed (${history.length+finished.length})</summary>
      <div class="advanced-body">${historyCards?`<div class="action-grid notification-grid">${historyCards}</div>`:''}
      ${finished.length?`<div class="task-list">${finished.map(taskRow).join('')}</div>`:''}
      <button class="btn btn-small btn-quiet" data-action="task-clear-finished">Clear completed jobs</button></div></details>`:''}
  </section>`;
  const wanted=new URLSearchParams(location.search).get('task');
  if(wanted)queueMicrotask(()=>openTaskDetail(wanted).catch(e=>flash(e.message,'bad')));
}

function backupTargetLabel(job){
  if(!job?.target_id) return job?.destination||'Local destination';
  const t=list(window.__zero1BackupTargets?.targets).find(x=>x.id===job.target_id);
  return t?`${t.name} · ${String(t.type||'remote').toUpperCase()}`:'Remote target';
}
async function openBackupVersions(jobId){
  const d=await api('/api/backup-versions?job='+encodeURIComponent(jobId));
  const versions=list(d.versions);
  openModal('Backup versions',`Available local/mounted recovery points for ${d.job?.name||'this job'}.`,versions.length?`<div class="table-frame"><table class="data-table"><thead><tr><th>Version</th><th>Modified</th><th>Size</th><th></th></tr></thead><tbody>${versions.map(v=>`<tr><td><code>${esc(v.name)}</code></td><td>${esc(fmtDate(v.modified))}</td><td>${fmtBytes(v.size)}</td><td><button class="btn btn-small" data-action="backup-version-browse" data-backup="${attr(jobId)}" data-archive="${attr(v.name)}">Browse</button></td></tr>`).join('')}</tbody></table></div>`:emptyState('No backup versions','Run this backup job at least once before browsing recovery points.'),'<button class="btn btn-primary" data-action="close-modal">Close</button>');
}
async function openBackupVersionContents(jobId,archive){
  const d=await api('/api/backup-versions/contents?job='+encodeURIComponent(jobId)+'&archive='+encodeURIComponent(archive));
  const items=list(d.items).filter(x=>x.path&&String(x.path).split('/').length>1).slice(0,1000);
  openModal('Browse backup version',archive,`<div class="version-browser"><div class="table-frame"><table class="data-table"><thead><tr><th>Item</th><th>Modified</th><th>Size</th><th></th></tr></thead><tbody>${items.map(x=>`<tr><td><b>${esc(String(x.path).split('/').slice(1).join('/')||x.path)}</b><small>${x.directory?'Folder':'File'}</small></td><td>${esc(fmtDate(x.modified))}</td><td>${x.directory?'—':fmtBytes(x.size)}</td><td><button class="btn btn-small" data-action="backup-version-restore" data-backup="${attr(jobId)}" data-archive="${attr(archive)}" data-member="${attr(x.path)}">Restore</button></td></tr>`).join('')||'<tr><td colspan="4">No restorable entries were reported.</td></tr>'}</tbody></table></div>${d.truncated?'<div class="context-note">Only the first 5,000 archive entries were indexed for interactive browsing.</div>':''}</div>`,`<button class="btn btn-quiet" data-action="backup-versions-open" data-backup="${attr(jobId)}">Back</button><button class="btn btn-primary" data-action="close-modal">Close</button>`);
}
function backupProtectionAssessment(share,jobs,targets){
  const enabled=jobs.filter(j=>j.enabled!==false&&j.share===share.name);
  if(!enabled.length)return {label:'Unprotected',tone:'bad',last:'Never',destination:'No backup job'};
  const targetById=new Map(targets.map(t=>[t.id,t]));
  const classify=j=>{const t=j.target_id?targetById.get(j.target_id):null;if(t){if(String(t.type||'').toLowerCase()!=='local')return {off:true,label:`${t.name} · ${String(t.type||'remote').toUpperCase()}`};const ep=String(t.endpoint||'');return {off:!ep.startsWith('/disk0'),label:t.name||ep||'Mounted destination'}}const dest=String(j.destination||'');return {off:!!dest&&!dest.startsWith('/disk0'),label:dest||'Local destination'}};
  const completed=enabled.filter(j=>j.last_status==='completed').sort((a,b)=>String(b.last_run_at||'').localeCompare(String(a.last_run_at||'')));
  const off=completed.find(j=>classify(j).off);
  if(off){const c=classify(off);return {label:'Protected',tone:'good',last:fmtDate(off.last_run_at),destination:c.label}}
  const local=completed[0];
  if(local){const c=classify(local);return {label:'Local copy only',tone:'warn',last:fmtDate(local.last_run_at),destination:c.label}}
  const failed=enabled.find(j=>j.last_status==='failed');
  if(failed)return {label:'Attention',tone:'bad',last:fmtDate(failed.last_run_at),destination:classify(failed).label};
  return {label:'Pending',tone:'warn',last:'Not run',destination:classify(enabled[0]).label};
}

function protectionLayerSummary(shareName,plans,backups,offsite,snapshots){
  const plan=list(plans.plans).find(x=>x.share===shareName);
  const bjobs=list(backups.jobs).filter(x=>x.share===shareName&&x.enabled!==false);
  const ojobs=list(offsite.jobs).filter(x=>x.share===shareName&&x.enabled!==false);
  const spolicies=list(snapshots.policies).filter(x=>x.share===shareName&&x.enabled!==false);
  const snaps=list(snapshots.snapshots).filter(x=>x.share===shareName);
  const failed=[...bjobs,...ojobs].some(x=>x.last_status==='failed') || plan?.health==='attention';
  const offOK=ojobs.some(x=>x.last_status==='completed');
  const backupOK=bjobs.some(x=>x.last_status==='completed');
  const snapOK=spolicies.length>0||snaps.length>0;
  let label='Unprotected',tone='bad';
  if(failed){label='Needs attention';tone='bad'}
  else if(offOK&&(backupOK||snapOK)){label='Layered protection';tone='good'}
  else if(offOK){label='Off-site protected';tone='good'}
  else if(backupOK||snapOK){label='Local protection only';tone='warn'}
  else if(plan||bjobs.length||ojobs.length||spolicies.length){label='Protection pending';tone='warn'}
  const latest=[...bjobs,...ojobs].filter(x=>x.last_run_at).sort((a,b)=>String(b.last_run_at).localeCompare(String(a.last_run_at)))[0];
  return {plan,bjobs,ojobs,spolicies,snaps,failed,offOK,backupOK,snapOK,label,tone,last:latest?.last_run_at||'',layers:[snapOK?'Snapshots':'',backupOK?'Backup':'',offOK?'Off-site':''].filter(Boolean)};
}

async function protectionOverviewPage(){
  const [health,plans,backups,offsite,verification]=await Promise.all([
    api('/api/protection/status',{fresh:true}).catch(()=>({shares:[],average_score:0,attention:0})),
    api('/api/protection/plans').catch(()=>({plans:[]})),api('/api/backups').catch(()=>({jobs:[]})),Promise.resolve({jobs:[]}),
    api('/api/protection/recovery-tests').catch(()=>({policy:{enabled:false}}))
  ]);
  const verificationEnabled=!!verification?.policy?.enabled;
  const rows=list(health.shares),fully=rows.filter(x=>x.score>=85&&x.tone==='good').length;
  // An optional backup not being configured is a suggestion, not a failure.
  const hasRealFailure=x=>list(backups.jobs).some(j=>j.share===x.share&&j.last_status==='failed')||
    /(?:failed|error|verification failed)/i.test(String(x.status||'')+' '+String(x.reason||''));
  const attention=rows.filter(hasRealFailure).length;
  const unconfigured=rows.filter(x=>!hasRealFailure(x)&&!x.plan&&!(Number(x.score)>0)).length;
  const partial=Math.max(0,rows.length-fully-attention-unconfigured);
  const recoveryLabel=x=>hasRealFailure(x)?['Needs review','bad'] : !x.plan&&Number(x.score||0)<30?['Not set up','neutral'] : String(x.status||'').toLowerCase().includes('protect')&&x.tone==='bad'?['Setup recommended','neutral'] : [x.status||'Unknown',x.tone||'neutral'];
  const recent=list(backups.jobs).map(x=>({...x,kind:'Backup'})).filter(x=>x.last_run_at).sort((a,b)=>String(b.last_run_at).localeCompare(String(a.last_run_at))).slice(0,8);
  document.getElementById('content').innerHTML=`<section class="screen protection-overview-screen">
    ${heading('Sync & Backup','Sync & Backup','Choose how to back up, copy, and recover your shared files.')}
    <section class="sync-direction-grid"><a class="sync-direction-card" href="/replication"><span class="sync-arrow">NAS → NAS</span><div><b>Replication</b><small>Keep a copy on another NAS, manually or on a schedule.</small></div>${statusPill('Built in','good')}</a><a class="sync-direction-card" href="/help/sync"><span class="sync-arrow">NAS ↔ Cloud</span><div><b>Cloud sync with Syncria</b><small>Use the separate Syncria app to sync files with supported cloud storage.</small></div>${statusPill('Optional','neutral')}</a></section>
    <div class="protection-score-grid"><article class="protection-score-card"><span>Recovery readiness</span><b>${Number(health.average_score||0)}</b><small>out of 100 across shared folders</small></article><article class="protection-score-card"><span>Plans configured</span><b>${fully}</b><small>Strong layered recovery coverage</small></article><article class="protection-score-card ${partial?'is-warning':''}"><span>In progress</span><b>${partial}</b><small>Some recovery options are configured</small></article><article class="protection-score-card"><span>Not set up</span><b>${unconfigured}</b><small>Optional recovery plans not configured</small></article></div>
    <section class="content-panel">${sectionTitle('Recovery options by folder','These are optional ways to restore files if they are lost or deleted. No plan configured is not a drive or RAID error.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Shared folder</th><th>Score</th><th>Protection</th><th>Recovery layers</th>${verificationEnabled?'<th>Verification</th>':''}<th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.share)}</b><small>${esc(x.reason||'')}</small></td><td><div class="protection-meter"><span style="width:${Math.max(0,Math.min(100,Number(x.score||0)))}%"></span></div><b>${Number(x.score||0)}/100</b></td><td>${statusPill(...recoveryLabel(x))}${x.plan?`<small>Plan: ${esc(x.plan)}</small>`:''}</td><td>${list(x.layers).length?list(x.layers).map(y=>`<span class="layer-chip">${esc(y)}</span>`).join(' '):'<span class="muted">None configured</span>'}</td>${verificationEnabled?`<td>${x.verified_at?`${statusPill(x.verified_ok?'Verified':'Attention',x.verified_ok?'good':'warn')}<small>${esc(fmtDate(x.verified_at))}</small>`:'Not yet verified'}</td>`:''}<td class="row-actions">${verificationEnabled?`<button class="btn btn-small" data-action="recovery-verify-run" data-share="${attr(x.share)}">Verify</button>`:''}<a class="btn btn-small" href="/protection/restore">Restore</a></td></tr>`).join('')||`<tr><td colspan="6">${emptyState('No shared folders','Create a shared folder before configuring protection.','<a class="btn btn-primary" href="/shares">Create shared folder</a>')}</td></tr>`}</tbody></table></div></section>
    <div class="protection-workflow-grid"><a class="workflow-card" href="/snapshots"><span>${icon('history',22)}</span><div><b>Snapshots</b><small>Restore earlier versions when your storage supports snapshots.</small></div>${icon('chevron',16)}</a><a class="workflow-card" href="/backups"><span>${icon('storage',22)}</span><div><b>Backups</b><small>Keep recoverable copies of your important files.</small></div>${icon('chevron',16)}</a><a class="workflow-card" href="/help/sync"><span>${icon('protection',22)}</span><div><b>Cloud sync with Syncria</b><small>Connect supported cloud accounts through the separate Syncria app.</small></div>${icon('chevron',16)}</a><a class="workflow-card" href="/replication"><span>${icon('network',22)}</span><div><b>Replication</b><small>Keep a second copy on another NAS.</small></div>${icon('chevron',16)}</a></div>
    <section class="content-panel">${sectionTitle('Recent protection activity','Detailed history remains with the workflow that owns each job.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Type</th><th>Job</th><th>Share</th><th>Result</th></tr></thead><tbody>${recent.map(x=>`<tr><td>${esc(fmtDate(x.last_run_at))}</td><td>${esc(x.kind)}</td><td><b>${esc(x.name||'Protection job')}</b></td><td>${esc(x.share||'—')}</td><td>${statusPill(x.last_status||'Unknown',x.last_status==='completed'?'good':x.last_status==='failed'?'bad':'neutral')}</td></tr>`).join('')||'<tr><td colspan="5">No protection jobs have run yet.</td></tr>'}</tbody></table></div></section>
    <div class="context-note">${icon('about',16)}<span><b>RAID is not backup.</b> Storage redundancy keeps the NAS available after a disk failure; recovery layers protect against deletion, corruption, ransomware and loss of the appliance.</span></div>
  </section>`;
}
async function restoreCenterPage(){
  const [snapshots,backups,offsite,verification]=await Promise.all([
    api('/api/snapshots',{fresh:true}).catch(()=>({snapshots:[]})),api('/api/backups',{fresh:true}).catch(()=>({jobs:[]})),Promise.resolve({generations:[],targets:[]}),api('/api/protection/recovery-tests',{fresh:true}).catch(()=>({policy:{enabled:false,weekday:'Sunday',time_of_day:'05:00',history:[]},shares:[]}))
  ]);
  window.__zero1Offsite=offsite;window.__zero1RecoveryVerification=verification;
  const snaps=list(snapshots.snapshots).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),jobs=list(backups.jobs).filter(x=>!x.target_id),generations=list(offsite.generations).sort((a,b)=>String(b.created_at).localeCompare(String(a.created_at))),targets=list(offsite.targets),policy=verification.policy||{},history=list(policy.history).slice().sort((a,b)=>String(b.ended_at).localeCompare(String(a.ended_at))).slice(0,25),total=snaps.length+jobs.length+generations.length;
  document.getElementById('content').innerHTML=`<section class="screen restore-center-screen">
    ${heading('Protection','Restore Center','Search and verify recovery sources without first deciding which backup technology created them.',`<div class="row-actions"><a class="btn" href="/protection">Protection overview</a><a class="btn btn-primary" href="/offsite">Protect a Share</a></div>`)}
    <section class="content-panel recovery-search-panel">${sectionTitle('Find something to recover','Search recent native snapshots and local backup archives by file or folder name. Remote cloud generations remain browsed on demand so search never stalls on WAN latency.')}<div class="recovery-search-bar"><input id="recoverySearchQuery" placeholder="Report.docx, Photos/2026, invoices…"><button class="btn btn-primary" data-action="recovery-search-run">Search recovery sources</button></div><div id="recoverySearchResults" class="recovery-search-results"><small>Enter at least two characters.</small></div></section>
    <div class="summary-strip"><div><span>Recovery sources</span><b>${total}</b></div><div><span>Native snapshots</span><b>${snaps.length}</b></div><div><span>Local backup jobs</span><b>${jobs.length}</b></div></div>
    <details class="advanced feature-checks"><summary>Recovery verification (optional)</summary><div class="advanced-body">${sectionTitle('Recovery verification','A backup is more trustworthy after Zero1Local has proved that a managed recovery source can actually be read.')}<label class="switch-row"><div><b>Scheduled recovery verification</b><small>Runs a lightweight sample verification against available recovery sources; it does not overwrite live files.</small></div><span class="switch"><input id="recoveryVerifyEnabled" type="checkbox" ${policy.enabled?'checked':''}><i></i></span></label><div class="field-grid"><div><label>Weekday</label><select id="recoveryVerifyDay">${['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'].map(d=>`<option ${String(policy.weekday||'Sunday')===d?'selected':''}>${d}</option>`).join('')}</select></div><div><label>Time</label><input id="recoveryVerifyTime" type="time" value="${attr(policy.time_of_day||'05:00')}"></div></div><div class="panel-actions"><button class="btn" data-action="recovery-verify-run">Verify all now</button><button class="btn btn-primary" data-action="recovery-policy-save">Save verification schedule</button></div>${history.length?`<div class="recovery-verification-history"><h3>Recent verification</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Share</th><th>Completed</th><th>Result</th><th>Sources</th></tr></thead><tbody>${history.map(x=>`<tr><td><b>${esc(x.share)}</b></td><td>${esc(fmtDate(x.ended_at))}</td><td>${statusPill(x.ok?'Verified':'Attention',x.ok?'good':'warn')}<small>${esc(x.summary||'')}</small></td><td>${Object.entries(x.sources||{}).map(([k,v])=>`<span class="verification-source"><b>${esc(k)}</b> ${esc(v)}</span>`).join(' ')||'No source detail'}</td></tr>`).join('')}</tbody></table></div></div>`:'<div class="human-note">No recovery verification has been recorded yet.</div>'}</div></details>
    <section class="content-panel">${sectionTitle('Native snapshots','Exact point-in-time copies on snapshot-capable filesystems. Full rollback remains deliberately explicit because it replaces live share state.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Share</th><th>Created</th><th>Backend</th><th>Reason</th><th></th></tr></thead><tbody>${snaps.map(x=>`<tr><td><b>${esc(x.share)}</b></td><td>${esc(fmtDate(x.created_at))}</td><td>${statusPill(x.backend||'snapshot','good')}</td><td>${esc(x.reason||'manual')}</td><td><button class="btn btn-small" data-action="snapshot-restore" data-snapshot="${attr(x.id)}" data-share="${attr(x.share)}">Restore</button></td></tr>`).join('')||'<tr><td colspan="5">No native snapshots are currently available.</td></tr>'}</tbody></table></div></section>
    <section class="content-panel">${sectionTitle('Local backup versions','Browse retained local versions and restore individual items without overwriting existing files.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Job</th><th>Share</th><th>Last run</th><th>Status</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><b>${esc(j.name||'Backup job')}</b></td><td>${esc(j.share||'—')}</td><td>${j.last_run_at?esc(fmtDate(j.last_run_at)):'Never'}</td><td>${statusPill(j.last_status||'Not run',j.last_status==='completed'?'good':j.last_status==='failed'?'bad':'neutral')}</td><td><button class="btn btn-small" data-action="backup-versions-open" data-backup="${attr(j.id)}">Browse versions</button></td></tr>`).join('')||'<tr><td colspan="5">No directly browsable local backup jobs are configured.</td></tr>'}</tbody></table></div></section>
    
    <div class="context-note">${icon('about',16)}<span><b>Restore Center is a discovery layer, not a lowest-common-denominator restore engine.</b> Each recovery source keeps its safest native restore behavior.</span></div>
  </section>`;
}
async function backupsPage(){
  const [d,files,targets]=await Promise.all([api('/api/backups'),api('/api/files'),api('/api/backup-targets')]);
  window.__zero1Backups=d; window.__zero1BackupShares=list(files.shares); window.__zero1BackupTargets=targets;
  const jobs=list(d.jobs), targetList=list(targets.targets), shareList=list(files.shares);
  const assessments=shareList.map(sh=>({share:sh,...backupProtectionAssessment(sh,jobs,targetList)}));
  const protectedShares=new Set(assessments.filter(x=>x.tone==='good').map(x=>x.share.name));
  const failures=jobs.filter(j=>j.last_status==='failed').length;
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Data Protection','Protect a Share','Choose versioned backup, off-site cloud copy, or NAS-to-NAS replication based on the outcome you want.',`<div class="row-actions"><button class="btn btn-primary" data-action="backup-create">Versioned backup</button><a class="btn" href="/help/sync">Syncria for Cloud Sync</a><a class="btn" href="/replication">NAS replica</a></div>`)}
    <div class="summary-strip"><div><span>Protected shares</span><b>${protectedShares.size}</b></div><div><span>Backup jobs</span><b>${jobs.length}</b></div><div><span>Destinations</span><b>${targetList.length}</b></div><div class="${failures?'summary-attention':''}"><span>Failed jobs</span><b>${failures}</b></div></div>
    <section class="content-panel admin-section">${sectionTitle('Protection health','Share-level confidence based on enabled jobs, last successful run and whether the newest usable copy is off Main Storage.')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Shared folder</th><th>Protection</th><th>Last successful copy</th><th>Best destination</th></tr></thead><tbody>${assessments.map(x=>`<tr><td><b>${esc(x.share.name)}</b><small>${esc(friendlyShareLocation(x.share))}</small></td><td>${statusPill(x.label,x.tone)}</td><td>${esc(x.last)}</td><td>${esc(x.destination)}</td></tr>`).join('')||'<tr><td colspan="4">No active shared folders were reported.</td></tr>'}</tbody></table></div></section>
    <section class="content-panel admin-section">${sectionTitle('Backup jobs',jobs.length?`${jobs.length} configured job${jobs.length===1?'':'s'}.`:'No backup jobs configured.','<button class="btn btn-small" data-action="backup-create">Create job</button>')}
      <div class="table-frame borderless"><table class="data-table"><thead><tr><th>Job</th><th>Source</th><th>Destination</th><th>Schedule</th><th>Last run</th><th>Status</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><b>${esc(j.name)}</b><small>${j.verify?'Verification enabled':'Verification off'}${j.encrypt?' · Encrypted':''}</small></td><td>${esc(j.share)}</td><td><span>${esc(backupTargetLabel(j))}</span></td><td>${j.schedule==='manual'?'On demand':`${esc(j.schedule)} · ${esc(j.time_of_day||'—')}`}</td><td>${esc(fmtDate(j.last_run_at))}</td><td>${statusPill(j.last_status||'Not run',j.last_status==='completed'?'good':j.last_status==='failed'?'bad':'neutral')}${j.last_error?`<small class="error-detail">${esc(j.last_error)}</small>`:''}</td><td class="row-actions"><button class="btn btn-small btn-primary" data-action="backup-run" data-backup="${attr(j.id)}">Run</button><details class="row-action-menu"><summary aria-label="Backup job actions">${icon('more',18)}</summary><div>${!j.target_id?`<button data-action="backup-versions-open" data-backup="${attr(j.id)}">Browse versions</button>`:''}<button data-action="backup-edit" data-backup="${attr(j.id)}">Edit</button><button class="danger-text" data-action="backup-delete" data-backup="${attr(j.id)}" data-name="${attr(j.name)}">Remove</button></div></details></td></tr>`).join('')||`<tr><td colspan="7">${emptyState('No backup jobs','Protect an important shared folder with a scheduled or on-demand backup.','<button class="btn btn-primary" data-action="backup-create">Create backup job</button>')}</td></tr>`}</tbody></table></div>
    </section>
    <section class="content-panel admin-section">${sectionTitle('Destinations','Reusable backup destinations are tested before you depend on them.','<button class="btn btn-small" data-action="backup-target-create">Add destination</button>')}
      <div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Endpoint</th><th>Last test</th><th></th></tr></thead><tbody>${targetList.map(t=>`<tr><td><b>${esc(t.name)}</b></td><td>${esc(String(t.type||'').toUpperCase())}</td><td><code>${esc(t.endpoint||'—')}</code>${t.bucket?`<small>Bucket: ${esc(t.bucket)}</small>`:''}</td><td>${t.last_test?`${statusPill(t.last_ok?'Passed':'Failed',t.last_ok?'good':'bad')}<small>${esc(fmtDate(t.last_test))}</small>`:statusPill('Not tested','neutral')}${t.last_error?`<small class="error-detail">${esc(t.last_error)}</small>`:''}</td><td class="row-actions"><button class="btn btn-small" data-action="backup-target-test" data-target="${attr(t.id)}">Test</button><details class="row-action-menu"><summary aria-label="Destination actions">${icon('more',18)}</summary><div><button data-action="backup-target-edit" data-target="${attr(t.id)}">Edit</button><button class="danger-text" data-action="backup-target-delete" data-target="${attr(t.id)}" data-name="${attr(t.name)}">Remove</button></div></details></td></tr>`).join('')||`<tr><td colspan="5">${emptyState('No remote destinations','Local and mounted USB paths can be used directly. Add a local, SMB, NFS or SSH/SFTP destination; cloud synchronization belongs in Syncria.','<button class="btn btn-primary" data-action="backup-target-create">Add destination</button>')}</td></tr>`}</tbody></table></div>
    </section>
    <section class="content-panel admin-section">${sectionTitle('Appliance configuration','Export or restore Zero1Local configuration without copying share data.')}
      <div class="settings-list"><div class="settings-row"><div><b>Export configuration</b><small>Users, shared folders, managed network state, protection settings and Zero1Local configuration.</small></div><a class="btn" href="/api/system/config-backup" download>Download ZIP</a></div><div class="settings-row"><div><b>Restore configuration</b><small>A local recovery checkpoint is created before current appliance configuration is replaced.</small></div><div class="row-actions"><input id="configRestoreFile" class="compact-file-input" type="file" accept=".zip"><button class="btn" data-action="config-restore">Restore</button></div></div></div>
    </section>
    <div class="context-note">${icon('about',16)} <span>A backup stored under <code>/disk0</code> is a second copy, not protection against Main Storage failure. Use removable or remote storage for array-loss protection.</span></div>
  </section>`;
}
function backupModal(job=null){
  const shares=list(window.__zero1BackupShares), targets=list(window.__zero1BackupTargets?.targets), isEdit=!!job;
  openModal(isEdit?'Edit backup job':'Create backup job','Choose a shared folder and either a mounted local/USB path or a verified remote destination.',`<div class="form-stack"><label>Job name</label><input id="backupName" value="${attr(job?.name||'')}" placeholder="Documents offsite"><label>Shared folder</label><select id="backupShare">${shares.map(x=>`<option value="${attr(x.name)}" ${job?.share===x.name?'selected':''}>${esc(x.name)}</option>`).join('')}</select><label>Remote destination</label><select id="backupTarget"><option value="">Local / mounted path</option>${targets.map(t=>`<option value="${attr(t.id)}" ${job?.target_id===t.id?'selected':''}>${esc(t.name)} · ${esc(String(t.type||'').toUpperCase())}</option>`).join('')}</select><label>Local destination path</label><input id="backupDestination" value="${attr(job?.destination||'/mnt/backup')}" placeholder="/mnt/backup"><small class="field-help">Ignored when a remote destination is selected. /disk0 is a local copy; use /mnt, /media or /run/media for removable/off-storage copies.</small><div class="field-grid"><div><label>Schedule</label><select id="backupSchedule"><option value="manual" ${!job||job.schedule==='manual'?'selected':''}>On demand</option><option value="daily" ${job?.schedule==='daily'?'selected':''}>Daily</option><option value="weekly" ${job?.schedule==='weekly'?'selected':''}>Weekly</option></select></div><div><label>Run at</label><input id="backupTime" type="time" value="${attr(job?.time_of_day||'02:00')}"></div></div><label>Weekly days <small>(Mon,Tue,...)</small></label><input id="backupDays" value="${attr(list(job?.weekdays).join(','))}" placeholder="Mon,Wed,Fri"><div class="field-grid"><div><label>Retention</label><input id="backupRetain" type="number" min="1" max="365" value="${attr(job?.retain||7)}"></div><div><label>Bandwidth limit (KB/s)</label><input id="backupBandwidth" type="number" min="0" value="${attr(job?.bandwidth_kb||0)}"><small class="field-help">0 = unlimited.</small></div></div><label>Include patterns <small>(comma separated; blank = everything)</small></label><input id="backupInclude" value="${attr(list(job?.include).join(','))}" placeholder="Photos/**,Documents/**"><label>Exclude patterns</label><input id="backupExclude" value="${attr(list(job?.exclude).join(','))}" placeholder="*.tmp,@eaDir/**"><label class="checkline"><input id="backupVerify" type="checkbox" ${job?.verify!==false?'checked':''}><span><b>Verify after backup</b><small>Zero1Local validates local archives or confirms the remote object/file exists.</small></span></label><label class="checkline"><input id="backupEncrypt" type="checkbox" ${job?.encrypt?'checked':''}><span><b>Encrypt archive before remote transfer</b><small>AES-256-CBC with PBKDF2. Keep the passphrase outside this NAS too.</small></span></label><label>Encryption passphrase</label><input id="backupPassphrase" type="password" value="${job?.passphrase==='********'?'********':''}" autocomplete="new-password" placeholder="At least 12 characters"><label class="checkline"><input id="backupEnabled" type="checkbox" ${job?.enabled!==false?'checked':''}><span><b>Enable scheduled runs</b></span></label></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="backup-save" data-backup="${attr(job?.id||'')}">${isEdit?'Save changes':'Create backup job'}</button>`)
}
function backupTargetModal(target=null){
  const t=target||{}, isEdit=!!target;
  openModal(isEdit?'Edit backup destination':'Add backup destination','Zero1Local will store the destination in protected appliance state. Use Test after saving to verify the real path/login.',`<div class="form-stack"><label>Name</label><input id="backupTargetName" value="${attr(t.name||'')}" placeholder="Offsite Backup"><div class="notice notice-info"><b>Cloud backup targets unavailable</b><span>Use a separately configured Syncria Docker container for NAS-to-cloud and cloud-to-NAS synchronization.</span></div><label>Type</label><select id="backupTargetType"><option value="local" ${t.type==='local'?'selected':''}>USB drive or mounted folder</option><option value="smb" ${t.type==='smb'?'selected':''}>SMB</option><option value="nfs" ${t.type==='nfs'?'selected':''}>NFS</option><option value="rsync" ${t.type==='rsync'?'selected':''}>rsync over SSH</option><option value="sftp" ${t.type==='sftp'?'selected':''}>SFTP</option></select><label>Endpoint / path</label><input id="backupTargetEndpoint" value="${attr(t.endpoint||'')}" placeholder="/mnt/usb · //server/share · server:/path"><label>Remote username</label><input id="backupTargetUser" value="${attr(t.username||'')}" autocomplete="off"><label>Remote password (if supported)</label><input id="backupTargetSecret" type="password" value="${t.secret==='********'?'********':''}" autocomplete="new-password"><div class="notice notice-info"><b>SSH destinations use Zero1Local's replication key</b><span>rsync and SFTP are key-authenticated. The destination account must authorize the public key shown on the Replication page.</span></div></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="backup-target-save" data-target="${attr(t.id||'')}">Save destination</button>`)
}

async function dockerStacksPage(){
  const d=await api('/api/docker/stacks');const stacks=list(d.stacks);
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Apps','Docker Compose','Validate, deploy and operate multi-container applications with Docker Compose.','<button class="btn btn-primary" data-action="stack-create">+ Deploy stack</button>')}
    <section class="content-panel admin-section">${sectionTitle('Stacks',`${stacks.length} stack${stacks.length===1?'':'s'} managed by Zero1Local.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Type</th><th>Status</th><th></th></tr></thead><tbody>${stacks.map(x=>`<tr><td><b>${esc(x.name)}</b></td><td>Docker Compose</td><td>${statusPill(x.status||'Available',toneFor(x.status||'available'))}</td><td class="row-actions"><button class="btn btn-small" data-action="stack-action" data-stack="${attr(x.name)}" data-stack-action="restart">Restart</button><details class="row-action-menu"><summary aria-label="Stack actions">${icon('more',18)}</summary><div><button data-action="stack-action" data-stack="${attr(x.name)}" data-stack-action="update">Pull & update</button><button class="danger-text" data-action="stack-delete" data-stack="${attr(x.name)}">Remove</button></div></details></td></tr>`).join('')||`<tr><td colspan="4">${emptyState('No Docker Compose projects','Deploy an existing Compose definition without leaving Zero1Local.','<button class="btn btn-primary" data-action="stack-create">Deploy stack</button>')}</td></tr>`}</tbody></table></div></section>
    <div class="context-note">${icon('check',16)} <span>Zero1Local runs <code>docker compose config</code> before deployment. Deploy and update operations report through Task Center.</span></div>
  </section>`
}
function stackCreateModal(){openModal('Deploy Compose stack','Paste a complete Docker Compose definition. Zero1Local validates it before anything starts.',`<div class="form-stack"><label>Stack name</label><input id="stackName" placeholder="immich"><label>compose.yaml</label><textarea id="stackCompose" class="code-editor" spellcheck="false" placeholder="services:\n  app:\n    image: nginx:latest"></textarea></div>`,'<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="stack-save">Validate & deploy</button>')}

async function diagnosticsPage(){
  const [d,u,n,audit,perf,q,sys]=await Promise.all([api('/api/diagnostics'),api('/api/update/status'),api('/api/network/safety'),api('/api/audit'),api('/api/diagnostics/performance'),api('/api/diagnostics/qualification'),api('/api/system')]);
  const checks=list(d.checks),failed=checks.filter(c=>!c.ok),events=list(audit.events).slice(0,20),qualification=q.report||{},counts=qualification.counts||{},status=String(qualification.status||'not-run').toLowerCase(),tone=status==='pass'?'good':status==='fail'?'bad':status==='warn'?'warn':'neutral';
  document.getElementById('content').innerHTML=`<section class="screen diagnostics-screen">
    ${heading('System','Advanced Stats','Performance, restart history and troubleshooting information. Routine users do not need the feature-check details.','<a class="btn" href="/api/diagnostics/bundle" download>Download support bundle</a>')}
    <div class="metric-band"><div><span>Successful starts</span><b>${Number(sys.boot_persistence?.boots_observed||0)}</b><small>Recorded restart history</small></div><div><span>Feature status</span><b>${failed.length?'Attention':'Healthy'}</b><small>${failed.length?`${failed.length} item${failed.length===1?'':'s'} flagged`:'No current failures'}</small></div><div><span>API cache</span><b>${Number(d.telemetry_cache?.response_entries||0)+Number(d.telemetry_cache?.value_entries||0)}</b><small>Cached snapshots</small></div><div><span>Full check</span><b>${status==='not-run'?'Not run':status.toUpperCase()}</b><small>${qualification.completed_at?esc(fmtDate(qualification.completed_at)):'Optional diagnostic'}</small></div></div>
    <section class="content-panel">${sectionTitle('Management performance','Operational timing summarized without exposing raw diagnostic internals by default.')}<div class="settings-list"><div class="settings-row"><div><b>API response cache</b><small>${esc(d.telemetry_cache?.strategy||'Snapshot cache')}</small></div>${statusPill(String(d.telemetry_cache?.backend||'').includes('snapshot')?'Active':'Unavailable',String(d.telemetry_cache?.backend||'').includes('snapshot')?'good':'warn')}</div><div class="settings-row"><div><b>Cache activity</b><small>Hits · stale responses · misses · refreshes</small></div><span>${Number(d.telemetry_cache?.hits||0).toLocaleString()} · ${Number(d.telemetry_cache?.stale_served||0).toLocaleString()} · ${Number(d.telemetry_cache?.misses||0).toLocaleString()} · ${Number(d.telemetry_cache?.refreshes||0).toLocaleString()}</span></div></div></section>
    <details class="advanced feature-checks"><summary>Feature checks</summary><div class="advanced-body"><div class="section-heading"><div><h3>Current appliance checks</h3><p>Read-only validation intended for troubleshooting.</p></div><button class="btn btn-small btn-primary" data-action="qualification-run">Run full feature check</button></div><div class="table-frame"><table class="data-table"><thead><tr><th>Check</th><th>Status</th><th>Detail</th></tr></thead><tbody>${checks.map(c=>`<tr><td><b>${esc(c.label)}</b></td><td>${statusPill(c.ok?'Passed':'Attention',c.ok?'good':'bad')}</td><td>${esc(c.detail||'—')}</td></tr>`).join('')}</tbody></table></div><div class="settings-list"><div class="settings-row"><div><b>Latest full check</b><small>${qualification.completed_at?`Completed ${esc(fmtDate(qualification.completed_at))}`:'Not run'}</small></div>${statusPill(status==='not-run'?'Not run':status.toUpperCase(),tone)}</div><div class="settings-row"><div><b>Passed · Warning · Failed</b><small>Qualification totals</small></div><span>${Number(counts.pass||0)} · ${Number(counts.warn||0)} · ${Number(counts.fail||0)}</span></div></div></div></details>
    <div class="diagnostics-detail-grid"><section class="content-panel diagnostics-detail-panel">${sectionTitle('Performance','Read-only diagnostic information')}<div class="advanced-body"><div class="diagnostic-columns"><div><h3>API requests</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Endpoint</th><th>Calls</th><th>Avg</th><th>Max</th><th>Failures</th></tr></thead><tbody>${list(perf.requests).slice(0,12).map(x=>`<tr><td><code>${esc(x.key||x.name||'')}</code></td><td>${Number(x.count||0)}</td><td>${Number(x.average_ms||0).toFixed(1)} ms</td><td>${Number(x.max_ms||0).toFixed(1)} ms</td><td>${Number(x.failures||0)}</td></tr>`).join('')||'<tr><td colspan="5">No request timing data yet.</td></tr>'}</tbody></table></div></div><div><h3>Collectors</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Command</th><th>Calls</th><th>Avg</th><th>Max</th><th>Failures</th></tr></thead><tbody>${list(perf.commands).slice(0,12).map(x=>`<tr><td><code>${esc(x.key||x.name||'')}</code></td><td>${Number(x.count||0)}</td><td>${Number(x.average_ms||0).toFixed(1)} ms</td><td>${Number(x.max_ms||0).toFixed(1)} ms</td><td>${Number(x.failures||0)}</td></tr>`).join('')||'<tr><td colspan="5">No collector timing data yet.</td></tr>'}</tbody></table></div></div></div><h3>Browser route timing</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Route</th><th>Total</th><th>Slowest API</th><th>GETs</th><th>Cache</th><th>Time</th></tr></thead><tbody>${browserPerformanceRows().map(x=>`<tr><td><code>${esc(x.path)}</code></td><td>${Number(x.total_ms||0).toFixed(1)} ms</td><td title="${attr(x.slowest_endpoint||"No network request recorded")}">${x.api_calls?Number(x.slowest_api_ms||0).toFixed(1)+" ms":"—"}</td><td>${Number(x.api_calls||0)}</td><td>${statusPill(x.snapshot?'Snapshot':'Fresh',x.snapshot?'good':'neutral')}</td><td>${esc(new Date(x.at).toLocaleTimeString())}</td></tr>`).join('')||'<tr><td colspan="6">No browser timing data yet.</td></tr>'}</tbody></table></div></div></section>
    <section class="content-panel diagnostics-detail-panel">${sectionTitle('Current configuration','Read-only diagnostic information')}<div class="advanced-body"><div class="diagnostic-columns"><div><h3>Update readiness</h3><div class="settings-list">${list(u.checks).map(c=>`<div class="settings-row"><div><b>${esc(c.label)}</b></div>${statusPill(c.ok?'Ready':'Blocked',c.ok?'good':'bad')}</div>`).join('')}</div></div><div><h3>Network safety</h3><div class="fact-list"><div><div><b>Management address</b></div><span>${esc(n.primary_ipv4||'Not detected')}</span></div><div><div><b>Default route</b></div><span>${esc(n.default_route||'Not detected')}</span></div><div><div><b>DNS</b></div><span>${esc(list(n.dns_servers).join(', ')||'None')}</span></div></div></div></div><h3>Recent changes</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Operation</th><th>Source</th><th>Result</th></tr></thead><tbody>${events.map(e=>`<tr><td>${esc(fmtDate(e.timestamp))}</td><td><code>${esc(e.method)} ${esc(e.path)}</code></td><td>${esc(e.remote_ip||'local')}</td><td>${statusPill(e.ok?'Succeeded':'Failed',e.ok?'good':'bad')}</td></tr>`).join('')||'<tr><td colspan="4">No recent changes.</td></tr>'}</tbody></table></div></div></section></div>
  </section>`;
}
async function refreshChromeStatus(){
  try {
    const n=await api('/api/notifications',{busy:false,fresh:true,stale:false});
    const ne=document.querySelector('[data-notification-count]');
    if(ne){
      const unread=visibleUnreadNotices(n).length;
      ne.textContent=String(unread);
      ne.classList.toggle('hidden',unread===0);
    }
  }catch(_){}
}
let runtimeSearchItems=[];
let runtimeSearchHydrated=false;
function globalSearchItems(){
  const items=[];
  for(const appDef of applications){items.push({href:appDef.href,label:appDef.label,meta:'Application',icon:appDef.icon})}
  for(const [appId,tabs] of Object.entries(applicationTabs)){const appDef=applications.find(x=>x.id===appId);if(!appDef)continue;for(const [href,label] of tabs){items.push({href,label,meta:appDef?.label||'Zero1Local',icon:appDef?.icon||'about'})}}
  return [...items,...runtimeSearchItems];
}
async function hydrateGlobalSearchCatalog(){
  if(runtimeSearchHydrated)return;
  runtimeSearchHydrated=true;
  try{
    const [shares,users,storage,groups,catalog,backups,offsite,replication,services,admins,network]=await Promise.all([
      api('/api/shares',{busy:false}).catch(()=>({active:[]})),api('/api/users',{busy:false}).catch(()=>({users:[]})),api('/api/storage',{busy:false}).catch(()=>({block_devices:[]})),api('/api/groups',{busy:false}).catch(()=>({groups:[]})),api('/api/apps/catalog',{busy:false}).catch(()=>({apps:[]})),api('/api/backups',{busy:false}).catch(()=>({jobs:[]})),Promise.resolve({jobs:[],targets:[]}),api('/api/replication',{busy:false}).catch(()=>({jobs:[],peers:[]})),api('/api/services',{busy:false}).catch(()=>({services:[]})),api('/api/security/admins',{busy:false}).catch(()=>({admins:[]})),api('/api/network',{busy:false}).catch(()=>({}))
    ]);
    const discovered=[];
    for(const sh of mergedSMBShareInventory(shares).shares) discovered.push({href:'/shares',label:sh.name,meta:'Shared folder',icon:'shares',keywords:`${sh.path||''} ${windowsShare(sh.name)}`});
    for(const u of list(users.users)) discovered.push({href:'/users',label:u.gecos||u.username,meta:`User · ${u.username}`,icon:'users',keywords:`${u.username} ${list(u.groups).join(' ')}`});
    for(const g of list(groups.groups)) discovered.push({href:'/groups',label:g.name,meta:'Group',icon:'groups',keywords:list(g.members).join(' ')});
    const walk=(nodes)=>{for(const d of list(nodes)){if(d.type==='disk'||String(d.name||'').match(/^(sd|nvme|mmcblk)/))discovered.push({href:'/storage/disks',label:d.model||d.name||'Disk',meta:`Physical disk · /dev/${d.name||''}`,icon:'disks',keywords:`${d.serial||''} ${d.name||''}`});walk(d.children)}}; walk(storage.block_devices);
    for(const x of list(catalog.apps)) discovered.push({href:'/apps/catalog',label:x.name,meta:`App · ${x.installed?'installed':'available'}`,icon:'docker',keywords:`${x.id||''} ${x.category||''} ${x.image||''}`});
    for(const x of list(backups.jobs)) discovered.push({href:'/backups',label:x.name||x.id,meta:'Backup job',icon:'backups',keywords:`${x.share||''} ${x.destination||''}`});
    for(const x of list(replication.peers)) discovered.push({href:'/replication',label:x.name||x.id,meta:'NAS replication peer',icon:'replication',keywords:`${x.host||''} ${x.address||''}`});
    for(const x of list(replication.jobs)) discovered.push({href:'/replication',label:x.name||x.id,meta:'NAS → NAS job',icon:'replication',keywords:`${x.share||''} ${x.peer_id||''}`});
    for(const x of list(services.services)) discovered.push({href:'/services',label:friendlyServiceName(x),meta:`Service · ${x.active||'unknown'}`,icon:'settings',keywords:`${x.unit||''} ${x.description||''} ${x.category||''}`});
    for(const x of list(admins.admins)) discovered.push({href:'/security/admins',label:x.username,meta:`Administrator · ${x.role||''}`,icon:'security',keywords:list(x.allowed_cidrs).join(' ')});
    const primary=network.primary||{}; if(primary.address_cidr||primary.address)discovered.push({href:'/network',label:primary.address_cidr||primary.address,meta:'Primary network address',icon:'network',keywords:`${primary.gateway||''} ${primary.interface||''}`});
    runtimeSearchItems=discovered;
  }catch(_){runtimeSearchItems=[];runtimeSearchHydrated=false}
}

function renderGlobalSearch(value){
  const box=document.getElementById('globalSearchResults');if(!box)return;
  const q=String(value||'').trim().toLowerCase();if(!q){box.classList.add('hidden');box.innerHTML='';return}
  const seen=new Set();
  const results=globalSearchItems().filter(x=>{const key=`${x.href}|${x.label}`;if(seen.has(key))return false;const hay=(x.label+' '+x.meta+' '+x.href+' '+(x.keywords||'')).toLowerCase();if(!hay.includes(q))return false;seen.add(key);return true}).slice(0,12);
  box.innerHTML=results.length?`<div class="search-result-group">${results.map(x=>`<a href="${attr(x.href)}"><span class="search-result-icon">${icon(x.icon,18)}</span><div><b>${esc(x.label)}</b><small>${esc(x.meta)}</small></div><span class="search-result-arrow">${icon('chevron',15)}</span></a>`).join('')}</div>`:'<div class="global-search-empty"><b>No results</b><span>Try a page name, user, share, disk model, or setting.</span></div>';
  box.classList.remove('hidden');
}

function makeTablesSortable(root=document){
  root.querySelectorAll('table.data-table').forEach(table=>{
    if(table.dataset.sortableReady)return; table.dataset.sortableReady='1';
    table.querySelectorAll('thead th').forEach((th,index)=>{
      const label=th.textContent.trim(); if(!label||label==='Actions'||label==='')return;
      th.classList.add('sortable-column'); th.tabIndex=0; th.setAttribute('role','button'); th.setAttribute('aria-label',`Sort by ${label}`);
      const sort=()=>{const body=table.tBodies[0];if(!body)return;const rows=[...body.rows];const next=th.dataset.sortDirection==='asc'?'desc':'asc';table.querySelectorAll('th').forEach(x=>{delete x.dataset.sortDirection;x.classList.remove('sort-asc','sort-desc')});th.dataset.sortDirection=next;th.classList.add(next==='asc'?'sort-asc':'sort-desc');rows.sort((a,b)=>{const av=a.cells[index]?.innerText.trim()||'',bv=b.cells[index]?.innerText.trim()||'';const an=parseFloat(av.replace(/[^0-9.-]/g,'')),bn=parseFloat(bv.replace(/[^0-9.-]/g,''));const cmp=Number.isFinite(an)&&Number.isFinite(bn)?an-bn:av.localeCompare(bv,undefined,{numeric:true,sensitivity:'base'});return next==='asc'?cmp:-cmp});rows.forEach(r=>body.appendChild(r));};
      th.addEventListener('click',sort);th.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();sort()}});
    });
  });
}

async function snapshotsPage(){
  const d=await api('/api/snapshots'); window.__zero1Snapshots=d; const snaps=list(d.snapshots), policies=list(d.policies), shares=list(d.shares);
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Storage & Files','Snapshots','Point-in-time protection using the native capabilities of the filesystem actually backing each share.','<button class="btn btn-primary" data-action="snapshot-create">+ Create snapshot</button>')}
  <div class="notice notice-info"><b>Capability-aware by design</b><span>Zero1Local enables native snapshots only when the live share is a safe Btrfs subvolume or ZFS dataset. Existing ext4/XFS data is never reformatted or silently converted.</span></div>
  <section class="content-panel">${sectionTitle('Shared-folder capability','Native snapshot support is evaluated independently for every active SMB share.')}<div class="fact-list">${shares.map(x=>`<div><div><b>${esc(x.name)}</b><small>${esc(x.capability?.filesystem||'Unknown filesystem')} · ${esc(friendlyStoragePath(x.path))}</small></div>${statusPill(x.capability?.supported?`${x.capability.backend} snapshots`:'Backup/replication recommended',x.capability?.supported?'good':'neutral')}</div>`).join('')||'<div><span>No active shares</span></div>'}</div></section>
  <section class="content-panel">${sectionTitle('Snapshot policies',policies.length?'Automatic point-in-time protection.':'No scheduled snapshot policies yet.','<button class="btn btn-small" data-action="snapshot-policy">Configure policy</button>')}<div class="fact-list">${policies.map(p=>`<div><div><b>${esc(p.share)}</b><small>${esc(p.schedule)} · retain ${Number(p.retain||0)} · last ${esc(fmtDate(p.last_run_at))}</small></div>${statusPill(p.enabled?'Enabled':'Disabled',p.enabled?'good':'neutral')}</div>`).join('')||'<div><span>Create a policy for a snapshot-capable share.</span></div>'}</div></section>
  <section class="content-panel">${sectionTitle('Available snapshots',`${snaps.length} point-in-time snapshot${snaps.length===1?'':'s'}.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Share</th><th>Created</th><th>Backend</th><th>Reason</th><th></th></tr></thead><tbody>${snaps.map(x=>`<tr><td><b>${esc(x.share)}</b></td><td>${esc(fmtDate(x.created_at))}</td><td>${statusPill(x.backend,'good')}</td><td>${esc(x.reason||'manual')}</td><td class="row-actions"><button class="btn btn-small" data-action="snapshot-restore" data-snapshot="${attr(x.id)}" data-share="${attr(x.share)}">Restore</button><button class="btn btn-small danger-soft" data-action="snapshot-delete" data-snapshot="${attr(x.id)}">Delete</button></td></tr>`).join('')||'<tr><td colspan="5">No snapshots yet.</td></tr>'}</tbody></table></div></section></section>`;
}
function snapshotCreateModal(){const shares=list(window.__zero1Snapshots?.shares).filter(x=>x.capability?.supported);openModal('Create snapshot','Create a native point-in-time snapshot without moving or converting data.',`<div class="form-stack"><label>Shared folder</label><select id="snapshotShare">${shares.map(x=>`<option value="${attr(x.name)}">${esc(x.name)} · ${esc(x.capability.backend)}</option>`).join('')}</select><label>Description</label><input id="snapshotReason" value="manual" maxlength="80"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="snapshot-create-save">Create snapshot</button>`)}
function snapshotPolicyModal(){const shares=list(window.__zero1Snapshots?.shares).filter(x=>x.capability?.supported);openModal('Snapshot policy','Keep automatic point-in-time snapshots for a supported shared folder.',`<div class="form-stack"><label>Shared folder</label><select id="snapshotPolicyShare">${shares.map(x=>`<option value="${attr(x.name)}">${esc(x.name)}</option>`).join('')}</select><div class="field-grid"><div><label>Schedule</label><select id="snapshotPolicySchedule"><option value="hourly">Hourly</option><option value="daily">Daily</option><option value="weekly">Weekly</option></select></div><div><label>Run at</label><input id="snapshotPolicyTime" type="time" value="02:00"></div></div><label>Weekly days</label><input id="snapshotPolicyDays" value="Sun"><label>Retain snapshots</label><input id="snapshotPolicyRetain" type="number" min="1" max="1000" value="24"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="snapshot-policy-save">Save policy</button>`)}

async function replicationPage(){
  const [d,files]=await Promise.all([api('/api/replication'),api('/api/files')]); window.__zero1Replication=d; window.__zero1ReplicationShares=list(files.shares);
  const peers=list(d.peers), jobs=list(d.jobs);
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Sync & Backup','NAS → NAS','Resumable share replication to another Zero1Local or SSH-accessible storage host. Use a private LAN or independently administered trusted VPN. Zero1Local does not create public tunnels.','<div class="row-actions"><button class="btn" data-action="replication-peer-create">Pair destination</button><button class="btn btn-primary" data-action="replication-job-create">+ Replication job</button></div>')}
    <section class="content-panel admin-section">${sectionTitle('NAS destinations',`${peers.length} paired destination${peers.length===1?'':'s'}.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Name</th><th>Host</th><th>Remote root</th><th>Connectivity</th><th></th></tr></thead><tbody>${peers.map(p=>`<tr><td><b>${esc(p.name)}</b></td><td><code>${esc(p.user)}@${esc(p.host)}:${esc(p.port)}</code></td><td><code>${esc(p.remote_root)}</code></td><td>${p.last_test?`${statusPill(p.last_ok?'Reachable':'Failed',p.last_ok?'good':'bad')}<small>${esc(fmtDate(p.last_test))}</small>`:statusPill('Not tested','neutral')}</td><td class="row-actions"><button class="btn btn-small" data-action="replication-peer-test" data-peer="${attr(p.id)}">Test</button><details class="row-action-menu"><summary aria-label="Replication destination actions">${icon('more',18)}</summary><div><button class="danger-text" data-action="replication-peer-delete" data-peer="${attr(p.id)}" data-name="${attr(p.name)}">Remove</button></div></details></td></tr>`).join('')||`<tr><td colspan="5">${emptyState('No replication destinations','Pair another Zero1Local or SSH-accessible host before creating a replication job.','<button class="btn btn-primary" data-action="replication-peer-create">Pair destination</button>')}</td></tr>`}</tbody></table></div></section>
    <section class="content-panel admin-section">${sectionTitle('NAS → NAS jobs',`${jobs.length} configured job${jobs.length===1?'':'s'}.`)}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>Job</th><th>Source</th><th>Schedule</th><th>Bandwidth</th><th>Last run</th><th>Status</th><th></th></tr></thead><tbody>${jobs.map(j=>`<tr><td><b>${esc(j.name)}</b></td><td>${esc(j.share)}</td><td>${j.schedule==='manual'?'On demand':`${esc(j.schedule)} · ${esc(j.time_of_day||'—')}`}</td><td>${j.bandwidth_kb?`${Number(j.bandwidth_kb).toLocaleString()} KB/s`:'Unlimited'}</td><td>${esc(fmtDate(j.last_run_at))}</td><td>${statusPill(j.last_status||'Not run',j.last_status==='completed'?'good':j.last_status==='failed'?'bad':'neutral')}${j.last_error?`<small class="error-detail">${esc(j.last_error)}</small>`:''}</td><td class="row-actions"><button class="btn btn-small btn-primary" data-action="replication-run" data-job="${attr(j.id)}">Run</button><details class="row-action-menu"><summary aria-label="Replication job actions">${icon('more',18)}</summary><div><button class="danger-text" data-action="replication-job-delete" data-job="${attr(j.id)}" data-name="${attr(j.name)}">Remove</button></div></details></td></tr>`).join('')||`<tr><td colspan="7">${emptyState('No replication jobs','Choose a shared folder and paired destination to create a replication job.','<button class="btn btn-primary" data-action="replication-job-create">Create replication job</button>')}</td></tr>`}</tbody></table></div></section>
    <details class="advanced"><summary>Replication SSH public key</summary><div class="advanced-body"><p>Authorize this dedicated key on the destination account.</p><pre class="resolver-box">${esc(d.public_key||'Key generation unavailable')}</pre></div></details>
  </section>`;
}
function replicationPeerModal(){openModal('Pair NAS destination','Zero1Local uses its dedicated replication SSH key for this connection.',`<div class="form-stack"><label>Name</label><input id="replPeerName" placeholder="Backup NAS"><label>Host/IP</label><input id="replPeerHost" placeholder="192.168.0.148"><div class="field-grid"><div><label>SSH port</label><input id="replPeerPort" type="number" value="22"></div><div><label>SSH user</label><input id="replPeerUser" value="root"></div></div><label>Remote root</label><input id="replPeerRoot" value="/disk0/Zero1Replication"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="replication-peer-save">Pair target</button>`)}
function replicationJobModal(){
  const peers=list(window.__zero1Replication?.peers), shares=list(window.__zero1ReplicationShares);
  openModal('Create NAS → NAS job','Replicate one live shared folder to a paired NAS/SSH destination.',`<div class="form-stack"><label>Name</label><input id="replJobName" placeholder="Documents replica"><label>Shared folder</label><select id="replJobShare">${shares.map(x=>`<option value="${attr(x.name)}">${esc(x.name)}</option>`).join('')}</select><label>Destination</label><select id="replJobPeer">${peers.map(x=>`<option value="${attr(x.id)}">${esc(x.name)}</option>`).join('')}</select><div class="field-grid"><div><label>Schedule</label><select id="replJobSchedule"><option value="manual">On demand</option><option value="daily">Daily</option><option value="weekly">Weekly · Sunday</option></select></div><div><label>Run at</label><input id="replJobTime" type="time" value="03:00"></div></div><label>Bandwidth limit KB/s <small>(0 = unlimited)</small></label><input id="replJobBandwidth" type="number" min="0" value="0"><label class="checkline"><input id="replJobEnabled" type="checkbox" checked><span><b>Enable scheduled runs</b><small>Manual runs remain available at any time.</small></span></label></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="replication-job-save">Create job</button>`)
}

async function analyticsPage(){
  const d=await api('/api/storage/analytics'),pctUsed=d.total?Math.round(d.used/d.total*100):0,dup=list(d.duplicates),types=Object.entries(d.file_types||{}).sort((a,b)=>Number(b[1])-Number(a[1]));
  const counts=d.file_type_counts||{},typeTotal=types.reduce((a,[,v])=>a+Number(v||0),0),palette=['#2774d8','#5a8dee','#78b7ff','#6aa89f','#a58bd4','#d49a6a','#8c9aa8'];
  let angle=0;const stops=types.slice(0,6).map(([k,v],i)=>{const n=typeTotal?Number(v)/typeTotal*100:0,a=angle;angle+=n;return `${palette[i%palette.length]} ${a}% ${angle}%`});if(angle<100)stops.push(`#dfe5ec ${angle}% 100%`);
  const hist=list(d.history).slice(-30),maxUsed=Math.max(1,...hist.map(x=>Number(x.used||0))),points=hist.map((x,i)=>`${hist.length<2?0:(i/(hist.length-1))*100},${100-(Number(x.used||0)/maxUsed)*92}`).join(' ');
  document.getElementById('content').innerHTML=`<section class="screen analytics-screen">${heading('Storage','Analytics','See capacity growth, file makeup, share usage and large or duplicate files in one place.')}<div class="metric-band"><div><span>Used</span><b>${fmtBytes(d.used)}</b><small>${pctUsed}% of ${fmtBytes(d.total)}</small></div><div><span>File types</span><b>${Number(d.file_type_count??types.length)}</b><small>${Number(d.scanned_files||Object.values(counts).reduce((a,v)=>a+Number(v||0),0)).toLocaleString()} files scanned</small></div><div><span>Duplicate groups</span><b>${dup.length}</b><small>Verified matches</small></div><div><span>90% forecast</span><b>${d.forecast_days_to_90>0?`${Math.round(d.forecast_days_to_90)} days`:'Learning'}</b><small>Based on usage history</small></div></div><div class="analytics-grid"><section class="content-panel">${sectionTitle('File types','Storage consumed by the most common file extensions.')}<div class="filetype-visual"><div class="donut-chart" style="background:conic-gradient(${stops.join(',')})"><span>${types.length}<small>types</small></span></div><div class="chart-legend">${types.slice(0,8).map(([k,v],i)=>`<div><i style="background:${palette[i%palette.length]}"></i><span>${esc(k||'Other')}</span><b>${Number(counts[k]||0).toLocaleString()} · ${fmtBytes(v)}</b></div>`).join('')||'<p>No file type data yet.</p>'}</div></div></section><section class="content-panel">${sectionTitle('Capacity trend','Recent Main Storage usage history.')}<div class="line-chart"><svg viewBox="0 0 100 100" preserveAspectRatio="none"><polyline points="${points}" fill="none" vector-effect="non-scaling-stroke"/></svg></div><div class="chart-axis"><span>${hist.length?esc(fmtDate(hist[0].at||hist[0].At)):'—'}</span><span>${hist.length?esc(fmtDate(hist[hist.length-1].at||hist[hist.length-1].At)):'—'}</span></div></section></div><section class="content-panel">${sectionTitle('Usage by shared folder','Relative storage use across shared folders.')}<div class="share-bars">${list(d.shares).map(x=>{const n=Number(x.size||0),w=d.used?Math.max(1,Math.round(n/d.used*100)):0;return `<div><div><b>${esc(x.name)}</b><span>${Number(x.items||0).toLocaleString()} files · ${fmtBytes(n)}</span></div><div class="bar-track"><i style="width:${w}%"></i></div></div>`}).join('')||'<p>No shared-folder usage data yet.</p>'}</div></section><div class="analytics-grid"><section class="content-panel">${sectionTitle('Largest files','Largest regular files found in the bounded scan.')}<div class="table-frame borderless"><table class="data-table"><thead><tr><th>File</th><th>Size</th></tr></thead><tbody>${list(d.largest_files).map(x=>`<tr><td><b>${esc(x.name)}</b><small>${esc(friendlyStoragePath(x.path))}</small></td><td>${fmtBytes(x.size)}</td></tr>`).join('')||'<tr><td colspan="2">No file data found.</td></tr>'}</tbody></table></div></section><section class="content-panel">${sectionTitle('Duplicate candidates','Verified same-content files from the bounded scan.')}<div class="fact-list">${dup.map(g=>`<div><div><b>${list(g.paths).length} identical files · ${fmtBytes(g.size)}</b><small>${list(g.paths).map(friendlyStoragePath).map(esc).join(' · ')}</small></div></div>`).join('')||'<div><span>No verified duplicate groups found.</span></div>'}</div></section></div><details class="advanced feature-checks"><summary>Scan details</summary><div class="advanced-body"><p>Analytics uses bounded scanning and bounded duplicate hashing so management stays responsive on large storage sets.</p></div></details></section>`;
}
async function replacementPage(){
  history.replaceState({},'', '/storage/raid');
  return raidPage();
}
async function replacementAddModal(){
  const state=window.__zero1Replacement||{};
  const storage=state.storage||await api('/api/storage');
  const raw=String(state.detail||'');
  const members=new Set([...raw.matchAll(/\/dev\/(sd[a-z]+)\b/g)].map(m=>m[1]));
  const disks=list(storage?.block_devices?.blockdevices).filter(x=>x.type==='disk'&&/^sd[a-z]+$/.test(String(x.name||''))&&!members.has(String(x.name||'')));
  if(!disks.length){flash('No unused whole-disk replacement candidate is currently detected.','warn');return;}
  openModal('Add replacement RAID drive','The selected disk will be added to the existing RAID1 Main Storage array. Zero1Local performs the same server-side safety checks used by Fresh Setup before mdadm can modify it.',`<div class="form-stack"><label>Replacement drive</label><select id="replacementDevice">${disks.map(x=>`<option value="${attr(x.path||'/dev/'+x.name)}">${esc(x.model||x.name)} · ${fmtBytes(x.size)} · ${esc(x.path||'/dev/'+x.name)}</option>`).join('')}</select><div class="notice notice-warn"><b>This operation writes to the selected replacement disk</b><span>Main Storage and the surviving RAID member are not recreated. The replacement disk is synchronized from the existing array.</span></div><label>Type exactly: ADD REPLACEMENT DRIVE</label><input id="replacementAck" autocomplete="off"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="replacement-add-save">Add replacement drive</button>`);
}

async function desktopIntegrationPage(){
  const d=await api('/api/desktop-integration'); window.__zero1Desktop=d;
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Shares & Access','Windows & Mac','Desktop discovery and per-share compatibility based on capabilities actually available on this appliance.')}
    <div class="integration-strip"><div><b>Windows discovery</b><small>WS-Discovery built into Zero1Local</small>${statusPill(d.ws_discovery?'Ready':'Unavailable',d.ws_discovery?'good':'bad')}</div><div><b>Bonjour / mDNS</b><small>Finder and local service discovery</small>${statusPill(d.bonjour?'Ready':'Optional package missing',d.bonjour?'good':'neutral')}</div></div>
    <section class="admin-section"><div class="section-heading"><div><h2>Shared-folder integration</h2><p>Time Machine and Previous Versions are enabled only when Samba and the backing filesystem support them.</p></div></div><div class="table-frame"><table class="data-table"><thead><tr><th>Shared folder</th><th>Filesystem</th><th>Time Machine</th><th>Previous Versions</th><th>Configure</th></tr></thead><tbody>${list(d.shares).map(x=>`<tr><td><b>${esc(x.name)}</b><small>${esc(windowsShare(x.name))}</small></td><td>${esc(x.snapshot_capability?.filesystem||'Unknown')}</td><td>${statusPill(x.policy?.time_machine?'Enabled':'Off',x.policy?.time_machine?'good':'neutral')}</td><td>${statusPill(x.policy?.previous_versions?'Enabled':'Off',x.policy?.previous_versions?'good':'neutral')}</td><td><button class="btn btn-small" data-action="desktop-share-edit" data-share="${attr(x.name)}">Configure</button></td></tr>`).join('')||'<tr><td colspan="5">No shared folders available.</td></tr>'}</tbody></table></div></section>
  </section>`;
}
function desktopShareModal(name){const x=list(window.__zero1Desktop?.shares).find(y=>y.name===name)||{};const p=x.policy||{};openModal(`${name} desktop integration`,'Configure Windows/macOS behavior for this shared folder.',`<div class="form-stack"><label class="checkline"><input id="desktopTM" type="checkbox" ${p.time_machine?'checked':''} ${window.__zero1Desktop?.fruit_available?'':'disabled'}><span><b>Time Machine destination</b><small>Uses Samba fruit compatibility and advertises this share for Mac backups.</small></span></label><label>Time Machine quota (GB)</label><input id="desktopTMGB" type="number" min="0" value="${attr(p.time_machine_gb||0)}"><label class="checkline"><input id="desktopPV" type="checkbox" ${p.previous_versions?'checked':''} ${window.__zero1Desktop?.shadow_copy2_available&&x.snapshot_capability?.supported?'':'disabled'}><span><b>Windows Previous Versions</b><small>Requires native snapshots plus Samba shadow_copy2.</small></span></label></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="desktop-share-save" data-share="${attr(name)}">Save</button>`)}

async function userProfilesPage(){
  const d=await api('/api/users/profiles');
  window.__zero1UserProfiles=d;
  const roleLabel={user:'User','storage-admin':'Storage administrator','app-admin':'Application administrator',auditor:'Read-only auditor'};
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Shares & Access','User Policies','Account lifecycle, administrative role, personal storage, SSH access and quota policy backed by the local Linux identity database.')}
    <div class="notice ${d.quota_supported?'notice-info':'notice-warn'}"><b>${d.quota_supported?'Main Storage quotas available':'Quotas not active on Main Storage'}</b><span>${esc(d.quota_detail||'')}</span></div>
    <section class="content-panel">${sectionTitle('Account policies',`${list(d.users).length} NAS account${list(d.users).length===1?'':'s'}.`)}
      <div class="table-frame borderless"><table class="data-table"><thead><tr><th>User</th><th>Role</th><th>Status</th><th>Personal folder</th><th>SSH</th><th>Expiration</th><th>Quota</th><th></th></tr></thead><tbody>
      ${list(d.users).map(u=>`<tr><td><b>${esc(u.display_name||u.username)}</b><small>${esc(u.username)}</small></td><td>${esc(roleLabel[u.role]||'User')}</td><td>${statusPill(u.disabled?'Disabled':'Enabled',u.disabled?'warn':'good')}</td><td>${u.home_enabled?statusPill('Enabled','good'):statusPill('Off','neutral')}</td><td>${u.ssh_access?'Allowed':'Blocked'}</td><td>${esc(u.expires||'Never')}</td><td>${u.quota_gb?`${u.quota_gb} GB`:'Unlimited'}</td><td><button class="btn btn-small" data-action="user-profile-edit" data-user="${attr(u.username)}">Policy</button></td></tr>`).join('')}
      </tbody></table></div>
    </section>
    <div class="context-note">${icon('security',16)} <span>These Linux/SMB role labels describe delegation policy for the account. Separate Zero1Local web-management credentials are created under Control Panel → Administrators; assigning a file-service role here never silently creates a web login or rewrites existing shared-folder ACLs. Personal folders are hidden SMB shares under <code>/disk0/homes</code> and remain owner data if later disabled.</span></div>
  </section>`;
}
function userProfileModal(name){
  const u=list(window.__zero1UserProfiles?.users).find(x=>x.username===name)||{};
  openModal(`${name} account policy`,'Changes are checkpointed across passwd, shadow, group and gshadow before Zero1Local modifies the account.',`<div class="form-stack">
    <label>Display name</label><input id="profileDisplay" value="${attr(u.display_name||'')}">
    <label>Zero1Local role</label><select id="profileRole"><option value="user" ${u.role==='user'||!u.role?'selected':''}>User</option><option value="storage-admin" ${u.role==='storage-admin'?'selected':''}>Storage administrator</option><option value="app-admin" ${u.role==='app-admin'?'selected':''}>Application administrator</option><option value="auditor" ${u.role==='auditor'?'selected':''}>Read-only auditor</option></select>
    <label class="checkline"><input id="profileHome" type="checkbox" ${u.home_enabled?'checked':''}><span><b>Personal home folder</b><small>Create a hidden per-user SMB share at /disk0/homes/${esc(name)}. Disabling the policy removes only the share definition and preserves files.</small></span></label>
    <label class="checkline"><input id="profileDisabled" type="checkbox" ${u.disabled?'checked':''}><span><b>Disable account</b><small>Lock the account without deleting files or memberships.</small></span></label>
    <label class="checkline"><input id="profileSSH" type="checkbox" ${u.ssh_access?'checked':''}><span><b>Allow local SSH shell</b><small>Off uses /usr/sbin/nologin.</small></span></label>
    <label>Account expires</label><input id="profileExpires" type="date" value="${attr(u.expires||'')}">
    <label>Storage quota (GB)</label><input id="profileQuota" type="number" min="0" value="${attr(u.quota_gb||0)}" ${window.__zero1UserProfiles?.quota_supported?'':'disabled'}>
    <label class="checkline"><input id="profileForcePw" type="checkbox"><span><b>Require password change at next login</b></span></label>
  </div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="user-profile-save" data-user="${attr(name)}">Save policy</button>`)
}

async function hardwareProfilesPage(){const d=await api('/api/hardware/profiles');window.__zero1HardwareProfiles=d;document.getElementById('content').innerHTML=`<section class="screen">${heading('Appliance / Hardware','Hardware Profiles','Keep board-specific controls isolated from the generic NAS management layer.')}<section class="content-panel">${sectionTitle('Available profiles','Only detected hardware-specific profiles can be selected.')}<div class="entity-list">${list(d.profiles).map(p=>`<article class="entity-card"><div class="entity-primary"><div class="avatar">HW</div><div><b>${esc(p.name)}</b><small>${esc(p.description)}</small></div></div><div class="entity-detail"><span>Detection</span>${statusPill(p.detected?'Detected':'Not detected',p.detected?'good':'neutral')}</div><div class="entity-detail"><span>Selected</span>${d.selected===p.id?'Yes':'No'}</div><div class="entity-actions"><button class="btn" data-action="hardware-profile-select" data-profile="${attr(p.id)}" ${!p.detected||d.selected===p.id?'disabled':''}>Use profile</button></div></article>`).join('')}</div></section></section>`}

async function advancedNetworkPage(){
  const [d,n2,netHistory]=await Promise.all([api('/api/network/advanced'),api('/api/network/v025'),api('/api/network/history').catch(()=>({interfaces:{}}))]);
  window.__zero1AdvancedNetwork=d; window.__zero1NetworkV025=n2;
  const pending=d.pending?.id||n2.pending?.id;
  const masters=list(n2.profiles).filter(x=>String(x.name||'').startsWith('zero1-bond-')||String(x.name||'').startsWith('zero1-bridge-'));
  document.getElementById('content').innerHTML=`<section class="screen">
    ${heading('Control Panel / Connectivity','Advanced Network','Bonding, bridges, IPv6, MTU and routing with rollback safeguards for management-affecting changes.','<div class="row-actions"><button class="btn" data-action="network-profile-create">New bond / bridge</button><button class="btn btn-primary" data-action="advanced-network-edit">MTU / routes</button></div>')}
    ${pending?`<div class="notice notice-warn"><b>Network change awaiting confirmation</b><span>Confirm only after verifying this NAS remains reachable. If the timer expires, Zero1Local restores the previous network state automatically.</span><div class="row-actions"><button class="btn btn-primary" data-action="network-v025-commit">Keep changes</button><button class="btn" data-action="network-v025-rollback">Roll back now</button></div></div>`:''}
    <section class="content-panel">${sectionTitle('Physical interfaces','Link state and the current management attachment.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Interface</th><th>Link</th><th>Speed</th><th>Recent traffic</th><th>MAC</th><th>Connection</th><th>IPv6</th></tr></thead><tbody>${list(n2.physical).map(x=>`<tr><td><b>${esc(x.name)}</b>${x.primary?'<small>Current default route</small>':''}</td><td>${statusPill(x.state||'unknown',x.state==='up'?'good':'neutral')}</td><td>${x.speed_mbps&&x.speed_mbps!=='-1'?`${esc(x.speed_mbps)} Mbps`:'—'}</td><td>${(()=>{const t=interfaceTrafficDelta(netHistory.interfaces?.[x.name]);return t?`↓ ${fmtBytes(t.rx)} · ↑ ${fmtBytes(t.tx)}${t.drops?` · ${t.drops} drops`:''}`:'Collecting history'})()}</td><td><code>${esc(x.mac||'—')}</code></td><td>${esc(x.active_connection||'—')}</td><td><button class="btn btn-small" data-action="network-ipv6-edit" data-interface="${attr(x.name)}">Configure</button></td></tr>`).join('')||'<tr><td colspan="7">No physical network interfaces detected.</td></tr>'}</tbody></table></div></section>
    <section class="content-panel">${sectionTitle('Bonds & bridges','Zero1Local-managed NetworkManager profiles. Profiles can be staged inactive or activated through a guarded management transaction.','<button class="btn btn-primary" data-action="network-profile-create">Create profile</button>')}<div class="table-frame"><table class="data-table"><thead><tr><th>Profile</th><th>Type</th><th>Interface</th><th>IPv4</th><th>IPv6</th><th>Status</th><th></th></tr></thead><tbody>${masters.map(x=>`<tr><td><b>${esc(x.name)}</b><small>${x.bond_options?esc(x.bond_options):''}</small></td><td>${esc(x.type||'—')}</td><td><code>${esc(x.interface||'—')}</code></td><td>${esc(x.ipv4_addresses||x.ipv4_method||'—')}</td><td>${esc(x.ipv6_addresses||x.ipv6_method||'—')}</td><td>${statusPill(x.active?'Active':'Inactive',x.active?'good':'neutral')}</td><td class="row-actions"><button class="btn btn-small" data-action="network-profile-edit" data-name="${attr(x.name)}">Edit</button><details class="row-action-menu"><summary aria-label="Network profile actions">${icon('more',18)}</summary><div><button class="danger-text" data-action="network-profile-delete" data-name="${attr(x.name)}">Delete profile</button></div></details></td></tr>`).join('')||'<tr><td colspan="7">No Zero1Local-managed bonds or bridges.</td></tr>'}</tbody></table></div></section>
    <section class="content-panel">${sectionTitle('MTU & static routes','Low-level changes retain the existing 45-second safety transaction.')}<div class="fact-list"><div><div><b>${esc(d.primary||'Unknown')}</b><small>Primary interface</small></div><span>MTU ${esc(d.mtu||'—')}</span></div><div><div><b>IPv6</b><small>Kernel capability</small></div>${statusPill(d.ipv6?'Available':'Unavailable',d.ipv6?'good':'neutral')}</div><div><div><b>Bonding</b><small>NetworkManager / kernel capability</small></div>${statusPill(n2.available?'Managed':'Unavailable',n2.available?'good':'neutral')}</div></div></section>
    <details class="advanced"><summary>Routing table</summary><div class="advanced-body"><pre class="resolver-box">${esc(d.routes||'')}</pre></div></details>
  </section>`;
}
function advancedNetworkModal(){const d=window.__zero1AdvancedNetwork||{};openModal('Advanced network change','The change is applied temporarily. You must confirm it within 45 seconds or Zero1Local restores the previous MTU and routes.',`<div class="form-stack"><label>Interface</label><input id="advIface" value="${attr(d.primary||'')}"><label>MTU</label><input id="advMTU" type="number" min="576" max="9216" value="${attr(d.mtu||1500)}"><label>Static routes <small>(one ip route expression per line)</small></label><textarea id="advRoutes" rows="5" placeholder="10.20.0.0/16 via 192.168.0.1 dev ${attr(d.primary||'eth0')}"></textarea></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="advanced-network-apply">Apply for 45 seconds</button>`)}
function networkProfileModal(profile=null){
  const d=window.__zero1NetworkV025||{}; const physical=list(d.physical), editing=!!profile;
  if(!physical.length){flash('No physical interfaces are available for a bond or bridge.','warn');return;}
  const type=editing?(String(profile.type||'').includes('bond')?'bond':'bridge'):'bond';
  const bondMode=String(profile?.bond_options||'').match(/(?:^|,)mode=([^,]+)/)?.[1]||'active-backup';
  const memberProfiles=list(d.profiles).filter(x=>String(x.name||'').startsWith('zero1-member-')&&(x.master===profile?.interface||x.master===profile?.name||x.master===profile?.uuid));
  const members=new Set(memberProfiles.map(x=>x.interface));
  const ipv4Method=profile?.ipv4_method||'disabled', ipv6Method=profile?.ipv6_method||'auto';
  const defaultRoute=String(profile?.ipv4_never_default||'').toLowerCase()!=='yes';
  const title=editing?`Edit ${profile.name}`:'Create bond or bridge';
  const subtitle=editing?'Update addressing, MTU and bond policy through the same guarded management transaction. Physical member topology is intentionally changed by recreating the profile so rollback remains deterministic.':'Create a NetworkManager profile without changing the current wired network connection. Activating a profile that includes the current management NIC requires explicit acknowledgement and a 60-second confirmation.';
  openModal(title,subtitle,`<div class="form-stack">
    <label>Profile type</label><select id="npKind" ${editing?'disabled':''}><option value="bond" ${type==='bond'?'selected':''}>Bond</option><option value="bridge" ${type==='bridge'?'selected':''}>Bridge</option></select>
    <label>Label</label><input id="npLabel" value="${attr(editing?profile.name.replace(/^zero1-(bond|bridge)-/,''):'')}" placeholder="storage-lan" ${editing?'disabled':''}>
    <label>Interface name</label><input id="npIface" value="${attr(editing?profile.interface:'bond0')}" placeholder="bond0" ${editing?'disabled':''}>
    <label>Bond mode</label><select id="npBondMode" ${type==='bridge'?'disabled':''}><option value="active-backup" ${bondMode==='active-backup'?'selected':''}>Active / backup</option><option value="802.3ad" ${bondMode==='802.3ad'?'selected':''}>802.3ad / LACP</option><option value="balance-xor" ${bondMode==='balance-xor'?'selected':''}>Balance XOR</option><option value="balance-rr" ${bondMode==='balance-rr'?'selected':''}>Round robin</option><option value="balance-tlb" ${bondMode==='balance-tlb'?'selected':''}>Adaptive transmit load balancing</option><option value="balance-alb" ${bondMode==='balance-alb'?'selected':''}>Adaptive load balancing</option></select>
    <label>Physical members</label><div class="check-grid">${physical.map(x=>`<label class="checkline"><input class="npMember" type="checkbox" value="${attr(x.name)}" ${members.has(x.name)?'checked':''} ${editing?'disabled':''}><span><b>${esc(x.name)}</b><small>${x.primary?'Current management interface · ':''}${esc(x.state||'unknown')} · ${esc(x.mac||'')}</small></span></label>`).join('')}</div>${editing?'<small class="field-help">Member topology is fixed for in-place edits. Recreate the profile to add or remove physical members.</small>':''}
    <label>IPv4</label><select id="npIPv4Method"><option value="disabled" ${ipv4Method==='disabled'?'selected':''}>Disabled</option><option value="auto" ${ipv4Method==='auto'?'selected':''}>DHCP</option><option value="manual" ${ipv4Method==='manual'?'selected':''}>Manual</option></select>
    <label>IPv4 address / prefix</label><input id="npIPv4Address" value="${attr(profile?.ipv4_addresses||'')}" placeholder="192.168.50.10/24"><label>IPv4 gateway</label><input id="npIPv4Gateway" value="${attr(profile?.ipv4_gateway||'')}" placeholder="192.168.50.1"><label>DNS servers</label><input id="npDNS" value="${attr(String(profile?.ipv4_dns||'').replace(/;/g,','))}" placeholder="192.168.50.1, 1.1.1.1"><label class="checkline"><input id="npDefaultRoute" type="checkbox" ${defaultRoute?'checked':''}><span><b>Use as default IPv4 route</b><small>Required when this profile carries the management gateway. Leave off for storage-only or secondary networks.</small></span></label>
    <label>IPv6</label><select id="npIPv6Method"><option value="auto" ${ipv6Method==='auto'?'selected':''}>Automatic</option><option value="manual" ${ipv6Method==='manual'?'selected':''}>Manual</option><option value="disabled" ${ipv6Method==='disabled'?'selected':''}>Disabled</option><option value="ignore" ${ipv6Method==='ignore'?'selected':''}>Ignore</option></select><label>IPv6 address / prefix</label><input id="npIPv6Address" value="${attr(profile?.ipv6_addresses||'')}" placeholder="2001:db8::10/64"><label>IPv6 gateway</label><input id="npIPv6Gateway" value="${attr(profile?.ipv6_gateway||'')}" placeholder="2001:db8::1"><label>IPv6 DNS</label><input id="npIPv6DNS" value="${attr(String(profile?.ipv6_dns||'').replace(/;/g,','))}" placeholder="2001:4860:4860::8888">
    <label>MTU</label><input id="npMTU" type="number" min="576" max="9216" value="${attr(profile?.mtu||1500)}">
    <label class="checkline"><input id="npActivate" type="checkbox" ${editing&&profile.active?'checked':''}><span><b>${editing?'Reactivate after saving':'Activate immediately'}</b><small>${editing?'Active profile changes use a 60-second confirmation window.':'Leave off to stage the profile without changing live networking.'}</small></span></label>
    <label>Management-change acknowledgement</label><input id="npAck" autocomplete="off" placeholder="Required only when moving management"><small>Type <b>CHANGE MANAGEMENT NETWORK</b> if this activation can affect the current management path or default gateway.</small>
  </div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="network-profile-save" data-profile="${attr(profile?.name||'')}">${editing?'Save profile':'Create profile'}</button>`);
}

function networkIPv6Modal(iface){
  openModal(`${iface} IPv6`,'IPv6 changes are applied through a 45-second confirmation transaction. If the management path is lost, Zero1Local restores the previous NetworkManager settings.',`<div class="form-stack"><input type="hidden" id="ipv6Iface" value="${attr(iface)}"><label>IPv6 method</label><select id="ipv6Method"><option value="auto">Automatic / SLAAC</option><option value="manual">Manual</option><option value="disabled">Disabled</option><option value="ignore">Ignore</option></select><label>Address / prefix</label><input id="ipv6Address" placeholder="2001:db8::10/64"><label>Gateway</label><input id="ipv6Gateway" placeholder="2001:db8::1"><label>DNS servers</label><input id="ipv6DNS" placeholder="2001:4860:4860::8888"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="network-ipv6-save">Apply for 45 seconds</button>`)
}

function remoteMappingSummary(direct={},setup={}){
  const raw=String(direct.last_mapping_error||'').trim();
  const gateway=String(setup.route_gateway||'the default gateway');
  const protocol=(name)=>{
    const m=raw.match(new RegExp(`${name}:\\s*([^;]+)`,'i'));
    if(!m)return null;
    const detail=String(m[1]||'').trim();
    if(/connection refused/i.test(detail))return {name,state:'Refused',tone:'bad'};
    if(/no .*response|no ssdp|timed out|timeout/i.test(detail))return {name,state:'No response',tone:'warn'};
    return {name,state:'Unavailable',tone:'warn'};
  };
  return {
    raw,
    gateway,
    protocols:['UPnP','PCP','NAT-PMP'].map(protocol).filter(Boolean),
    message:`Zero1Local can reach ${gateway}, but that gateway did not provide an automatic inbound mapping. Set up the two forwards below, then save the public IP or DDNS hostname.`
  };
}

async function recoverySystemPage(){let key={};try{key=await api('/api/recovery/key')}catch(e){key={error:e.message}}document.getElementById('content').innerHTML=`<section class="screen">${heading('Support & Recovery','Independent Recovery Environment','A second Zero1Local service remains available even if the primary management UI needs repair.')}<div class="notice notice-info"><b>Recovery service: port 8089</b><span>Recovery is restricted to private-LAN clients and requires the appliance Recovery Key. It can restart the main UI, restore configuration, reset the web administrator password, roll back the installed release and perform safe power actions.</span></div><section class="content-panel">${sectionTitle('Recovery Key','Store this outside the NAS. It is intentionally separate from your normal web password.')} ${key.key?`<pre class="resolver-box">${esc(key.key)}</pre><div class="row-actions"><button class="btn" data-action="recovery-key-copy" data-key="${attr(key.key)}">Copy Recovery Key</button></div>`:`<div class="notice notice-warn"><b>Recovery Key unavailable</b><span>${esc(key.error||'The installer has not generated a Recovery Key yet.')}</span></div>`}</section><section class="content-panel">${sectionTitle('Open Recovery 2.0','This intentionally connects directly to the independent recovery service rather than the primary Zero1Local process.')}<a class="btn btn-primary" href="http://${attr(location.hostname)}:8089/" target="_blank" rel="noopener">Open Recovery Environment</a></section></section>`}

function selectedFileEntryFromRow(row){
  if(!row)return null;
  return {path:row.dataset.path||'',name:row.dataset.name||'',directory:row.dataset.directory==='1',symlink:row.dataset.symlink==='1',size:Number(row.dataset.size||0),shareRoot:row.dataset.shareRoot==='1',share:row.dataset.share||'',writable:row.dataset.writable==='1'};
}
function closeFileContextMenu(){document.getElementById('fileContextMenu')?.remove()}
function armFileContextMenuAutoClose(menu){if(!menu)return;menu.addEventListener('click',()=>queueMicrotask(closeFileContextMenu));}
function selectedEntries(){return [...selectedFileRows].filter(x=>x?.isConnected).map(selectedFileEntryFromRow).filter(Boolean)}
function updateFileSelectionUI(){
  document.querySelectorAll('[data-file-entry]').forEach(r=>r.classList.toggle('selected',selectedFileRows.has(r)));
  const count=selectedFileRows.size,bar=document.getElementById('fileBatchBar'),label=document.getElementById('fileBatchCount');
  if(label)label.textContent=`${count} selected`;bar?.classList.toggle('hidden',count<2);selectedFileRow=count?[...selectedFileRows][count-1]:null;
}
function clearFileSelection(){selectedFileRows.clear();selectedFileRow=null;fileSelectionAnchor=null;updateFileSelectionUI()}
function selectFileRow(row,{toggle=false,range=false}={}){
  const rows=[...document.querySelectorAll('[data-file-entry]')];
  if(!row){clearFileSelection();return}
  if(range&&fileSelectionAnchor&&rows.includes(fileSelectionAnchor)){
    const a=rows.indexOf(fileSelectionAnchor),b=rows.indexOf(row),lo=Math.min(a,b),hi=Math.max(a,b);if(!toggle)selectedFileRows.clear();for(let i=lo;i<=hi;i++)selectedFileRows.add(rows[i]);
  }else if(toggle){if(selectedFileRows.has(row))selectedFileRows.delete(row);else selectedFileRows.add(row);fileSelectionAnchor=row}
  else{selectedFileRows.clear();selectedFileRows.add(row);fileSelectionAnchor=row}
  selectedFileRow=row;updateFileSelectionUI();
}
function batchContextMenuHTML(){return `<button data-action="file-batch-download">Download selected as ZIP</button><span></span><button data-action="file-batch-copy">Copy</button><button data-action="file-batch-cut">Cut</button><button data-action="file-batch-copy-to">Copy to…</button><button data-action="file-batch-move-to">Move to…</button><button data-action="file-batch-archive">Compress selected</button><span></span><button class="danger-text" data-action="file-batch-trash">Move selected to Recycle Bin</button>`}
function showFileContextMenu(entry,x,y){
  if(!entry)return;closeFileContextMenu();const d=window.__zero1Files||{},menu=document.createElement('div');menu.id='fileContextMenu';menu.className='file-context-menu';
  if(selectedFileRows.size>1&&!entry.shareRoot){menu.innerHTML=batchContextMenuHTML()}else{
    const action=(label,act,extra='')=>`<button data-action="${act}" data-path="${attr(entry.path)}" data-name="${attr(entry.name)}" ${entry.share?`data-share="${attr(entry.share)}"`:''} ${extra}>${label}</button>`;const items=[];
    if(entry.shareRoot){items.push(`<a href="/files?share=${encodeURIComponent(entry.share||entry.name)}">Open</a>`);if(entry.path)items.push(action('Properties','file-properties'));items.push(`<a href="/shares?tab=smb">Manage shared folder</a>`)}else{if(entry.directory&&!entry.symlink)items.push(`<a href="/files?share=${encodeURIComponent(d.share)}&rel=${encodeURIComponent(String(entry.path).replace(String(d.path||'')+'/',''))}">Open</a>`);if(!entry.directory&&!entry.symlink&&officeSupportedName(entry.name))items.push(action('Open in Office','file-office'));if(!entry.directory&&!entry.symlink)items.push(action('Preview','file-preview',`data-size="${entry.size}"`),action('Previous Versions','file-versions'),`<a href="/api/files/download?path=${encodeURIComponent(entry.path)}" download>Download</a>`);items.push(action('Properties','file-properties'),action('Create Share Link','file-share-link'));if(entry.directory&&!entry.symlink)items.push(action('Request files here','file-upload-request'));if(d.writable){items.push('<span></span>',action('Copy','file-clipboard-copy'),action('Cut','file-clipboard-cut'),action('Copy to…','file-copy'),action('Move to…','file-move'),action('Rename','file-rename'),action('Compress to ZIP','file-archive'));if(!entry.directory&&String(entry.name).toLowerCase().endsWith('.zip'))items.push(action('Extract here','file-extract'));items.push('<span></span>',action('Move to Recycle Bin','file-trash','class="danger-text"'))}}
    menu.innerHTML=items.join('');
  }
  document.body.appendChild(menu);armFileContextMenuAutoClose(menu);const width=240,height=Math.min(520,menu.scrollHeight||520);menu.style.left=`${Math.max(8,Math.min(x,innerWidth-width-8))}px`;menu.style.top=`${Math.max(8,Math.min(y,innerHeight-height-8))}px`;
}
function enableFileDesktopInteractions(){
  selectedFileRows.clear();selectedFileRow=null;fileSelectionAnchor=null;
  document.querySelectorAll('[data-file-entry]').forEach(row=>{
    row.addEventListener('click',e=>{if(!e.target.closest('a,button,summary,details'))selectFileRow(row,{toggle:e.ctrlKey||e.metaKey,range:e.shiftKey})});
    row.addEventListener('focus',e=>{if(!selectedFileRows.size)selectFileRow(row)});
    row.addEventListener('dblclick',e=>{if(e.target.closest('a,button,summary,details'))return;selectFileRow(row);const v=selectedFileEntryFromRow(row);if(v.directory){const link=row.querySelector('a[href^="/files?"]');if(link)navigateTo(link.getAttribute('href')).catch(pageError)}else if(officeSupportedName(v.name)){openOfficeFile(v.path,v.name)}else handleFileKeyboardAction('file-preview')});
    row.addEventListener('contextmenu',e=>{e.preventDefault();if(!selectedFileRows.has(row))selectFileRow(row);showFileContextMenu(selectedFileEntryFromRow(row),e.clientX,e.clientY)});
  });
  const zone=document.querySelector('[data-file-dropzone]');zone?.addEventListener('click',e=>{if(e.target===zone||e.target.closest('tbody')&&!e.target.closest('[data-file-entry]'))clearFileSelection()});
  zone?.addEventListener('contextmenu',e=>{if(e.target.closest('[data-file-entry]'))return;e.preventDefault();clearFileSelection();closeFileContextMenu();const d=window.__zero1Files||{},m=document.createElement('div');m.id='fileContextMenu';m.className='file-context-menu';m.innerHTML=`${d.writable?'<button data-action="file-new-folder">New folder</button><button data-action="file-upload">Upload files</button><button data-action="file-paste">Paste</button><span></span>':''}<button data-action="file-refresh">Refresh</button>`;document.body.appendChild(m);armFileContextMenuAutoClose(m);m.style.left=`${Math.max(8,Math.min(e.clientX,innerWidth-248))}px`;m.style.top=`${Math.max(8,Math.min(e.clientY,innerHeight-Math.min(320,m.scrollHeight||320)-8))}px`});
}
function handleFileKeyboardAction(action){const entries=selectedEntries();if(entries.length>1){const map={'file-trash':'file-batch-trash','file-clipboard-copy':'file-batch-copy','file-clipboard-cut':'file-batch-cut'};if(map[action]){const b=document.createElement('button');b.dataset.action=map[action];return handleAction(b)}return}const entry=entries[0]||selectedFileEntryFromRow(selectedFileRow);if(!entry)return;const b=document.createElement('button');b.dataset.action=action;b.dataset.path=entry.path;b.dataset.name=entry.name;b.dataset.size=String(entry.size||0);return handleAction(b)}
function openBatchTransferModal(kind){const items=selectedEntries();if(items.length<2)return;const d=window.__zero1Files||{};const body=`<div class="form-stack"><div class="selected-share"><div><b>${items.length} selected items</b><small>${esc(items.slice(0,4).map(x=>x.name).join(', '))}${items.length>4?'…':''}</small></div></div><input id="fileTransferDest" type="hidden" value="${attr(d.path||'')}"><div id="fileTransferSelected" class="selected-folder"><span class="folder-icon">${icon('folder',16)}</span><div><b>Selected destination</b><small>${esc(currentFileLocationLabel())}</small></div></div><div id="fileTransferBrowser" class="folder-browser"><div class="loading"><span class="spinner"></span>Loading shared folders…</div></div></div>`;openModal(`${kind==='copy'?'Copy':'Move'} selected items`,'Choose one destination. Zero1Local validates every collision before the batch starts.',body,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-batch-transfer-save" data-kind="${kind}">${kind==='copy'?'Copy':'Move'} ${items.length} items</button>`);loadFileTransferBrowser(d.share||'',d.relative_path||'')}
async function runFileBatch(operation,extra={}){const paths=selectedEntries().map(x=>x.path);if(paths.length<2){flash('Select at least two items for a batch action.','warn');return null}return api('/api/files/batch',{method:'POST',body:JSON.stringify({operation,paths,...extra})})}
async function pasteFileClipboard(){
  const d=window.__zero1Files||{};if(!fileClipboard||d.scope!=='share'||!d.writable){flash(fileClipboard?'Open a writable folder before pasting.':'Nothing has been copied or cut.','warn');return}
  try{if(Array.isArray(fileClipboard.paths)&&fileClipboard.paths.length>1){await api('/api/files/batch',{method:'POST',body:JSON.stringify({operation:fileClipboard.cut?'move':'copy',paths:fileClipboard.paths,destination_directory:d.path})});flash(`${fileClipboard.paths.length} items ${fileClipboard.cut?'moved':'copied'}.`)}else{await api('/api/files/'+(fileClipboard.cut?'move':'copy'),{method:'POST',body:JSON.stringify({Source:fileClipboard.path,DestinationDirectory:d.path,NewName:''})});flash(fileClipboard.cut?'Item moved.':'Item copied.')}if(fileClipboard.cut)fileClipboard=null;await filesPage()}catch(e){flash(e.message,'bad')}
}
async function openFileVersions(path,name){
  const d=await api('/api/files/versions?path='+encodeURIComponent(path),{fresh:true}); const versions=list(d.versions),sets=list(d.recovery_sets);
  const exact=versions.length?`<h3 class="subsection-heading">Exact file versions</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Created</th><th>Source</th><th>Size</th><th></th></tr></thead><tbody>${versions.map(v=>`<tr><td>${esc(fmtDate(v.created_at))}</td><td>${esc(v.source)}</td><td>${fmtBytes(v.size)}</td><td><button class="btn btn-small" data-action="file-version-restore" data-source="${attr(v.path)}" data-destination="${attr(path)}" data-name="${attr(name)}">Restore</button></td></tr>`).join('')}</tbody></table></div>`:emptyState('No exact snapshot version','No managed native snapshot currently contains an earlier copy of this exact file.');
  const recovery=sets.length?`<h3 class="subsection-heading">Other recovery sets</h3><p class="human-note">These protect the whole shared folder. Browse a recovery set to confirm the file existed there before restoring it.</p><div class="table-frame"><table class="data-table"><thead><tr><th>Created</th><th>Source</th><th>Recovery set</th><th></th></tr></thead><tbody>${sets.map(x=>`<tr><td>${esc(fmtDate(x.created_at))}</td><td>${esc(x.source==='offsite'?'Off-site generation':x.source==='backup'?'Local backup archive':'Remote backup')}</td><td>${esc(x.job_name||x.detail||x.remote_path||'Recovery point')}</td><td>${x.source==='offsite'?`<button class="btn btn-small" data-action="offsite-generation-browse" data-target="${attr(x.target_id)}" data-path="${attr(x.remote_path)}">Browse</button>`:x.source==='backup'?`<button class="btn btn-small" data-action="backup-version-browse" data-backup="${attr(x.job_id)}" data-archive="${attr(x.archive)}">Browse</button>`:'<a class="btn btn-small" href="/backups">Open Backups</a>'}</td></tr>`).join('')}</tbody></table></div>`:'';
  openModal(`Previous Versions · ${name}`,'Exact native versions and whole-share recovery sets available to help recover this file.',`<div class="version-timeline">${exact}${recovery}</div>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>');
}
function openOfficeSetupPrompt(name,detail=''){
  const label=name||'this file';
  openModal('Office editing',`Open ${label} in Zero1Local Office.`, `<div class="office-simple-setup"><div class="office-setup-symbol">${icon('file',34)}</div><div><h3>Office isn't installed yet</h3><p>Zero1Local can install and configure the browser editor automatically. No server addresses or Docker settings are required.</p>${detail?`<small class="error-detail">${esc(detail)}</small>`:''}</div></div>`, '<button class="btn btn-quiet" data-action="close-modal">Not now</button><button class="btn btn-primary" data-action="office-install">Install Office</button>');
}
function openOfficeFile(path,name){
  const url=`/office/open?path=${encodeURIComponent(path)}&name=${encodeURIComponent(name||'Document')}`;
  // Open synchronously from the user's gesture so popup blockers can make a
  // definitive decision. Never fall back to navigating the File Manager tab:
  // with noopener some browsers intentionally return no WindowProxy even after
  // successfully opening the new tab, which previously caused both tabs to
  // navigate to the Office launcher.
  const win=window.open('about:blank','_blank');
  if(!win){flash('Your browser blocked the Office editor window. Allow pop-ups for this NAS and try again.','warn');return false}
  try{win.opener=null}catch(_){ }
  try{win.location.replace(url)}catch(_){win.location.href=url}
  return true;
}
function officeTaskProgress(task){
  const progress=Math.max(0,Math.min(100,Number(task?.progress||0)));
  return `<div class="office-install-progress"><div class="office-install-meter"><i style="width:${progress}%"></i></div><div class="office-install-detail"><b>${esc(task?.title||'Installing Office')}</b><span>${esc(task?.detail||'Preparing the editor…')}</span><small>${progress}%</small></div></div>`;
}
async function waitForOfficeInstall(taskID,path,name){
  const box=document.getElementById('officeOpenState');
  const deadline=Date.now()+5*60*1000;
  while(Date.now()<deadline){
    let task=null;
    try{const d=await api('/api/tasks',{busy:false,fresh:true});task=list(d.tasks).find(x=>x.id===taskID)||null}catch(e){}
    if(task&&box)box.innerHTML=officeTaskProgress(task);
    if(task?.status==='completed'){
      if(box)box.innerHTML=`${officeTaskProgress({...task,progress:100})}<div class="office-opening-note">Office is ready. Opening ${esc(name||'your document')}…</div>`;
      await launchOfficeDocument(path,name);return;
    }
    if(task?.status==='failed'){
      if(box)box.innerHTML=`<div class="office-open-failure"><h2>Office couldn't be installed</h2><p>${esc(task.error||task.detail||'The installation did not complete.')}</p><div class="row-actions"><button class="btn btn-primary" data-action="office-install-inline" data-path="${attr(path)}" data-name="${attr(name)}">Try again</button><a class="btn" href="/tasks">View details</a></div></div>`;
      return;
    }
    await new Promise(resolve=>setTimeout(resolve,1000));
  }
  if(box)box.innerHTML=`<div class="office-open-failure"><h2>Office is taking longer than expected</h2><p>The setup task is still available in Task Center. You can retry this document when installation finishes.</p><div class="row-actions"><button class="btn btn-primary" data-action="office-open-retry" data-path="${attr(path)}" data-name="${attr(name)}">Check again</button><a class="btn" href="/notifications">Notifications & activity</a></div></div>`;
}
async function launchOfficeDocument(path,name){
  const box=document.getElementById('officeOpenState');
  try{
    const d=await api('/api/office/launch?path='+encodeURIComponent(path),{fresh:true,busy:false});
    if(!d?.url)throw new Error('Office did not return an editor address.');
    location.replace(d.url);
  }catch(e){
    const status=await api('/api/office/settings',{fresh:true,busy:false}).catch(()=>({}));
    if(box)box.innerHTML=`<div class="office-open-failure"><h2>${status.installed?'Office needs attention':'Office isn\'t installed yet'}</h2><p>${esc(status.detail||e.message||'Zero1Local could not open this document.')}</p><div class="row-actions"><button class="btn btn-primary" data-action="${status.installed?'office-repair-inline':'office-install-inline'}" data-path="${attr(path)}" data-name="${attr(name)}">${status.installed?'Repair Office':'Install Office'}</button><button class="btn" data-action="office-open-close">Close</button></div></div>`;
  }
}
async function officeOpenPage(){
  const q=new URLSearchParams(location.search),path=q.get('path')||'',name=q.get('name')||String(path).split('/').pop()||'Document';
  document.body.classList.add('office-workspace-mode');
  document.getElementById('content').innerHTML=`<section class="office-open-page"><div class="office-open-brand"><b>Zero1Local Office</b><span>${esc(name)}</span></div><div id="officeOpenState" class="office-open-state"><div class="office-open-loading"><span class="spinner"></span><b>Opening ${esc(name)}…</b></div></div></section>`;
  if(!path){document.getElementById('officeOpenState').innerHTML='<div class="office-open-failure"><h2>No document selected</h2><p>Return to File Manager and double-click a supported Office document.</p><button class="btn btn-primary" data-action="office-open-close">Close</button></div>';return;}
  try{
    const status=await api('/api/office/settings',{fresh:true,busy:false});
    if(status.ready){await launchOfficeDocument(path,name);return;}
    const box=document.getElementById('officeOpenState');
    box.innerHTML=`<div class="office-open-install"><div class="office-setup-symbol">${icon('file',38)}</div><h1>Open ${esc(name)}</h1><p>Office editing isn't installed on this NAS yet. Zero1Local can install it, configure it, and open this document automatically.</p><button class="btn btn-primary btn-large" data-action="office-install-inline" data-path="${attr(path)}" data-name="${attr(name)}">Install Office</button><small>You only need to do this once.</small></div>`;
  }catch(e){document.getElementById('officeOpenState').innerHTML=`<div class="office-open-failure"><h2>Unable to check Office</h2><p>${esc(e.message)}</p><button class="btn btn-primary" data-action="office-open-retry" data-path="${attr(path)}" data-name="${attr(name)}">Try again</button></div>`;}
}

const CODE_VIEW_MAX_BYTES=2*1024*1024;
const CODE_LANGUAGES={
  javascript:{label:'JavaScript / TypeScript',ext:/\.(js|mjs|cjs|ts|jsx|tsx)$/i,keywords:'as async await break case catch class const continue debugger default delete do else export extends finally for from function get if implements import in instanceof interface let new of package private protected public return set static super switch this throw try typeof var void while with yield'.split(' ')},
  json:{label:'JSON',ext:/\.json$/i,keywords:[]},python:{label:'Python',ext:/\.py$/i,keywords:'and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return True try while with yield'.split(' ')},
  shell:{label:'Shell script',ext:/\.(sh|bash|zsh)$/i,keywords:'case do done elif else esac export fi for function if in local readonly return set shift then until while'.split(' ')},
  powershell:{label:'PowerShell',ext:/\.ps1$/i,keywords:'begin break catch class continue data do dynamicparam else elseif end exit filter finally for foreach from function if in param process return switch throw trap try until using var while'.split(' ')},
  sql:{label:'SQL',ext:/\.sql$/i,keywords:'select from where insert update delete create alter drop table view index join left right inner outer on group by order having limit values into set as distinct union all null is not and or case when then else end'.split(' ')},
  go:{label:'Go',ext:/\.go$/i,keywords:'break default func interface select case defer go map struct chan else goto package switch const fallthrough if range type continue for import return var'.split(' ')},
  rust:{label:'Rust',ext:/\.rs$/i,keywords:'as break const continue crate else enum extern false fn for if impl in let loop match mod move mut pub ref return self Self static struct super trait true type unsafe use where while async await dyn'.split(' ')},
  java:{label:'Java',ext:/\.java$/i,keywords:'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while'.split(' ')},
  c:{label:'C / C++',ext:/\.(c|h|cc|cpp|cxx|hpp|hxx)$/i,keywords:'auto break case char const continue default do double else enum extern float for goto if inline int long register restrict return short signed sizeof static struct switch typedef union unsigned void volatile while class namespace public private protected template typename virtual constexpr nullptr'.split(' ')},
  php:{label:'PHP',ext:/\.php$/i,keywords:'abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile eval exit extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield'.split(' ')},
  ruby:{label:'Ruby',ext:/\.rb$/i,keywords:'BEGIN END alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield'.split(' ')},
  web:{label:'HTML / XML',ext:/\.(html?|xml|svg)$/i,keywords:[]},css:{label:'CSS',ext:/\.(css|scss|sass)$/i,keywords:[]},yaml:{label:'YAML',ext:/\.(ya?ml)$/i,keywords:[]},
  config:{label:'Configuration',ext:/(^|\/)(Dockerfile|Makefile)$/i,keywords:[]},configext:{label:'Configuration',ext:/\.(toml|ini|conf|cfg|env|properties)$/i,keywords:[]},markdown:{label:'Markdown',ext:/\.(md|markdown)$/i,keywords:[]},text:{label:'Plain text',ext:/\.(txt|log|csv)$/i,keywords:[]}
};
function codeLanguageForName(name){for(const [id,def] of Object.entries(CODE_LANGUAGES))if(def.ext.test(String(name||'')))return {id,...def};return null}
function codeCommentMarker(lang){if(['python','shell','powershell','yaml','config','configext'].includes(lang))return '#';if(lang==='sql')return '--';if(['javascript','go','rust','java','c','php'].includes(lang))return '//';return ''}
function commentStartOutsideQuotes(line,marker){if(!marker)return -1;let quote='',escaped=false;for(let i=0;i<=line.length-marker.length;i++){const ch=line[i];if(escaped){escaped=false;continue}if(quote&&ch==='\\'){escaped=true;continue}if(ch==='"'||ch==="'"||ch==='`'){if(!quote)quote=ch;else if(quote===ch)quote='';continue}if(!quote&&line.startsWith(marker,i))return i}return -1}
function highlightCodeLine(line,lang){
  if(lang==='web')return esc(line).replace(/(&lt;\/?)([A-Za-z][\w:-]*)/g,'$1<span class="syn-tag">$2</span>').replace(/\s([A-Za-z_:][-\w:.]*)(=)/g,' <span class="syn-key">$1</span>$2');
  if(lang==='markdown')return esc(line).replace(/^(#{1,6})(\s+.*)$/,'<span class="syn-keyword">$1</span><span class="syn-string">$2</span>').replace(/(`[^`]+`)/g,'<span class="syn-string">$1</span>');
  const marker=codeCommentMarker(lang),idx=commentStartOutsideQuotes(line,marker),body=idx>=0?line.slice(0,idx):line,comment=idx>=0?line.slice(idx):'';
  const def=CODE_LANGUAGES[lang]||{keywords:[]},keywords=new Set(def.keywords||[]),literals=new Set(['true','false','null','undefined','None','True','False','nil']);
  let html='',last=0,re=/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$-]*\b)/g,m;
  while((m=re.exec(body))){html+=esc(body.slice(last,m.index));const tok=m[0],after=body.slice(re.lastIndex);let cls='';if(/^['"`]/.test(tok))cls=(lang==='json'&&/^\s*:/.test(after))?'syn-key':'syn-string';else if(/^\d/.test(tok))cls='syn-number';else if(keywords.has(tok)||keywords.has(tok.toLowerCase()))cls='syn-keyword';else if(literals.has(tok))cls='syn-literal';html+=cls?`<span class="${cls}">${esc(tok)}</span>`:esc(tok);last=re.lastIndex}html+=esc(body.slice(last));if(comment)html+=`<span class="syn-comment">${esc(comment)}</span>`;return html;
}
function highlightedSource(text,lang){return String(text??'').replace(/\r\n/g,'\n').split('\n').map((line,i)=>`<div class="code-view-line"><span class="code-line-number">${i+1}</span><code>${highlightCodeLine(line,lang)}</code></div>`).join('')}
function codeEditorText(){return document.getElementById('fileCodeEditorInput')?.value??window.__zero1CodeEditor?.text??''}
function downloadBrowserEditedCopy(){const s=window.__zero1CodeEditor;if(!s)return;const blob=new Blob([codeEditorText()],{type:'text/plain;charset=utf-8'}),a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=s.name;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000)}
async function openCodeTextViewer(path,name,size,lang){
  if(Number(size||0)>CODE_VIEW_MAX_BYTES){openModal(name,'Code & text viewer',`<div class="file-preview-empty">${icon('file',28)}<h3>This text file is too large for the browser editor</h3><p>Download the file to work with it locally.</p></div>`,`<a class="btn" href="/api/files/download?path=${encodeURIComponent(path)}" download>Download</a><button class="btn btn-primary" data-action="close-modal">Close</button>`);return}
  const src='/api/files/preview?path='+encodeURIComponent(path),res=await fetch(src,{credentials:'same-origin',cache:'no-store'});if(!res.ok)throw new Error(`Unable to open text file (${res.status})`);const text=await res.text();
  window.__zero1CodeEditor={path,name,text,lang:lang.id,wrap:true,editing:false};
  openModal(name,`Code & text editor · ${lang.label}`,`<div class="code-viewer"><div class="code-viewer-toolbar"><span class="tag">${esc(lang.label)}</span><span>${text.replace(/\r\n/g,'\n').split('\n').length.toLocaleString()} lines</span><button class="btn btn-small" data-action="code-wrap-toggle">Do not wrap</button><button class="btn btn-small" data-action="code-copy">Copy</button><button class="btn btn-small" data-action="code-edit-toggle">Edit in browser</button></div><div id="fileCodeHighlight" class="code-highlight-wrap is-wrapped">${highlightedSource(text,lang.id)}</div><textarea id="fileCodeEditorInput" class="code-edit-input hidden" spellcheck="false" aria-label="Edit ${attr(name)}">${esc(text)}</textarea><div class="code-editor-note">${icon('about',15)}<span>Syntax colors are chosen automatically from the filename. Browser edits are not written back to the NAS; download an edited copy when you are done.</span></div></div>`,`<a class="btn" href="/api/files/download?path=${encodeURIComponent(path)}" download>Download original</a><button class="btn hidden" id="downloadEditedCopy" data-action="code-download-edited">Download edited copy</button><button class="btn btn-primary" data-action="close-modal">Close</button>`);
  modalState={...(modalState||{}),kind:'code'};
}

let imagePreviewState={zoom:1,rotation:0,fit:true,path:'',name:'',index:-1,images:[],naturalWidth:0,naturalHeight:0};
function imageFileName(name){return /\.(png|jpe?g|gif|webp|bmp)$/i.test(String(name||''))}
function currentFolderImages(){return list(window.__zero1Files?.entries).filter(x=>!x.directory&&!x.symlink&&imageFileName(x.name)).map(x=>({path:x.path,name:x.name,size:Number(x.size||0)}))}
function imageViewerApply(){
  const img=document.getElementById('filePreviewImage'),wrap=document.getElementById('imageTransformWrap'),stage=document.querySelector('.image-lightbox-stage'),label=document.getElementById('filePreviewZoomLabel'),meta=document.getElementById('imageDimensions');if(!img||!wrap)return;
  const nw=imagePreviewState.naturalWidth||img.naturalWidth||1,nh=imagePreviewState.naturalHeight||img.naturalHeight||1,rot=((imagePreviewState.rotation%360)+360)%360,sideways=rot===90||rot===270;
  if(imagePreviewState.fit&&stage){const aw=Math.max(80,stage.clientWidth-40),ah=Math.max(80,stage.clientHeight-40),rw=sideways?nh:nw,rh=sideways?nw:nh;imagePreviewState.zoom=Math.min(1,aw/rw,ah/rh)}
  imagePreviewState.zoom=Math.max(.1,Math.min(10,Number(imagePreviewState.zoom||1)));
  const w=Math.max(1,Math.round(nw*imagePreviewState.zoom)),h=Math.max(1,Math.round(nh*imagePreviewState.zoom));wrap.style.width=`${sideways?h:w}px`;wrap.style.height=`${sideways?w:h}px`;img.style.width=`${w}px`;img.style.height=`${h}px`;img.style.transform=`translate(-50%,-50%) rotate(${rot}deg)`;img.style.maxWidth='none';img.style.maxHeight='none';if(label)label.textContent=`${Math.round(imagePreviewState.zoom*100)}%`;if(meta)meta.textContent=`${nw.toLocaleString()} × ${nh.toLocaleString()} px`;
}
function applyImagePreviewZoom(next,{fit=false}={}){imagePreviewState.fit=!!fit;imagePreviewState.zoom=Number(next||1);imageViewerApply()}
function imageViewerNavigate(delta){const s=imagePreviewState;if(!s.images.length)return;const next=(s.index+Number(delta)+s.images.length)%s.images.length,entry=s.images[next];openImageViewer(entry.path,entry.name,entry.size)}
function openImageViewer(path,name,size=0){
  const images=currentFolderImages(),found=images.findIndex(x=>String(x.path)===String(path));imagePreviewState={zoom:1,rotation:0,fit:true,path,name,index:found,images,naturalWidth:0,naturalHeight:0};const src='/api/files/preview?path='+encodeURIComponent(path),position=found>=0&&images.length?`${found+1} of ${images.length}`:'Image';
  const film=images.length>1?`<div class="image-filmstrip">${images.map((x,i)=>`<button class="image-thumb ${i===found?'active':''}" data-action="image-open" data-path="${attr(x.path)}" data-name="${attr(x.name)}" data-size="${Number(x.size||0)}" title="${attr(x.name)}"><img src="/api/files/thumbnail?path=${encodeURIComponent(x.path)}" alt=""></button>`).join('')}</div>`:'';
  openModal(name,'Image viewer',`<div class="image-lightbox"><div class="image-lightbox-toolbar"><button class="btn btn-small" data-action="image-prev" ${images.length>1?'':'disabled'} aria-label="Previous image">‹</button><button class="btn btn-small" data-action="image-next" ${images.length>1?'':'disabled'} aria-label="Next image">›</button><span class="image-position">${esc(position)}</span><span class="image-toolbar-sep"></span><button class="btn btn-small" data-action="image-zoom" data-delta="-0.1">−</button><span id="filePreviewZoomLabel">100%</span><button class="btn btn-small" data-action="image-zoom" data-delta="0.1">+</button><button class="btn btn-small" data-action="image-fit">Fit</button><button class="btn btn-small" data-action="image-actual">100%</button><span class="image-toolbar-sep"></span><button class="btn btn-small" data-action="image-rotate-left">↶</button><button class="btn btn-small" data-action="image-rotate-right">↷</button><button class="btn btn-small" data-action="image-fullscreen">Full screen</button><a class="btn btn-small" href="${src}" target="_blank" rel="noopener">Open original</a><a class="btn btn-small" href="/api/files/download?path=${encodeURIComponent(path)}" download>Download</a></div><div class="image-meta-line"><b>${esc(name)}</b><span id="imageDimensions">Loading dimensions…</span><span>Wheel to zoom · drag to pan · arrows move between images</span></div><div class="image-lightbox-stage"><div id="imageTransformWrap" class="image-transform-wrap"><img id="filePreviewImage" src="${src}" alt="${attr(name)}" draggable="false"></div></div>${film}</div>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>');
  modalState={...(modalState||{}),kind:'image'};document.querySelector('[data-modal-panel]')?.classList.add('image-viewer-modal');const img=document.getElementById('filePreviewImage'),stage=document.querySelector('.image-lightbox-stage');
  img?.addEventListener('load',()=>{imagePreviewState.naturalWidth=img.naturalWidth;imagePreviewState.naturalHeight=img.naturalHeight;imageViewerApply()},{once:true});
  stage?.addEventListener('wheel',e=>{e.preventDefault();imagePreviewState.fit=false;applyImagePreviewZoom(imagePreviewState.zoom*(e.deltaY<0?1.12:.89));},{passive:false});
  stage?.addEventListener('dblclick',e=>{e.preventDefault();if(imagePreviewState.fit)applyImagePreviewZoom(1);else applyImagePreviewZoom(1,{fit:true})});
  let dragging=false,lastX=0,lastY=0;stage?.addEventListener('pointerdown',e=>{if(e.button!==0)return;dragging=true;lastX=e.clientX;lastY=e.clientY;stage.setPointerCapture?.(e.pointerId);stage.classList.add('is-panning')});stage?.addEventListener('pointermove',e=>{if(!dragging)return;stage.scrollLeft-=e.clientX-lastX;stage.scrollTop-=e.clientY-lastY;lastX=e.clientX;lastY=e.clientY});const end=e=>{dragging=false;stage?.classList.remove('is-panning');try{stage?.releasePointerCapture?.(e.pointerId)}catch(_){}};stage?.addEventListener('pointerup',end);stage?.addEventListener('pointercancel',end);
}
async function openFilePreview(path,name,size=0){
  let info={kind:'file',vlc_available:false,browser_native:false};try{info=await api('/api/files/media-info?path='+encodeURIComponent(path),{busy:false,fresh:true});}catch(_){}
  if(Number(size||info.size||0)===0){openModal(`Preview ${name}`,'File preview',`<div class="file-preview-empty">${icon('file',28)}<h3>This file is empty</h3><p>There is no content to preview.</p></div>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>');return}
  const lang=codeLanguageForName(name);if(lang){await openCodeTextViewer(path,name,Number(size||info.size||0),lang);return}
  if(info.kind==='image'){openImageViewer(path,name,Number(size||info.size||0));return}
  if(info.kind==='video'){
    const native='/api/files/preview?path='+encodeURIComponent(path),useVLC=info.vlc_available===true&&info.browser_native!==true,src=useVLC?'/api/files/vlc-preview?path='+encodeURIComponent(path):native;const engine=useVLC?'Compatibility playback':'Direct browser playback';
    openModal(name,engine,`<div class="video-preview"><video controls autoplay preload="metadata" playsinline poster="/api/files/thumbnail?path=${encodeURIComponent(path)}"><source src="${src}"></video><div class="media-preview-note"><span>${icon('video',16)}</span><div><b>${esc(engine)}</b><small>${useVLC?'Zero1Local is converting this format into a stream your browser can play.':'The original file is streamed directly with seeking support.'}</small></div></div></div>`,`<a class="btn" href="/api/files/download?path=${encodeURIComponent(path)}" download>Download</a><button class="btn btn-primary" data-action="close-modal">Close</button>`);return;
  }
  const src='/api/files/preview?path='+encodeURIComponent(path);openModal(`Preview ${name}`,'File preview',`<div class="file-preview"><iframe src="${src}" title="Preview ${attr(name)}"></iframe></div>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>');
}

function openShareLinkModal(path,name){openModal(`Share ${name}`,'Create a revocable download link. External access works only if your Zero1Local management address itself is reachable by the recipient.',`<div class="form-stack"><div class="field-grid"><div><label>Expires after</label><select id="shareLinkExpiry"><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="720">30 days</option><option value="8760">1 year</option></select></div><div><label>Maximum downloads</label><input id="shareLinkMax" type="number" min="0" value="0"><small class="field-help">0 means unlimited until expiration.</small></div></div><label>Optional password</label><input id="shareLinkPassword" type="password" autocomplete="new-password" placeholder="No password"><div class="notice notice-info"><b>Nothing is exposed automatically</b><span>Creating a link does not configure port forwarding, a tunnel, or public DNS. Local-only remains the default.</span></div></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-share-link-create" data-path="${attr(path)}" data-name="${attr(name)}">Create link</button>`)}
async function createShareLink(target){try{const d=await api('/api/files/share-links',{method:'POST',body:JSON.stringify({Path:target.dataset.path,Password:document.getElementById('shareLinkPassword').value,ExpiresHours:Number(document.getElementById('shareLinkExpiry').value),MaxDownloads:Number(document.getElementById('shareLinkMax').value||0)})});const absolute=new URL(d.url,location.origin).href;openModal('Secure link created','Copy this link now. Zero1Local stores only its hash, so the secret URL cannot be reconstructed later.',`<div class="share-link-result"><input id="createdShareLink" readonly value="${attr(absolute)}"><button class="btn" data-action="share-link-copy">Copy</button></div><div class="notice notice-info"><b>Expires ${esc(fmtDate(d.expires_at))}</b><span>${d.password_protected?'The recipient will also be prompted for the password you set.':'No link password was configured.'}</span></div>`,'<button class="btn btn-primary" data-action="close-modal">Done</button>')}catch(e){flash(e.message,'bad')}}
function openUploadRequestModal(path,name){openModal(`Request files · ${name}`,'Create an upload-only link that lets a recipient add files to this folder without seeing its contents.',`<div class="form-stack"><div class="field-grid"><div><label>Expires after</label><select id="uploadLinkExpiry"><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option><option value="720">30 days</option></select></div><div><label>Maximum uploads</label><input id="uploadLinkMax" type="number" min="0" max="100000" value="0"><small class="field-help">0 means unlimited until expiration.</small></div></div><label>Maximum size per file</label><div class="input-with-suffix"><input id="uploadLinkSize" type="number" min="1" max="102400" value="2048"><span>MB</span></div><label>Optional password</label><input id="uploadLinkPassword" type="password" autocomplete="new-password" placeholder="No password"><div class="notice notice-info"><b>Upload only</b><span>Recipients can add files to this folder but cannot browse, list, download, replace, rename, or delete existing NAS content. Filename collisions are renamed safely.</span></div><div class="notice notice-warn"><b>Keep it behind your security boundary</b><span>The link does not modify nftables, port forwarding, DNS, or your reverse proxy. For access outside your LAN/VPN, publish only through an intentionally configured trusted proxy/tunnel.</span></div></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-upload-request-create" data-path="${attr(path)}" data-name="${attr(name)}">Create upload request</button>`)}
async function createUploadRequest(target){try{const d=await api('/api/files/share-links',{method:'POST',body:JSON.stringify({Path:target.dataset.path,Mode:'upload',Password:document.getElementById('uploadLinkPassword').value,ExpiresHours:Number(document.getElementById('uploadLinkExpiry').value),MaxUploads:Number(document.getElementById('uploadLinkMax').value||0),MaxUploadMB:Number(document.getElementById('uploadLinkSize').value||2048)})});const absolute=new URL(d.url,location.origin).href;openModal('Upload request created','Copy this secret link and send it to the person who needs to upload files.',`<div class="share-link-result"><input id="createdShareLink" readonly value="${attr(absolute)}"><button class="btn" data-action="share-link-copy">Copy</button></div><div class="notice notice-info"><b>Upload-only access</b><span>The recipient cannot list or download files from the destination folder. ${d.password_protected?'Their browser will also request the password you configured.':'No link password was configured.'}</span></div>`,'<button class="btn btn-primary" data-action="close-modal">Done</button>')}catch(e){flash(e.message,'bad')}}

async function sharedLinksPage(){
  const d=await api('/api/files/share-links',{fresh:true});const links=list(d.links);
  document.getElementById('content').innerHTML=`<section class="screen">${heading('File Manager','Shared Links','Revocable download and upload-request links created from File Manager. Creating a link never changes router/firewall settings.')}<section class="content-panel">${sectionTitle('Active and recent links',`${links.filter(x=>!x.revoked&&!x.expired).length} active`)}<div class="table-frame"><table class="data-table"><thead><tr><th>Item</th><th>Access</th><th>Created</th><th>Expires</th><th>Transfers</th><th>Protection</th><th></th></tr></thead><tbody>${links.map(x=>{const upload=x.mode==='upload';const transfer=upload?`${Number(x.uploads||0)}${x.max_uploads?` / ${Number(x.max_uploads)}`:''} uploads`:`${Number(x.downloads||0)}${x.max_downloads?` / ${Number(x.max_downloads)}`:''} downloads`;return `<tr><td><b>${esc(x.name)}</b><small>${upload?'Upload destination':x.directory?'Folder ZIP':'File download'}</small></td><td>${statusPill(upload?'Upload only':'Download',upload?'good':'neutral')}</td><td>${esc(fmtDate(x.created_at))}</td><td>${x.expired?statusPill('Expired','warn'):x.revoked?statusPill('Revoked','neutral'):esc(fmtDate(x.expires_at))}</td><td>${esc(transfer)}</td><td>${x.password_protected?'Password protected':'Link secret only'}</td><td>${!x.revoked&&!x.expired?`<button class="btn btn-small danger-soft" data-action="share-link-revoke" data-link="${attr(x.id)}">Revoke</button>`:'—'}</td></tr>`}).join('')||`<tr><td colspan="7">${emptyState('No shared links','Right-click a file/folder for a download link, or a folder for an upload request.')}</td></tr>`}</tbody></table></div></section></section>`;
}

async function officePage(){
  const [d,catalog]=await Promise.all([api('/api/office/settings',{fresh:true}),api('/api/apps/catalog').catch(()=>({apps:[]}))]);
  const local=list(catalog.apps).find(x=>x.id==='collabora');
  const ready=!!d.ready,running=!!d.running,installed=!!d.installed;
  const state=ready?statusPill('Ready','good'):installed?statusPill(running?'Needs repair':'Installed · stopped','warn'):statusPill('Not installed','neutral');
  const action=ready?'<button class="btn" data-action="office-repair">Check & repair</button>':`<button class="btn btn-primary" data-action="${installed?'office-repair':'office-install'}">${installed?'Repair Office':'Install Office'}</button>`;
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Files & Sharing','Office Editing','Double-click a supported document in File Manager. Zero1Local takes care of the editor automatically.')}<section class="content-panel office-status-panel">${sectionTitle('Office editing','There is normally nothing to configure here.')}<div class="office-status-hero"><div class="office-status-icon">${icon('file',30)}</div><div><div class="catalog-title-line"><h2>${ready?'Office is ready':installed?'Office needs attention':'Office is not installed'}</h2>${state}</div><p>${esc(d.detail||'Zero1Local automatically discovers and configures a local Office editor.')}</p><small>${ready?'Word, spreadsheet and presentation files open directly from File Manager.':installed?'Use Repair Office and Zero1Local will start/reconnect the existing editor automatically.':'The first time someone opens an eligible file, Zero1Local can install Office in that same window.'}</small></div></div><div class="panel-actions">${action}${!ready?'<a class="btn" href="/files">Open File Manager</a>':''}</div></section><section class="content-panel">${sectionTitle('How it works','Designed for people who just want to open a document.')}<div class="office-simple-steps"><article><b>1</b><span>Double-click a Word, spreadsheet or presentation file.</span></article><article><b>2</b><span>If Office is missing, choose <strong>Install Office</strong> once and watch its progress.</span></article><article><b>3</b><span>Zero1Local configures the editor automatically and opens the document. Future files open directly.</span></article></div></section><details class="content-panel advanced office-advanced"><summary>Advanced / external Office server</summary><div class="advanced-body form-stack"><p class="field-help">Only use this when intentionally connecting Zero1Local to a Collabora server that is not running locally on this NAS. Local installations are auto-detected.</p><label class="switch-row"><div><b>Enable external Office server</b><small>Overrides automatic local discovery while this configuration remains healthy.</small></div><span class="switch"><input id="officeEnabled" type="checkbox" ${d.enabled?'checked':''}><i></i></span></label><label>Collabora URL</label><input id="officeEndpoint" value="${attr(d.auto_configured?'':d.endpoint||'')}" placeholder="https://office.example.internal"><label>Zero1Local WOPI address</label><input id="officeWopiBase" value="${attr(d.auto_configured?'':d.wopi_base_url||location.origin)}" placeholder="${attr(location.origin)}"><div class="panel-actions"><button class="btn" data-action="office-settings-save">Save advanced settings</button></div></div></details><div class="context-note">${icon('security',16)}<span>Office stays internal by default. If browser access crosses networks, use a trusted reverse proxy such as NGINX Proxy Manager with an IP/CIDR Access List rather than directly exposing the NAS or Collabora port.</span></div></section>`;
}

function protectionPlanModal(){const p=window.__zero1ProtectionPlans||{},backups=list(p.backups);openModal('Create Protection Plan','Choose the recovery layers for one shared folder. Existing advanced jobs remain independently manageable.',`<div class="form-stack"><label>Plan name</label><input id="planName" placeholder="Documents protection"><label>Shared folder</label><select id="planShare">${list(p.shares).map(x=>`<option>${esc(x)}</option>`).join('')}</select><label class="checkline"><input id="planSnapshot" type="checkbox" checked><span><b>Native snapshots when supported</b><small>Fast local point-in-time recovery.</small></span></label><div class="field-grid"><div><label>Snapshot retention</label><input id="planSnapshotRetain" type="number" min="1" max="365" value="7"></div><div><label>Schedule</label><select id="planSchedule"><option value="daily">Daily</option><option value="hourly">Hourly</option><option value="weekly">Weekly</option><option value="manual">Manual only</option></select></div></div><label>Time</label><input id="planTime" type="time" value="02:00"><div class="wizard-step"><b>Existing local backup jobs</b>${backups.map(j=>`<label class="checkline" data-plan-job-share="${attr(j.share)}"><input type="checkbox" data-plan-backup="${attr(j.id)}"><span><b>${esc(j.name)}</b><small>${esc(j.share)} → ${esc(j.destination||j.target_id||'backup destination')}</small></span></label>`).join('')||'<small>No local backup jobs exist yet. You can add one later.</small>'}</div><div class="wizard-step"><b>Existing off-site jobs</b>${offsite.map(j=>`<label class="checkline" data-plan-job-share="${attr(j.share)}"><input type="checkbox" data-plan-offsite="${attr(j.id)}"><span><b>${esc(j.name)}</b><small>${esc(j.share)} · ${esc(j.mode)}</small></span></label>`).join('')||'<small>No off-site jobs exist yet. Create one from Protect a Share, then add it to a plan.</small>'}</div><label class="checkline"><input id="planEnabled" type="checkbox" checked><span><b>Enable plan immediately</b></span></label></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="protection-plan-save">Create plan</button>`);const sync=()=>{const sh=document.getElementById('planShare')?.value;document.querySelectorAll('[data-plan-job-share]').forEach(x=>x.classList.toggle('hidden',x.dataset.planJobShare!==sh));document.querySelectorAll('[data-plan-job-share].hidden input').forEach(x=>x.checked=false)};document.getElementById('planShare')?.addEventListener('change',sync);sync()}

function renderRecoverySearchResults(d){
  const box=document.getElementById('recoverySearchResults');if(!box)return;
  const rows=list(d.results);
  box.innerHTML=rows.length?`<div class="table-frame"><table class="data-table"><thead><tr><th>Item</th><th>Share</th><th>Recovery source</th><th>Created</th><th></th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.path||'Recovered item')}</b><small>${x.directory?'Folder':fmtBytes(x.size||0)}</small></td><td>${esc(x.share||'—')}</td><td>${x.source==='snapshot'?statusPill('Snapshot','good'):statusPill('Local backup','neutral')}${x.job_name?`<small>${esc(x.job_name)}</small>`:''}</td><td>${esc(fmtDate(x.created_at))}</td><td>${x.source==='backup'?`<button class="btn btn-small" data-action="backup-versions-open" data-backup="${attr(x.job_id)}">Browse backup</button>`:'<a class="btn btn-small" href="/snapshots">Review snapshot</a>'}</td></tr>`).join('')}</tbody></table></div>${d.limited?'<div class="human-note">Showing the first 200 matches. Narrow the search for a more specific result.</div>':''}<div class="human-note">${esc(d.remote_note||'')}</div>`:emptyState('No matching recovery items','Try another file or folder name. Remote generations can still be browsed directly below.');
}
async function runRecoverySearch(){
  const q=String(document.getElementById('recoverySearchQuery')?.value||'').trim(),box=document.getElementById('recoverySearchResults');
  if(q.length<2){flash('Enter at least two characters.','warn');return}
  if(box)box.innerHTML='<div class="skeleton-lines"><i></i><i></i><i></i></div>';
  try{renderRecoverySearchResults(await api('/api/protection/recovery-search?q='+encodeURIComponent(q),{fresh:true}))}catch(e){if(box)box.innerHTML=`<div class="notice notice-bad"><b>Recovery search failed</b><span>${esc(e.message)}</span></div>`}
}

function catalogAppIcon(id,size=34){
  const paths={
    collabora:'<path d="M7 3h8l4 4v14H7z"/><path d="M15 3v5h5"/><path d="M10 12h6M10 16h6"/>',
    'stirling-pdf':'<path d="M6 3h9l4 4v14H6z"/><path d="M15 3v5h5"/><path d="M9 15h6M9 11h4"/>',
    jellyfin:'<path d="m12 3 8 16H4z"/><path d="m12 8 4 8H8z"/>',
    navidrome:'<path d="M9 18V6l9-2v12"/><circle cx="6" cy="18" r="3"/><circle cx="15" cy="16" r="3"/>',
    audiobookshelf:'<path d="M4 5h6a3 3 0 0 1 3 3v11H7a3 3 0 0 0-3 2z"/><path d="M20 5h-4a3 3 0 0 0-3 3v11h4a3 3 0 0 1 3 2z"/>',
    syncthing:'<circle cx="12" cy="12" r="8"/><path d="m7 9 3-3 3 3M17 15l-3 3-3-3M10 6v6h7M14 18v-6H7"/>',
    vaultwarden:'<path d="M12 3 20 6v6c0 5-3.3 8-8 9-4.7-1-8-4-8-9V6z"/><path d="M9 12h6M12 9v6"/>',
    'uptime-kuma':'<path d="M3 13h4l2-6 4 11 2-7 2 2h4"/>',
    gitea:'<circle cx="7" cy="6" r="2"/><circle cx="17" cy="18" r="2"/><path d="M7 8v5a5 5 0 0 0 5 5h3M7 13h5a5 5 0 0 0 5-5V6"/>',
    'home-assistant':'<path d="M3 11.5 12 4l9 7.5V20H3z"/><path d="M8 14h8M12 10v8"/>',
    portainer:'<path d="M4 8h16v11H4z"/><path d="M7 8V5h10v3M8 12h2M12 12h2M16 12h2M8 16h2M12 16h2M16 16h2"/>',
    freshrss:'<path d="M5 18a1 1 0 1 0 0 .1"/><path d="M4 11a9 9 0 0 1 9 9M4 5a15 15 0 0 1 15 15"/>',
    mealie:'<path d="M7 3v8M10 3v8M7 7h3M8.5 11v10M16 3c2 4 2 8 0 11v7"/>',
    'actual-budget':'<path d="M4 18V9M10 18V5M16 18v-7M22 20H2"/><path d="m4 7 6-4 6 6 5-4"/>',
    filebrowser:'<path d="M3 7h7l2-2h9v14H3z"/><path d="M7 12h10M7 16h7"/>',
    memos:'<path d="M5 4h14v16H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
    linkding:'<path d="M10 13a5 5 0 0 0 7.1.1l2-2a5 5 0 0 0-7.1-7.1l-1.1 1.1"/><path d="M14 11a5 5 0 0 0-7.1-.1l-2 2A5 5 0 0 0 12 20l1.1-1.1"/>',
    changedetection:'<path d="M3 12s3-6 9-6 9 6 9 6-3 6-9 6-9-6-9-6z"/><circle cx="12" cy="12" r="2.5"/><path d="M18 4v4M16 6h4"/>'
  };
  const body=paths[id]||'<rect x="4" y="4" width="16" height="16" rx="4"/><path d="M8 12h8M12 8v8"/>';
  return `<svg class="catalog-app-svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}
function catalogAppInfoModal(id){
  const d=window.__zero1Catalog||{}, x=list(d.apps).find(app=>app.id===id);
  if(!x)return;
  const artwork=value=>/^\/assets\/catalog-brand\/[a-z0-9-]+\.(?:svg|png|webp)$/.test(String(value||''))?String(value):'';
  const src=artwork(x.brand_logo)||artwork(x.brand_icon);
  const image=x.image?'<div><dt>Container image</dt><dd><code>'+esc(x.image)+'</code></dd></div>':'';
  const memory=x.min_memory_mb?'<div><dt>App memory requirements</dt><dd>Minimum '+Number(x.min_memory_mb)+' MB'+(x.recommended_memory_mb?', recommended '+Number(x.recommended_memory_mb)+' MB':'')+'</dd></div>':'';
  const compatibility=x.manual_setup?'<div><dt>Installation method</dt><dd>Follow the developer setup guide</dd></div>':'<div><dt>Zero1 compatibility</dt><dd>'+esc(x.zero1_fit==='optimized'?'Optimized':x.zero1_fit==='conditional'?'Check requirements':'Supported')+' · '+esc(String(x.workload||'moderate'))+' workload</dd></div>';
  const resources=[
    compatibility,
    memory,
    list(x.architectures).length?'<div><dt>CPU architecture</dt><dd>'+esc(list(x.architectures).join(', '))+'</dd></div>':'',
    image,
    !x.manual_setup&&x.data_dir?'<div><dt>Persistent app data</dt><dd><code>'+esc(x.data_dir)+'</code></dd></div>':'',
    x.share?'<div><dt>Shared folder</dt><dd>'+esc(x.share)+(x.share_read_only?' (read-only)':'')+'</dd></div>':'',
    list(x.dependencies).length?'<div><dt>Requirements</dt><dd>'+list(x.dependencies).map(dep=>esc(dep)).join(', ')+'</dd></div>':''
  ].filter(Boolean).join('');
  let setup='';
  if(x.manual_setup){
    const raw=String(x.setup_url||'');
    try{
      const url=new URL(raw);
      if(url.protocol==='https:'&&url.hostname==='github.com'&&url.pathname.startsWith('/gigabytegrove/'))setup='<a class="btn btn-primary" href="'+attr(url.href)+'" target="_blank" rel="noopener noreferrer">Setup guide</a>';
    }catch{}
  }
  const body='<div class="catalog-info-hero">'+(src?'<img src="'+attr(src)+'" alt="'+attr(x.name)+' logo" loading="lazy" decoding="async">':'')+'<p>'+esc(x.description)+'</p></div>'+
    '<dl class="catalog-info-facts">'+resources+'</dl>'+
    (x.notes?'<p class="catalog-info-note">'+esc(x.notes)+'</p>':'')+
    (x.manual_setup?'<p class="catalog-info-note">This app uses its own setup process. Zero1Local will not change an existing deployment.</p>':'');
  openModal(x.name,'Application information',body,'<div class="row-actions">'+setup+'<button class="btn" data-action="close-modal">Close</button></div>');
}
async function appCatalogPage(){
  const [d,custom,sources]=await Promise.all([api('/api/apps/catalog',{fresh:true}),api('/api/apps/catalog-custom',{fresh:true}).catch(()=>({images:[]})),api('/api/apps/catalog-sources',{fresh:true}).catch(()=>({sources:[]}))]);window.__zero1Catalog=d;window.__zero1CustomCatalog=custom;window.__zero1CatalogSources=sources;
  const platform=d.platform||{},native=!!platform.native;
  const groups={};for(const app of list(d.apps)){const k=app.category||'Other';(groups[k]||(groups[k]=[])).push(app)}
  const fitLabel=x=>x.zero1_fit==='optimized'?['Optimized for Zero1','good']:x.zero1_fit==='conditional'?['Supported with conditions','warn']:['Supported on Zero1','neutral'];
  const workloadLabel=x=>String(x.workload||'moderate').replace(/^./,m=>m.toUpperCase())+' workload';
  const catalogBrandAsset=value=>/^\/assets\/catalog-brand\/[a-z0-9-]+\.(?:svg|png|webp)$/.test(String(value||''))?String(value):'';
  const catalogSetupLink=value=>{try{const u=new URL(String(value||''));return u.protocol==='https:'&&u.hostname==='github.com'&&u.pathname.startsWith('/gigabytegrove/')?u.href:'';}catch{return '';}};
  const cards=x=>{
    const brandIcon=catalogBrandAsset(x.brand_icon),setupLink=catalogSetupLink(x.setup_url);
    const status=x.manual_setup?statusPill('Setup guide','neutral'):statusPill(x.running?'Running':x.installed?'Stopped':x.architecture_compatible===false?'Unsupported architecture':x.memory_sufficient===false?'Above spec':'Available',x.running?'good':x.installed?'warn':x.architecture_compatible===false?'bad':x.memory_sufficient===false?'warn':'neutral');
    const actions=x.manual_setup?(setupLink?'<a class="btn btn-small btn-primary" href="'+attr(setupLink)+'" target="_blank" rel="noopener noreferrer" data-catalog-manual="true">Setup guide</a>':'<span class="catalog-guide-unavailable">Guide unavailable</span>'):
      x.installed?'<a class="btn btn-small" href="'+attr(x.backup_url)+'">Back up data</a><button class="btn btn-small" data-action="catalog-runtime" data-app="'+attr(x.id)+'" data-runtime="'+(x.running?'restart':'start')+'">'+(x.running?'Restart':'Start')+'</button><button class="btn btn-small" data-action="catalog-configure" data-app="'+attr(x.id)+'">Manage</button><details class="row-action-menu"><summary aria-label="More actions for '+attr(x.name)+'">'+icon('more',18)+'</summary><div><button class="danger-text" data-action="catalog-remove" data-app="'+attr(x.id)+'">Uninstall app</button></div></details>':
      '<button class="btn btn-small btn-primary" data-action="catalog-configure" data-app="'+attr(x.id)+'" '+(x.architecture_compatible===false?'disabled':'')+'>Install</button>';
    return '<article class="catalog-card '+(x.architecture_compatible===false?'is-incompatible':x.memory_sufficient===false?'is-above-spec':'')+'">'+
      '<div class="catalog-icon '+(brandIcon?'catalog-icon-official':'')+'">'+(brandIcon?'<img src="'+attr(brandIcon)+'" alt="'+attr(x.name)+' logo" loading="lazy" decoding="async">':catalogAppIcon(x.id))+'</div>'+
      '<div class="catalog-copy"><div class="catalog-title-line"><h3>'+esc(x.name)+'</h3>'+status+'</div><p class="catalog-summary">'+esc(x.description)+'</p></div>'+
      '<div class="catalog-actions"><button class="btn btn-small catalog-more" data-action="catalog-more" data-app="'+attr(x.id)+'" aria-label="More information about '+attr(x.name)+'">More info</button><div class="row-actions">'+(x.update_available?statusPill('Update ready','warn'):'')+actions+'</div></div></article>';
  };

  const customCards=list(custom.images).map(x=>`<article class="custom-image-card"><div class="catalog-icon">${icon('docker',25)}</div><div><div class="catalog-title-line"><h3>${esc(x.name||x.image)}</h3>${statusPill(x.pulled?'Pulled':'Saved',x.pulled?'good':'neutral')}</div><code>${esc(x.image)}</code>${x.notes?`<p>${esc(x.notes)}</p>`:''}<small>Added ${esc(fmtDate(x.added_at))}</small></div><div class="row-actions"><button class="btn btn-small btn-primary" data-action="catalog-custom-pull" data-custom="${attr(x.id)}">${x.pulled?'Pull latest':'Pull image'}</button><button class="btn btn-small danger-soft" data-action="catalog-custom-remove" data-custom="${attr(x.id)}">Remove entry</button></div></article>`).join('');
  const sourceCards=list(sources.sources).map(x=>`<article class="catalog-source-card"><div class="catalog-icon">${icon('network',24)}</div><div><h3>${esc(x.name)}</h3><code>${esc(x.prefix)}</code>${x.notes?`<p>${esc(x.notes)}</p>`:''}<small>Saved repository source</small></div><button class="btn btn-small danger-soft" data-action="catalog-source-remove" data-source="${attr(x.id)}">Remove</button></article>`).join('');
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Apps','Catalog','Find, install and manage apps for your NAS.','<div class="row-actions"><button class="btn btn-primary" data-action="catalog-custom-add">Add custom image</button><a class="btn" href="/docker/stacks">Docker Compose</a></div>')}<div class="content-panel catalog-discovery-toolbar"><label for="catalogSearch">Find an app</label><input id="catalogSearch" type="search" placeholder="Search apps and descriptions" autocomplete="off"><label for="catalogFilter">Show</label><select id="catalogFilter"><option value="all">All apps</option><option value="installed">Installed</option><option value="available">Available to install</option></select><span id="catalogFilterCount" role="status">Showing ${list(d.apps).length} apps</span></div>${Object.entries(groups).map(([category,apps])=>`<section class="catalog-category"><div class="section-heading"><div><h2>${esc(category)}</h2><p>${apps.length} curated application${apps.length===1?'':'s'}.</p></div></div><div class="catalog-grid">${apps.map(cards).join('')}</div></section>`).join('')||emptyState('No compatible catalog applications','The curated catalog is currently empty.')}<section class="content-panel custom-catalog-panel">${sectionTitle('Custom repositories & images','Keep reusable registry/repository prefixes here, then save exact images you want to pull. Docker Compose remains the advanced path for multi-container apps.','<div class="row-actions"><button class="btn btn-small" data-action="catalog-source-add">+ Add repository</button><button class="btn btn-small" data-action="catalog-custom-add">+ Add image</button></div>')}<div class="catalog-source-list">${sourceCards||emptyState('No custom repositories','Add a registry or repository prefix such as ghcr.io/home-assistant or lscr.io/linuxserver.')}</div><div class="custom-image-list">${customCards||emptyState('No custom images saved','Add an image from Docker Hub, GHCR or another registry. Docker Compose is still available when an application needs multiple containers.')}</div></section><div class="context-note">${icon('about',16)}<span>Installed apps keep their settings and files on this NAS. Choose “More info” to view requirements and technical details. Custom images require manual setup.</span></div></section>`;
  const applyCatalogFilter=()=>{
    const query=String(document.getElementById('catalogSearch')?.value||'').trim().toLowerCase();
    const mode=document.getElementById('catalogFilter')?.value||'all';
    let shown=0;
    document.querySelectorAll('.catalog-category').forEach(group=>{
      let matchesInGroup=0;
      group.querySelectorAll('.catalog-card').forEach(card=>{
        const search=((card.querySelector('h3')?.textContent||'')+' '+(card.querySelector('.catalog-summary')?.textContent||'')).toLowerCase();
        const installed=!!card.querySelector('[data-action="catalog-runtime"]');
        const manual=!!card.querySelector('[data-catalog-manual]');
        const match=search.includes(query)&&(mode==='all'||(mode==='installed'&&installed)||(mode==='available'&&!installed&&!manual));
        card.classList.toggle('hidden',!match);
        if(match){shown++;matchesInGroup++;}
      });
      group.classList.toggle('hidden',matchesInGroup===0);
    });
    const counter=document.getElementById('catalogFilterCount');
    if(counter)counter.textContent=`${shown} app${shown===1?'':'s'} shown`;
  };
  document.getElementById('catalogSearch')?.addEventListener('input',applyCatalogFilter);
  document.getElementById('catalogFilter')?.addEventListener('change',applyCatalogFilter);
}

function customCatalogModal(){
  const sources=list(window.__zero1CatalogSources?.sources);const sourceOptions=sources.length?`<label>Start from saved repository <span class="optional">optional</span></label><select id="customCatalogSource"><option value="">Type a full image reference</option>${sources.map(x=>`<option value="${attr(x.prefix)}">${esc(x.name)} · ${esc(x.prefix)}</option>`).join('')}</select>`:'';
  openModal('Add custom Docker image','Save an exact image repository/reference in your Zero1Local catalog. Pulling it only downloads the image; it does not create a container automatically.',`<div class="form-stack"><label>Display name</label><input id="customCatalogName" maxlength="100" placeholder="My application">${sourceOptions}<label>Docker image</label><input id="customCatalogImage" maxlength="512" placeholder="ghcr.io/example/app:latest"><small class="field-help">Use a full image reference. If you choose a saved repository, enter only the remaining image/tag and Zero1Local will join them.</small><label>Notes <span class="optional">optional</span></label><textarea id="customCatalogNotes" rows="3" maxlength="1000" placeholder="Why this image is here or how you plan to run it"></textarea></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="catalog-custom-save">Save image</button>`);
}
function customCatalogSourceModal(){
  openModal('Add Docker repository','Save a reusable registry/repository prefix. This does not grant credentials or expose Docker remotely.',`<div class="form-stack"><label>Name</label><input id="customCatalogSourceName" maxlength="100" placeholder="LinuxServer.io"><label>Registry / repository prefix</label><input id="customCatalogSourcePrefix" maxlength="300" placeholder="lscr.io/linuxserver"><small class="field-help">Examples: ghcr.io/home-assistant, lscr.io/linuxserver, registry.example.com/team.</small><label>Notes <span class="optional">optional</span></label><textarea id="customCatalogSourceNotes" rows="3" maxlength="1000"></textarea></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="catalog-source-save">Save repository</button>`);
}

async function checkCatalogPort(id){const input=document.getElementById('catalogPort'),box=document.getElementById('catalogPortStatus'),save=document.querySelector('[data-action="catalog-install-save"]');if(!input||!box)return;const port=Number(input.value||0);if(port<1024||port>65535){box.innerHTML='<span class="port-check bad">Choose a port from 1024–65535.</span>';if(save)save.disabled=true;return}try{const d=await api('/api/network/port-check?port='+encodeURIComponent(port)+'&protocol=tcp&ignore_catalog='+encodeURIComponent(id),{busy:false,fresh:true});if(d.available){box.innerHTML='<span class="port-check good">Available on this NAS.</span>';if(save)save.disabled=false}else{const x=list(d.conflicts)[0];box.innerHTML=`<span class="port-check bad">Port ${port} is already used by ${esc(x?.owner||'another service')}.</span>`;if(save)save.disabled=true}}catch(e){box.innerHTML=`<span class="port-check warn">Unable to verify port: ${esc(e.message)}</span>`;if(save)save.disabled=true}}
function catalogInstallModal(id){
  const d=window.__zero1Catalog||{},x=list(d.apps).find(a=>a.id===id);if(!x)return;
  const proxyOK=list(d.proxy_cidrs).length>0,shares=list(d.shares),incompatible=x.architecture_compatible===false,aboveSpec=x.memory_sufficient===false;
  openModal(`${x.installed?'Configure / update':'Install'} ${x.name}`,'Zero1Local checks architecture, memory guidance, live port ownership and exposure policy before changing Docker.',`<div class="form-stack">${incompatible?`<div class="notice notice-bad"><b>This application is not currently installable</b><span>The image is not approved for this CPU architecture.</span></div>`:aboveSpec?`<div class="notice notice-warn"><b>Above this NAS's recommended specification</b><span>This NAS reports ${Number(x.host_memory_mb||d.host_memory_mb||0)||'unknown'} MB RAM. ${x.name} is rated for at least ${Number(x.min_memory_mb||0)} MB and ${Number(x.recommended_memory_mb||x.min_memory_mb||0)} MB is recommended. Installation is still allowed, but performance may be limited.</span></div>`:`<div class="notice notice-info"><b>Resource guidance</b><span>Minimum ${Number(x.min_memory_mb||0)} MB${x.recommended_memory_mb?`, ${Number(x.recommended_memory_mb)} MB recommended`:''}. Host reports ${Number(x.host_memory_mb||d.host_memory_mb||0)||'unknown'} MB total RAM.</span></div>`}<label>Management exposure</label><select id="catalogExposure" ${incompatible?'disabled':''}><option value="lan" ${x.exposure==='lan'?'selected':''}>Trusted LAN / VPN only · recommended</option><option value="proxy" ${x.exposure==='proxy'?'selected':''} ${proxyOK?'':'disabled'}>Trusted reverse proxy only${proxyOK?'':' · configure proxy CIDRs first'}</option><option value="local" ${x.exposure==='local'?'selected':''}>Local host only</option></select><small class="field-help">Proxy-only is intended for NGINX Proxy Manager or another trusted reverse proxy whose CIDR is configured under Security. Zero1Local never publishes catalog ports to the public Internet itself.</small><label>Host port</label><input id="catalogPort" type="number" min="1024" max="65535" value="${Number(x.port||x.default_port)}" ${incompatible?'disabled':''}><div id="catalogPortStatus" class="port-check-wrap"></div>${x.needs_share?`<label>Shared folder</label><select id="catalogShare" ${incompatible?'disabled':''}>${shares.map(sh=>`<option value="${attr(sh.name)}" ${sh.name===x.share?'selected':''}>${esc(sh.name)}${x.share_read_only?' · read-only':''}</option>`).join('')}</select><small class="field-help">${x.share_read_only?'The application receives read-only access to this shared folder.':'The application receives read/write access to this shared folder.'}</small>`:''}${list(x.dependencies).length?`<div class="catalog-dependency-list"><b>Dependencies</b>${list(x.dependencies).map(dep=>`<span>${esc(dep)} ${x.dependency_status?.[dep]?statusPill('Ready','good'):statusPill('Missing','warn')}</span>`).join('')}</div>`:''}<div class="context-note">${icon('storage',16)}<span>Persistent application state stays in <code>${esc(x.data_dir)}</code> and is preserved across updates and removal.</span></div></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="catalog-install-save" data-app="${attr(x.id)}" data-update="${x.installed?'1':'0'}" ${incompatible?'disabled':''}>${x.installed?'Pull & recreate':'Install application'}</button>`);const portInput=document.getElementById('catalogPort');if(!incompatible){portInput?.addEventListener('input',()=>{clearTimeout(portInput._checkTimer);portInput._checkTimer=setTimeout(()=>checkCatalogPort(id),250)});checkCatalogPort(id)}
}
function deliverySecretPlaceholder(configured,key,label='Configured — leave blank to keep'){return configured?.[key]?label:''}
function deliveryProviderDetails(id,title,subtitle,enabled,body){return `<details class="delivery-provider" ${enabled?'open':''}><summary><span><b>${title}</b><small>${subtitle}</small></span>${statusPill(enabled?'Enabled':'Off',enabled?'good':'neutral')}</summary><div class="delivery-provider-body">${body}</div></details>`}
function toggleDeliveryEmailTransport(){const smtp=document.getElementById('deliveryEmailTransport')?.value!=='sendmail';document.getElementById('deliverySMTPFields')?.classList.toggle('hidden',!smtp)}
const automationSections = [
  ['recycle', 'Recycle Bin', 'Retention and cleanup'],
  ['ups', 'UPS Shutdown', 'Power protection'],
  ['storage', 'Storage Maintenance', 'Scheduled disk tasks'],
  ['notifications', 'Notifications', 'Alert rules and routing'],
  ['channels', 'Notification Channels', 'Delivery providers'],
  ['history', 'Delivery History', 'Recent attempts']
];
function setAutomationSection(id, updateHistory = false) {
  const nav = document.getElementById('automationSectionNav');
  const content = document.getElementById('content');
  if (!nav || !content) return;
  const selected = automationSections.some(([key]) => key === id) ? id : 'recycle';
  for (const tab of nav.querySelectorAll('[data-automation-section]')) {
    const active = tab.dataset.automationSection === selected;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', String(active));
    tab.tabIndex = active ? 0 : -1;
  }
  for (const panel of content.querySelectorAll('[data-automation-panel]')) {
    panel.hidden = panel.dataset.automationPanel !== selected;
  }
  if (updateHistory && new URLSearchParams(location.search).get('section') !== selected) {
    const url = new URL(location.href);
    url.searchParams.set('section', selected);
    history.pushState(null, '', url.pathname + url.search + url.hash);
  }
}
async function automationPage(){
  const [recycle,ups,maintenance,delivery,policy,deliveryHistory]=await Promise.all([api('/api/files/recycle-settings'),api('/api/power/ups-policy'),api('/api/maintenance'),api('/api/notifications/delivery'),api('/api/notifications/policy'),api('/api/notifications/delivery/history').catch(()=>({history:[]}))]);
  const u=ups.policy||{},m=maintenance.policy||{},n=delivery.settings||{},configured=delivery.configured||{},q=policy.quiet_hours||{},routes=policy.routes||{},deliveryEvents=list(deliveryHistory.history);
  const routeProviders=[['email','Email'],['webhook','Webhook'],['ntfy','ntfy'],['gotify','Gotify'],['monita','Monita'],['telegram','Telegram'],['discord','Discord'],['slack','Slack'],['teams','Teams'],['pushover','Pushover']];
  const routeMatrix=`<div class="notification-route-matrix"><div></div><b>Critical</b><b>Warning</b><b>Information</b>${routeProviders.map(([id,label])=>`<span>${esc(label)}</span>${['critical','warning','information'].map(sev=>`<label class="route-check"><input id="route-${sev}-${id}" type="checkbox" ${(list(routes[sev]).includes(id)||(id==='monita'&&!n.monita_enabled&&sev!=='information'))?'checked':''}><span>${sev==='critical'?'Critical':sev==='warning'?'Warning':'Info'}</span></label>`).join('')}`).join('')}</div>`;
  const emailTransport=n.email_transport||'smtp';
  const emailBody=`<label class="checkline"><input id="deliveryEmailEnabled" type="checkbox" ${n.email_enabled?'checked':''}><span><b>Enable email alerts</b><small>Send to one or more comma-separated recipients.</small></span></label><label>Recipients</label><input id="deliveryEmail" value="${attr(n.email_to||'')}" placeholder="admin@example.com, owner@example.com"><label>Email transport</label><select id="deliveryEmailTransport"><option value="smtp" ${emailTransport==='smtp'?'selected':''}>SMTP server</option><option value="sendmail" ${emailTransport==='sendmail'?'selected':''}>Local sendmail</option></select><div id="deliverySMTPFields" class="form-stack ${emailTransport==='sendmail'?'hidden':''}"><div class="field-grid"><div><label>SMTP host</label><input id="deliverySMTPHost" value="${attr(n.smtp_host||'')}" placeholder="smtp.example.com"></div><div><label>Port</label><input id="deliverySMTPPort" type="number" min="1" max="65535" value="${Number(n.smtp_port||587)}"></div></div><label>Security</label><select id="deliverySMTPSecurity"><option value="starttls" ${String(n.smtp_security||'starttls')==='starttls'?'selected':''}>STARTTLS</option><option value="tls" ${n.smtp_security==='tls'?'selected':''}>TLS / SMTPS</option><option value="none" ${n.smtp_security==='none'?'selected':''}>None</option></select><div class="field-grid"><div><label>Username</label><input id="deliverySMTPUser" autocomplete="username" value="${attr(n.smtp_username||'')}" placeholder="alerts@example.com"></div><div><label>Password</label><input id="deliverySMTPPassword" type="password" autocomplete="new-password" placeholder="${attr(deliverySecretPlaceholder(configured,'smtp_password'))}"></div></div><label>From address</label><input id="deliverySMTPFrom" value="${attr(n.smtp_from||'')}" placeholder="Zero1Local <nas@example.com>"><small class="field-help">STARTTLS is recommended. Credentials are stored only in the root-readable Zero1Local state file and are never returned to the browser.</small></div>`;
  const webhookBody=`<label class="checkline"><input id="deliveryWebhookEnabled" type="checkbox" ${n.webhook_enabled?'checked':''}><span><b>Enable generic webhook</b><small>POST a JSON Zero1Local notice to your endpoint.</small></span></label><label>Webhook URL</label><input id="deliveryWebhook" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'webhook','Configured webhook — leave blank to keep'))}"><label>Optional bearer token</label><input id="deliveryWebhookBearer" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'webhook_bearer'))}">`;
  const ntfyBody=`<label class="checkline"><input id="deliveryNtfyEnabled" type="checkbox" ${n.ntfy_enabled?'checked':''}><span><b>Enable ntfy</b><small>Works with ntfy.sh or a self-hosted ntfy server.</small></span></label><div class="field-grid"><div><label>Server URL</label><input id="deliveryNtfyURL" value="${attr(n.ntfy_url||'https://ntfy.sh')}" placeholder="https://ntfy.sh"></div><div><label>Topic</label><input id="deliveryNtfyTopic" value="${attr(n.ntfy_topic||'')}" placeholder="zero1local-alerts"></div></div><label>Optional access token</label><input id="deliveryNtfyToken" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'ntfy_token'))}">`;
  const gotifyBody=`<label class="checkline"><input id="deliveryGotifyEnabled" type="checkbox" ${n.gotify_enabled?'checked':''}><span><b>Enable Gotify</b><small>Send through your self-hosted Gotify server.</small></span></label><label>Server URL</label><input id="deliveryGotifyURL" value="${attr(n.gotify_url||'')}" placeholder="https://push.example.com"><label>Application token</label><input id="deliveryGotifyToken" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'gotify_token'))}">`;
  const monitaGroups=[['storage','Storage and drives'],['backups','Backups and replication'],['apps','Apps and containers'],['security','Sign-in and security'],['updates','Software updates'],['system','Other system notices']];
  const monitaDestinations=monitaGroups.map(([id,label])=>`<div class="settings-row monita-channel-row">
    <div><b>${label}</b><small>Select a Monita Channel, or leave Off.</small></div>
    <select data-monita-category="${id}" data-selected="${Number(n.monita_channels?.[id]||0)}">
      <option value="0">Off</option>
      ${n.monita_channels?.[id]?`<option value="${Number(n.monita_channels[id])}" selected>Saved Channel #${Number(n.monita_channels[id])}</option>`:''}
    </select>
  </div>`).join('');
  const monitaBody=`<label class="checkline"><input id="deliveryMonitaEnabled" type="checkbox" ${n.monita_enabled?'checked':''}><span><b>Deliver through Monita</b><small>Choose which kinds of NAS notifications go to each Monita Channel.</small></span></label>
    <label>Monita server address</label><input id="deliveryMonitaURL" value="${attr(n.monita_url||'')}" placeholder="https://monita.example.com">
    <label>Monita access token</label><input id="deliveryMonitaToken" type="password" autocomplete="new-password" placeholder="${attr(deliverySecretPlaceholder(configured,'monita_token'))}">
    <p class="field-help">In Monita, create a service account that can view Channels and send messages. Paste its access token here. Save the connection first, then choose Channels below. Your access token is kept on the NAS. Critical and warning deliveries are preselected for a new connection; you can change that under Notification routing.</p>
    <div class="section-heading"><div><h3>What should Monita receive?</h3><p>Each category can go to a different Channel. Off means it will not be sent.</p></div><button class="btn btn-small" data-action="monita-channels-load">Refresh Channels</button></div>
    <div class="settings-list monita-channel-list">${monitaDestinations}</div>
    <div id="monitaChannelStatus" class="field-help" role="status">Save the connection, then load available Channels.</div><div class="panel-actions"><button class="btn btn-primary" data-action="monita-config-save">Save Monita settings & routing</button></div>`;
  const telegramBody=`<label class="checkline"><input id="deliveryTelegramEnabled" type="checkbox" ${n.telegram_enabled?'checked':''}><span><b>Enable Telegram</b><small>Send through a Telegram bot to a chat, group or channel.</small></span></label><div class="field-grid"><div><label>Bot token</label><input id="deliveryTelegramToken" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'telegram_token'))}"></div><div><label>Chat ID / @channel</label><input id="deliveryTelegramChat" value="${attr(n.telegram_chat_id||'')}" placeholder="-1001234567890"></div></div>`;
  const discordBody=`<label class="checkline"><input id="deliveryDiscordEnabled" type="checkbox" ${n.discord_enabled?'checked':''}><span><b>Enable Discord</b><small>Post directly to a Discord channel webhook.</small></span></label><label>Webhook URL</label><input id="deliveryDiscordWebhook" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'discord_webhook','Configured webhook — leave blank to keep'))}">`;
  const slackBody=`<label class="checkline"><input id="deliverySlackEnabled" type="checkbox" ${n.slack_enabled?'checked':''}><span><b>Enable Slack</b><small>Use a Slack incoming webhook.</small></span></label><label>Incoming webhook URL</label><input id="deliverySlackWebhook" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'slack_webhook','Configured webhook — leave blank to keep'))}">`;
  const teamsBody=`<label class="checkline"><input id="deliveryTeamsEnabled" type="checkbox" ${n.teams_enabled?'checked':''}><span><b>Enable Microsoft Teams</b><small>Use a Teams Workflows/incoming-webhook URL.</small></span></label><label>Webhook / workflow URL</label><input id="deliveryTeamsWebhook" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'teams_webhook','Configured webhook — leave blank to keep'))}">`;
  const pushoverBody=`<label class="checkline"><input id="deliveryPushoverEnabled" type="checkbox" ${n.pushover_enabled?'checked':''}><span><b>Enable Pushover</b><small>Push alerts to your Pushover users or groups.</small></span></label><div class="field-grid"><div><label>User/group key</label><input id="deliveryPushoverUser" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'pushover_user'))}"></div><div><label>Application token</label><input id="deliveryPushoverToken" type="password" placeholder="${attr(deliverySecretPlaceholder(configured,'pushover_app_token'))}"></div></div>`;
  const automationNavigation = `<aside class="automation-sidebar"><div class="automation-nav-kicker">Automation settings</div><nav id="automationSectionNav" role="tablist" aria-label="Automation sections" aria-orientation="vertical">${automationSections.map(([id,label,note])=>`<button type="button" class="automation-nav-button" id="automation-tab-${id}" role="tab" aria-controls="automation-panel-${id}" aria-selected="false" tabindex="-1" data-automation-section="${id}"><span class="automation-nav-copy"><strong>${esc(label)}</strong><small>${esc(note)}</small></span><span class="automation-nav-chevron" aria-hidden="true">&#8250;</span></button>`).join('')}</nav></aside>`;
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Control Panel','Automation','Retention, scheduled maintenance, UPS shutdown policy and outbound alerts.')}<div class="automation-workspace">${automationNavigation}<div class="automation-panel-stack"><section id="automation-panel-recycle" role="tabpanel" aria-labelledby="automation-tab-recycle" class="content-panel automation-panel" data-automation-panel="recycle">${sectionTitle('Recycle Bin retention','Old recycled items are purged by zero1d even when no browser is open.')}<label>Default retention</label><select id="recycleRetention">${[1,3,7,14,30,60,90,365].map(v=>`<option value="${v}" ${Number(recycle.retention_days)===v?'selected':''}>${v} day${v===1?'':'s'}</option>`).join('')}</select>${list(recycle.share_retention).length?`<div class="share-retention-list"><b>Per-share overrides</b><small>Leave a share on Default unless its data needs a different cleanup window.</small>${list(recycle.share_retention).map(x=>`<div class="settings-row"><div><b>${esc(x.share)}</b><small>${x.overridden?`${Number(x.retention_days)}-day override`:'Uses global default'}</small></div><select data-recycle-share="${attr(x.share)}"><option value="0" ${x.overridden?'':'selected'}>Default</option>${[1,3,7,14,30,60,90,365,730,3650].map(v=>`<option value="${v}" ${x.overridden&&Number(x.retention_days)===v?'selected':''}>${v} day${v===1?'':'s'}</option>`).join('')}</select></div>`).join('')}</div>`:''}<div class="panel-actions"><button class="btn btn-primary" data-action="recycle-settings-save">Save retention</button></div></section><section id="automation-panel-ups" role="tabpanel" aria-labelledby="automation-tab-ups" class="content-panel automation-panel" data-automation-panel="ups">${sectionTitle('UPS shutdown policy','If NUT reports that the NAS is on battery, Zero1Local can shut down cleanly before power is exhausted.')}<label class="switch-row"><div><b>Automatic UPS shutdown</b><small>Only acts when a managed UPS reports on-battery status.</small></div><span class="switch"><input id="upsPolicyEnabled" type="checkbox" ${u.enabled?'checked':''}><i></i></span></label><div class="field-grid"><div><label>Battery threshold</label><input id="upsBattery" type="number" min="5" max="95" value="${Number(u.shutdown_battery_percent||20)}"></div><div><label>Minutes on battery</label><input id="upsMinutes" type="number" min="1" max="240" value="${Number(u.shutdown_after_minutes||15)}"></div></div><label class="checkline"><input id="upsRestart" type="checkbox" ${u.restart_after_power_return!==false?'checked':''}><span><b>Allow restart after utility power returns</b><small>Hardware/firmware support ultimately controls automatic power-on.</small></span></label><div class="panel-actions"><button class="btn btn-primary" data-action="ups-policy-save">Save UPS policy</button></div></section><section id="automation-panel-storage" role="tabpanel" aria-labelledby="automation-tab-storage" class="content-panel automation-panel" data-automation-panel="storage">${sectionTitle('Storage maintenance','Staggered schedules avoid launching all maintenance work at once.')}<label class="switch-row"><div><b>Scheduled storage maintenance</b><small>SMART self-tests run in drive firmware; RAID scrub requests md consistency checking.</small></div><span class="switch"><input id="maintenanceEnabled" type="checkbox" ${m.enabled?'checked':''}><i></i></span></label><div class="maintenance-grid"><div><b>SMART short test</b><input id="smartShortDay" value="${attr(m.smart_short_day||'Sunday')}" placeholder="Sunday"><input id="smartShortTime" type="time" value="${attr(m.smart_short_time||'03:00')}"></div><div><b>SMART long test</b><input id="smartLongDay" value="${attr(m.smart_long_day||'1')}" placeholder="1"><input id="smartLongTime" type="time" value="${attr(m.smart_long_time||'04:00')}"></div><div><b>RAID scrub</b><input id="raidScrubDay" value="${attr(m.raid_scrub_day||'1')}" placeholder="1"><input id="raidScrubTime" type="time" value="${attr(m.raid_scrub_time||'02:00')}"></div></div><small class="field-help">Use a weekday name for weekly tests or a day-of-month number for monthly tests.</small><div class="panel-actions"><button class="btn" data-action="maintenance-run" data-kind="smart-short">Run SMART short</button><button class="btn" data-action="maintenance-run" data-kind="smart-long">Run SMART long</button><button class="btn" data-action="maintenance-run" data-kind="raid-scrub">Run RAID check</button><button class="btn btn-primary" data-action="maintenance-save">Save maintenance schedule</button></div>${list(m.history).length?`<div class="maintenance-history"><h3>Maintenance history</h3><div class="table-frame"><table class="data-table"><thead><tr><th>Operation</th><th>Started</th><th>Status</th><th>Result</th></tr></thead><tbody>${list(m.history).slice(0,20).map(x=>`<tr><td>${esc(String(x.kind||'').replaceAll('-',' '))}</td><td>${esc(fmtDate(x.started_at))}</td><td>${statusPill(x.status||'unknown',x.status==='completed'?'good':x.status==='failed'?'bad':x.status==='deferred'?'warn':'neutral')}</td><td>${esc(x.detail||'—')}</td></tr>`).join('')}</tbody></table></div></div>`:''}</section><section id="automation-panel-notifications" role="tabpanel" aria-labelledby="automation-tab-notifications" class="content-panel outbound-notifications automation-panel" data-automation-panel="notifications">${sectionTitle('Outbound notifications','Choose one or several delivery channels. Zero1Local remains fully local and fully usable without any external service.')}<label class="switch-row"><div><b>Send appliance alerts outside the NAS UI</b><small>Each enabled channel is tracked independently so one successful provider does not hide a failure on another.</small></div><span class="switch"><input id="deliveryEnabled" type="checkbox" ${n.enabled?'checked':''}><i></i></span></label><div class="delivery-severity"><b>Send severities</b><label class="checkline"><input id="deliveryCritical" type="checkbox" ${list(n.severities).includes('critical')?'checked':''}><span>Critical</span></label><label class="checkline"><input id="deliveryWarning" type="checkbox" ${list(n.severities).includes('warning')?'checked':''}><span>Warning</span></label><label class="checkline"><input id="deliveryInformation" type="checkbox" ${list(n.severities).includes('information')?'checked':''}><span>Information</span></label></div><div class="notification-policy-card"><div class="settings-row"><div><b>Quiet hours</b><small>Warning and information notifications wait until quiet hours end. Critical alerts always deliver immediately.</small></div><label class="switch"><input id="notificationQuietEnabled" type="checkbox" ${q.enabled?'checked':''}><i></i></label></div><div class="field-grid"><div><label>Quiet hours start</label><input id="notificationQuietStart" type="time" value="${attr(q.start||'22:00')}"></div><div><label>Quiet hours end</label><input id="notificationQuietEnd" type="time" value="${attr(q.end||'07:00')}"></div></div><h3>Delivery routing</h3><p class="field-help">Choose exactly where each severity goes. Disabled providers are skipped without opening any inbound firewall ports.</p>${routeMatrix}<div class="panel-actions"><button class="btn btn-primary" data-action="notification-policy-save">Save routing policy</button></div></div></section><section id="automation-panel-channels" role="tabpanel" aria-labelledby="automation-tab-channels" class="content-panel outbound-notifications automation-panel" data-automation-panel="channels">${sectionTitle('Notification Channels','Configure delivery providers and send a test alert.')}<div class="delivery-provider-grid">${deliveryProviderDetails('email','Email','Full SMTP or preserved local sendmail support',n.email_enabled,emailBody)}${deliveryProviderDetails('webhook','Webhook','Generic JSON HTTPS integration',n.webhook_enabled,webhookBody)}${deliveryProviderDetails('ntfy','ntfy','ntfy.sh or self-hosted push',n.ntfy_enabled,ntfyBody)}${deliveryProviderDetails('gotify','Gotify','Self-hosted Gotify application push',n.gotify_enabled,gotifyBody)}${deliveryProviderDetails('monita','Monita','Choose notification types and Channels',n.monita_enabled,monitaBody)}${deliveryProviderDetails('telegram','Telegram','Bot API delivery',n.telegram_enabled,telegramBody)}${deliveryProviderDetails('discord','Discord','Channel webhook',n.discord_enabled,discordBody)}${deliveryProviderDetails('slack','Slack','Incoming webhook',n.slack_enabled,slackBody)}${deliveryProviderDetails('teams','Microsoft Teams','Workflows / incoming webhook',n.teams_enabled,teamsBody)}${deliveryProviderDetails('pushover','Pushover','Mobile push API',n.pushover_enabled,pushoverBody)}</div><div class="panel-actions"><button class="btn" data-action="delivery-test">Send test</button><button class="btn btn-primary" data-action="delivery-save">Save notification delivery</button></div></section><section id="automation-panel-history" role="tabpanel" aria-labelledby="automation-tab-history" class="content-panel automation-panel" data-automation-panel="history">${sectionTitle('Delivery history','Recent outbound attempts are recorded without storing provider credentials in browser-visible history.')}<div class="table-frame"><table class="data-table"><thead><tr><th>Time</th><th>Provider</th><th>Notice</th><th>Severity</th><th>Result</th></tr></thead><tbody>${deliveryEvents.slice(0,50).map(x=>`<tr><td>${esc(fmtDate(x.at))}</td><td><b>${esc(String(x.provider||'').toUpperCase())}</b>${x.test?'<small>Test delivery</small>':''}</td><td>${esc(x.title||x.notice_id||'Notification')}<small>${esc(x.notice_id||'')}</small></td><td>${esc(x.severity||'—')}</td><td>${statusPill(x.ok?'Delivered':'Failed',x.ok?'good':'bad')}${x.error?`<small class="error-detail">${esc(x.error)}</small>`:''}</td></tr>`).join('')||'<tr><td colspan="5">No outbound delivery attempts have been recorded yet.</td></tr>'}</tbody></table></div></section></div></div></section>`;
  const sectionNav = document.getElementById('automationSectionNav');
  sectionNav?.addEventListener('click', event => {
    const tab = event.target.closest('[data-automation-section]');
    if (tab && sectionNav.contains(tab)) setAutomationSection(tab.dataset.automationSection, true);
  });
  sectionNav?.addEventListener('keydown', event => {
    if (!['ArrowUp','ArrowDown','Home','End'].includes(event.key)) return;
    const tabs = Array.from(sectionNav.querySelectorAll('[data-automation-section]'));
    const index = tabs.indexOf(event.target.closest('[data-automation-section]'));
    if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 :
      (index + (event.key === 'ArrowDown' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click();
    tabs[next].focus();
  });
  setAutomationSection(new URLSearchParams(location.search).get('section') || 'recycle');
  toggleDeliveryEmailTransport();
  if(n.monita_enabled)loadMonitaChannelOptions().catch(()=>{});
}

const adminPermissionOptions=[['status.read','Read appliance status'],['files.manage','Files & shares'],['protection.manage','Data protection'],['apps.manage','Apps & Docker'],['users.manage','Users & storage'],['network.manage','Network & remote access'],['automation.manage','Automation & notifications'],['security.manage','Security administration']];
function adminPermissionsHTML(selected=[]){return `<div id="adminPermissionWrap" class="admin-permission-grid">${adminPermissionOptions.map(([id,label])=>`<label class="checkline"><input type="checkbox" data-admin-permission="${attr(id)}" ${list(selected).includes(id)?'checked':''}><span><b>${esc(label)}</b><small>${esc(id)}</small></span></label>`).join('')}</div>`}
function toggleAdminCustomPermissions(){const custom=document.getElementById('adminRole')?.value==='custom';document.getElementById('adminPermissionSection')?.classList.toggle('hidden',!custom)}
async function administratorsPage(){const d=await api('/api/security/admins',{fresh:true});window.__zero1Admins=d;document.getElementById('content').innerHTML=`<section class="screen">${heading('Control Panel / Security','Administrators','Give trusted people their own Zero1Local web login without sharing the root password.','<button class="btn btn-primary" data-action="admin-create-open">Add administrator</button>')}<section class="content-panel"><div class="table-frame"><table class="data-table"><thead><tr><th>Account</th><th>Role</th><th>Security</th><th>Expires</th><th></th></tr></thead><tbody><tr><td><b>root</b><small>Appliance super-administrator</small></td><td>${statusPill('Administrator','good')}</td><td>${statusPill('Root security policy','good')}</td><td>Never</td><td><span class="locked-label">Protected</span></td></tr>${list(d.admins).map(x=>`<tr><td><b>${esc(x.username)}</b><small>${x.enabled?'Enabled':'Disabled'}${list(x.allowed_cidrs).length?` · ${list(x.allowed_cidrs).length} network restriction${list(x.allowed_cidrs).length===1?'':'s'}`:''}</small></td><td>${esc(x.role)}${x.role==='custom'?`<small>${list(x.permissions).length} explicit permission${list(x.permissions).length===1?'':'s'}</small>`:''}</td><td>${statusPill(x.totp_enabled?'2FA enabled':'Password only',x.totp_enabled?'good':'warn')}</td><td>${x.expires_at?esc(fmtDate(x.expires_at)):'Never'}</td><td class="row-actions"><button class="btn btn-small" data-action="admin-edit-open" data-admin="${attr(x.username)}">Edit</button><button class="btn btn-small" data-action="admin-totp-setup" data-admin="${attr(x.username)}">${x.totp_enabled?'Reset 2FA':'Set up 2FA'}</button>${x.totp_enabled?`<button class="btn btn-small" data-action="admin-totp-disable" data-admin="${attr(x.username)}">Disable 2FA</button>`:''}<button class="btn btn-small danger-soft" data-action="admin-delete" data-admin="${attr(x.username)}">Remove</button></td></tr>`).join('')}</tbody></table></div></section><div class="role-grid"><article><b>Administrator</b><span>Full Zero1Local management.</span></article><article><b>Storage Admin</b><span>Files, shares, users, storage and data protection changes.</span></article><article><b>App Admin</b><span>Containers and the managed App Catalog.</span></article><article><b>Auditor</b><span>Read-only access to non-secret appliance information.</span></article><article><b>Custom</b><span>Choose explicit server-enforced permissions for this administrator.</span></article></div><div class="context-note">${icon('security',16)} <span>Each delegated administrator can have independent TOTP, expiration and source-CIDR restrictions. Recovery keys and configuration-backup secrets remain reserved for the root/full Administrator boundary.</span></div></section>`}
function adminCreateModal(){openModal('Add Zero1Local administrator','This creates a web-management credential only; it does not create or change an SMB/Linux account.',`<div class="form-stack"><label>Username</label><input id="adminUsername" autocomplete="off" placeholder="alex"><label>Role</label><select id="adminRole"><option value="administrator">Administrator</option><option value="storage-admin">Storage Admin</option><option value="app-admin">App Admin</option><option value="auditor">Auditor</option><option value="custom">Custom</option></select><div id="adminPermissionSection" class="hidden"><label>Custom permissions</label>${adminPermissionsHTML([])}</div><label>Password</label><input id="adminPassword" type="password" autocomplete="new-password"><small class="field-help">Minimum 10 characters.</small><label>Allowed source CIDRs</label><textarea id="adminCIDRs" rows="3" placeholder="192.168.0.0/24\n10.10.0.0/24"></textarea><small class="field-help">Optional. Blank allows any network already permitted by the Zero1Local host firewall.</small><label>Account expires</label><input id="adminExpires" type="datetime-local"><small class="field-help">Optional. Existing sessions stop working after expiration.</small></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="admin-create-save">Create administrator</button>`);document.getElementById('adminRole')?.addEventListener('change',toggleAdminCustomPermissions);toggleAdminCustomPermissions()}
function adminEditModal(name){const x=list((window.__zero1Admins||{}).admins).find(a=>a.username===name);if(!x)return;let dt='';try{dt=x.expires_at?new Date(x.expires_at).toISOString().slice(0,16):''}catch{}openModal(`Edit ${name}`,'These controls are checked by zero1d on every authenticated request, including sessions that are already open.',`<div class="form-stack"><label class="checkline"><input id="adminEnabled" type="checkbox" ${x.enabled?'checked':''}><span><b>Account enabled</b></span></label><label>Role</label><select id="adminRole"><option value="administrator" ${x.role==='administrator'?'selected':''}>Administrator</option><option value="storage-admin" ${x.role==='storage-admin'?'selected':''}>Storage Admin</option><option value="app-admin" ${x.role==='app-admin'?'selected':''}>App Admin</option><option value="auditor" ${x.role==='auditor'?'selected':''}>Auditor</option><option value="custom" ${x.role==='custom'?'selected':''}>Custom</option></select><div id="adminPermissionSection" class="${x.role==='custom'?'':'hidden'}"><label>Custom permissions</label>${adminPermissionsHTML(x.permissions)}</div><label>Allowed source CIDRs</label><textarea id="adminCIDRs" rows="3">${esc(list(x.allowed_cidrs).join('\n'))}</textarea><label>Account expires</label><input id="adminExpires" type="datetime-local" value="${attr(dt)}"><small class="field-help">Blank means no expiry. Narrowing CIDRs or disabling the account invalidates access on the next request.</small></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="admin-update-save" data-admin="${attr(name)}">Save administrator</button>`);document.getElementById('adminRole')?.addEventListener('change',toggleAdminCustomPermissions);toggleAdminCustomPermissions()}
function adminPermissionValues(){return [...document.querySelectorAll('[data-admin-permission]:checked')].map(x=>x.dataset.adminPermission)}
function adminCIDRValues(){return String(document.getElementById('adminCIDRs')?.value||'').split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean)}
function adminExpiryValue(){const v=document.getElementById('adminExpires')?.value||'';return v?new Date(v).toISOString():''}


async function synchronizationPage(){
  // Guidance only; NAS peer and job controls are exclusively on Replication.
  document.getElementById('content').innerHTML=`<section class="screen">${heading('Sync & Backup','Synchronization','Native NAS-to-NAS replication stays in Zero1Local. Cloud synchronization belongs to optional Syncria.')}
  <section class="content-panel">${sectionTitle('NAS → NAS','Zero1Local native replication')}<p>Pair another NAS and manage scheduled or manual replication jobs in NAS Replication. Replication runs directly between the NAS devices.</p><a class="btn btn-primary" href="/replication">Open NAS Replication</a></section>
  <section class="content-panel">${sectionTitle('NAS ↔ Cloud','Syncria — optional Docker companion')}<p>Zero1Local no longer synchronizes with cloud providers. Run Syncria as a separate Docker container and configure cloud accounts and mappings in Syncria itself.</p><div class="row-actions"><a class="btn" href="/docker">Docker Containers</a><a class="btn" href="/help/sync">Sync & Backup help</a></div></section></section>`;
}
function mobileDeviceLabel(device){
  const nickname=String(device?.nickname||'').trim(),name=String(device?.name||device?.id||'Phone').trim();
  return nickname?`${nickname} — ${name}`:name;
}

function mobileNicknameModal(deviceID=''){
  const d=window.__zero1Mobile||{},device=list(d.devices).find(x=>x.id===deviceID);
  if(!device){flash('Phone is no longer connected.','warn');return;}
  if(!device.stable){flash('This phone does not expose a stable identity, so a nickname cannot be saved safely.','warn');return;}
  openModal('Phone nickname','Give this physical phone a familiar name. The detected device name remains visible underneath it.',`<div class="form-stack"><div class="notice notice-info"><b>${esc(device.name||'Detected phone')}</b><span>${esc(device.detail||'Stable phone identity detected.')}</span></div><label>Nickname</label><input id="mobileNickname" maxlength="64" value="${attr(device.nickname||'')}" placeholder="Brad's Phone"><small class="field-help">Leave this blank and save to remove the nickname. The nickname is stored against this phone's stable hardware identity.</small></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="mobile-nickname-save" data-device="${attr(device.id)}">Save nickname</button>`);
}

async function mobileOffloadPage(){
  if(normalizedPath(location.pathname)==='/mobile-offload') history.replaceState({},'', '/phone-transfer'+location.search);
  const d=await api('/api/mobile-offload',{fresh:true,stale:false});window.__zero1Mobile=d;
  const devices=list(d.devices),rules=list(d.rules),usb=list(d.usb_devices),ready=devices.filter(x=>x.ready),manualReady=ready.filter(x=>x.kind==='android');
  const usbNames=usb.slice(0,4).map(x=>[x.product,x.manufacturer].filter(Boolean).join(' · ')||`USB ${x.vendor_id||'?'}:${x.product_id||'?'}`).join(', ');
  const connectionState=ready.length?`<div class="inline-status good"><b>${ready.length} phone${ready.length===1?'':'s'} ready</b><span>Automatic rules and manual transfer are available.</span></div>`:devices.length?`<div class="inline-status warn"><b>Phone detected but not ready</b><span>${esc(devices.map(x=>x.detail).filter(Boolean).join(' · ')||'Unlock the phone and allow file/media access, then refresh.')}</span></div>`:usb.length?`<div class="inline-status warn"><b>Phone media unavailable</b><span>${esc(usbNames||'Unlock the phone and allow file/media access.')}</span></div>`:`<div class="inline-status neutral"><b>No phone connected</b><span>Connect and unlock a phone, then refresh.</span></div>`;
  const q=d.qualification||{},qe=q.evidence||{},host=q.host_role||{};
  const checks=[['USB host role',!!host.ready,host.ready?'Ready':'Not observed'],['Host role after reboot',!!qe.boot_usb_host_role,qe.boot_usb_host_role?'Observed':'Not observed'],['Stable device rule',!!qe.stable_rule_saved,qe.stable_rule_saved?'Observed':'Not observed'],['Destination creation',!!qe.destination_folder_created,qe.destination_folder_created?'Observed':'Not observed'],['Manual Android transfer',!!qe.manual_android_transfer,qe.manual_android_transfer?'Observed':'Not observed'],['Automatic Android transfer',!!qe.automatic_android_offload,qe.automatic_android_offload?'Observed':'Not observed'],['Apple transfer',!!qe.apple_offload,qe.apple_offload?'Observed':'Not observed']];
  const phones=devices.map(x=>`<div class="settings-row phone-row"><div class="entity-primary"><div class="avatar">${x.kind==='iphone'?'iOS':'MTP'}</div><div><b>${esc(x.nickname||x.name)}</b><small>${esc(x.kind==='iphone'?'Apple media':'Android media')} · ${esc(x.detail||'')}</small></div></div><div class="row-actions">${statusPill(x.ready?'Ready':'Needs attention',x.ready?'good':'warn')}${x.stable?`<button class="btn btn-small" data-action="mobile-nickname-open" data-device="${attr(x.id)}">${x.nickname?'Rename':'Name'}</button>`:''}<button class="btn btn-small" data-action="mobile-rule-create" data-device="${attr(x.id)}" ${x.ready?'':'disabled'}>Add rule</button>${x.kind==='android'?`<button class="btn btn-small btn-primary" data-action="mobile-manual-open" data-device="${attr(x.id)}" ${x.ready?'':'disabled'}>Transfer</button>`:''}</div></div>`).join('');
  document.getElementById('content').innerHTML=`<section class="screen phone-transfer-screen">${heading('Sync & Backup','Phone Transfer','Move photos, videos and files from connected phones into shared folders.',`<div class="row-actions"><button class="btn" data-action="mobile-refresh">Refresh</button><button class="btn btn-primary" data-action="mobile-manual-open" ${manualReady.length?'':'disabled'}>Manual transfer</button></div>`)}<div class="phone-transfer-layout"><main class="phone-transfer-main"><section class="content-panel phone-transfer-workspace">${sectionTitle('Phones & rules','Connected phones and their automatic transfer behavior live together here.')} ${connectionState}<div class="phone-transfer-subsection"><div class="section-heading compact"><div><h3>Connected phones</h3><p>${devices.length} phone${devices.length===1?'':'s'} detected.</p></div></div><div class="settings-list">${phones||emptyState('No phone connected','Connect and unlock a phone, then choose Refresh.')}</div></div><div class="phone-transfer-subsection"><div class="section-heading compact"><div><h3>Automatic transfer rules</h3><p>${rules.length} saved rule${rules.length===1?'':'s'}.</p></div><button class="btn btn-small" data-action="mobile-rule-create" ${ready.length?'':'disabled'}>+ Add rule</button></div><div class="table-frame borderless"><table class="data-table"><thead><tr><th>Phone</th><th>Source</th><th>Destination</th><th>Mode</th><th>When</th><th>Last run</th><th></th></tr></thead><tbody>${rules.map(x=>`<tr><td><b>${esc(x.device_name||x.device_id)}</b></td><td>${esc(x.source_path||'Media')}</td><td>${esc(x.share)}${x.destination_path?` / ${esc(x.destination_path)}`:''}</td><td>${esc(x.mode==='move'?'Move':'Copy')}</td><td>${esc(x.auto?'On connect':'Manual')}</td><td>${x.last_run_at?esc(fmtDate(x.last_run_at)):'Never'}</td><td class="row-actions"><button class="btn btn-small" data-action="mobile-rule-run" data-rule="${attr(x.id)}">Run</button><button class="btn btn-small btn-quiet" data-action="mobile-rule-edit" data-rule="${attr(x.id)}">Edit</button><button class="btn btn-small danger-soft" data-action="mobile-rule-delete" data-rule="${attr(x.id)}">Remove</button></td></tr>`).join('')||'<tr><td colspan="7">No automatic transfer rules yet.</td></tr>'}</tbody></table></div></div></section></main><aside class="phone-transfer-info"><div class="info-rail-section"><h3>Automatic transfer</h3><p>Save a phone-specific rule and Zero1Local can transfer from that phone when it is connected.</p></div><div class="info-rail-section"><h3>Manual transfer</h3><p>Choose individual files from a connected Android phone. Move removes the phone copy only after the NAS copy verifies successfully.</p></div><details class="advanced"><summary>Connection help</summary><div class="advanced-body"><p>On Android, select <b>Transferring files / Android Auto</b> if USB defaults to charging only. On Apple devices, unlock and approve Trust when asked.</p></div></details><details class="advanced feature-checks"><summary>Feature checks</summary><div class="advanced-body"><div class="fact-list">${checks.map(([label,ok,detail])=>`<div><div><b>${esc(label)}</b><small>${esc(detail)}</small></div>${statusPill(ok?'Working':'Not observed',ok?'good':'neutral')}</div>`).join('')}</div></div></details></aside></div></section>`;
}
function setMobileDestination(share,path){
  const shareInput=document.getElementById('mobileShare'),pathInput=document.getElementById('mobileDestination'),label=document.getElementById('mobileDestinationLabel');
  if(shareInput)shareInput.value=share||'';if(pathInput)pathInput.value=path||'';
  if(label)label.innerHTML=share?`<div><b>${esc(share)}${path?` / ${esc(path)}`:''}</b><small>Existing NAS folder</small></div>`:'<div><b>No NAS destination selected</b><small>Choose a shared folder and folder inside it.</small></div>';
}
function setMobileSource(path,chosen=true){
  const input=document.getElementById('mobileSource'),label=document.getElementById('mobileSourceLabel');
  if(input){input.value=path||'';input.dataset.chosen=chosen?'1':'0'}
  if(label)label.innerHTML=chosen?`<div><b>${esc(path||'Media root')}</b><small>Folder on connected phone</small></div>`:'<div><b>No phone source selected</b><small>Browse the connected phone and choose a folder.</small></div>';
}
function mobileRuleModal(deviceID=''){
  const d=window.__zero1Mobile||{},devices=list(d.devices).filter(x=>x.ready),chosen=deviceID&&devices.some(x=>x.id===deviceID)?deviceID:devices[0]?.id||'';
  openModal('Set up Phone Transfer','Browse both sides. Zero1Local never requires you to type a NAS or phone folder path.',`<div class="form-stack"><div class="notice notice-info"><b>Android USB mode</b><span>If Android defaults to “Charging phone only”, open the phone’s USB notification and select “Transferring files / Android Auto” before browsing.</span></div><label>Phone</label><select id="mobileDevice">${devices.map(x=>`<option value="${attr(x.id)}" data-kind="${attr(x.kind)}" ${x.id===chosen?'selected':''}>${esc(mobileDeviceLabel(x))}</option>`).join('')}</select><label>Source folder on phone</label><div class="folder-picker-wrap"><div class="selected-folder" id="mobileSourceLabel"><div><b>No phone source selected</b><small>Browse the connected phone and choose a folder.</small></div></div><div class="folder-browser" id="mobileSourceBrowser"><div class="folder-picker-empty">Choose Browse phone to open the connected device.</div></div></div><input id="mobileSource" type="hidden" value="" data-chosen="0"><div class="row-actions"><button class="btn" data-action="mobile-source-browse" data-path="">Browse phone</button></div><label>Destination on NAS</label><div class="folder-picker-wrap"><div class="selected-folder" id="mobileDestinationLabel"><div><b>No NAS destination selected</b><small>Choose a shared folder and folder inside it.</small></div></div><div class="folder-browser" id="mobileDestinationBrowser"><div class="folder-picker-empty">Choose NAS folder to browse existing shares.</div></div></div><input id="mobileShare" type="hidden" value=""><input id="mobileDestination" type="hidden" value=""><div class="row-actions"><button class="btn" data-action="mobile-destination-browse" data-share="" data-path="">Choose NAS folder</button></div><label>After a verified transfer</label><select id="mobileMode"><option value="copy">Keep files on phone</option><option value="move">Delete each phone file only after SHA-256 verification</option></select><label class="checkline"><input id="mobileAuto" type="checkbox" checked><span><b>Automatically transfer when this phone is connected</b><small>Only one run starts per connect event.</small></span></label></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="mobile-rule-save">Save rule</button>`);
  const device=document.getElementById('mobileDevice');
  device?.addEventListener('change',()=>{setMobileSource('',false);const host=document.getElementById('mobileSourceBrowser');if(host)host.innerHTML='';});
}

function showMobileDestinationFolderCreate(share,path){
  const box=document.getElementById('mobileDestinationCreate');if(!box)return;
  box.innerHTML=`<div class="inline-folder-create"><label>New folder in ${esc(share)}${path?` / ${esc(path)}`:''}</label><div class="row-actions"><input id="mobileDestinationNewFolderName" placeholder="Brad's Phone" autocomplete="off"><button class="btn btn-small btn-primary" data-action="mobile-destination-new-folder-save" data-share="${attr(share)}" data-path="${attr(path)}">Create & use</button><button class="btn btn-small btn-quiet" data-action="mobile-destination-new-folder-cancel">Cancel</button></div><small>Create the folder without leaving Phone Transfer.</small></div>`;
  document.getElementById('mobileDestinationNewFolderName')?.focus();
}

async function loadMobileDestinationBrowser(share='',path=''){
  const host=document.getElementById('mobileDestinationBrowser');if(!host)return;
  const d=window.__zero1Mobile||{},shares=list(d.shares);
  if(!share){host.innerHTML=`<div class="folder-picker-head"><div><b>Choose a shared folder</b><small>Only existing Zero1Local shared folders are available.</small></div></div><div class="folder-picker-list">${shares.map(x=>`<button data-action="mobile-destination-browse" data-share="${attr(x.name)}" data-path=""><span class="folder-icon"></span><div><b>${esc(x.name)}</b><small>Shared folder</small></div></button>`).join('')||'<div class="folder-picker-empty">No shared folders are available.</div>'}</div>`;return;}
  host.innerHTML='<div class="loading"><span class="spinner"></span>Loading NAS folders…</div>';
  try{
    const f=await api('/api/files?share='+encodeURIComponent(share)+'&rel='+encodeURIComponent(path),{busy:false,fresh:true});
    const parent=String(path||'').split('/').filter(Boolean).slice(0,-1).join('/');
    host.innerHTML=`<div class="folder-picker-head"><div><b>${esc(share)}${path?` / ${esc(path)}`:''}</b><small>Select this folder, create a new folder here, or open a child folder.</small></div><div class="row-actions"><button class="btn btn-small btn-primary" data-action="mobile-destination-select" data-share="${attr(share)}" data-path="${attr(path)}">Use this folder</button><button class="btn btn-small" data-action="mobile-destination-new-folder" data-share="${attr(share)}" data-path="${attr(path)}">New folder</button><button class="btn btn-small" data-action="mobile-destination-browse" data-share="${attr(path?share:'')}" data-path="${attr(path?parent:'')}">${path?'Up':'Shared folders'}</button></div></div><div id="mobileDestinationCreate"></div><div class="folder-picker-list">${list(f.entries).filter(x=>x.directory&&!x.symlink).map(x=>`<button data-action="mobile-destination-browse" data-share="${attr(share)}" data-path="${attr(x.relative_path||[path,x.name].filter(Boolean).join('/'))}"><span class="folder-icon"></span><div><b>${esc(x.name)}</b><small>Folder</small></div></button>`).join('')||'<div class="folder-picker-empty">No child folders.</div>'}</div>`;
  }catch(e){host.innerHTML=`<div class="notice notice-bad"><b>Unable to browse NAS folder</b><span>${esc(e.message)}</span></div>`}
}

async function loadMobileSourceBrowser(path=''){
  const host=document.getElementById('mobileSourceBrowser'),device=document.getElementById('mobileDevice')?.value||'';if(!host||!device)return;
  host.innerHTML='<div class="loading"><span class="spinner"></span>Connecting to phone…</div>';
  try{
    const d=await api('/api/mobile-offload/browse?device='+encodeURIComponent(device)+'&path='+encodeURIComponent(path),{busy:false,fresh:true});
    host.innerHTML=`<div class="folder-picker-head"><div><b>${esc(path||'Media root')}</b><small>Select this folder or open a child folder.</small></div><div class="row-actions"><button class="btn btn-small btn-primary" data-action="mobile-source-select" data-path="${attr(path)}">Use this folder</button>${path?`<button class="btn btn-small" data-action="mobile-source-browse" data-path="${attr(d.parent||'')}">Up</button>`:''}</div></div><div class="folder-picker-list">${list(d.entries).map(x=>`<button data-action="mobile-source-browse" data-path="${attr(x.path)}"><span class="folder-icon"></span><div><b>${esc(x.name)}</b><small>Phone folder</small></div></button>`).join('')||'<div class="folder-picker-empty">No child folders.</div>'}</div>`;
  }catch(e){host.innerHTML=`<div class="notice notice-bad"><b>Unable to browse phone</b><span>${esc(e.message)}</span></div>`}
}

async function closeMobileManualSession(){
  const sid=String(window.__zero1ManualSession||'').trim();
  window.__zero1ManualSession='';
  if(!sid)return;
  try{await api('/api/mobile-offload/manual/session/close',{method:'POST',busy:false,body:JSON.stringify({session_id:sid})})}catch(_){}
}

function mobileManualTransferModal(deviceID=''){
  const d=window.__zero1Mobile||{},devices=list(d.devices).filter(x=>x.ready&&x.kind==='android'),chosen=deviceID&&devices.some(x=>x.id===deviceID)?deviceID:devices[0]?.id||'';
  window.__zero1ManualSession='';
  window.__zero1ManualSelection=new Map();
  window.__zero1ManualBrowseBusy=false;
  openModal('Manual phone transfer','Choose specific files from a connected Android phone, then copy or move them to a NAS folder.',`<div class="form-stack"><div class="notice notice-info"><b>Android USB mode</b><span>The phone must be unlocked and set to “Transferring files / Android Auto”, not “Charging phone only”.</span></div><label>Phone</label><select id="mobileManualDevice">${devices.map(x=>`<option value="${attr(x.id)}" ${x.id===chosen?'selected':''}>${esc(mobileDeviceLabel(x))}</option>`).join('')}</select><label>Files on phone</label><div class="folder-picker-wrap"><div class="selected-folder" id="mobileManualSelectionSummary"><div><b>No files selected</b><small>Browse the phone and select individual files.</small></div></div><div class="folder-browser mobile-manual-browser" id="mobileManualBrowser"><div class="folder-picker-empty">Choose Browse phone to open the connected device.</div></div></div><div class="row-actions"><button class="btn" data-action="mobile-manual-browse" data-path="">Browse phone</button><button class="btn btn-quiet" data-action="mobile-manual-clear">Clear selection</button></div><label>Destination on NAS</label><div class="folder-picker-wrap"><div class="selected-folder" id="mobileDestinationLabel"><div><b>No NAS destination selected</b><small>Choose a shared folder and folder inside it.</small></div></div><div class="folder-browser" id="mobileDestinationBrowser"><div class="folder-picker-empty">Choose NAS folder to browse existing shares.</div></div></div><input id="mobileShare" type="hidden" value=""><input id="mobileDestination" type="hidden" value=""><div class="row-actions"><button class="btn" data-action="mobile-destination-browse" data-share="" data-path="">Choose NAS folder</button></div><label>After each verified transfer</label><select id="mobileMode"><option value="copy">Keep file on phone</option><option value="move">Delete phone file only after SHA-256 verification</option></select></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="mobile-manual-transfer-start">Start transfer</button>`);
  const sel=document.getElementById('mobileManualDevice');
  sel?.addEventListener('change',async()=>{await closeMobileManualSession();window.__zero1ManualSelection=new Map();updateMobileManualSelectionSummary();const host=document.getElementById('mobileManualBrowser');if(host)host.innerHTML='<div class="folder-picker-empty">Choose Browse phone to open this device.</div>';});
}

function updateMobileManualSelectionSummary(){
  const map=window.__zero1ManualSelection instanceof Map?window.__zero1ManualSelection:new Map(),box=document.getElementById('mobileManualSelectionSummary');if(!box)return;
  const items=[...map.values()],bytes=items.reduce((n,x)=>n+Number(x.size||0),0);
  box.innerHTML=items.length?`<div><b>${items.length} file${items.length===1?'':'s'} selected</b><small>${fmtBytes(bytes)} · selection is kept while you browse other phone folders</small></div>`:'<div><b>No files selected</b><small>Browse the phone and select individual files.</small></div>';
}

async function loadMobileManualBrowser(path=''){
  const host=document.getElementById('mobileManualBrowser'),device=document.getElementById('mobileManualDevice')?.value||'';if(!host||!device||window.__zero1ManualBrowseBusy)return;
  const previous=host.innerHTML,sid=String(window.__zero1ManualSession||'').trim();
  if(path&&!sid){flash('Restart the phone browser from Phone storage first.','warn');return;}
  window.__zero1ManualBrowseBusy=true;
  document.querySelectorAll('[data-action="mobile-manual-browse"]').forEach(x=>x.disabled=true);
  host.innerHTML='<div class="loading"><span class="spinner"></span>Reading phone folder…</div>';
  try{
    const url='/api/mobile-offload/manual/browse?device='+encodeURIComponent(device)+'&path='+encodeURIComponent(path)+(sid?'&session='+encodeURIComponent(sid):'');
    const d=await api(url,{busy:false,fresh:true}),selected=window.__zero1ManualSelection instanceof Map?window.__zero1ManualSelection:new Map();
    window.__zero1ManualSession=String(d.session_id||sid||'');
    const folders=list(d.entries).filter(x=>x.folder),files=list(d.entries).filter(x=>!x.folder);
    host.innerHTML=`<div class="folder-picker-head"><div><b>${esc(d.path||'Phone storage')}</b><small>${files.length} file${files.length===1?'':'s'} · ${folders.length} folder${folders.length===1?'':'s'}</small></div><div class="row-actions">${d.path?`<button class="btn btn-small" data-action="mobile-manual-browse" data-path="${attr(d.parent||'')}">Up</button>`:''}${files.length?`<button class="btn btn-small" data-action="mobile-manual-select-visible">Select files here</button>`:''}</div></div><div class="folder-picker-list">${folders.map(x=>`<button data-action="mobile-manual-browse" data-path="${attr(x.path)}"><span class="folder-icon"></span><div><b>${esc(x.name)}</b><small>Phone folder</small></div></button>`).join('')}${files.map(x=>`<label class="mobile-manual-file"><input type="checkbox" data-mobile-manual-file="1" data-id="${attr(x.id)}" data-name="${attr(x.name)}" data-path="${attr(x.path)}" data-size="${attr(x.size||0)}" ${selected.has(String(x.id))?'checked':''}><span><b>${esc(x.name)}</b><small>${fmtBytes(x.size||0)}${x.mtime?` · ${esc(new Date(Number(x.mtime)*1000).toLocaleString())}`:''}</small></span></label>`).join('')||(!folders.length?'<div class="folder-picker-empty">No files or child folders.</div>':'')}</div>`;
  }catch(e){
    await closeMobileManualSession();
    window.__zero1ManualSelection=new Map();
    updateMobileManualSelectionSummary();
    const keep=previous&&previous.includes('folder-picker-head')?`<div style="opacity:.55;pointer-events:none" aria-disabled="true">${previous}</div>`:'';
    host.innerHTML=`<div class="notice notice-bad"><b>Phone browser session ended</b><span>${esc(e.message)}</span></div><div class="row-actions"><button class="btn" data-action="mobile-manual-browse" data-path="">Restart phone browser</button></div>${keep}`;
  }finally{
    window.__zero1ManualBrowseBusy=false;
    document.querySelectorAll('[data-action="mobile-manual-browse"]').forEach(x=>x.disabled=false);
  }
}

function helpTopicCard(iconName,title,body,href,label='Open') {
  return `<article class="help-topic-card"><span>${icon(iconName,22)}</span><div><h3>${esc(title)}</h3><p>${esc(body)}</p><a class="text-link" href="${attr(href)}">${esc(label)} →</a></div></article>`;
}
async function helpPage(){
  const path=normalizedPath(),topic=path.split('/')[2]||'overview';
  const docNav=`<aside class="help-doc-nav"><b>In this guide</b><a href="/help/getting-started">Getting Started</a><a href="/help/storage">Storage & Drives</a><a href="/help/accounts">Accounts & quotas</a><a href="/help/network">Network & ports</a><a href="/help/lights">Status lights</a><a href="/help/recovery">Recovery environment</a><a href="/help/sync">Replication & Syncria</a><a href="/help/apps">Apps & Docker</a><a href="/help/troubleshooting">Troubleshooting</a></aside>`;
  const topics={
    overview:`${heading('Help','Help Center','Documentation that explains how Zero1Local behaves, what statuses mean, and what to do next. Links to settings are secondary to the explanation.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>How Zero1Local is organized</h2><p>The left navigation is divided by owner task: <b>Files & Sharing</b> covers shared folders and browsing; <b>Users & Groups</b> manages people and access; <b>Storage</b> is where physical drives, Main Storage and RAID live; <b>Sync & Backup</b> contains local backups and NAS-to-NAS replication; <b>Replication</b> owns NAS peer and job controls; <b>Apps</b> owns Docker workloads; <b>Connectivity</b> owns LAN/VLAN/desktop network integration; and <b>System</b> owns hardware, security and recovery; <b>Updates</b> installs software.</p><p>Pages inside one area use the same application bar. A feature that belongs to another area is linked contextually rather than duplicated as another permanent navigation item.</p><h3>Status language</h3><div class="help-definition-grid"><div><b>Healthy / Ready</b><span>No owner action is currently required.</span></div><div><b>Needs attention</b><span>The feature can still be online, but Zero1Local found something that should be reviewed.</span></div><div><b>Critical / Failed</b><span>A health check or operation failed and the detailed reason should be reviewed before relying on it.</span></div><div><b>Unavailable / Unknown</b><span>Zero1Local could not prove the state. It does not automatically mean the hardware failed.</span></div></div><h3>Where evidence lives</h3><p><b>Action Center</b> summarizes problems and active informational recommendations; unread notices are counted from visible active items. <b>Notifications</b> includes active tasks, failed tasks and appliance messages, with history available when needed. <b>Diagnostics</b> exposes deeper runtime evidence when the plain-language pages are not enough.</p><div class="row-actions"><a class="btn btn-primary" href="/action-center">Action Center</a><a class="btn" href="/notifications">Notifications</a><a class="btn" href="/diagnostics">Diagnostics</a></div></section></main></div>`,
    accounts:`${heading('Help','Users, groups and storage quotas','What a user can access, how limits work, and which accounts Zero1Local manages.')}
      <div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>NAS users versus web administrators</h2><p>Users & Groups controls file-sharing accounts. Control Panel administrators sign in to the web interface; creating a file-sharing user does not automatically grant web administration. Give each person only the access they need and use group permissions on shared folders for household or team access.</p><h2>Protected system accounts</h2><p>Zero1Local intentionally hides reserved operating-system identities from normal account lists and will not edit them from Account Policies. These accounts may own files or be required by device startup and recovery, even when they are not intended for household sign-in.</p><h2>Set a personal storage quota</h2><ol><li>Open Users & Groups → Account policies and select the person.</li><li>Enter the maximum space in GB. Use 0 for unlimited.</li><li>If quotas are unavailable, read the exact capability message. The <code>quota</code> Debian package supplies <code>setquota</code>, but the Main Storage filesystem must also be mounted with user quotas enabled.</li><li>Save, then verify the limit on the same filesystem. Zero1Local does not remount or reformat your data volume automatically.</li></ol><p>Shared folders and file ownership are not deleted when a quota is changed. Do not enable quota mount options manually without a tested backup and filesystem-specific recovery plan.</p></section></main></div>`,
    network:`${heading('Help','Network connections and listening ports','Understand where the NAS accepts connections and what the port inventory really tells you.')}
      <div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>Where a service is listening</h2><p><b>Local only</b> means the process is listening on the NAS loopback addresses <code>127.0.0.1</code> or <code>::1</code>; another computer cannot connect directly to that socket. <b>All interfaces</b> means the process bound to a wildcard address and could receive traffic on multiple NAS interfaces, but firewall rules and routing still determine who can connect. <b>Specific address</b> means it is limited to the shown IP; multicast addresses are used for local discovery.</p><h2>Common services</h2><div class="help-definition-grid"><div><b>323/UDP · Chrony</b><span>Local control endpoint for clock synchronization; loopback binding is expected.</span></div><div><b>500 and 4500/UDP · IPsec</b><span>Usually strongSwan's charon service for IPsec VPN. This is not WireGuard; an old service can remain installed after remote features are retired.</span></div><div><b>1701/UDP · L2TP</b><span>Legacy VPN transport. Check the owning process before deciding whether it is needed.</span></div><div><b>111, 2049 and 20048</b><span>Common RPC/NFS ports used for Linux file-sharing discovery or mounts.</span></div><div><b>139 and 445/TCP</b><span>Windows/macOS SMB file sharing.</span></div><div><b>5353/UDP</b><span>Multicast DNS, used for local network discovery.</span></div></div><h2>Investigate an unexpected port safely</h2><ol><li>Check the address and protocol. A loopback-only entry is not exposed on the LAN.</li><li>Read the process identity, if reported. A standard-port label is only a hint, not proof.</li><li>Check the host firewall and upstream VLAN/router rules before concluding a service is reachable.</li><li>Do not terminate unknown services or change network/firewall rules remotely without recovery access.</li></ol><p>The LAN mobile API does not require WireGuard or automatic Internet port forwarding. Existing file-sharing, DNS and recovery services must remain independently available.</p><div class="row-actions"><a class="btn btn-primary" href="/network">View listening services</a><a class="btn" href="/security">Firewall policy</a></div></section></main></div>`,
    recovery:`${heading('Help','Independent Recovery Environment','A separate way back into your NAS when normal management is unavailable.')}
      <div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc">
      <h2>What is IRE?</h2><p>The Independent Recovery Environment is a smaller, separate management service that keeps running independently of the normal Zero1Local web interface. If a software update fails or the main management interface cannot open, IRE provides a way to investigate and recover.</p>
      <h2>When should I use it?</h2><p>Most owners never need IRE. It is useful when Zero1Local does not start after an update, when you cannot open the normal management page, or when you need to restore an earlier working software version.</p>
      <h2>What can it do?</h2><ul><li>Report the installed release and management-service status.</li><li>Restart the Zero1Local management service.</li><li>Restore the previous release, when rollback data is available.</li><li>Reset a management administrator password using the separate recovery authorization process.</li><li>Orderly reboot or shut down the appliance when necessary.</li></ul>
      <h2>Access and Recovery Key</h2><p>From a trusted device on your NAS management network, open <code>http://YOUR-NAS-IP:8089</code>. You will need the Recovery Key configured during setup. Save that key somewhere other than the NAS, and ensure your firewall permits access from your trusted device.</p>
      <p><b>IRE does not replace backups.</b> It can help restore the management service, but cannot recreate lost files or repair damaged hardware.</p>
      <div class="row-actions"><a class="btn btn-primary" href="/recovery/system">Recovery information</a><a class="btn" href="/updates">Software Updates</a></div>
      </section></main></div>`,
    lights:`${heading('Help','Status light meanings','An illustrated, animated reference to every normal, warning and failure light pattern.')}
      <div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc">
      <h2>Read the pattern, not just the color</h2><p>There are three separate indicators: one for the NAS and one for each drive bay. Each is red/green hardware; both channels together produce yellow. The hardware does not have blue or arbitrary RGB colors. A steady light and a flashing light mean different things.</p>
      <p>The animations below show the defaults. They are examples, not live hardware status, and they do not change the LEDs. If you have customized assignments, open Customize lights to review your saved mapping.</p>
      ${ledReferenceHTML()}
      <h2>What to do if you see yellow or red</h2><ol><li>Identify whether it is the power/status light or a drive-bay light.</li><li>Note the color and whether it is steady, flashing quickly, or flashing slowly.</li><li>For a drive light, open Storage → Drives and read the precise SMART finding and RAID status. For the power light, open Notifications and System → Services.</li><li>Before replacing hardware, verify your latest backup and which drive bay is affected. Do not pull a drive simply because it is blinking.</li></ol>
      <h2>Offline networks and temporary overrides</h2><p>A NAS with intentionally restricted Internet access can operate normally over its LAN. Turn off the optional Internet-outage indication under Customize lights if a steady yellow power light would be misleading. During Phone Transfer, the power light may temporarily show transfer progress while the disk lights continue reporting drive health.</p>
      <div class="row-actions"><a class="btn btn-primary" href="/hardware?view=lights">Customize light behavior</a><a class="btn" href="/storage/disks">Drive health</a></div>
      </section></main></div>`,
    'getting-started':`${heading('Help','Getting Started','A practical setup order and the reason each step exists.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>1. Establish the appliance identity</h2><p>Finish Setup Assistant first. The web administrator credential protects the management UI; the device name becomes the NAS hostname used by local discovery and desktop clients. Keep the Recovery Key somewhere outside the NAS because Recovery on port 8089 is intentionally independent of the normal web session.</p><h2>2. Confirm storage before putting data on it</h2><p>Open Storage and make sure Main Storage has the capacity you expect. On a two-drive mirrored configuration, both data drives should be present and RAID should be healthy. A drive can remain online while SMART marks it as needing attention, so check both the array state and the drive-health state.</p><h2>3. Create people and shared folders</h2><p>Users and groups describe who is connecting. Shared Folders describe which data they can reach. Local NAS inherits these same permissions instead of creating a second mobile-only permission system.</p><h2>4. Add protection</h2><p>RAID availability is not a backup. Configure local backups and/or NAS-to-NAS replication for important data. To synchronize NAS data with cloud storage, run Syncria as a separate optional Docker container. Zero1Local does not connect directly to cloud providers.</p><h2>5. Keep access local</h2><p>Configure LAN access. Experimental public pairing and tunnel provisioning are unavailable in normal v1.3; connecting from outside the LAN requires a separately administered trusted network.</p><h2>6. Add apps after the NAS is stable</h2><p>The curated App Catalog includes applications with known persistence and resource expectations. Saved custom repositories/images are lower-level Docker sources. Docker Compose remains available for multi-container or advanced deployments.</p><div class="row-actions"><a class="btn btn-primary" href="/setup-assistant">Setup Assistant</a><a class="btn" href="/storage">Storage</a><a class="btn" href="/shares">Shared Folders</a><a class="btn" href="/protection">Sync & Backup</a></div></section></main></div>`,
    storage:`${heading('Help','Storage & Drives','What the storage states mean, why a drive light can be yellow, and how SMART tests are handled.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>Main Storage, RAID and drive health are different signals</h2><p><b>Main Storage</b> reports usable filesystem capacity. <b>RAID</b> reports whether the data-drive set is complete and synchronized. <b>SMART</b> reports drive telemetry. A drive can still participate in a healthy RAID array while SMART has recorded a condition worth investigating.</p><h3>Yellow drive light</h3><p>The physical bay light and the Drives page use the same Zero1Local SMART policy. Yellow means the drive needs attention, not necessarily that it has failed. The Drives table now shows the exact reason beside the status. Conditions currently treated as attention include reallocated sectors and interface CRC errors. Pending sectors, offline-uncorrectable sectors, reported uncorrectable errors, command timeouts, or a failed SMART overall-health result are treated as critical.</p><h3>SMART short and long tests</h3><p>SMART self-tests run inside the drive and are non-destructive. A short test is useful for a quick electronics/media check; a long test scans much more of the media and can take hours. If a test is already running, Zero1Local reports and follows that test instead of trying to start another one.</p><p>Some SATA-to-USB or bridge controllers require a different smartctl device mode for self-test commands than they do for normal telemetry. Zero1Local tries the detected mode, automatic detection, and supported SAT bridge modes. If all attempts fail, the Task/UI error contains the mode-specific diagnostics instead of only saying the test failed.</p><h3>What to do when a drive needs attention</h3><ol><li>Read the exact SMART reason on the Drives page.</li><li>Run a short test if no test is already active.</li><li>Confirm RAID remains healthy and a current backup exists before replacing hardware.</li><li>If the warning is an interface CRC error, inspect the drive/backplane connection as well as the drive itself. CRC errors can be transport-related.</li></ol><div class="row-actions"><a class="btn btn-primary" href="/storage/disks">Drives</a><a class="btn" href="/storage/raid">RAID</a><a class="btn" href="/storage/analytics">Storage Analytics</a></div></section></main></div>`,
    sync:`${heading('Help','Replication & Syncria','Choose the correct file transfer system.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>NAS-to-NAS · Zero1Local</h2><p>Use <a href="/replication">NAS Replication</a> to pair NAS destinations, manage jobs and review errors. Native replication does not require Docker, Syncria, or cloud authentication.</p><h2>NAS-to-cloud and cloud-to-NAS · Syncria</h2><p>Zero1Local v1.3 does not configure cloud destinations or run cloud transfer jobs. Syncria is an optional separate Docker container. Configure provider accounts and mapping policies in Syncria's own interface; Zero1Local does not install or connect it automatically.</p><h2>Historical cloud records</h2><p>Existing cloud job configuration can be retained in inactive state for a later owner-directed migration. Zero1Local never silently deletes remote files, backups, or saved credentials during upgrades.</p><h2>Where controls live</h2><p>Protection Overview shows overall posture. Replication owns NAS peer and job controls. Backups manages local jobs; Restore handles recovery. Action Center summarizes active notices requiring attention or recommendations; Notifications lists all notices, and Tasks shows execution history.</p><div class="row-actions"><a class="btn btn-primary" href="/replication">Replication</a><a class="btn" href="/docker">Docker</a></div></section></main></div>`,
    zero1connect:`${heading('Help','Experimental remote access','This optional feature is unavailable in this Zero1Local release.')}<div class="content-panel"><p>Pairing, public tunnels and automatic router mapping are disabled. Management, file sharing and backups remain available.</p></div>`,
    apps:`${heading('Help','Apps & Docker','The difference between curated apps, custom repositories/images, containers and Compose.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>Curated App Catalog</h2><p>Curated entries are applications for which Zero1Local knows the ARM64 image, persistent-data location, resource guidance, default port and expected network exposure. The app cards show a distinct visual icon, current runtime state, minimum/recommended memory, architecture compatibility and the exact image in Technical details.</p><h2>Custom repositories and images</h2><p>A custom repository is a reusable registry/repository prefix such as <code>ghcr.io/home-assistant</code> or <code>lscr.io/linuxserver</code>. A custom image is an exact Docker image reference that can be pulled and retained in your personal catalog. Saving either one does not create a container or expose a port automatically.</p><h2>Syncria for cloud synchronization</h2><p>Install Syncria as a separate, optional Docker container for NAS-to-cloud or cloud-to-NAS file sync. It manages its own cloud accounts and job settings.</p><h2>Docker Compose</h2><p>Use Compose when an application needs multiple containers, custom environment variables, networks, volumes or dependencies that do not fit a curated single-app installer. Zero1Local keeps Compose available alongside the catalog rather than replacing it.</p><h3>Before installing an app</h3><ul><li>Review memory guidance against the NAS's available memory.</li><li>Use LAN/VPN-only exposure unless you intentionally have a trusted reverse proxy.</li><li>Put important application state on persistent storage and include it in backups.</li><li>Do not assume a pulled image is configured securely; pulling and running are separate steps.</li></ul><div class="row-actions"><a class="btn btn-primary" href="/apps/catalog">App Catalog</a><a class="btn" href="/docker">Containers</a><a class="btn" href="/docker/stacks">Docker Compose</a></div></section></main></div>`,
    troubleshooting:`${heading('Help','Troubleshooting','A repeatable way to diagnose problems without guessing or erasing the evidence.')}<div class="help-doc-layout">${docNav}<main class="help-doc-main"><section class="content-panel help-doc"><h2>Start with the narrowest owner-facing evidence</h2><ol><li><b>Action Center:</b> current conditions that require attention.</li><li><b>Task Center:</b> progress, completion and the actual error returned by long-running operations. Finished or failed tasks can be dismissed; Clear finished removes terminal history from the active view.</li><li><b>Notifications:</b> persistent appliance notices, including successful software-update completion.</li><li><b>Diagnostics:</b> deeper service, runtime and capability evidence.</li><li><b>Recovery:</b> independent controls when the primary UI itself is unavailable.</li></ol><h2>Software update behavior</h2><p>An active update remains visible while it is preparing/applying. A successful update becomes a normal notification and a one-time toast instead of a large completion panel that has to be dismissed. Failed updates remain visible until dismissed because their error is diagnostic evidence.</p><p>Web login sessions are persisted in the root-only Zero1Local state directory so a management-service restart during an update can restore valid sessions. The first update from a release that never persisted its in-memory sessions can still require one final sign-in; after the persistence-capable release is running, ordinary update restarts keep the server-side session record.</p><h2>Collect before changing</h2><p>If a problem may need support, save the exact error text, time, device/page involved and relevant Task/Diagnostics details before restarting services or changing configuration. Zero1Local intentionally exposes the command/reason for failures where it can do so safely.</p><div class="row-actions"><a class="btn btn-primary" href="/tasks">Task Center</a><a class="btn" href="/notifications">Notifications</a><a class="btn" href="/diagnostics">Diagnostics</a><a class="btn" href="/recovery/system">Recovery</a></div></section></main></div>`
  };
  document.getElementById('content').innerHTML=`<section class="screen help-screen">${topics[topic]||topics.overview}</section>`;
}

const routes = {
  '/': dashboard,
  '/action-center': actionCenterPage,
  '/tasks': tasksPage,
  '/notifications': notificationsPage,
  '/protection': protectionOverviewPage,
  '/protection/restore': restoreCenterPage,
  '/backups': backupsPage,
  '/backups/targets': backupsPage,
  '/snapshots': snapshotsPage,
  '/synchronization': synchronizationPage,
  '/replication': replicationPage,
  '/offsite': synchronizationPage,
  '/mobile-offload': mobileOffloadPage,
  '/phone-transfer': mobileOffloadPage,
  '/storage/analytics': analyticsPage,
  '/storage/replacement': replacementPage,
  '/desktop-integration': desktopIntegrationPage,
  '/users/profiles': userProfilesPage,
  '/network/advanced': advancedNetworkPage,
  '/hardware/profiles': hardwareProfilesPage,
  '/recovery/system': recoverySystemPage,
  '/diagnostics': diagnosticsPage,
  '/readiness': readinessPage,
  '/storage': storageOverview,
  '/storage/disk0': dataVolume,
  '/storage/raid': raidPage,
  '/storage/disks': disksPage,
  '/shares': sharesPage,
  '/smb/shares': smbShares,
  '/nfs/shares': nfsShares,
  '/protocols': protocolsPage,
  '/files': filesPage,
  '/files/trash': fileTrashPage,
  '/files/links': sharedLinksPage,
  '/office': officePage,
  '/office/open': officeOpenPage,
  '/users': usersPage,
  '/groups': groupsPage,
  '/security': securityPage,
  '/security/admins': administratorsPage,
  '/system': systemPage,
  '/system/access': systemAccessPage,
  '/updates': updatesPage,
  '/docker': dockerPage,
  '/docker/stacks': dockerStacksPage,
  '/apps/catalog': appCatalogPage,
  '/network': networkPage,
  '/network/vlans': vlanPage,
  '/services': servicesPage,
  '/settings': settingsPage,
  '/automation': automationPage,
  '/hardware': hardwarePage,
  '/logs': logsPage,
  '/recovery': recoveryPage,
  '/setup-assistant': setupAssistantPage,
  '/factory': recoverySystemPage,
  '/about': aboutPage,
  '/help': helpPage,
  '/help/getting-started': helpPage,
  '/help/storage': helpPage,
  '/help/lights': helpPage,
  '/help/accounts': helpPage,
  '/help/network': helpPage,
  '/help/recovery': helpPage,
  '/help/sync': helpPage,
  '/help/apps': helpPage,
  '/help/troubleshooting': helpPage,
};

async function confirmAction(title, message, actionLabel, action, dangerous = true) {
  openModal(title, '', `<p class="confirm-copy">${esc(message)}</p>`, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn ${dangerous ? 'btn-danger' : 'btn-primary'}" data-action="confirm-run">${esc(actionLabel)}</button>`);
  modalState.confirm = action;
}

async function loadMonitaChannelOptions(){
  const status=document.getElementById('monitaChannelStatus');
  if(status)status.textContent='Looking up Monita Channels…';
  try{
    const d=await api('/api/notifications/monita/channels',{busy:false,fresh:true,stale:false});
    const channels=list(d.channels).filter(x=>Number(x.id)>0);
    document.querySelectorAll('select[data-monita-category]').forEach(select=>{
      const selected=Number(select.value||select.dataset.selected||0);
      select.innerHTML='<option value="0">Off</option>'+channels.map(c=>`<option value="${Number(c.id)}">${esc(c.name)}</option>`).join('');
      if(channels.some(c=>Number(c.id)===selected))select.value=String(selected);
      else if(selected>0){select.insertAdjacentHTML('beforeend',`<option value="${selected}">Saved Channel #${selected} (not available)</option>`);select.value=String(selected)}
    });
    if(status)status.textContent=channels.length?`${channels.length} Channels available. Choose a destination for each notification type, then save.`:'Monita did not return any accessible Channels.';
  }catch(e){
    if(status)status.textContent='Channels unavailable: '+e.message+'. Check the saved server address and access token.';
  }
}
function deliverySettingsFromForm(){
  const severities=[];if(document.getElementById('deliveryCritical')?.checked)severities.push('critical');if(document.getElementById('deliveryWarning')?.checked)severities.push('warning');if(document.getElementById('deliveryInformation')?.checked)severities.push('information');
  return {
    enabled:document.getElementById('deliveryEnabled')?.checked||false,severities,
    email_enabled:document.getElementById('deliveryEmailEnabled')?.checked||false,email_transport:document.getElementById('deliveryEmailTransport')?.value||'smtp',email_to:document.getElementById('deliveryEmail')?.value||'',smtp_host:document.getElementById('deliverySMTPHost')?.value||'',smtp_port:Number(document.getElementById('deliverySMTPPort')?.value||0),smtp_security:document.getElementById('deliverySMTPSecurity')?.value||'starttls',smtp_username:document.getElementById('deliverySMTPUser')?.value||'',smtp_password:document.getElementById('deliverySMTPPassword')?.value||'',smtp_from:document.getElementById('deliverySMTPFrom')?.value||'',
    webhook_enabled:document.getElementById('deliveryWebhookEnabled')?.checked||false,webhook_url:document.getElementById('deliveryWebhook')?.value||'',webhook_bearer:document.getElementById('deliveryWebhookBearer')?.value||'',
    ntfy_enabled:document.getElementById('deliveryNtfyEnabled')?.checked||false,ntfy_url:document.getElementById('deliveryNtfyURL')?.value||'',ntfy_topic:document.getElementById('deliveryNtfyTopic')?.value||'',ntfy_token:document.getElementById('deliveryNtfyToken')?.value||'',
    gotify_enabled:document.getElementById('deliveryGotifyEnabled')?.checked||false,gotify_url:document.getElementById('deliveryGotifyURL')?.value||'',gotify_token:document.getElementById('deliveryGotifyToken')?.value||'',
    monita_enabled:document.getElementById('deliveryMonitaEnabled')?.checked||false,monita_url:document.getElementById('deliveryMonitaURL')?.value||'',monita_token:document.getElementById('deliveryMonitaToken')?.value||'',
    monita_channels:Object.fromEntries([...document.querySelectorAll('select[data-monita-category]')].map(el=>[el.dataset.monitaCategory,Number(el.value||0)])),
    telegram_enabled:document.getElementById('deliveryTelegramEnabled')?.checked||false,telegram_bot_token:document.getElementById('deliveryTelegramToken')?.value||'',telegram_chat_id:document.getElementById('deliveryTelegramChat')?.value||'',
    discord_enabled:document.getElementById('deliveryDiscordEnabled')?.checked||false,discord_webhook:document.getElementById('deliveryDiscordWebhook')?.value||'',
    slack_enabled:document.getElementById('deliverySlackEnabled')?.checked||false,slack_webhook:document.getElementById('deliverySlackWebhook')?.value||'',
    teams_enabled:document.getElementById('deliveryTeamsEnabled')?.checked||false,teams_webhook:document.getElementById('deliveryTeamsWebhook')?.value||'',
    pushover_enabled:document.getElementById('deliveryPushoverEnabled')?.checked||false,pushover_user_key:document.getElementById('deliveryPushoverUser')?.value||'',pushover_app_token:document.getElementById('deliveryPushoverToken')?.value||''
  };
}
function deliveryTestResultsBody(d){const rows=Object.entries(d.results||{});return `<div class="settings-list">${rows.map(([name,r])=>`<div class="settings-row"><div><b>${esc(name)}</b><small>${r.ok?'Test notification accepted by provider':esc(r.error||'Delivery failed')}</small></div>${statusPill(r.ok?'Passed':'Failed',r.ok?'good':'bad')}</div>`).join('')}</div>`}

async function handleAction(target) {
  const action = target?.dataset?.action || '';
  if (action === 'refresh-current') { clearAPIMemo(); await renderCurrentRoute({scroll:false,allowSnapshot:false}); flash('Current appliance data refreshed.'); return; }
  if (!action) return;
  if (action === 'close-modal') { closeModal(); return; }
  if (action === 'task-open') { await openTaskDetail(target.dataset.task); return; }
  if (action === 'task-dismiss') { target.disabled=true;try{await api('/api/tasks/dismiss',{method:'POST',body:JSON.stringify({task_id:target.dataset.task})});flash('Task dismissed.');await tasksPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'task-clear-finished') { target.disabled=true;try{const d=await api('/api/tasks/clear-finished',{method:'POST',body:'{}'});flash(`${Number(d.cleared||0)} finished task${Number(d.cleared||0)===1?'':'s'} cleared.`);await tasksPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'task-control') { const id=target.dataset.task,control=target.dataset.control;target.disabled=true;try{await api('/api/tasks/control',{method:'POST',body:JSON.stringify({task_id:id,action:control})});flash(`${control.charAt(0).toUpperCase()+control.slice(1)} requested.`);await refreshTaskDetail(id)}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'task-load-more') { const holder=document.querySelector('[data-task-detail]');if(holder)holder.dataset.expanded='1';stopTaskDetailPolling();target.disabled=true;try{await refreshTaskDetail(target.dataset.task,{offset:Number(target.dataset.offset||0),append:true})}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'image-zoom') { imagePreviewState.fit=false;applyImagePreviewZoom(imagePreviewState.zoom+Number(target.dataset.delta||0)); return; }
  if (action === 'image-zoom-reset'||action === 'image-actual') { applyImagePreviewZoom(1); return; }
  if (action === 'image-fit') { applyImagePreviewZoom(1,{fit:true}); return; }
  if (action === 'image-prev') { imageViewerNavigate(-1); return; }
  if (action === 'image-next') { imageViewerNavigate(1); return; }
  if (action === 'image-open') { openImageViewer(target.dataset.path,target.dataset.name,Number(target.dataset.size||0)); return; }
  if (action === 'image-rotate-left') { imagePreviewState.rotation-=90;imageViewerApply(); return; }
  if (action === 'image-rotate-right') { imagePreviewState.rotation+=90;imageViewerApply(); return; }
  if (action === 'image-fullscreen') { const stage=document.querySelector('.image-lightbox-stage');if(stage?.requestFullscreen)await stage.requestFullscreen();return; }
  if (action === 'code-wrap-toggle') { const box=document.getElementById('fileCodeHighlight');box?.classList.toggle('is-wrapped');target.textContent=box?.classList.contains('is-wrapped')?'Do not wrap':'Wrap lines';return; }
  if (action === 'code-copy') { try{await navigator.clipboard.writeText(codeEditorText());flash('Text copied.')}catch(e){flash('Could not copy the text.','bad')}return; }
  if (action === 'code-edit-toggle') { const s=window.__zero1CodeEditor,view=document.getElementById('fileCodeHighlight'),input=document.getElementById('fileCodeEditorInput'),download=document.getElementById('downloadEditedCopy');if(!s||!view||!input)return;s.editing=!s.editing;view.classList.toggle('hidden',s.editing);input.classList.toggle('hidden',!s.editing);download?.classList.toggle('hidden',!s.editing);target.textContent=s.editing?'Preview with syntax colors':'Edit in browser';if(s.editing)input.focus();else{const lang=CODE_LANGUAGES[s.lang]||CODE_LANGUAGES.text;view.innerHTML=highlightedSource(input.value,lang===CODE_LANGUAGES.text?'text':s.lang)}return; }
  if (action === 'code-download-edited') { downloadBrowserEditedCopy();flash('Edited copy downloaded.');return; }
  if (action === 'chrome-drawer-close') { closeChromeDrawer(); return; }
  if (action === 'toggle-task-drawer') { const open=document.getElementById('chromeDrawer')?.classList.contains('open'); if(open) closeChromeDrawer(); else await openChromeDrawer('tasks'); return; }
  if (action === 'toggle-notification-drawer') { const open=document.getElementById('chromeDrawer')?.classList.contains('open'); if(open) closeChromeDrawer(); else await openChromeDrawer('notifications'); return; }
  if (action === 'toggle-theme') { cycleTheme(); return; }
  if (action === 'toggle-account-menu') { toggleAccountMenu(); return; }
  if (action === 'toggle-nav') { document.querySelector('.sidebar')?.classList.toggle('open'); return; }
  if (action === 'context-help') { openContextHelp(); return; }
  if (action === 'reload') { location.reload(); return; }
  if (action === 'sign-out') { await api('/api/logout', { method: 'POST', body: '{}' }); location.reload(); return; }
  if (action === 'setup-submit') {
    const p = document.getElementById('setupPw').value;
    if (p !== document.getElementById('setupPw2').value) { showAuthError('Passwords do not match.'); return; }
    const mode=document.querySelector('input[name="setupMode"]:checked')?.value||'fresh';
    const button=document.querySelector('[data-action="setup-submit"]');
    if(button){button.disabled=true;button.textContent='Completing setup…';}
    try {
      const d=await api('/api/setup', { method: 'POST', body: JSON.stringify({ Password: p, DeviceName: document.getElementById('setupName').value, Timezone: document.getElementById('setupTz').value, Mode: mode }) });
      await completeSetupTransition(d.next||'/');
    } catch (e) {
      showAuthError(e.message);
      if(button){button.disabled=false;button.textContent='Continue with Zero1Local';}
    }
    return;
  }
  if (action === 'login-submit') { await loginSubmit(); return; }
  if (action === 'file-office') { closeFileContextMenu(); await openOfficeFile(target.dataset.path,target.dataset.name); return; }
  if (action === 'file-versions') { closeFileContextMenu(); await openFileVersions(target.dataset.path,target.dataset.name); return; }
  if (action === 'file-share-link') { closeFileContextMenu(); openShareLinkModal(target.dataset.path,target.dataset.name); return; }
  if (action === 'file-share-link-create') { await createShareLink(target); return; }
  if (action === 'file-upload-request') { closeFileContextMenu(); openUploadRequestModal(target.dataset.path,target.dataset.name); return; }
  if (action === 'file-upload-request-create') { await createUploadRequest(target); return; }
  if (action === 'share-link-copy') { const el=document.getElementById('createdShareLink'); if(el){await navigator.clipboard.writeText(el.value);flash('Secure link copied.')} return; }
  if (action === 'share-link-revoke') { await api('/api/files/share-links/'+encodeURIComponent(target.dataset.link),{method:'DELETE',body:'{}'});flash('Shared link revoked.');await sharedLinksPage();return; }
  if (action === 'file-paste') { closeFileContextMenu(); await pasteFileClipboard(); return; }
  if (action === 'file-refresh') { closeFileContextMenu(); await filesPage(); return; }
  if (action === 'file-selection-clear') { closeFileContextMenu(); clearFileSelection(); return; }
  if (action === 'file-batch-copy' || action === 'file-batch-cut') {
    closeFileContextMenu();
    const items=selectedEntries(); if(items.length<2){flash('Select at least two items.','warn');return;}
    fileClipboard={paths:items.map(x=>x.path),names:items.map(x=>x.name),cut:action.endsWith('cut')};
    flash(`${items.length} items ${fileClipboard.cut?'cut':'copied'} — open a writable destination and paste.`); return;
  }
  if (action === 'file-batch-copy-to' || action === 'file-batch-move-to') { closeFileContextMenu(); openBatchTransferModal(action.endsWith('move-to')?'move':'copy'); return; }
  if (action === 'file-batch-transfer-save') {
    target.disabled=true; try { const dest=document.getElementById('fileTransferDest')?.value||''; if(!dest)throw new Error('Choose a destination folder.'); const op=target.dataset.kind==='move'?'move':'copy'; const count=selectedEntries().length; await runFileBatch(op,{destination_directory:dest}); closeModal(); flash(`${count} items ${op==='move'?'moved':'copied'}.`); clearFileSelection(); await filesPage(); } catch(e){flash(e.message,'bad');target.disabled=false} return;
  }
  if (action === 'file-batch-trash') {
    const count=selectedEntries().length; if(count<2){flash('Select at least two items.','warn');return;}
    await confirmAction(`Recycle ${count} items?`,'The selected files and folders will be moved to the Recycle Bin together.','Move to Recycle Bin',async()=>{await runFileBatch('trash');closeModal();flash(`${count} items moved to the Recycle Bin.`);clearFileSelection();await filesPage();}); return;
  }
  if (action === 'file-batch-archive') {
    const count=selectedEntries().length;if(count<2){flash('Select at least two items.','warn');return;}
    openModal(`Compress ${count} items`,'Create one ZIP archive in the current folder.',`<div class="form-stack"><label>Archive name</label><input id="fileBatchArchiveName" value="Archive-${new Date().toISOString().slice(0,10)}.zip" autocomplete="off"><small class="field-help">All selected items must be in this folder. Existing files are never overwritten.</small></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="file-batch-archive-save">Create ZIP</button>`);return;
  }
  if (action === 'file-batch-archive-save') { target.disabled=true;try{const count=selectedEntries().length;const name=document.getElementById('fileBatchArchiveName')?.value||'Archive.zip';await runFileBatch('archive',{archive_name:name});closeModal();flash(`${count} items compressed.`);clearFileSelection();await filesPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'file-batch-download') { closeFileContextMenu();try{const d=await runFileBatch('download');if(d?.url){const a=document.createElement('a');a.href=d.url;a.download=d.filename||'Zero1Local-selection.zip';document.body.appendChild(a);a.click();a.remove();flash(`${selectedEntries().length} items prepared for download.`)}}catch(e){flash(e.message,'bad')}return; }
  if (action === 'file-clipboard-copy' || action === 'file-clipboard-cut') { closeFileContextMenu(); const items=selectedEntries(); if(items.length>1){fileClipboard={paths:items.map(x=>x.path),names:items.map(x=>x.name),cut:action.endsWith('cut')};flash(`${items.length} items ${fileClipboard.cut?'cut':'copied'} — choose a destination and paste.`);return;} fileClipboard={path:target.dataset.path,name:target.dataset.name,cut:action.endsWith('cut')}; flash(`${target.dataset.name} ${fileClipboard.cut?'cut':'copied'} — choose a destination and paste.`); return; }
  if (action === 'file-version-restore') { await confirmAction(`Restore ${target.dataset.name}?`,'The current file will be replaced with this previous snapshot version.','Restore previous version',async()=>{await api('/api/files/versions/restore',{method:'POST',body:JSON.stringify({SourcePath:target.dataset.source,Destination:target.dataset.destination})});closeModal();flash('Previous version restored.');await filesPage();}); return; }
  if (action === 'office-setup-open') { closeModal();await navigateTo('/office');return; }
  if (action === 'office-open-close') { window.close();if(!window.closed)location.href='/files';return; }
  if (action === 'office-open-retry') { await officeOpenPage();return; }
  if (action === 'office-install' || action === 'office-repair') {
    target.disabled=true;
    try{const d=await api(action==='office-repair'?'/api/office/repair':'/api/office/install',{method:'POST',body:'{}'});if(d.already_ready||d.status?.ready){flash('Office is ready.');await officePage();return;}openModal('Setting up Office','Zero1Local is installing and configuring the editor automatically.',`<div id="officeModalProgress">${officeTaskProgress({title:'Setting up Office',detail:'Preparing the editor…',progress:0})}</div>`,'<button class="btn btn-quiet" data-action="close-modal">Keep working</button>');const taskID=d.task_id;const deadline=Date.now()+5*60*1000;while(taskID&&Date.now()<deadline){const td=await api('/api/tasks',{busy:false,fresh:true});const t=list(td.tasks).find(x=>x.id===taskID);const box=document.getElementById('officeModalProgress');if(t&&box)box.innerHTML=officeTaskProgress(t);if(t?.status==='completed'){closeModal();flash('Office is installed and ready.');await officePage();return;}if(t?.status==='failed'){if(box)box.innerHTML=`<div class="office-open-failure"><h3>Office setup failed</h3><p>${esc(t.error||t.detail||'The installation did not complete.')}</p></div>`;return;}await new Promise(resolve=>setTimeout(resolve,1000));}}catch(e){flash(e.message,'bad');target.disabled=false}return;
  }
  if (action === 'office-install-inline' || action === 'office-repair-inline') {
    const path=target.dataset.path||new URLSearchParams(location.search).get('path')||'',name=target.dataset.name||new URLSearchParams(location.search).get('name')||'Document',box=document.getElementById('officeOpenState');target.disabled=true;
    if(box)box.innerHTML=officeTaskProgress({title:'Setting up Office',detail:'Preparing the editor…',progress:0});
    try{const d=await api(action==='office-repair-inline'?'/api/office/repair':'/api/office/install',{method:'POST',body:'{}',busy:false});if(d.already_ready||d.status?.ready){await launchOfficeDocument(path,name);return;}if(!d.task_id)throw new Error('Office setup did not return a task.');await waitForOfficeInstall(d.task_id,path,name)}catch(e){if(box)box.innerHTML=`<div class="office-open-failure"><h2>Office setup failed</h2><p>${esc(e.message)}</p><button class="btn btn-primary" data-action="office-install-inline" data-path="${attr(path)}" data-name="${attr(name)}">Try again</button></div>`;}return;
  }
  if (action === 'office-settings-save') { target.disabled=true; try{await api('/api/office/settings',{method:'PUT',body:JSON.stringify({enabled:document.getElementById('officeEnabled').checked,endpoint:document.getElementById('officeEndpoint').value,wopi_base_url:document.getElementById('officeWopiBase').value})});flash('Advanced Office settings saved.');await officePage();}catch(e){flash(e.message,'bad');target.disabled=false} return; }
  if (action === 'catalog-collabora-install') { await api('/api/apps/catalog/collabora/install',{method:'POST',body:'{}'}); flash('Collabora installation started. Follow progress in Task Center.'); return; }
  if (action === 'sync-job-create') { if(!list(window.__zero1Replication?.peers).length){flash('Pair a NAS destination first.','warn');return;} replicationJobModal();return; }
  if (action === 'sync-remote-browse') { await loadSyncRemoteBrowser(target.dataset.path||''); return; }
  if (action === 'mobile-refresh') { target.disabled=true;try{await mobileOffloadPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'mobile-nickname-open') { mobileNicknameModal(target.dataset.device||''); return; }
  if (action === 'mobile-nickname-save') { const device=target.dataset.device||'',nickname=document.getElementById('mobileNickname')?.value||'';target.disabled=true;try{await api('/api/mobile-offload/nickname',{method:'PUT',body:JSON.stringify({device_id:device,nickname})});closeModal();flash(nickname.trim()?'Phone nickname saved.':'Phone nickname removed.');await mobileOffloadPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-pair') { target.disabled=true;try{await api('/api/mobile-offload/pair',{method:'POST',body:JSON.stringify({device_id:target.dataset.device||''})});flash('Pairing completed. If the phone displayed a Trust prompt, approve it and refresh devices.');await mobileOffloadPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-rule-create') { mobileRuleModal(target.dataset.device||''); return; }
  if (action === 'mobile-manual-open') { mobileManualTransferModal(target.dataset.device||''); return; }
  if (action === 'mobile-manual-browse') { await loadMobileManualBrowser(target.dataset.path||''); return; }
  if (action === 'mobile-manual-clear') { window.__zero1ManualSelection=new Map();document.querySelectorAll('[data-mobile-manual-file]').forEach(x=>x.checked=false);updateMobileManualSelectionSummary();return; }
  if (action === 'mobile-manual-select-visible') { const map=window.__zero1ManualSelection instanceof Map?window.__zero1ManualSelection:new Map();document.querySelectorAll('[data-mobile-manual-file]').forEach(x=>{x.checked=true;map.set(String(x.dataset.id),{id:Number(x.dataset.id),name:x.dataset.name||'',path:x.dataset.path||'',size:Number(x.dataset.size||0)});});window.__zero1ManualSelection=map;updateMobileManualSelectionSummary();return; }
  if (action === 'mobile-manual-transfer-start') { const session=String(window.__zero1ManualSession||''),device=document.getElementById('mobileManualDevice')?.value||'',share=document.getElementById('mobileShare')?.value||'',selection=window.__zero1ManualSelection instanceof Map?[...window.__zero1ManualSelection.values()]:[];if(!device){flash('Connect and choose an Android phone first.','warn');return;}if(!session){flash('Browse the phone before starting a transfer.','warn');return;}if(!selection.length){flash('Select at least one phone file.','warn');return;}if(!share){flash('Choose a NAS destination folder.','warn');return;}target.disabled=true;try{const d=await api('/api/mobile-offload/manual/transfer',{method:'POST',body:JSON.stringify({session_id:session,device_id:device,object_ids:selection.map(x=>Number(x.id)),share,destination_path:document.getElementById('mobileDestination')?.value||'',mode:document.getElementById('mobileMode')?.value||'copy'})});window.__zero1ManualSession='';closeModal();flash(`Manual phone transfer started${d.task_id?` as task ${d.task_id}`:''}. Follow progress in Task Center.`);}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-source-browse') { await loadMobileSourceBrowser(target.dataset.path||''); return; }
  if (action === 'mobile-source-select') { setMobileSource(target.dataset.path||'',true);const box=document.getElementById('mobileSourceBrowser');if(box)box.innerHTML=`<div class="notice notice-good"><b>Phone source selected</b><span>${esc(target.dataset.path||'Media root')}</span></div>`;return; }
  if (action === 'mobile-destination-browse') { await loadMobileDestinationBrowser(target.dataset.share||'',target.dataset.path||''); return; }
  if (action === 'mobile-destination-new-folder') { showMobileDestinationFolderCreate(target.dataset.share||'',target.dataset.path||''); return; }
  if (action === 'mobile-destination-new-folder-cancel') { const box=document.getElementById('mobileDestinationCreate');if(box)box.innerHTML='';return; }
  if (action === 'mobile-destination-new-folder-save') { const name=document.getElementById('mobileDestinationNewFolderName')?.value||'';if(!name.trim()){flash('Enter a folder name.','warn');return;}target.disabled=true;try{const d=await api('/api/mobile-offload/destination-folder',{method:'POST',body:JSON.stringify({share:target.dataset.share||'',parent:target.dataset.path||'',name})});setMobileDestination(d.share||target.dataset.share||'',d.path||'');await loadMobileDestinationBrowser(d.share||target.dataset.share||'',d.path||'');flash(`Created ${d.name||name} and selected it as the phone destination.`);}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-destination-select') { setMobileDestination(target.dataset.share||'',target.dataset.path||'');const box=document.getElementById('mobileDestinationBrowser');if(box)box.innerHTML=`<div class="notice notice-good"><b>NAS destination selected</b><span>${esc(target.dataset.share||'')}${target.dataset.path?` / ${esc(target.dataset.path)}`:''}</span></div>`;return; }
  if (action === 'mobile-rule-save') { const select=document.getElementById('mobileDevice'),opt=select?.selectedOptions?.[0],device=list(window.__zero1Mobile?.devices).find(x=>x.id===select?.value),share=document.getElementById('mobileShare')?.value||'',source=document.getElementById('mobileSource'); if(!select?.value){flash('Connect and choose a phone first.','warn');return;} if(source?.dataset.chosen!=='1'){flash('Browse the phone and choose a source folder.','warn');return;} if(!share){flash('Choose an existing NAS destination folder.','warn');return;} target.disabled=true;try{await api('/api/mobile-offload/rules',{method:'POST',body:JSON.stringify({device_id:select.value,device_kind:opt?.dataset.kind||'',device_name:device?.nickname||device?.name||select.value,share,destination_path:document.getElementById('mobileDestination')?.value||'',source_path:source?.value||'',source_explicit:true,mode:document.getElementById('mobileMode')?.value||'copy',auto:!!document.getElementById('mobileAuto')?.checked,enabled:true})});closeModal();flash('Phone Transfer rule saved.');await mobileOffloadPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-run') { target.disabled=true;try{const d=await api('/api/mobile-offload/run',{method:'POST',body:JSON.stringify({rule_id:target.dataset.rule})});flash(`Phone Transfer started${d.task_id?` as task ${d.task_id}`:''}.`);await mobileOffloadPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'mobile-rule-delete') { await confirmAction('Remove this Phone Transfer rule?','Files already copied to the NAS and files still on the phone are left untouched.','Remove rule',async()=>{await api('/api/mobile-offload/rules/'+encodeURIComponent(target.dataset.rule),{method:'DELETE',body:'{}'});closeModal();flash('Phone Transfer rule removed.');await mobileOffloadPage()});return; }
  if (action === 'recovery-search-run') { await runRecoverySearch();return; }
  if (action === 'recovery-policy-save') { target.disabled=true;try{await api('/api/protection/recovery-tests',{method:'PUT',body:JSON.stringify({enabled:document.getElementById('recoveryVerifyEnabled').checked,weekday:document.getElementById('recoveryVerifyDay').value,time_of_day:document.getElementById('recoveryVerifyTime').value})});flash('Recovery verification schedule saved.');await restoreCenterPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'recovery-verify-run') { target.disabled=true;try{const body=target.dataset.share?{share:target.dataset.share}:{};const d=await api('/api/protection/recovery-tests/run',{method:'POST',body:JSON.stringify(body)});flash(`Recovery verification started${target.dataset.share?' for '+target.dataset.share:''}. Follow task ${d.task_id||''} in Task Center.`);target.disabled=false}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'protection-plan-create') { protectionPlanModal();return; }
  if (action === 'protection-plan-save') { target.disabled=true;try{const backup_job_ids=[...document.querySelectorAll('[data-plan-backup]:checked')].map(x=>x.dataset.planBackup);await api('/api/protection/plans',{method:'POST',body:JSON.stringify({name:document.getElementById('planName').value,share:document.getElementById('planShare').value,enabled:document.getElementById('planEnabled').checked,schedule:document.getElementById('planSchedule').value,time_of_day:document.getElementById('planTime').value,snapshot_enabled:document.getElementById('planSnapshot').checked,snapshot_retain:Number(document.getElementById('planSnapshotRetain').value||7),backup_job_ids})});closeModal();flash('Protection Plan created.');await synchronizationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'protection-plan-run') { const plan=list(window.__zero1ProtectionPlans?.plans).find(x=>String(x.id)===String(target.dataset.plan));await api('/api/protection/plans/'+encodeURIComponent(target.dataset.plan)+'/run',{method:'POST',body:'{}'});flash('Protection Plan started. Follow its layers in Task Center.');return; }
  if (action === 'protection-plan-delete') { await confirmAction('Remove this Protection Plan?','Underlying snapshots and backup jobs remain intact and independently manageable.','Remove plan',async()=>{await api('/api/protection/plans/'+encodeURIComponent(target.dataset.plan),{method:'DELETE',body:'{}'});closeModal();flash('Protection Plan removed.');await synchronizationPage()});return; }
  if (action === 'catalog-custom-add') { customCatalogModal();return; }
  if (action === 'catalog-source-add') { customCatalogSourceModal();return; }
  if (action === 'catalog-source-save') { const name=document.getElementById('customCatalogSourceName')?.value||'',prefix=document.getElementById('customCatalogSourcePrefix')?.value||'',notes=document.getElementById('customCatalogSourceNotes')?.value||'';target.disabled=true;try{await api('/api/apps/catalog-sources',{method:'POST',body:JSON.stringify({name,prefix,notes})});closeModal();flash('Docker repository saved.');await appCatalogPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'catalog-source-remove') { await confirmAction('Remove this repository source?','Saved image entries and already-pulled Docker images are not removed.','Remove repository',async()=>{await api('/api/apps/catalog-sources/'+encodeURIComponent(target.dataset.source),{method:'DELETE',body:'{}'});closeModal();flash('Repository source removed.');await appCatalogPage();});return; }
  if (action === 'catalog-custom-save') { let image=document.getElementById('customCatalogImage')?.value||'',name=document.getElementById('customCatalogName')?.value||'',notes=document.getElementById('customCatalogNotes')?.value||'';const prefix=document.getElementById('customCatalogSource')?.value||'';if(prefix&&image&&!image.startsWith(prefix+'/'))image=prefix.replace(/\/$/,'')+'/'+image.replace(/^\//,'');target.disabled=true;try{await api('/api/apps/catalog-custom',{method:'POST',body:JSON.stringify({name,image,notes})});closeModal();flash('Custom Docker image saved.');await appCatalogPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'catalog-custom-pull') { target.disabled=true;try{const d=await api('/api/apps/catalog-custom/'+encodeURIComponent(target.dataset.custom)+'/pull',{method:'POST',body:'{}'});flash(`Image pull started${d.task_id?` as task ${d.task_id}`:''}. Follow progress in Task Center.`);await appCatalogPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'catalog-custom-remove') { await confirmAction('Remove this custom image entry?','The saved catalog entry will be removed. Any Docker image already pulled to the NAS is left intact.','Remove entry',async()=>{await api('/api/apps/catalog-custom/'+encodeURIComponent(target.dataset.custom),{method:'DELETE',body:'{}'});closeModal();flash('Custom image entry removed; local image data was preserved.');await appCatalogPage();});return; }
  if (action === 'catalog-more') { catalogAppInfoModal(target.dataset.app);return; }
  if (action === 'catalog-install' || action === 'catalog-configure') { catalogInstallModal(target.dataset.app);return; }
  if (action === 'catalog-install-save') { target.disabled=true;try{const verb=target.dataset.update==='1'?'update':'install';await api('/api/apps/catalog/'+encodeURIComponent(target.dataset.app)+'/'+verb,{method:'POST',body:JSON.stringify({host_port:Number(document.getElementById('catalogPort')?.value||0),exposure:document.getElementById('catalogExposure')?.value||'lan',share:document.getElementById('catalogShare')?.value||''})});closeModal();flash(`Application ${verb} started. Follow progress in Task Center.`);await appCatalogPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'catalog-runtime') { target.disabled=true;try{await api('/api/apps/catalog/'+encodeURIComponent(target.dataset.app)+'/'+encodeURIComponent(target.dataset.runtime),{method:'POST',body:'{}'});flash(`Application ${target.dataset.runtime} completed.`);await appCatalogPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'catalog-remove') { await confirmAction('Remove this application?','The managed container will be removed. Zero1Local preserves its application data directory.','Remove app',async()=>{await api('/api/apps/catalog/'+encodeURIComponent(target.dataset.app)+'/remove',{method:'DELETE',body:'{}'});closeModal();flash('Application removed; its data was preserved.');await appCatalogPage();});return; }
  if (action === 'recycle-settings-save') { const share_retention={};document.querySelectorAll('[data-recycle-share]').forEach(el=>{const v=Number(el.value||0);if(v>0)share_retention[el.dataset.recycleShare]=v});await api('/api/files/recycle-settings',{method:'PUT',body:JSON.stringify({retention_days:Number(document.getElementById('recycleRetention').value),share_retention})});flash('Recycle Bin retention saved.');await automationPage();return; }
  if (action === 'ups-policy-save') { await api('/api/power/ups-policy',{method:'PUT',body:JSON.stringify({enabled:document.getElementById('upsPolicyEnabled').checked,shutdown_battery_percent:Number(document.getElementById('upsBattery').value),shutdown_after_minutes:Number(document.getElementById('upsMinutes').value),restart_after_power_return:document.getElementById('upsRestart').checked})});flash('UPS policy saved.');return; }
  if (action === 'maintenance-run') { await api('/api/maintenance/run',{method:'POST',body:JSON.stringify({kind:target.dataset.kind})});flash('Maintenance operation queued. Completion will be tracked in history.');return; }
  if (action === 'maintenance-save') { await api('/api/maintenance',{method:'PUT',body:JSON.stringify({enabled:document.getElementById('maintenanceEnabled').checked,smart_short_day:document.getElementById('smartShortDay').value,smart_short_time:document.getElementById('smartShortTime').value,smart_long_day:document.getElementById('smartLongDay').value,smart_long_time:document.getElementById('smartLongTime').value,raid_scrub_day:document.getElementById('raidScrubDay').value,raid_scrub_time:document.getElementById('raidScrubTime').value})});flash('Storage maintenance schedule saved.');await automationPage();return; }
  if (action === 'monita-channels-load'){await loadMonitaChannelOptions();return;}
  if (action === 'monita-config-save'){
    target.disabled=true;
    try{
      const deliveryValues=deliverySettingsFromForm();
      await api('/api/notifications/delivery',{method:'PUT',body:JSON.stringify(deliveryValues)});
      const policy=await api('/api/notifications/policy',{fresh:true,stale:false});
      const routes={};
      for(const severity of ['critical','warning','information']){
        // Preserve other notification providers and quiet-hour rules.
        routes[severity]=list(policy.routes?.[severity]).filter(p=>p!=='monita');
        if(document.getElementById('route-'+severity+'-monita')?.checked)routes[severity].push('monita');
      }
      await api('/api/notifications/policy',{method:'PUT',body:JSON.stringify({quiet_hours:policy.quiet_hours||{},routes})});
      flash(deliveryValues.monita_enabled&&!deliveryValues.enabled?'Monita is saved, but outbound alerts are off. Turn on “Send appliance alerts outside the NAS UI” to begin delivery.':'Monita settings and notification choices saved.',deliveryValues.monita_enabled&&!deliveryValues.enabled?'warn':'good');
      await automationPage();
    }catch(e){flash(e.message,'bad');target.disabled=false}
    return;
  }

  if (action === 'notification-policy-save') { target.disabled=true;try{const providers=['email','webhook','ntfy','gotify','monita','telegram','discord','slack','teams','pushover'],routes={critical:[],warning:[],information:[]};for(const sev of Object.keys(routes))for(const p of providers)if(document.getElementById(`route-${sev}-${p}`)?.checked)routes[sev].push(p);await api('/api/notifications/policy',{method:'PUT',body:JSON.stringify({quiet_hours:{enabled:document.getElementById('notificationQuietEnabled')?.checked||false,start:document.getElementById('notificationQuietStart')?.value||'22:00',end:document.getElementById('notificationQuietEnd')?.value||'07:00'},routes})});flash('Notification routing policy saved.');await automationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'delivery-save') { target.disabled=true;try{await api('/api/notifications/delivery',{method:'PUT',body:JSON.stringify(deliverySettingsFromForm())});flash('Outbound notification settings saved.');await automationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'delivery-test') { target.disabled=true;try{await api('/api/notifications/delivery',{method:'PUT',body:JSON.stringify(deliverySettingsFromForm())});const d=await api('/api/notifications/delivery/test',{method:'POST',body:'{}'});openModal('Notification delivery test',d.ok?'All enabled providers accepted the test notification.':'One or more providers rejected the test. Nothing is hidden—review each result below.',deliveryTestResultsBody(d),'<button class="btn btn-primary" data-action="close-modal">Done</button>');}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'notification-state') { await api('/api/notifications/state',{method:'POST',body:JSON.stringify({ID:target.dataset.notification,State:target.dataset.state,SnoozeMinutes:Number(target.dataset.snooze||0)})});flash(target.dataset.state==='active'?'Notification restored.':target.dataset.state==='ignored'?'Notification ignored until you explicitly restore it.':target.dataset.state==='snoozed'?'Notification snoozed.':target.dataset.state==='dismissed'?'Notification dismissed.':'Notification marked read.'); const p=normalizedPath();if(p==='/action-center')await actionCenterPage();else if(p==='/notifications')await notificationsPage();else{try{renderNotificationDrawerData(await api('/api/notifications',{busy:false,fresh:true,stale:false}));}catch(_){}}await refreshChromeStatus();return; }
  if (action === 'notification-dismiss-all') { const d=await api('/api/notifications',{fresh:true,stale:false});await Promise.all(visibleUnreadNotices(d).map(n=>api('/api/notifications/state',{method:'POST',busy:false,body:JSON.stringify({ID:n.id,State:'read'})})));flash('All notifications marked read.');await notificationsPage();await refreshChromeStatus();return; }
  if (action === 'admin-create-open') { adminCreateModal(); return; }
  if (action === 'admin-create-save') { target.disabled=true;try{await api('/api/security/admins',{method:'POST',body:JSON.stringify({Username:document.getElementById('adminUsername').value,Role:document.getElementById('adminRole').value,Password:document.getElementById('adminPassword').value,AllowedCIDRs:adminCIDRValues(),ExpiresAt:adminExpiryValue(),Permissions:adminPermissionValues()})});closeModal();flash('Administrator created.');await administratorsPage();}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'admin-edit-open') { adminEditModal(target.dataset.admin);return; }
  if (action === 'admin-update-save') { target.disabled=true;try{await api('/api/security/admins/'+encodeURIComponent(target.dataset.admin),{method:'PUT',body:JSON.stringify({Role:document.getElementById('adminRole').value,Enabled:document.getElementById('adminEnabled').checked,AllowedCIDRs:adminCIDRValues(),ExpiresAt:adminExpiryValue(),Permissions:adminPermissionValues()})});closeModal();flash('Administrator policy updated.');await administratorsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'admin-totp-setup') { try{const d=await api('/api/security/admins/'+encodeURIComponent(target.dataset.admin)+'/totp/setup',{method:'POST',body:'{}'});openModal(`Set up 2FA · ${target.dataset.admin}`,'Add this account to an authenticator app, then verify one current six-digit code.',`<div class="form-stack"><label>Authenticator secret</label><div class="secret-display"><code>${esc(d.secret)}</code></div><a class="btn" href="${attr(d.otpauth_uri)}">Open authenticator app</a><label>Verification code</label><input id="adminTOTPCode" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="123456"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="admin-totp-enable" data-admin="${attr(target.dataset.admin)}">Enable 2FA</button>`)}catch(e){flash(e.message,'bad')}return; }
  if (action === 'admin-totp-enable') { target.disabled=true;try{await api('/api/security/admins/'+encodeURIComponent(target.dataset.admin)+'/totp/enable',{method:'POST',body:JSON.stringify({code:document.getElementById('adminTOTPCode').value})});closeModal();flash('Administrator 2FA enabled.');await administratorsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'admin-totp-disable') { await confirmAction(`Disable 2FA for ${target.dataset.admin}?`,'That delegated administrator will return to password-only authentication.','Disable 2FA',async()=>{await api('/api/security/admins/'+encodeURIComponent(target.dataset.admin)+'/totp/disable',{method:'POST',body:'{}'});closeModal();flash('Administrator 2FA disabled.');await administratorsPage()});return; }
  if (action === 'admin-delete') { await confirmAction(`Remove ${target.dataset.admin}?`,'That Zero1Local web credential will stop working immediately. SMB/Linux accounts are not affected.','Remove administrator',async()=>{await api('/api/security/admins/'+encodeURIComponent(target.dataset.admin),{method:'DELETE',body:'{}'});closeModal();flash('Administrator removed.');await administratorsPage();});return; }
  if (action === 'smb-create') { openSMBModal('create'); return; }
  if (action === 'smb-nfs-enable') {
    const share=target.dataset.share;
    const d=await api('/api/nfs/exports',{fresh:true,stale:false});
    if(!d.installed){
      history.pushState({}, '', '/shares?tab=nfs');
      await nfsShares(true);
      flash('Enable Linux sharing (NFS) first, then choose this shared folder.','warn');
      return;
    }
    window.__zero1NFS=d;
    const candidate=list(d.shares).find(x=>x.name===share && x.nfs_eligible);
    if(!candidate){flash('This folder is not currently eligible for NFS sharing. Open the Linux tab to review available folders.','warn');return;}
    const existing=list(d.exports).find(x=>x.share_name===share);
    if(existing){flash('NFS is already enabled for this folder.','good');history.pushState({},'', '/shares?tab=nfs');await nfsShares(true);return;}
    openNFSModal(share);
    return;
  }
  if (action === 'smb-adopt') { const sh=list(window.__zero1SMB?.shares).find(x=>x.name===target.dataset.share&&x.detected_only);if(sh)openSMBAdoptModal(sh);return; }
  if (action === 'smb-adopt-save') { const perm=collectPermissions('smbAdoptPerm');if(!perm.valid.length){flash('Select at least one SMB-enabled user for this share.','bad');return;}target.disabled=true;try{await api('/api/shares',{method:'POST',body:JSON.stringify({Name:target.dataset.share,Path:target.dataset.path,ValidUsers:perm.valid,WriteUsers:perm.write,Browseable:document.getElementById('smbAdoptBrowseable').checked,CreateDirectory:false})});closeModal();flash(`${target.dataset.share} is now managed by Zero1Local. Existing files were left in place.`);await smbShares();}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'smb-folder-nav') { await loadSMBFolderBrowser(target.dataset.path); return; }
  if (action === 'smb-folder-select') { selectSMBFolder(target.dataset.path); return; }
  if (action === 'file-transfer-folder-nav') { await loadFileTransferBrowser(target.dataset.share || '', target.dataset.rel || ''); return; }
  if (action === 'file-transfer-folder-select') { selectFileTransferFolder(target.dataset.path, target.dataset.label); return; }
  if (action === 'share-insights') { try{const name=target.dataset.share;const d=await api('/api/shares/insights?share='+encodeURIComponent(name));const sh=d.share||{};const users=[...new Set([...list(sh.valid_users),...list(sh.write_users)])];openModal(`${name} details`,'Usage, access policy and current SMB session evidence for this shared folder.',`<div class="share-insight-grid"><div><span>Stored data</span><b>${fmtBytes(d.size)}</b><small>${Number(d.items||0).toLocaleString()} filesystem items</small></div><div><span>Network path</span><b>${esc(windowsShare(name))}</b><small>${esc(friendlyShareLocation(sh))}</small></div><div><span>Browse status</span><b>${sh.browseable?'Visible':'Hidden'}</b><small>${esc(permissionSummary(sh))}</small></div></div><section class="modal-section"><div class="form-section-title"><b>Effective access</b><span>Check what the current Zero1Local SMB policy grants to a specific user.</span></div><div class="effective-access-line"><select id="shareInsightUser">${users.map(u=>`<option value="${attr(u)}">${esc(u)}</option>`).join('')}</select><button class="btn btn-small" data-action="share-access-check" data-share="${attr(name)}">Check access</button></div><div id="shareAccessResult"></div></section><details class="advanced"><summary>Current SMB session evidence</summary><pre>${esc(d.active_sessions_raw||'No smbstatus output available.')}</pre></details>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>')}catch(e){flash(e.message,'bad')} return; }
  if (action === 'share-access-check') { const u=document.getElementById('shareInsightUser')?.value||'';try{const d=await api('/api/shares/insights?share='+encodeURIComponent(target.dataset.share)+'&user='+encodeURIComponent(u));const x=d.effective_access||{};const box=document.getElementById('shareAccessResult');if(box)box.innerHTML=`<div class="effective-access-result"><span>${statusPill(x.read?'Can read':'Cannot read',x.read?'good':'warn')}</span><span>${statusPill(x.write?'Can write':'Cannot write',x.write?'good':'neutral')}</span></div>`}catch(e){flash(e.message,'bad')} return; }
  if (action === 'smb-edit') {
    const sh = list(window.__zero1SMB?.shares).find(x => x.name === target.dataset.share);
    if (sh) openSMBModal('edit', sh);
    return;
  }
  if (action === 'smb-modal-save') { await saveSMBModal(target); return; }
  if (action === 'smb-detach') {
    const sh = list(window.__zero1SMB?.shares).find(x => x.name === target.dataset.share);
    if (!sh) return;
    if (!sh.remove_allowed) { flash('This shared folder cannot be safely changed because its data path is not proven to be on Main Storage.', 'warn'); return; }
    await confirmAction(`Stop sharing ${sh.name}?`, 'Network access will be removed, but the folder and every file will stay exactly where they are on Main Storage. You can share the folder again later.', 'Stop sharing', async () => {
      const result = await api('/api/shares/' + encodeURIComponent(sh.name), { method: 'DELETE', body: '{}' });
      markWorkspaceLocationStale(sh.name,'',true);
      closeModal();
      if(result.factory_login_retire_warning) flash(`Sharing stopped, but a reserved SMB login could not be retired: ${result.factory_login_retire_warning}`,'warn');
      else flash('Sharing stopped. Your files were kept on Main Storage.');
      await smbShares();
    });
    return;
  }
  if (action === 'smb-remove') {
    const sh = list(window.__zero1SMB?.shares).find(x => x.name === target.dataset.share);
    if (!sh) return;
    if (!sh.remove_allowed) { flash('This shared folder cannot be safely deleted because its data path is not proven to be on Main Storage.', 'warn'); return; }
    const adoptedNote = sh.adopted ? ' This includes an existing shared folder. Recovery metadata is kept, but deleted files are not silently recreated.' : '';
    await confirmAction(`Delete shared folder ${sh.name}?`, `Every file and subfolder will be moved to the Recycle Bin first, then network sharing will be removed.${adoptedNote} Recycled data still uses disk space until it expires or you empty the Recycle Bin.`, 'Delete shared folder', async () => {
      const box=document.querySelector('.modal-body');
      if(box) box.innerHTML='<div class="loading"><span class="spinner"></span>Moving shared-folder contents to the Recycle Bin…</div><div class="context-note"><span>This can take a while for folders containing many top-level items. The share definition will not be removed unless recycling finishes successfully.</span></div>';
      let moved=0, passes=0;
      while(true){
        if(++passes>10000) throw new Error('Share deletion stopped because the folder did not become empty after repeated recycle passes. The share definition was left intact.');
        const fd=await api(`/api/files?share=${encodeURIComponent(sh.name)}&rel=&limit=250&offset=0&sort=name&order=asc`,{busy:false,fresh:true});
        if(fd.scope!=='share'||String(fd.share)!==String(sh.name)) throw new Error('Zero1Local could not prove the selected shared-folder root. Nothing was unshared.');
        const entries=list(fd.entries);
        if(!entries.length){
          if(Number(fd.total||0)>0) throw new Error('The shared folder still reports data that File Manager could not enumerate. The share definition was left intact.');
          break;
        }
        const paths=entries.map(x=>x.path).filter(Boolean);
        if(paths.length!==entries.length) throw new Error('One or more shared-folder entries had no safe path. The share definition was left intact.');
        if(paths.length===1) await api('/api/files/trash',{method:'POST',body:JSON.stringify({Path:paths[0]}),busy:false});
        else await api('/api/files/batch',{method:'POST',body:JSON.stringify({operation:'trash',paths}),busy:false});
        moved+=paths.length;
        if(box) box.innerHTML=`<div class="loading"><span class="spinner"></span>Moved ${moved.toLocaleString()} top-level item${moved===1?'':'s'} to the Recycle Bin…</div><div class="context-note"><span>Network sharing stays active until the folder is empty and the final share removal succeeds.</span></div>`;
      }
      const result=await api('/api/shares/'+encodeURIComponent(sh.name),{method:'DELETE',body:'{}'});
      markWorkspaceLocationStale(sh.name,'',true);
      closeModal();
      if(result.factory_login_retire_warning) flash(`Shared folder deleted, but a reserved SMB login could not be retired: ${result.factory_login_retire_warning}`,'warn');
      else flash(`${sh.name} deleted. ${moved.toLocaleString()} top-level item${moved===1?'':'s'} moved to the Recycle Bin.`);
      await smbShares();
    });
    return;
  }
  if (action === 'smb-restore') {
    target.disabled = true;
    try { await api('/api/shares/restore', { method: 'POST', body: JSON.stringify({ Name: target.dataset.share }) }); flash('Shared folder restored.'); await smbShares(); }
    catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'nfs-enable') { await startNFSInstall(); return; }
  if (action === 'nfs-create') { openNFSModal(); return; }
  if (action === 'nfs-modal-save') {
    target.disabled = true;
    try { await api('/api/nfs/exports', { method: 'POST', body: JSON.stringify({ ShareName: document.getElementById('nfsShare').value, Clients: csv(nfsClientValue()), Access: document.getElementById('nfsAccess').value, Squash: document.getElementById('nfsSquash').value }) }); closeModal(); flash('NFS share created and service started.'); await nfsShares(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'nfs-edit') {
    const ex = list(window.__zero1NFS?.exports).find(x => String(x.id) === String(target.dataset.id));
    if (ex) openNFSEditModal(ex);
    return;
  }
  if (action === 'nfs-edit-save') {
    target.disabled = true;
    try {
      await api('/api/nfs/exports/' + encodeURIComponent(target.dataset.id), { method: 'PUT', body: JSON.stringify({ Clients: csv(document.getElementById('nfsEditClients').value), Access: document.getElementById('nfsEditAccess').value, Squash: document.getElementById('nfsEditSquash').value }) });
      closeModal(); flash('NFS share updated.'); await nfsShares();
    } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'nfs-delete') {
    await confirmAction(`Remove NFS export for ${target.dataset.name}?`, 'This stops exporting the folder over NFS. It does not delete the SMB share, directory, or files.', 'Remove export', async () => { await api('/api/nfs/exports/' + encodeURIComponent(target.dataset.id), { method: 'DELETE', body: '{}' }); closeModal(); flash('NFS export removed; files preserved.'); await nfsShares(); });
    return;
  }
  if (action === 'fan-return-auto') {
    try{const d=await api('/api/hardware/fan',{method:'PUT',body:JSON.stringify({mode:'auto',speed:Number(document.querySelector('input[name=\"fanSpeed\"]:checked')?.value||60)})});flash(`Automatic cooling restored. Effective level: ${fanSpeedLabel(d.fan?.effective_speed)}.`);await hardwarePage();}catch(e){flash(e.message,'bad')}return;
  }
  if (action === 'fan-settings-save') {
    const mode=document.querySelector('input[name="fanMode"]:checked')?.value||'auto';
    const speed=Number(document.querySelector('input[name="fanSpeed"]:checked')?.value||60);
    const save=async()=>{target.disabled=true;try{const d=await api('/api/hardware/fan',{method:'PUT',body:JSON.stringify({mode,speed})});closeModal();flash(`Cooling policy saved. Effective level: ${fanSpeedLabel(d.fan?.effective_speed)}.`);await hardwarePage();}catch(e){flash(e.message,'bad');target.disabled=false;}};
    if(mode==='manual'&&speed===0){await confirmAction('Turn the chassis fan off?','Zero1Local will still force the fan to 100% above 80°C or if the thermal sensor fails, but Manual Off is intended only for deliberate short testing at a safe temperature.','Use Manual Off',save,true);return;}
    await save();
    return;
  }
  if (action === 'led-discovery') {
    target.disabled = true;
    const original = target.textContent; target.textContent = 'Running discovery…';
    try {
      const d = await api('/api/hardware/led-discovery');
      openModal('LED hardware discovery', 'Read-only evidence from this NAS. No LED, GPIO, service, storage or network state was changed.', `<div class="notice notice-info"><b>Safe discovery complete</b><span>Use this report to identify the exact chassis control mapping before any physical write is enabled.${d.saved_to ? ` A local copy was saved under Zero1Local hardware state.` : ''}</span></div><pre class="discovery-report">${esc(d.report || 'No discovery output returned.')}</pre>`, '<button class="btn btn-primary" data-action="close-modal">Close</button>');
    } catch (e) { flash(e.message, 'bad'); target.disabled = false; target.textContent = original; }
    return;
  }
  if (action === 'copy-text') { const value=target.dataset.copy||'';try{if(navigator.clipboard?.writeText&&window.isSecureContext){await navigator.clipboard.writeText(value)}else{const area=document.createElement('textarea');area.value=value;area.setAttribute('readonly','');area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();if(!document.execCommand('copy'))throw new Error('Browser copy command was rejected');area.remove()}flash('Copied to clipboard.')}catch(e){flash('Copy failed. Select the text and copy it manually.','warn')}return; }
  if (action === 'user-create') { openUserCreate(); return; }
  if (action === 'user-create-save') {
    const groups = Array.from(document.querySelectorAll('[data-new-user-group]:checked')).map(x => x.value);
    target.disabled = true;
    try { await api('/api/users', { method: 'POST', body: JSON.stringify({ Username: document.getElementById('newUsername').value, Password: document.getElementById('newUserPassword').value, SMB: document.getElementById('newUserSMB').checked, Groups: groups }) }); closeModal(); flash('NAS user created.'); await usersPage({fresh:true}); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'user-edit') { openUserEdit(target.dataset.user); return; }
  if (action === 'user-edit-save') {
    const groups = Array.from(document.querySelectorAll('[data-edit-user-group]:checked')).map(x => x.value);
    target.disabled = true;
    try {
      await api('/api/users/' + encodeURIComponent(target.dataset.user), { method: 'PUT', body: JSON.stringify({ SMBEnabled: document.getElementById('editUserSMB').checked, Password: document.getElementById('editUserPassword').value, Groups: groups }) });
      closeModal(); flash('User updated.'); await usersPage({fresh:true});
    } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'user-groups') { openUserGroups(target.dataset.user); return; }
  if (action === 'user-groups-save') {
    const groups = Array.from(document.querySelectorAll('[data-edit-user-group]:checked')).map(x => x.value);
    try { await api('/api/users/groups', { method: 'POST', body: JSON.stringify({ Username: target.dataset.user, Groups: groups }) }); closeModal(); flash('Group membership updated.'); await usersPage({fresh:true}); } catch (e) { flash(e.message, 'bad'); }
    return;
  }
  if (action === 'user-password') {
    const u = target.dataset.user;
    openModal(`SMB password for ${u}`, 'This changes the Samba password only; it does not enable SSH.', `<label>New SMB password</label><input id="changeSMBPw" type="password" autocomplete="new-password">`, `<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="user-password-save" data-user="${attr(u)}">Change password</button>`);
    return;
  }
  if (action === 'user-password-save') {
    try { await api('/api/users/password', { method: 'POST', body: JSON.stringify({ Username: target.dataset.user, Password: document.getElementById('changeSMBPw').value }) }); closeModal(); flash('SMB password changed.'); } catch (e) { flash(e.message, 'bad'); }
    return;
  }
  if (action === 'user-delete') {
    const u = target.dataset.user;
    await confirmAction(`Remove ${u}?`, 'The NAS login and SMB password will be removed. Files owned by this account are intentionally left on Main Storage instead of being deleted with the user. Linux records file ownership by a numeric UID, so those files may show the old UID until you explicitly reassign or remove them.', 'Remove user', async () => { const result = await api('/api/users/' + encodeURIComponent(u), { method: 'DELETE', body: '{}' }); closeModal(); flash(result.uid ? `User removed. Existing files are preserved under UID ${result.uid}.` : 'User removed; existing files are preserved.'); await usersPage({fresh:true}); });
    return;
  }
  if (action === 'group-create') {
    openModal('Create group', 'Groups make it easier to organize NAS users.', '<label>Group name</label><input id="newGroupName" placeholder="family">', '<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="group-create-save">Create group</button>');
    return;
  }
  if (action === 'group-create-save') {
    try { await api('/api/groups', { method: 'POST', body: JSON.stringify({ Name: document.getElementById('newGroupName').value }) }); closeModal(); flash('Group created.'); await groupsPage({fresh:true}); } catch (e) { flash(e.message, 'bad'); }
    return;
  }
  if (action === 'group-edit') { openGroupEdit(target.dataset.group); return; }
  if (action === 'group-edit-save') {
    target.disabled = true;
    try {
      await api('/api/groups/' + encodeURIComponent(target.dataset.group), { method: 'PUT', body: JSON.stringify({ Name: document.getElementById('editGroupName').value }) });
      closeModal(); flash('Group updated.'); await groupsPage({fresh:true});
    } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'group-delete') {
    const g = target.dataset.group;
    await confirmAction(`Remove ${g}?`, 'Zero1Local will automatically detach users who only have this as a supplementary group, then remove the group. If any account uses it as its primary Linux group, the operation will stop without changing that account.', 'Remove group', async () => { const result = await api('/api/groups/' + encodeURIComponent(g), { method: 'DELETE', body: '{}' }); closeModal(); const count = list(result.detached_members).length; flash(count ? `Group removed and ${count} member${count===1?'':'s'} detached.` : 'Group removed.'); await groupsPage({fresh:true}); });
    return;
  }
  if (action === 'file-new-folder') { openNewFolderModal(); return; }
  if (action === 'file-new-folder-save') {
    target.disabled = true;
    try { await api('/api/files/mkdir', { method: 'POST', body: JSON.stringify({ Path: window.__zero1Files?.path || '', Name: document.getElementById('fileNewFolderName').value }) }); closeModal(); flash('Folder created.'); await filesPage(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'file-rename') { openRenameFileModal(target.dataset.path, target.dataset.name); return; }
  if (action === 'file-rename-save') {
    target.disabled = true;
    try { await api('/api/files/rename', { method: 'POST', body: JSON.stringify({ Path: target.dataset.path, NewName: document.getElementById('fileRenameName').value }) }); closeModal(); flash('Item renamed.'); await filesPage(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'file-trash') {
    const name = target.dataset.name;
    await confirmAction(`Move ${name} to the Recycle Bin?`, 'The item will disappear from its current folder but remains in Main Storage and can be restored from Zero1Local.', 'Move to Recycle Bin', async () => { const entry=currentFileEntryByPath(target.dataset.path); await api('/api/files/trash', { method: 'POST', body: JSON.stringify({ Path: target.dataset.path }) }); if(entry?.directory&&window.__zero1Files?.share){markWorkspaceLocationStale(window.__zero1Files.share,entry.relative_path||'',false);await pruneWorkspaceFavoritesForStale(window.__zero1FileWorkspace,window.__zero1Files.share,entry.relative_path||'',false);} closeModal(); flash('Item moved to the Recycle Bin.'); await filesPage(); });
    return;
  }
  if (action === 'file-restore') {
    target.disabled = true;
    try { await api('/api/files/restore', { method: 'POST', body: JSON.stringify({ ID: target.dataset.trashId }) }); flash(`${target.dataset.name} restored.`); await fileTrashPage(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'trash-delete') { await confirmAction(`Permanently delete ${target.dataset.name}?`,'This bypasses the Recycle Bin and cannot be undone.','Delete permanently',async()=>{await api('/api/files/trash/'+encodeURIComponent(target.dataset.trashId),{method:'DELETE',body:'{}'});closeModal();flash('Item permanently deleted.');await fileTrashPage();}); return; }
  if (action === 'trash-empty') { await confirmAction('Empty the entire Recycle Bin?','Every recycled file and folder will be permanently removed from Main Storage. This cannot be undone.','Empty Recycle Bin',async()=>{await api('/api/files/trash/empty',{method:'POST',body:'{}'});closeModal();flash('Recycle Bin emptied.');await fileTrashPage();}); return; }
  if (action === 'raid-create') { const disks=list((await api('/api/storage'))?.block_devices?.blockdevices).filter(x=>x.type==='disk'&&/^sd[a-z]+$/.test(String(x.name||''))); openModal('Create RAID1 Main Storage','This ERASES both selected data drives. Zero1Local refuses system, mounted and existing RAID-member devices.',`<div class="form-stack"><label>Drive 1</label><select id="raidDev1">${disks.map(x=>`<option value="${attr(x.path||'/dev/'+x.name)}">${esc(x.model||x.name)} · ${fmtBytes(x.size)}</option>`).join('')}</select><label>Drive 2</label><select id="raidDev2">${disks.map(x=>`<option value="${attr(x.path||'/dev/'+x.name)}">${esc(x.model||x.name)} · ${fmtBytes(x.size)}</option>`).join('')}</select><label>Type exactly: ERASE BOTH DATA DRIVES</label><input id="raidAck"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="raid-create-save">Create RAID1</button>`); return; }
  if (action === 'raid-create-save') { target.disabled=true; try{await api('/api/storage/raid1/create',{method:'POST',body:JSON.stringify({Devices:[document.getElementById('raidDev1').value,document.getElementById('raidDev2').value],Acknowledge:document.getElementById('raidAck').value})});closeModal();flash('RAID1 Main Storage created.');await raidPage();}catch(e){flash(e.message,'bad');target.disabled=false;} return; }
  if (action === 'raid-scrub') { await confirmAction('Run RAID consistency check?','This asks md RAID to read/check the mirror. It does not format the filesystem. Zero1Local will show live progress while it runs.','Start check',async()=>{const r=await api('/api/storage/raid1/scrub',{method:'POST',body:'{}'});closeModal();flash(r.already_running?'A RAID consistency check is already running; attached to its progress.':'RAID consistency check started.');await raidPage();}); return; }
  if (action === 'raid-add') { const disks=list((await api('/api/storage'))?.block_devices?.blockdevices).filter(x=>x.type==='disk'&&/^sd[a-z]+$/.test(String(x.name||''))); openModal('Add replacement RAID drive','The selected empty drive will be added to the existing RAID1 Main Storage array and overwritten during mirror rebuild.',`<label>Replacement drive</label><select id="raidAddDev">${disks.map(x=>`<option value="${attr(x.path||'/dev/'+x.name)}">${esc(x.model||x.name)} · ${fmtBytes(x.size)}</option>`).join('')}</select><label>Type exactly: ADD REPLACEMENT DRIVE</label><input id="raidAddAck">`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="raid-add-save">Add drive</button>`);return; }
  if (action === 'raid-add-save'){target.disabled=true;try{await api('/api/storage/raid1/add',{method:'POST',body:JSON.stringify({Device:document.getElementById('raidAddDev').value,Acknowledge:document.getElementById('raidAddAck').value})});closeModal();flash('Replacement drive added; RAID rebuild will proceed in the background.');await raidPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if (action === 'docker-create'){openDockerCreateModal();return;}
  if (action === 'docker-create-save'){
    target.disabled=true;
    try{
      const lines=id=>String(document.getElementById(id)?.value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);
      const commandText=String(document.getElementById('dockerCreateCommand')?.value||'').trim();
      const cmd=commandText?commandText.split(/\s+/).filter(Boolean):[];
      const image=dockerImageChoice();
      if(!image) throw new Error('Choose a local Docker image or enter an image reference.');
      await api('/api/docker/containers',{method:'POST',body:JSON.stringify({
        Name:document.getElementById('dockerCreateName')?.value||'',
        Image:image,
        Restart:document.getElementById('dockerCreateRestart')?.value||'unless-stopped',
        Network:document.getElementById('dockerCreateNetwork')?.value||'',
        Env:lines('dockerCreateEnv'),
        Ports:dockerPortMappingsFromEditor('dockerCreatePortRows'),
        Volumes:lines('dockerCreateVolumes'),
        Command:cmd
      })});
      closeModal();flash('Container created.');await dockerPage();
    }catch(e){flash(e.message,'bad');target.disabled=false;}
    return;
  }
  if(action==='docker-inspect'){try{const d=await api('/api/docker/containers/'+encodeURIComponent(target.dataset.container)+'/inspect');const cfg=d.Config||{},host=d.HostConfig||{},state=d.State||{};const mounts=list(d.Mounts);openModal(`${target.dataset.container} details`,'Current runtime configuration reported directly by Docker.',`<div class="docker-detail-grid"><div><span>Status</span>${statusPill(state.Running?'Running':state.Status||'Stopped',state.Running?'good':'warn')}</div><div><span>Image</span><code>${esc(cfg.Image||d.Image||'—')}</code></div><div><span>Restart policy</span><b>${esc(host.RestartPolicy?.Name||'no')}</b></div><div><span>Network mode</span><b>${esc(host.NetworkMode||'default')}</b></div></div><section class="modal-section"><div class="form-section-title"><b>Published ports</b><span>Ports reachable on the NAS and their destination inside the container.</span></div>${dockerPortChips(d.port_bindings)}</section><section class="modal-section"><div class="form-section-title"><b>Storage</b><span>${mounts.length} mount${mounts.length===1?'':'s'} attached.</span></div><div class="resource-list">${mounts.map(m=>`<div class="resource-row"><div><b>${esc(m.Destination||'—')}</b><small>${esc(m.Source||m.Name||'')}</small></div><span>${esc(m.Type||'mount')}</span><span>${m.RW===false?'Read only':'Read/write'}</span></div>`).join('')||'<span class="subtle">No mounts.</span>'}</div></section><details class="advanced"><summary>Raw Docker inspect data</summary><div class="advanced-body"><pre class="modal-log">${esc(JSON.stringify(d,null,2))}</pre></div></details>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>')}catch(e){flash(e.message,'bad')}return;}
  if(action==='docker-edit'){await openDockerEditModal(target.dataset.container);return;}
  if(action==='docker-edit-save'){
    target.disabled=true;
    try{
      const result=await api('/api/docker/containers/'+encodeURIComponent(target.dataset.container),{method:'PUT',body:JSON.stringify({
        Name:document.getElementById('dockerEditName')?.value||'',
        Restart:document.getElementById('dockerEditRestart')?.value||'no',
        Ports:dockerPortMappingsFromEditor('dockerEditPortRows')
      })});
      closeModal();
      flash(result.recreated?'Container recreated safely with the new published ports.':'Container settings updated.');
      await dockerPage();
    }catch(e){flash(e.message,'bad');target.disabled=false;}
    return;
  }
  if(action==='docker-port-add'){const id=target.dataset.portTarget;const root=id?document.getElementById(id):null;if(root)root.insertAdjacentHTML('beforeend',dockerPortRow());return;}
  if(action==='docker-port-remove'){target.closest('[data-docker-port-row]')?.remove();return;}
  if(action==='docker-network-create'){openDockerResourceModal('network');return;} if(action==='docker-volume-create'){openDockerResourceModal('volume');return;}
  if(action==='docker-resource-save'){target.disabled=true;try{const kind=target.dataset.kind;if(kind==='network')await api('/api/docker/networks',{method:'POST',body:JSON.stringify({Name:document.getElementById('dockerResourceName').value,Driver:document.getElementById('dockerNetworkDriver').value})});else await api('/api/docker/volumes',{method:'POST',body:JSON.stringify({Name:document.getElementById('dockerResourceName').value})});closeModal();flash(`Docker ${kind} created.`);await dockerPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if(action==='docker-engine-start'){target.disabled=true;try{await api('/api/services/zero1-docker.service/action',{method:'POST',body:JSON.stringify({Action:'enable-start'})});clearAPIMemo();flash('Docker engine started.');await dockerPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if(action==='docker-network-delete'){await confirmAction(`Remove network ${target.dataset.network}?`,'Docker will refuse while containers still use it.','Remove network',async()=>{await api('/api/docker/networks/'+encodeURIComponent(target.dataset.network),{method:'DELETE',body:'{}'});closeModal();flash('Network removed.');await dockerPage();});return;}
  if(action==='docker-volume-delete'){await confirmAction(`Remove volume ${target.dataset.volume}?`,'Persistent volume data will be permanently deleted if Docker allows removal.','Remove volume',async()=>{await api('/api/docker/volumes/'+encodeURIComponent(target.dataset.volume),{method:'DELETE',body:'{}'});closeModal();flash('Volume removed.');await dockerPage();});return;}
  if(action==='led-pattern-create'){openModal('Create custom light pattern','Choose the light, color and behavior. Advanced users can optionally enter the raw hardware commands instead.',`<div class="form-stack"><label>Pattern name</label><input id="ledPatternName" placeholder="Maintenance mode"><div class="field-grid"><div><label>Light</label><select id="ledPatternTarget"><option value="power">Power light</option><option value="disk1">Drive 1 light</option><option value="disk2">Drive 2 light</option></select></div><div><label>Color</label><select id="ledPatternColor"><option value="green">Green</option><option value="yellow">Yellow</option><option value="red">Red</option><option value="off">Off</option></select></div></div><label>Behavior</label><select id="ledPatternBehavior"><option value="solid">Solid</option><option value="fast">Flashing</option><option value="slow">Slow flashing</option></select><label>Description</label><input id="ledPatternDesc" placeholder="Used while maintenance is in progress"><details class="advanced form-advanced"><summary>Advanced hardware commands</summary><div class="advanced-body"><input id="ledPatternCodes" placeholder="Leave blank to generate automatically"><small class="field-help">Optional comma-separated Twinkle commands. Use this only if you understand the verified channel/mode mapping.</small></div></details></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="led-pattern-create-save">Create pattern</button>`);return;}
  if(action==='led-pattern-create-save'){const d=window.__zero1LED;const custom=list(d.settings?.patterns).filter(x=>!x.built_in);let codes=csv(document.getElementById('ledPatternCodes')?.value);if(!codes.length){const target=document.getElementById('ledPatternTarget').value,color=document.getElementById('ledPatternColor').value,behavior=document.getElementById('ledPatternBehavior').value;const pair=target==='power'?['0','1']:target==='disk1'?['2','3']:['4','5'];const mode=behavior==='solid'?'0':behavior==='slow'?'3':'2';codes=color==='off'?[pair[0]+'1',pair[1]+'1']:color==='green'?[pair[0]+'1',pair[1]+mode]:color==='red'?[pair[0]+mode,pair[1]+'1']:color==='yellow'?[pair[0]+mode,pair[1]+mode]:[pair[0]+mode,pair[1]+mode];}custom.push({name:document.getElementById('ledPatternName').value,description:document.getElementById('ledPatternDesc').value,codes});try{await api('/api/hardware/led-settings',{method:'PUT',body:JSON.stringify({Automatic:d.settings?.automatic!==false,InternetOutageIndicator:d.settings?.internet_outage_indicator!==false,CustomPatterns:custom,Assignments:d.settings?.assignments||{}})});closeModal();flash('Custom light pattern created.');await hardwarePage();}catch(e){flash(e.message,'bad')}return;}
  if(action==='led-pattern-delete'){const d=window.__zero1LED;const name=target.dataset.pattern;const used=Object.entries(d.settings?.assignments||{}).filter(([,v])=>v===name).map(([k])=>k);if(used.length){flash('This pattern is assigned to '+used.join(', ')+'. Reassign those events before removing it.','warn');return;}const custom=list(d.settings?.patterns).filter(x=>!x.built_in&&x.name!==name);await api('/api/hardware/led-settings',{method:'PUT',body:JSON.stringify({Automatic:d.settings?.automatic!==false,InternetOutageIndicator:d.settings?.internet_outage_indicator!==false,CustomPatterns:custom,Assignments:d.settings?.assignments||{}})});flash('Custom LED pattern removed.');await hardwarePage();return;}
  if(action==='led-pattern-test'){target.disabled=true;try{await api('/api/hardware/led-test',{method:'POST',body:JSON.stringify({Pattern:target.dataset.pattern,Seconds:5})});flash(`${target.dataset.pattern} applied for 5 seconds.`);}catch(e){flash(e.message,'bad')}finally{target.disabled=false}return;}
  if(action==='led-settings-save'){const d=window.__zero1LED;const assignments={};document.querySelectorAll('[data-led-assignment]').forEach(x=>assignments[x.dataset.ledAssignment]=x.value);const custom=list(d.settings?.patterns).filter(x=>!x.built_in);try{await api('/api/hardware/led-settings',{method:'PUT',body:JSON.stringify({Automatic:document.getElementById('ledAutomatic').checked,InternetOutageIndicator:document.getElementById('ledInternetIndicator').checked,CustomPatterns:custom,Assignments:assignments})});flash('Status-light settings saved.');await hardwarePage();}catch(e){flash(e.message,'bad')}return;}
  if(action==='usb-mount'){target.disabled=true;try{await api('/api/recovery/usb/mount',{method:'POST',body:JSON.stringify({Device:target.dataset.device})});flash('USB drive connected.');await usbDrivesPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if(action==='usb-backup-open'){usbBackupModal(target.dataset.mountpoint,target.dataset.label||'USB drive');return;}
  if(action==='usb-backup-save'){target.disabled=true;try{const share=document.getElementById('usbBackupShare').value,mount=String(target.dataset.mountpoint||'').replace(/\/+$/,''),destination=`${mount}/Zero1Backups/${slug(share)||'share'}`,name=`USB backup · ${share}`;const payload={Name:name,Share:share,Destination:destination,TargetID:'',Schedule:document.getElementById('usbBackupSchedule').value,TimeOfDay:document.getElementById('usbBackupTime').value,Weekdays:csv(document.getElementById('usbBackupDays').value),Retain:Number(document.getElementById('usbBackupRetain').value||7),BandwidthKB:0,Include:[],Exclude:[],Verify:document.getElementById('usbBackupVerify').checked,Encrypt:false,Passphrase:'',Enabled:true};let jobs=list((await api('/api/backups',{fresh:true})).jobs),job=jobs.find(j=>String(j.share)===share&&String(j.destination||'')===destination);if(job){await api('/api/backups/'+encodeURIComponent(job.id),{method:'PUT',body:JSON.stringify(payload)});}else{await api('/api/backups',{method:'POST',body:JSON.stringify(payload)});jobs=list((await api('/api/backups',{fresh:true})).jobs);job=jobs.find(j=>String(j.share)===share&&String(j.destination||'')===destination);}const runNow=document.getElementById('usbBackupRunNow').checked;closeModal();if(runNow&&job?.id){const r=await api('/api/backups/'+encodeURIComponent(job.id)+'/run',{method:'POST',body:'{}'});flash(`USB backup started${r.task_id?` as task ${r.task_id}`:''}.`);}else if(runNow){flash('USB backup job was created, but Zero1Local could not resolve its task ID. Open Backups to run it.','warn');}else flash('USB backup job saved.');await usbDrivesPage();}catch(e){flash(e.message,'bad');target.disabled=false}return;}
  if(action==='recovery-mount'){target.disabled=true;try{const d=await api('/api/recovery/usb/mount',{method:'POST',body:JSON.stringify({Device:target.dataset.device})});flash(`Recovery USB mounted at ${d.mountpoint}.`);await recoveryPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if(action==='recovery-create'){await confirmAction('Create a verified Recovery Vault?','Zero1Local will archive known IronCow application data and configuration to this USB, preserving Linux ownership, ACLs and xattrs, then verify every archive/checksum. Main Storage is not modified by this step.','Create Recovery Vault',async()=>{await api('/api/recovery/archive',{method:'POST',body:JSON.stringify({Mount:target.dataset.mount})});closeModal();flash('Recovery Vault creation started.');await recoveryPage();});return;}
  if(action==='clean-takeover'){const review=list(window.__zero1Recovery?.clean_takeover_review);const reviewHtml=review.length?`<div class="notice notice-warn"><b>Owner review required before removal</b><span>${review.length} unclassified path${review.length===1?'':'s'} remain inside IronCow application roots. They are included in the verified Recovery Vault, but will be removed from Main Storage with those roots unless you move them first.</span></div><div class="takeover-review-list">${review.map(x=>`<code>${esc(x.path)}</code>`).join('')}</div><label class="checkline risk"><input id="cleanTakeoverReviewAck" type="checkbox"><span><b>I reviewed every path listed above</b><small>Anything I want to keep has been copied or moved out of the IronCow application roots.</small></span></label>`:'';openModal('Start Fresh and Remove IronCow','This is the deliberate factory-layout removal path. The selected USB vault will be re-verified immediately before any data movement.',`<div class="notice notice-warn"><b>What will happen</b><span>Existing shares are adopted. Share-backed data inside IronCow/legacy implementation folders is normalized to top-level Main Storage. Unknown top-level owner data is preserved. Unclassified content inside known IronCow roots requires explicit review. Known IronCow application roots are removed only after SMB/NFS validation succeeds. Factory application/UI services remain reversibly isolated.</span></div>${reviewHtml}<label>Verified vault</label><code>${esc(target.dataset.vault)}</code><label>Type exactly: REMOVE IRONCOW APPLICATION DATA</label><input id="cleanTakeoverAck">`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="clean-takeover-run" data-vault="${attr(target.dataset.vault)}">Run Start Fresh and Remove IronCow</button>`);return;}
  if(action==='clean-takeover-run'){const review=list(window.__zero1Recovery?.clean_takeover_review);if(review.length&&!document.getElementById('cleanTakeoverReviewAck')?.checked){flash('Review and acknowledge the unclassified IronCow-root content before continuing.','warn');return;}target.disabled=true;try{const d=await api('/api/recovery/clean-takeover',{method:'POST',body:JSON.stringify({VaultPath:target.dataset.vault,Acknowledge:document.getElementById('cleanTakeoverAck').value,ReviewUnclassified:review.length===0||Boolean(document.getElementById('cleanTakeoverReviewAck')?.checked)})});closeModal();flash(`Start Fresh and Remove IronCow completed. ${list(d.removed_factory_roots).length} IronCow application roots removed.`);await recoveryPage();}catch(e){flash(e.message,'bad');target.disabled=false;}return;}
  if(action==='recovery-restore'){await confirmAction('Restore archived IronCow factory data?','Zero1Local re-verifies the USB vault and refuses to overwrite any factory-data root that currently exists. Recorded factory services are restored to their pre-isolation state after the data is extracted.','Restore factory data',async()=>{await api('/api/recovery/restore',{method:'POST',body:JSON.stringify({VaultPath:target.dataset.vault,Acknowledge:true})});closeModal();flash('Archived factory data restored.');await recoveryPage();});return;}
  if (action === 'docker-action') {
    target.disabled = true;
    try { await api('/api/docker/containers/' + encodeURIComponent(target.dataset.container) + '/action', { method: 'POST', body: JSON.stringify({ Action: target.dataset.dockerAction }) }); flash(`Container ${target.dataset.dockerAction} command completed.`); await dockerPage(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'docker-logs') {
    try { const d = await api('/api/docker/containers/' + encodeURIComponent(target.dataset.container) + '/logs?lines=300'); openModal(`${target.dataset.container} logs`, 'Last 300 lines', `<pre class="modal-log">${esc(d.log || 'No output')}</pre>`, '<button class="btn btn-primary" data-action="close-modal">Close</button>'); } catch (e) { flash(e.message, 'bad'); }
    return;
  }
  if (action === 'smart-test') {
    const device=target.dataset.device, test=target.dataset.test; await confirmAction(`Start ${test} SMART test?`, `The ${test} drive self-test runs in the disk firmware and does not erase data. If another self-test is already active, Zero1Local will show its progress instead of aborting it.`, 'Start test', async()=>{const r=await api('/api/storage/smart-test',{method:'POST',body:JSON.stringify({Device:device,Test:test})});closeModal();flash(r.already_running?`A SMART self-test is already running on ${device}; progress is now shown below.`:`${test} SMART test started on ${device}.`);await disksPage();}); return;
  }
  if (action === 'vlan-create') { openVLANModal('create'); return; }
  if (action === 'vlan-edit') { const v=list(window.__zero1VLANs?.vlans).find(x=>x.name===target.dataset.vlan); if(v)openVLANModal('edit',v); return; }
  if (action === 'vlan-save') { const editing=target.dataset.mode==='edit'; const payload={ID:Number(document.getElementById('vlanId')?.value||0),Parent:document.getElementById('vlanParent')?.value||'',Label:document.getElementById('vlanLabel')?.value||'',Method:document.getElementById('vlanMethod').value,Address:composedVLANAddress(),Gateway:'',DNS:[],MTU:Number(document.getElementById('vlanMtu')?.value||0)}; target.disabled=true; try{await api(editing?'/api/network/vlans/'+encodeURIComponent(target.dataset.vlan):'/api/network/vlans',{method:editing?'PUT':'POST',body:JSON.stringify(payload)});closeModal();flash(editing?'VLAN settings updated.':'VLAN created and activated.');await (normalizedPath()==='/network'?networkPage():vlanPage());}catch(e){flash(e.message,'bad');target.disabled=false;} return; }
  if (action === 'vlan-delete') { const name=target.dataset.vlan; await confirmAction(`Remove ${name}?`,'This removes only the Zero1Local-created VLAN connection. The physical LAN connection is not changed.','Remove VLAN',async()=>{await api('/api/network/vlans/'+encodeURIComponent(name),{method:'DELETE',body:'{}'});closeModal();flash('VLAN removed.');await (normalizedPath()==='/network'?networkPage():vlanPage());}); return; }
  if (action === 'file-view-mode') { localStorage.setItem('zero1-file-view',target.dataset.view==='grid'?'grid':'list');await filesPage();return; }
  if (action === 'file-upload') { openUploadModal(); return; }
  if (action === 'file-upload-save') { await uploadSelectedFiles(target); return; }
  if (action === 'file-copy' || action === 'file-move') { openFileTransferModal(action==='file-copy'?'copy':'move',target.dataset.path,target.dataset.name); return; }
  if (action === 'file-transfer-save') { target.disabled=true; try{await api('/api/files/'+target.dataset.kind,{method:'POST',body:JSON.stringify({Source:target.dataset.path,DestinationDirectory:document.getElementById('fileTransferDest').value,NewName:document.getElementById('fileTransferName').value})});closeModal();flash(target.dataset.kind==='copy'?'Item copied.':'Item moved.');await filesPage();}catch(e){flash(e.message,'bad');target.disabled=false;} return; }
  if (action === 'docker-pull') { openDockerPullModal(); return; }
  if (action === 'docker-pull-view') { const job=list(window.__zero1Docker?.pull_jobs).find(j=>j.id===target.dataset.job); if(job) openDockerPullModal(job); return; }
  if (action === 'docker-pull-save') {
    target.disabled=true;
    try{
      const image=String(document.getElementById('dockerPullImage')?.value||'').trim();
      if(!image) throw new Error('Enter a Docker image reference.');
      const job=await api('/api/docker/images/pull',{method:'POST',busy:false,body:JSON.stringify({Image:image})});
      document.querySelector('[data-action="docker-pull-save"]')?.classList.add('hidden');
      document.getElementById('dockerPullImage')?.setAttribute('disabled','disabled');
      await pollDockerPullJob(job.id);
    }catch(e){flash(e.message,'bad');target.disabled=false;}
    return;
  }
  if (action === 'docker-remove-container') { const name=target.dataset.container; await confirmAction(`Remove ${name}?`,'The stopped container will be deleted. Named volumes and images are not removed.','Remove container',async()=>{await api('/api/docker/containers/'+encodeURIComponent(name),{method:'DELETE',body:'{}'});closeModal();flash('Container removed.');await dockerPage();}); return; }
  if (action === 'docker-remove-image') { const image=target.dataset.image; await confirmAction('Remove Docker image?','Docker will refuse if a container still depends on this image.','Remove image',async()=>{await api('/api/docker/images/'+encodeURIComponent(image),{method:'DELETE',body:'{}'});closeModal();flash('Image removed.');await dockerPage();}); return; }
  if (action === 'dns-edit') { openDNSEditModal(); return; }
  if (action === 'proxy-helper') { proxyHelperModal(Number(target.dataset.port||80),target.dataset.service||'Web service'); return; }
  if (action === 'dns-save') {
    const mode = document.getElementById('dnsMode').value;
    const servers = mode === 'manual' ? csv(document.getElementById('dnsServers').value) : [];
    target.disabled = true;
    try { await api('/api/network/dns', { method: 'PUT', body: JSON.stringify({ Mode: mode, Servers: servers }) }); closeModal(); flash('DNS settings updated.'); await networkPage(); }
    catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'hostname-edit') { openHostnameModal(); return; }
  if (action === 'hostname-save') {
    target.disabled = true;
    try {
      const d = await api('/api/system/hostname', { method: 'PUT', body: JSON.stringify({ Hostname: document.getElementById('newHostname').value }) });
      closeModal(); flash(`Hostname changed to ${d.hostname}.`); await systemPage();
      const top = document.getElementById('topDevice'); if (top) top.textContent = d.hostname || 'Zero1Local';
    } catch (e) { flash(e.message, 'bad'); target.disabled = false; }
    return;
  }
  if (action === 'factory-isolate') {
    await confirmAction('Isolate factory application services?', 'Zero1Local will enforce its application boundary against IronCow UI, remote-connectivity and other replaceable vendor userspace, including unresolved vendor processes such as upload-module. Factory files stay intact, hardware-facing services remain protected, and original service states are recorded for deliberate rollback.', 'Isolate factory applications', async () => {
      await api('/api/vendor/isolation', { method: 'POST', body: JSON.stringify({ Action: 'isolate', Acknowledge: true }) }); closeModal(); flash('Factory application services isolated.'); await factoryPage();
    });
    return;
  }
  if (action === 'factory-restore') {
    await confirmAction('Restore factory application services?', 'This deliberately opts out of Zero1Local factory-application isolation. Recorded IronCow services will return to their previous startup/running states and vendor remote-connectivity or unresolved userspace may run again until you re-isolate them.', 'Restore factory applications', async () => {
      await api('/api/vendor/isolation', { method: 'POST', body: JSON.stringify({ Action: 'restore', Acknowledge: true }) }); closeModal(); flash('Factory application services restored.'); await factoryPage();
    });
    return;
  }
  if (action === 'service-action') {
    const unit = target.dataset.service;
    const verb = target.dataset.serviceAction;
    const dangerous = ['stop', 'mask', 'disable-stop'].includes(verb);
    const run = async () => { const endpoint='/api/services/' + encodeURIComponent(unit) + '/action'; if(verb==='enable-start'){await api(endpoint,{method:'POST',body:JSON.stringify({Action:'enable'})});await api(endpoint,{method:'POST',body:JSON.stringify({Action:'start'})});}else if(verb==='disable-stop'){await api(endpoint,{method:'POST',body:JSON.stringify({Action:'stop'})});await api(endpoint,{method:'POST',body:JSON.stringify({Action:'disable'})});}else{await api(endpoint,{method:'POST',body:JSON.stringify({Action:verb})});} closeModal(); flash('Service setting updated.'); if(normalizedPath()==='/settings') await settingsPage(); else await servicesPage(); };
    if (dangerous) {
      const label = verb === 'mask' ? 'Mask service' : verb === 'disable-stop' ? 'Disable and stop' : 'Stop service';
      const msg = verb === 'mask' ? 'The service will be stopped immediately and prevented from starting until it is explicitly unmasked.' : 'Other system functions using this service may be interrupted.';
      await confirmAction(`${label} · ${unit}?`, msg, label, run);
    } else { target.disabled = true; try { await run(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; } }
    return;
  }
  if (action === 'qualification-run') {
    target.disabled=true;
    try { const d=await api('/api/diagnostics/qualification/run',{method:'POST',body:'{}'}); flash(`Advanced system check started${d.task_id?' · task '+d.task_id:''}. Follow progress in Task Center.`); await refreshChromeStatus(); await diagnosticsPage(); }
    catch(e){ flash(e.message,'bad'); target.disabled=false; }
    return;
  }
  if (action === 'update-apply-dismiss') {
    const x=window.__zero1Updates?.update_apply;
    if(!x||(x.status!=='failed'&&x.status!=='completed'))return;
    try{localStorage.setItem('zero1local.updateApplyDismissed',updateApplyDismissKey(x))}catch{}
    flash(x.status==='failed'?'Failed update notice dismissed.':'Completed update notice dismissed.');
    renderUpdatesPage(window.__zero1Updates||{});
    return;
  }
  if (action === 'update-settings-save') {
    target.disabled=true;
    try {
      await api('/api/update/settings',{method:'PUT',body:JSON.stringify({channel:document.getElementById('updateChannel')?.value||'stable',auto_check:!!document.getElementById('updateAutoCheck')?.checked,interval_hours:Number(document.getElementById('updateInterval')?.value||6),install_mode:document.getElementById('updateInstallMode')?.value||'manual',install_hour:Number(document.getElementById('updateInstallHour')?.value??3)})});
      flash('Update preferences saved.'); await updatesPage();
    } catch(e) { flash(e.message,'bad'); target.disabled=false; }
    return;
  }
  if (action === 'update-check-now') {
    target.disabled=true;
    try { await refreshUpdatesFromGitHub(); } catch(e) { flash(e.message,'bad'); }
    return;
  }
  if (action === 'update-install') {
    const v=target.dataset.version||'the selected release';
    await confirmAction(`Install Zero1Local v${v}?`,'Zero1Local will download the release from GitHub, verify the package, check this NAS, and then install it. After the update starts, this browser will move to the independent Update Monitor so progress remains visible while the normal administrator session restarts. If the new version cannot activate safely, the transactional installer attempts to return to the previous working version.','Install now',async()=>{
      await api('/api/update/install',{method:'POST',body:'{}'});
      closeModal();
      const h=location.hostname.includes(':')?`[${location.hostname}]`:location.hostname;
      const monitorQuery=new URLSearchParams({version:v});
      const monitorTheme=String(document.documentElement.dataset.theme||'').toLowerCase();
      if(monitorTheme==='light'||monitorTheme==='dark')monitorQuery.set('theme',monitorTheme);
      window.location.assign(`http://${h}:8090/?${monitorQuery.toString()}`);
    });
    return;
  }
  if (action === 'power-request') {
    const verb = target.dataset.powerAction;
    const title = verb === 'reboot' ? 'Restart this NAS?' : 'Power off this NAS?';
    const msg = verb === 'reboot' ? 'Active file transfers and sessions will be interrupted. The NAS should return after the normal boot sequence.' : 'Active file transfers and sessions will be interrupted. The operating system will shut down cleanly and may require physical power to start again.';
    const label = verb === 'reboot' ? 'Restart NAS' : 'Power Off NAS';
    await confirmAction(title, msg, label, async () => { const d=await api('/api/system/power', { method: 'POST', body: JSON.stringify({ Action: verb, Acknowledge: true }) }); closeModal(); savePendingPowerAction({action:verb,boot_id:d.boot_id||window.__zero1System?.boot_persistence?.boot_id||'',requested_at:Date.now(),version:currentVersion}); flash(verb === 'reboot' ? 'Restarting the NAS. This page will reconnect when Zero1Local is back online.' : 'Powering off the NAS. This page will disconnect shortly.', 'warn'); if(verb==='reboot') monitorOrderlyReboot(d.boot_id||window.__zero1System?.boot_persistence?.boot_id||''); });
    return;
  }
  if (action === 'backup-create') { backupModal(); return; }
  if (action === 'backup-edit') { const j=list(window.__zero1Backups?.jobs).find(x=>x.id===target.dataset.backup); if(j)backupModal(j); return; }
  if (action === 'backup-versions-open') { try{await openBackupVersions(target.dataset.backup)}catch(e){flash(e.message,'bad')} return; }
  if (action === 'backup-version-browse') { try{await openBackupVersionContents(target.dataset.backup,target.dataset.archive)}catch(e){flash(e.message,'bad')} return; }
  if (action === 'backup-version-restore') { if(!confirm('Restore this item to its original shared folder? Existing files are not overwritten.'))return;target.disabled=true;try{const d=await api('/api/backup-versions/restore',{method:'POST',body:JSON.stringify({job:target.dataset.backup,archive:target.dataset.archive,member:target.dataset.member,destination:'',overwrite:false})});flash(`${d.restored||1} item${Number(d.restored||1)===1?'':'s'} restored.`);closeModal()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'backup-save') { target.disabled=true; try{const payload={Name:document.getElementById('backupName').value,Share:document.getElementById('backupShare').value,Destination:document.getElementById('backupDestination').value,TargetID:document.getElementById('backupTarget').value,Schedule:document.getElementById('backupSchedule').value,TimeOfDay:document.getElementById('backupTime').value,Weekdays:csv(document.getElementById('backupDays').value),Retain:Number(document.getElementById('backupRetain').value||7),BandwidthKB:Number(document.getElementById('backupBandwidth').value||0),Include:csv(document.getElementById('backupInclude').value),Exclude:csv(document.getElementById('backupExclude').value),Verify:document.getElementById('backupVerify').checked,Encrypt:document.getElementById('backupEncrypt').checked,Passphrase:document.getElementById('backupPassphrase').value,Enabled:document.getElementById('backupEnabled').checked};const id=target.dataset.backup;await api(id?'/api/backups/'+encodeURIComponent(id):'/api/backups',{method:id?'PUT':'POST',body:JSON.stringify(payload)});closeModal();flash(id?'Backup job updated.':'Backup job created.');await backupsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'backup-target-create') { backupTargetModal(); return; }
  if (action === 'backup-target-edit') { const t=list(window.__zero1BackupTargets?.targets).find(x=>x.id===target.dataset.target); if(t)backupTargetModal(t); return; }
  if (action === 'backup-target-save') { target.disabled=true;try{const payload={ID:target.dataset.target||'',Name:document.getElementById('backupTargetName').value,Type:document.getElementById('backupTargetType').value,Endpoint:document.getElementById('backupTargetEndpoint').value,Username:document.getElementById('backupTargetUser').value,Secret:document.getElementById('backupTargetSecret').value,Bucket:document.getElementById('backupTargetBucket').value,Region:document.getElementById('backupTargetRegion').value};await api('/api/backup-targets',{method:'POST',body:JSON.stringify(payload)});closeModal();flash('Backup destination saved.');await backupsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'backup-target-test') { target.disabled=true;try{await api('/api/backup-targets/'+encodeURIComponent(target.dataset.target)+'/test',{method:'POST',body:'{}'});flash('Backup destination passed a live connectivity/write test.');await backupsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'backup-target-delete') { await confirmAction(`Remove ${target.dataset.name||'this backup destination'}?`,'Jobs using this destination must be changed or removed first.','Remove destination',async()=>{await api('/api/backup-targets/'+encodeURIComponent(target.dataset.target),{method:'DELETE',body:'{}'});closeModal();flash('Backup destination removed.');await backupsPage()});return; }
  if (action === 'backup-run') { target.disabled=true; try{const d=await api('/api/backups/'+encodeURIComponent(target.dataset.backup)+'/run',{method:'POST',body:'{}'});flash(`Backup started as task ${d.task_id}.`);await backupsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'backup-delete') { await confirmAction(`Remove ${target.dataset.name}?`,'The backup job definition is removed. Existing backup archives at the destination are deliberately left intact.','Remove job',async()=>{await api('/api/backups/'+encodeURIComponent(target.dataset.backup),{method:'DELETE',body:'{}'});closeModal();flash('Backup job removed. Existing archives were preserved.');await backupsPage();}); return; }
  if (action === 'config-restore') { const input=document.getElementById('configRestoreFile'); if(!input?.files?.length){flash('Choose a Zero1Local configuration backup ZIP.','bad');return} await confirmAction('Restore this Zero1Local configuration?','Zero1Local will create a local recovery checkpoint before replacing current configuration state. Active SMB configuration will be revalidated after restore.','Restore configuration',async()=>{const fd=new FormData();fd.append('backup',input.files[0],input.files[0].name);showGlobalBusy('Restoring configuration…');try{const res=await fetch('/api/system/config-restore',{method:'POST',headers:{'X-Zero1Local-Request':'1'},credentials:'same-origin',body:fd});let d={};try{d=await res.json()}catch{};if(!res.ok)throw new Error(d.error||`Restore failed (${res.status})`);closeModal();flash('Configuration restored and reconciled.');setTimeout(()=>location.reload(),800)}finally{hideGlobalBusy()}}); return; }
  if (action === 'stack-create') { stackCreateModal(); return; }
  if (action === 'stack-save') { target.disabled=true;try{const d=await api('/api/docker/stacks',{method:'POST',body:JSON.stringify({Name:document.getElementById('stackName').value,Compose:document.getElementById('stackCompose').value})});closeModal();flash(`Stack deployment started as ${d.task_id}.`);await dockerStacksPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'stack-action') { target.disabled=true;try{const d=await api('/api/docker/stacks/'+encodeURIComponent(target.dataset.stack)+'/'+encodeURIComponent(target.dataset.stackAction),{method:'POST',body:'{}'});flash(`${target.dataset.stackAction} started as ${d.task_id}.`);await dockerStacksPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'stack-delete') { await confirmAction(`Remove ${target.dataset.stack}?`,'Zero1Local will run docker compose down, then remove only the stored stack definition. Docker images and external volumes are preserved.','Remove stack',async()=>{await api('/api/docker/stacks/'+encodeURIComponent(target.dataset.stack),{method:'DELETE',body:'{}'});closeModal();flash('Compose stack removed.');await dockerStacksPage();}); return; }
  if (action === 'file-properties') { try{const d=await api('/api/files/properties?path='+encodeURIComponent(target.dataset.path));openModal(`${d.name} properties`,'Live filesystem information from the active shared folder.',`<div class="property-grid"><div><span>Type</span><b>${d.directory?'Folder':'File'}</b></div><div><span>Size</span><b>${fmtBytes(d.size)}</b></div><div><span>Items</span><b>${Number(d.items||1)}</b></div><div><span>Modified</span><b>${esc(fmtDate(d.modified))}</b></div><div><span>Permissions</span><code>${esc(d.mode)}</code></div><div><span>Writable</span><b>${d.writable?'Yes':'No'}</b></div></div><details class="advanced"><summary>Linux path</summary><code>${esc(d.path)}</code></details>`,'<button class="btn btn-primary" data-action="close-modal">Close</button>')}catch(e){flash(e.message,'bad')} return; }
  if (action === 'file-preview') { closeFileContextMenu();await openFilePreview(target.dataset.path,target.dataset.name,Number(target.dataset.size||0));return; }
  if (action === 'file-archive') { await confirmAction(`Create ZIP for ${target.dataset.name}?`,'The ZIP is created beside the selected item inside the same shared folder. Symbolic links are refused for safety.','Create ZIP',async()=>{await api('/api/files/archive',{method:'POST',body:JSON.stringify({Path:target.dataset.path,Name:target.dataset.name+'.zip'})});closeModal();flash('ZIP archive created.');await filesPage();},false); return; }
  if (action === 'file-extract') { await confirmAction(`Extract ${target.dataset.name}?`,'The ZIP is extracted into a new folder beside the archive. Unsafe archive paths and collisions are refused.','Extract ZIP',async()=>{await api('/api/files/extract',{method:'POST',body:JSON.stringify({Path:target.dataset.path})});closeModal();flash('ZIP archive extracted.');await filesPage();},false); return; }
  if (action === 'file-favorite-toggle') { const d=window.__zero1Files||{};if(d.scope!=='share')return;try{if(target.dataset.favorite==='1'){await api('/api/files/favorites?share='+encodeURIComponent(d.share)+'&path='+encodeURIComponent(d.relative_path||''),{method:'DELETE'});flash('Removed from Favorites.')}else{await api('/api/files/favorites',{method:'POST',body:JSON.stringify({share:d.share,path:d.relative_path||''})});flash('Added to Favorites.')}await filesPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'file-search-run') { const d=window.__zero1Files||{};const q=document.getElementById('fileSearchQuery')?.value||'';if(d.scope!=='share'){return}try{const r=await api('/api/files/search?share='+encodeURIComponent(d.share)+'&q='+encodeURIComponent(q)+'&limit=100');const body=`<div class="search-result-list search-v3-results">${list(r.results).map(x=>`<a href="${x.directory?`/files?share=${encodeURIComponent(d.share)}&rel=${encodeURIComponent(x.relative_path)}`:`/api/files/download?path=${encodeURIComponent(x.path)}`}"><span>${x.directory?'▰':'▤'}</span><div><b>${esc(x.name)}</b><small>${esc(x.relative_path)} · matched ${esc(x.match_source||'metadata')}</small>${x.snippet?`<p>${esc(x.snippet)}</p>`:''}</div><em>${x.directory?'Folder':fmtBytes(x.size)}</em></a>`).join('')||'<div class="definition-note"><b>No matches</b><span>Try a broader name, path, or indexed text phrase.</span></div>'}</div>`;openModal(`Search ${d.share}`,`${Number(r.total||0).toLocaleString()} match${Number(r.total||0)===1?'':'es'} across ${Number(r.indexed||0).toLocaleString()} indexed items · ${Number(r.content_indexed||0).toLocaleString()} include safe text content${r.refreshing?' · index refresh in progress':''}.`,body,'<button class="btn btn-primary" data-action="close-modal">Close</button>')}catch(e){flash(e.message,'bad')}return; }
  if (action === 'snapshot-create') { snapshotCreateModal(); return; }
  if (action === 'snapshot-create-save') { target.disabled=true;try{await api('/api/snapshots',{method:'POST',body:JSON.stringify({Share:document.getElementById('snapshotShare').value,Reason:document.getElementById('snapshotReason').value})});closeModal();flash('Snapshot created.');await snapshotsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'snapshot-policy') { snapshotPolicyModal(); return; }
  if (action === 'snapshot-policy-save') { target.disabled=true;try{await api('/api/snapshots/policies',{method:'POST',body:JSON.stringify({Share:document.getElementById('snapshotPolicyShare').value,Schedule:document.getElementById('snapshotPolicySchedule').value,TimeOfDay:document.getElementById('snapshotPolicyTime').value,Weekdays:csv(document.getElementById('snapshotPolicyDays').value),Retain:Number(document.getElementById('snapshotPolicyRetain').value||24),Enabled:true})});closeModal();flash('Snapshot policy saved.');await snapshotsPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'snapshot-delete') { await confirmAction('Delete snapshot?','This removes only the selected point-in-time snapshot, not the live shared folder.','Delete snapshot',async()=>{await api('/api/snapshots/'+encodeURIComponent(target.dataset.snapshot),{method:'DELETE',body:'{}'});closeModal();flash('Snapshot removed.');await snapshotsPage()});return; }
  if (action === 'snapshot-restore') { await confirmAction(`Roll ${target.dataset.share} back to this snapshot?`,'Full rollback replaces the live contents of this shared folder with the selected point-in-time state.','Restore snapshot',async()=>{const d=await api('/api/snapshots/'+encodeURIComponent(target.dataset.snapshot)+'/restore',{method:'POST',body:JSON.stringify({Full:true})});closeModal();flash(`Restore started as task ${d.task_id}.`);await snapshotsPage()});return; }
  if (action === 'replication-peer-create') { replicationPeerModal(); return; }
  if (action === 'replication-peer-save') { target.disabled=true;try{await api('/api/replication/peers',{method:'POST',body:JSON.stringify({Name:document.getElementById('replPeerName').value,Host:document.getElementById('replPeerHost').value,Port:Number(document.getElementById('replPeerPort').value||22),User:document.getElementById('replPeerUser').value,RemoteRoot:document.getElementById('replPeerRoot').value})});closeModal();flash('Replication target saved.');await synchronizationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'replication-peer-test') { target.disabled=true;try{await api('/api/replication/'+encodeURIComponent(target.dataset.peer)+'/test',{method:'POST',body:'{}'});flash('Replication target is reachable.');await synchronizationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'replication-job-create') { if(!list(window.__zero1Replication?.peers).length){flash('Pair a replication target first.','warn');return} replicationJobModal(); return; }
  if (action === 'replication-job-save') { target.disabled=true;try{await api('/api/replication/jobs',{method:'POST',body:JSON.stringify({Name:document.getElementById('replJobName').value,Share:document.getElementById('replJobShare').value,PeerID:document.getElementById('replJobPeer').value,Schedule:document.getElementById('replJobSchedule').value,TimeOfDay:document.getElementById('replJobTime').value,BandwidthKB:Number(document.getElementById('replJobBandwidth').value||0),Enabled:document.getElementById('replJobEnabled').checked})});closeModal();flash('Replication job created.');await synchronizationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'replication-peer-delete') { await confirmAction(`Remove ${target.dataset.name||'this replication target'}?`,'A target cannot be removed while a replication job still uses it.','Remove target',async()=>{await api('/api/replication/peers/'+encodeURIComponent(target.dataset.peer),{method:'DELETE',body:'{}'});closeModal();flash('Replication target removed.');await synchronizationPage()});return; }
  if (action === 'replication-job-delete') { await confirmAction(`Remove ${target.dataset.name||'this replication job'}?`,'Remote replicated data is left intact. Only the Zero1Local job definition is removed.','Remove job',async()=>{await api('/api/replication/jobs/'+encodeURIComponent(target.dataset.job),{method:'DELETE',body:'{}'});closeModal();flash('Replication job removed.');await synchronizationPage()});return; }
  if (action === 'replication-run') { target.disabled=true;try{const d=await api('/api/replication/'+encodeURIComponent(target.dataset.job)+'/run',{method:'POST',body:'{}'});flash(`Replication started as task ${d.task_id}.`);await synchronizationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'replacement-locate') { try{await api('/api/storage/replacement/locate',{method:'POST',body:JSON.stringify({Bay:Number(target.dataset.bay)})});flash(`Bay ${target.dataset.bay} locate pattern started.`)}catch(e){flash(e.message,'bad')}return; }
  if (action === 'replacement-add') { replacementAddModal(); return; }
  if (action === 'replacement-add-save') { target.disabled=true;try{const d=await api('/api/storage/replacement/add',{method:'POST',body:JSON.stringify({Device:document.getElementById('replacementDevice').value,Acknowledge:document.getElementById('replacementAck').value})});closeModal();flash(`RAID replacement started as task ${d.task_id}.`);await replacementPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'desktop-share-edit') { desktopShareModal(target.dataset.share); return; }
  if (action === 'desktop-share-save') { target.disabled=true;try{await api('/api/desktop-integration/shares/'+encodeURIComponent(target.dataset.share),{method:'PUT',body:JSON.stringify({TimeMachine:document.getElementById('desktopTM').checked,TimeMachineGB:Number(document.getElementById('desktopTMGB').value||0),PreviousVersions:document.getElementById('desktopPV').checked})});closeModal();flash('Desktop integration updated.');await desktopIntegrationPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'user-profile-edit') { userProfileModal(target.dataset.user); return; }
  if (action === 'user-profile-save') { target.disabled=true;try{await api('/api/users/profiles/'+encodeURIComponent(target.dataset.user),{method:'PUT',body:JSON.stringify({DisplayName:document.getElementById('profileDisplay').value,Role:document.getElementById('profileRole').value,HomeEnabled:document.getElementById('profileHome').checked,Disabled:document.getElementById('profileDisabled').checked,SSHAccess:document.getElementById('profileSSH').checked,Expires:document.getElementById('profileExpires').value,QuotaGB:Number(document.getElementById('profileQuota').value||0),ForcePasswordChange:document.getElementById('profileForcePw').checked})});closeModal();flash('Account policy updated.');await userProfilesPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'hardware-profile-select') { target.disabled=true;try{await api('/api/hardware/profiles',{method:'PUT',body:JSON.stringify({ID:target.dataset.profile})});flash('Hardware profile selected.');await hardwareProfilesPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'network-profile-create') { networkProfileModal(); return; }
  if (action === 'network-profile-edit') { const p=list(window.__zero1NetworkV025?.profiles).find(x=>x.name===target.dataset.name); if(p)networkProfileModal(p); else flash('Network profile not found.','bad'); return; }
  if (action === 'network-profile-save') { target.disabled=true;try{const editing=String(target.dataset.profile||'');const members=[...document.querySelectorAll('.npMember:checked')].map(x=>x.value);const body={Kind:document.getElementById('npKind').value,Label:document.getElementById('npLabel').value,Interface:document.getElementById('npIface').value,Members:members,BondMode:document.getElementById('npBondMode').value,MTU:Number(document.getElementById('npMTU').value||1500),IPv4Method:document.getElementById('npIPv4Method').value,IPv4Address:document.getElementById('npIPv4Address').value,IPv4Gateway:document.getElementById('npIPv4Gateway').value,DNS:String(document.getElementById('npDNS').value||'').split(',').map(x=>x.trim()).filter(Boolean),DefaultRoute:document.getElementById('npDefaultRoute').checked,IPv6Method:document.getElementById('npIPv6Method').value,IPv6Address:document.getElementById('npIPv6Address').value,IPv6Gateway:document.getElementById('npIPv6Gateway').value,IPv6DNS:String(document.getElementById('npIPv6DNS')?.value||'').split(',').map(x=>x.trim()).filter(Boolean),Activate:document.getElementById('npActivate').checked,Acknowledge:document.getElementById('npAck').value};const d=await api(editing?'/api/network/v025/profiles/'+encodeURIComponent(editing):'/api/network/v025/profiles',{method:editing?'PUT':'POST',body:JSON.stringify(body)});closeModal();flash(d.transaction?'Network profile applied; confirm connectivity before the timer expires.':editing?'Network profile updated.':'Network profile staged.');await advancedNetworkPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'network-profile-delete') { await confirmAction(`Delete ${target.dataset.name}?`,'Only the Zero1Local-managed NetworkManager profile and its member profiles are removed. Zero1Local refuses to delete the profile carrying the current default route.','Delete profile',async()=>{await api('/api/network/v025/profiles/'+encodeURIComponent(target.dataset.name),{method:'DELETE',body:'{}'});closeModal();flash('Network profile removed.');await advancedNetworkPage()});return; }
  if (action === 'network-ipv6-edit') { networkIPv6Modal(target.dataset.interface); return; }
  if (action === 'network-ipv6-save') { target.disabled=true;try{await api('/api/network/v025/ipv6/apply',{method:'POST',body:JSON.stringify({Interface:document.getElementById('ipv6Iface').value,Method:document.getElementById('ipv6Method').value,Address:document.getElementById('ipv6Address').value,Gateway:document.getElementById('ipv6Gateway').value,DNS:String(document.getElementById('ipv6DNS').value||'').split(',').map(x=>x.trim()).filter(Boolean)})});closeModal();flash('IPv6 change applied temporarily. Confirm it within 45 seconds.','warn');await advancedNetworkPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'network-v025-commit') { try{if(window.__zero1NetworkV025?.pending?.id)await api('/api/network/v025/commit',{method:'POST',body:'{}'});else await api('/api/network/advanced/commit',{method:'POST',body:'{}'});flash('Network changes confirmed.');await advancedNetworkPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'network-v025-rollback') { try{if(window.__zero1NetworkV025?.pending?.id)await api('/api/network/v025/rollback',{method:'POST',body:'{}'});else await api('/api/network/advanced/rollback',{method:'POST',body:'{}'});flash('Network change rolled back.');await advancedNetworkPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'advanced-network-edit') { advancedNetworkModal(); return; }
  if (action === 'advanced-network-apply') { target.disabled=true;try{const routes=String(document.getElementById('advRoutes').value||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean);await api('/api/network/advanced/apply',{method:'POST',body:JSON.stringify({Interface:document.getElementById('advIface').value,MTU:Number(document.getElementById('advMTU').value),Routes:routes})});closeModal();flash('Network change applied temporarily. Confirm it within 45 seconds.','warn');await advancedNetworkPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'advanced-network-commit') { try{await api('/api/network/advanced/commit',{method:'POST',body:'{}'});flash('Network changes confirmed and saved for reboot.');await advancedNetworkPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'advanced-network-rollback') { try{await api('/api/network/advanced/rollback',{method:'POST',body:'{}'});flash('Network change rolled back.');await advancedNetworkPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'recovery-key-copy') { try{await navigator.clipboard.writeText(target.dataset.key||'');flash('Recovery Key copied to clipboard.')}catch(e){flash('Unable to copy Recovery Key automatically.','bad')}return; }
  if (action === 'totp-setup-open') {
    try { const d=await api('/api/security/totp/setup',{method:'POST'}); openModal('Set up two-factor authentication','Add this account to an authenticator app, then enter a current 6-digit code to confirm it.',`<div class="form-stack"><label>Authenticator secret</label><div class="copy-value"><code>${esc(d.secret)}</code></div><label>Authenticator URI</label><textarea readonly rows="3">${esc(d.otpauth_uri)}</textarea><label>Verification code</label><input id="totpEnableCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="totp-enable-save">Enable 2FA</button>`); } catch(e){flash(e.message,'bad');} return;
  }
  if (action === 'totp-enable-save') { target.disabled=true; try{await api('/api/security/totp/enable',{method:'POST',body:JSON.stringify({code:document.getElementById('totpEnableCode')?.value||''})});closeModal();flash('Two-factor authentication enabled.');await securityPage();}catch(e){flash(e.message,'bad');target.disabled=false} return; }
  if (action === 'totp-disable-open') { openModal('Disable two-factor authentication','Confirm both your current password and authenticator code.',`<div class="form-stack"><label>Current web password</label><input id="totpDisablePw" type="password" autocomplete="current-password"><label>Authenticator code</label><input id="totpDisableCode" inputmode="numeric" maxlength="6" autocomplete="one-time-code"></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-danger" data-action="totp-disable-save">Disable 2FA</button>`); return; }
  if (action === 'totp-disable-save') { target.disabled=true;try{await api('/api/security/totp/disable',{method:'POST',body:JSON.stringify({password:document.getElementById('totpDisablePw')?.value||'',code:document.getElementById('totpDisableCode')?.value||''})});closeModal();flash('Two-factor authentication disabled.');await securityPage();}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'api-key-create-open') { openModal('Create API key','Use the minimum scope required by the integration. The token is displayed only once.',`<div class="form-stack"><label>Name</label><input id="apiKeyName" placeholder="Automation"><label>Scopes</label><div class="check-grid"><label><input type="checkbox" id="apiScopeRead" checked> Read</label><label><input type="checkbox" id="apiScopeWrite"> Write</label><label><input type="checkbox" id="apiScopeAdmin"> Admin</label></div><label>Expires</label><select id="apiKeyExpiry"><option value="0">Never</option><option value="30">30 days</option><option value="90">90 days</option><option value="365">1 year</option></select></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="api-key-create-save">Create key</button>`); return; }
  if (action === 'api-key-create-save') { const scopes=[];if(document.getElementById('apiScopeRead')?.checked)scopes.push('read');if(document.getElementById('apiScopeWrite')?.checked)scopes.push('write');if(document.getElementById('apiScopeAdmin')?.checked)scopes.push('admin');target.disabled=true;try{const d=await api('/api/security/api-keys',{method:'POST',body:JSON.stringify({name:document.getElementById('apiKeyName')?.value||'',scopes,expires_days:Number(document.getElementById('apiKeyExpiry')?.value||0)})});openModal('API key created','Copy this token now. Zero1Local stores only its SHA-256 hash and cannot display it again.',`<div class="copy-value"><code>${esc(d.token)}</code></div><div class="notice notice-warn"><b>Shown once</b><span>Store this token in your integration's secret store.</span></div>`,'<button class="btn btn-primary" data-action="security-refresh">Done</button>');}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'security-refresh') { closeModal();await renderCurrentRoute({scroll:false,allowSnapshot:false});return; }
  if (action === 'api-key-delete') { if(!confirm(`Revoke API key ${target.dataset.name||''}?`))return;try{await api('/api/security/api-keys/'+encodeURIComponent(target.dataset.key),{method:'DELETE'});flash('API key revoked.');await systemAccessPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'session-delete') { try{await api('/api/security/sessions/'+encodeURIComponent(target.dataset.session),{method:'DELETE'});flash('Session terminated.');await systemAccessPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'ssh-key-add-open') { openModal('Add SSH public key','Paste one OpenSSH public-key line. Private keys never belong on the NAS.',`<div class="form-stack"><label>Public key</label><textarea id="sshPublicKey" rows="5" placeholder="ssh-ed25519 AAAA... admin@workstation"></textarea></div>`,`<button class="btn btn-quiet" data-action="close-modal">Cancel</button><button class="btn btn-primary" data-action="ssh-key-add-save">Add key</button>`);return; }
  if (action === 'ssh-key-add-save') { target.disabled=true;try{await api('/api/security/ssh-keys',{method:'POST',body:JSON.stringify({key:document.getElementById('sshPublicKey')?.value||''})});closeModal();flash('SSH public key added.');await systemAccessPage()}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'ssh-key-delete') { if(!confirm('Remove this root SSH public key?'))return;try{await api('/api/security/ssh-keys/'+encodeURIComponent(target.dataset.key),{method:'DELETE'});flash('SSH key removed.');await systemAccessPage()}catch(e){flash(e.message,'bad')}return; }
  if (action === 'certificate-import-open') { certificateImportModal(); return; }
  if (action === 'certificate-import-save') { target.disabled=true;try{await api('/api/security/certificate/import',{method:'POST',body:JSON.stringify({CertificatePEM:document.getElementById('certPEM').value,PrivateKeyPEM:document.getElementById('certKeyPEM').value})});closeModal();flash('Certificate installed. Zero1Local is restarting its management listener.');setTimeout(()=>location.reload(),2200)}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'certificate-selfsigned') { await confirmAction('Generate a new self-signed certificate?','Browsers that trusted the previous self-signed certificate will see a new fingerprint. Existing data and configuration are unaffected.','Generate certificate',async()=>{await api('/api/security/certificate/self-signed',{method:'POST',body:'{}'});closeModal();flash('New self-signed certificate generated. Zero1Local is restarting.');setTimeout(()=>location.reload(),2200)});return; }
  if (action === 'certificate-acme-open') { certificateACMEModal(); return; }
  if (action === 'certificate-acme-save') { target.disabled=true;try{const d=await api('/api/security/certificate/acme',{method:'POST',body:JSON.stringify({Hostname:document.getElementById('acmeHostname').value,Email:document.getElementById('acmeEmail').value})});closeModal();flash(`ACME request started as task ${d.task_id}.`)}catch(e){flash(e.message,'bad');target.disabled=false}return; }
  if (action === 'firewall-save') { const enabled=document.getElementById('firewallEnabled').checked;const cidrs=String(document.getElementById('firewallCIDRs').value||'').split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean);const proxy=String(document.getElementById('firewallProxyCIDRs')?.value||'').split(/\r?\n|,/).map(x=>x.trim()).filter(Boolean);await confirmAction(enabled?'Apply strict appliance firewall?':'Disable Zero1Local firewall enforcement?',enabled?'Inbound traffic will default to deny. Only required ports will be opened to the trusted LAN/VPN or reverse-proxy CIDRs you specified; an enabled WireGuard listener is the only intentionally public exception. Zero1Local rejects a policy that would lock out your current browser.':'Disabling Zero1Local firewall enforcement removes its host-level default-deny protection. Your external firewall/router policy will become the only inbound boundary.','Save firewall settings',async()=>{await api('/api/security/firewall',{method:'PUT',body:JSON.stringify({Enabled:enabled,CIDRs:cidrs,ProxyCIDRs:proxy})});closeModal();flash('Firewall settings updated.');await securityPage()});return; }
  if (action === 'security-save') {
    const enabled = document.getElementById('sshPwEnable').checked;
    if (enabled && !document.getElementById('sshRisk').checked) { flash('Risk acknowledgement is required before enabling root password SSH.', 'bad'); return; }
    try { await api('/api/security/root-ssh-password', { method: 'POST', body: JSON.stringify({ Enabled: enabled, Password: document.getElementById('linuxRootPw').value, UseWebPassword: document.getElementById('sameWebPw').checked, WebPassword: document.getElementById('currentWebPw').value, CIDRs: csv(document.getElementById('sshCidrs').value), Acknowledge: document.getElementById('sshRisk').checked }) }); flash('Root SSH policy updated.'); await systemAccessPage(); } catch (e) { flash(e.message, 'bad'); }
    return;
  }
  if (action === 'confirm-run' && modalState?.confirm) { const fn = modalState.confirm; target.disabled = true; try { await fn(); } catch (e) { flash(e.message, 'bad'); target.disabled = false; } }
}

document.addEventListener('change',e=>{
  const target=e.target;
  if(target?.matches?.('[data-mobile-manual-file]')){
    const map=window.__zero1ManualSelection instanceof Map?window.__zero1ManualSelection:new Map(),key=String(target.dataset.id||'');
    if(target.checked) map.set(key,{id:Number(target.dataset.id),name:target.dataset.name||'',path:target.dataset.path||'',size:Number(target.dataset.size||0)}); else map.delete(key);
    window.__zero1ManualSelection=map;
    updateMobileManualSelectionSummary();
  }
  if(target?.id==='updateInstallMode'){
    const hour=document.getElementById('updateInstallHour');
    if(hour) hour.disabled=target.value!=='automatic';
    if(target.value==='automatic'){ const check=document.getElementById('updateAutoCheck'); if(check) check.checked=true; }
  }
});

document.addEventListener('click', e => {
  // Native details menus otherwise stay open when clicking the rest of the UI.
  const inside=e.target.closest('details.row-action-menu,details.mini-menu');
  document.querySelectorAll('details.row-action-menu[open],details.mini-menu[open]').forEach(menu=>{
    if(menu!==inside) menu.open=false;
  });
  if (!e.target.closest('#fileContextMenu')) closeFileContextMenu();
  if (!e.target.closest('.account-control')) document.getElementById('accountMenu')?.classList.remove('open');
  const a = e.target.closest('a[href]');
  if (!a || a.hasAttribute('download') || a.target === '_blank' || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
  const u = new URL(a.href, location.href);
  if (u.origin !== location.origin || !routes[normalizedPath(u.pathname)]) return;
  e.preventDefault();
  navigateTo(u.pathname + u.search + u.hash).catch(err => pageError(err));
});
window.addEventListener('popstate', () => { renderCurrentRoute({scroll:false}).catch(err => pageError(err)); });
document.addEventListener('visibilitychange',()=>{if(document.hidden){stopTaskCenterPolling();stopUSBDrivePolling();stopTaskDrawerPolling();stopUpdatePagePolling();return;}if(normalizedPath()==='/tasks')pollTaskCenter().catch(()=>{});if(normalizedPath()==='/updates')startUpdatePagePolling();if(isUSBDrivesView())pollUSBDrives().catch(()=>{});const drawer=document.getElementById('chromeDrawer');if(drawer?.classList.contains('open')&&drawer.dataset.kind==='tasks')pollTaskDrawer().catch(()=>{});});

document.addEventListener('click', e => {
  const help=e.target.closest?.('[data-ui-help]');
  if(help){e.preventDefault();e.stopPropagation();const wrap=help.closest('.info-tip-wrap');document.querySelectorAll('.info-tip-wrap.is-open').forEach(x=>{if(x!==wrap)x.classList.remove('is-open')});wrap?.classList.toggle('is-open');return;}
  if(!e.target.closest?.('.info-tip-wrap'))document.querySelectorAll('.info-tip-wrap.is-open').forEach(x=>x.classList.remove('is-open'));
  const target = e.target.closest('[data-action]');
  if (!target) return;
  if (target.classList.contains('modal-backdrop') && e.target.closest('[data-modal-panel]')) return;
  e.preventDefault();
  handleAction(target).catch(err => flash(err.message, 'bad'));
});
document.addEventListener('input', async e => {
  if (e.target.id === 'shareSearch') { const q = e.target.value.toLowerCase(); document.querySelectorAll('[data-share-search]').forEach(row => row.classList.toggle('hidden', !row.dataset.shareSearch.includes(q))); }
  if (e.target.id === 'userSearch') { const q = e.target.value.toLowerCase(); document.querySelectorAll('[data-user-search]').forEach(row => row.classList.toggle('hidden', !row.dataset.userSearch.includes(q))); }
  if (e.target.id === 'serviceSearch') { const q = e.target.value.toLowerCase(); document.querySelectorAll('[data-service-search]').forEach(row => row.classList.toggle('hidden', !row.dataset.serviceSearch.includes(q))); }
  if (e.target.id === 'globalSearch') { await hydrateGlobalSearchCatalog(); renderGlobalSearch(e.target.value); }
  if (e.target.matches('[data-filter-permissions]')) { const prefix = e.target.dataset.filterPermissions; const q = e.target.value.toLowerCase(); document.querySelectorAll(`[data-permission-user="${CSS.escape(prefix)}"]`).forEach(row => row.classList.toggle('hidden', !row.dataset.search.includes(q))); }
});
document.addEventListener('keydown',e=>{
  if(e.key==='Escape')document.querySelectorAll('details.row-action-menu[open],details.mini-menu[open]').forEach(x=>x.open=false);
});
document.addEventListener('focusin', e => { if (e.target.id === 'globalSearch') hydrateGlobalSearchCatalog().catch(()=>{}); });
document.addEventListener('change', e => { if(e.target.id==='fileSort'){localStorage.setItem('zero1-file-sort',e.target.value||'name:asc');const u=new URL(location.href);u.searchParams.delete('page');navigateTo(u.pathname+(u.search?'?'+u.searchParams.toString():'')).catch(pageError);return;} if (e.target.id === 'sameWebPw') toggleSecurityPasswordFields(); if (e.target.id === 'vlanMethod') toggleVLANStatic(); if (e.target.id === 'smbFolderMode') toggleSMBFolderMode(); if (e.target.id === 'nfsClientMode') toggleNFSClientMode(); if (e.target.id === 'dnsMode') toggleDNSMode(); if (e.target.id === 'dockerCreateImageSelect') toggleDockerCustomImage(); if (e.target.id === 'deliveryEmailTransport') toggleDeliveryEmailTransport(); });
document.addEventListener('keydown', e => {
  const typing=['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName);
  if(modalState?.kind==='image'&&!typing){if(e.key==='ArrowLeft'){e.preventDefault();imageViewerNavigate(-1);return}if(e.key==='ArrowRight'){e.preventDefault();imageViewerNavigate(1);return}if(e.key==='+'||e.key==='='){e.preventDefault();imagePreviewState.fit=false;applyImagePreviewZoom(imagePreviewState.zoom+.1);return}if(e.key==='-'){e.preventDefault();imagePreviewState.fit=false;applyImagePreviewZoom(imagePreviewState.zoom-.1);return}if(e.key==='0'){e.preventDefault();applyImagePreviewZoom(1);return}if(e.key.toLowerCase()==='f'){e.preventDefault();applyImagePreviewZoom(1,{fit:true});return}if(e.key.toLowerCase()==='r'){e.preventDefault();imagePreviewState.rotation+=90;imageViewerApply();return}}
  if(e.key==='Escape'){document.querySelectorAll('.info-tip-wrap.is-open').forEach(x=>x.classList.remove('is-open'));closeFileContextMenu();if(modalState)closeModal();else if(selectedFileRows.size)clearFileSelection();else document.getElementById('globalSearchResults')?.classList.add('hidden');}
  if(e.key==='Enter'&&(e.target.id==='loginPw'||e.target.id==='loginTotp'))loginSubmit();
  if(e.key==='/'&&!typing){e.preventDefault();document.getElementById('globalSearch')?.focus();return;}
  if(normalizedPath()!=='/files'||typing||modalState)return;
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='a'){e.preventDefault();selectedFileRows=new Set(document.querySelectorAll('[data-file-entry]'));updateFileSelectionUI();return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='c'){e.preventDefault();handleFileKeyboardAction('file-clipboard-copy');return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='x'){e.preventDefault();handleFileKeyboardAction('file-clipboard-cut');return;}
  if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='v'){e.preventDefault();pasteFileClipboard();return;}
  if(e.key==='F2'){e.preventDefault();handleFileKeyboardAction('file-rename');return;}
  if(e.key==='Delete'){e.preventDefault();handleFileKeyboardAction('file-trash');return;}
  if(e.key==='Enter'&&selectedFileRow){e.preventDefault();const entry=selectedFileEntryFromRow(selectedFileRow);const a=selectedFileRow.querySelector('a[href^="/files?"]');if(entry?.directory&&a)navigateTo(a.getAttribute('href')).catch(pageError);else if(entry&&!entry.directory&&officeSupportedName(entry.name))openOfficeFile(entry.path,entry.name);else handleFileKeyboardAction('file-preview');}
});

const routePrefetchGroups = {
  home: ['/api/system','/api/storage','/api/shares','/api/tasks','/api/notifications','/api/readiness'],
  files: ['/api/files','/api/files/workspace','/api/shares','/api/users','/api/groups','/api/account-capabilities','/api/nfs/exports','/api/office/settings'],
  storage: ['/api/storage','/api/storage/health','/api/storage/health-history','/api/storage/replacement','/api/storage/analytics'],
  protection: ['/api/protection/status','/api/protection/plans','/api/backups','/api/backup-targets','/api/snapshots','/api/replication'],
  apps: ['/api/docker','/api/docker/stats','/api/docker/stacks','/api/apps/catalog'],
  connectivity: ['/api/network','/api/network/v025','/api/network/safety','/api/desktop-integration'],
  system: ['/api/system','/api/services','/api/hardware','/api/power/ups','/api/security','/api/security/center','/api/security/admins','/api/update/status','/api/maintenance','/api/notifications/delivery'],
  help: []
};
// Idle warming must never compete with owner disk I/O. Tree scans, logs,
// diagnostics, share-insight scans and recovery searches remain on-demand.
const adjacentPrefetchApps = {
  home: ['files','storage'],
  files: ['storage','protection'],
  storage: ['files','protection'],
  protection: ['storage','apps'],
  apps: ['protection','system'],
  connectivity: ['system','files'],
  system: ['connectivity','home'],
  help: ['home','system']
};

async function prefetchEndpoints(endpoints, concurrency = 3) {
  const queue = [...new Set(endpoints)];
  const workers = Array.from({length: Math.min(concurrency, queue.length)}, async () => {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      await api(url, { busy:false }).catch(() => {});
    }
  });
  await Promise.all(workers);
}
function cancelScheduledPrefetch() {
  if (!idlePrefetchHandle) return;
  if (window.cancelIdleCallback) cancelIdleCallback(idlePrefetchHandle); else clearTimeout(idlePrefetchHandle);
  idlePrefetchHandle = null;
}
function scheduleApplicationPrefetch() {
  cancelScheduledPrefetch();
  if (!CLIENT_RESPONSE_CACHE_ENABLED) return;
  if (navigator.connection?.saveData) return;
  const active = currentApplication(normalizedPath()).id;
  const neighbors = adjacentPrefetchApps[active] || [];
  const runAdjacent = () => {
    idlePrefetchHandle = null;
    if (document.hidden) return;
    const urls = neighbors.flatMap(id => routePrefetchGroups[id] || []);
    prefetchEndpoints(urls, 2).catch(() => {});
  };
  idlePrefetchHandle = window.requestIdleCallback ? requestIdleCallback(runAdjacent, { timeout: 1200 }) : setTimeout(runAdjacent, 350);
}
function routeLoadingShell(path) {
  const appDef = currentApplication(path);
  const activeTab = (applicationTabs[appDef.id] || []).find(([href]) => appTabActive(path, href));
  const title = activeTab?.[1] || appDef.label;
  return `<section class="screen route-skeleton" aria-busy="true" aria-label="Loading ${attr(title)}">
    ${heading(appDef.label, title, 'Loading current appliance data…')}
    <div class="route-skeleton-grid"><div class="route-skeleton-card route-skeleton-card-wide"><i></i><i></i><i></i></div><div class="route-skeleton-card"><i></i><i></i><i></i></div><div class="route-skeleton-card"><i></i><i></i><i></i></div></div>
  </section>`;
}
function nextPaint() { return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); }

function normalizedPath(pathname = location.pathname) { return String(pathname || '/').replace(/\/$/, '') || '/'; }
function routeView() { return new URLSearchParams(location.search).get('view') || ''; }
function isUSBDrivesView(){ return normalizedPath()==='/storage' && routeView()==='usb'; }
function updateNavActive() {
  const path = normalizedPath();
  const activeApp = currentApplication(path);
  document.querySelectorAll('.app-nav-item').forEach(a => a.classList.toggle('active', a.dataset.app === activeApp.id));
  const bar=document.getElementById('applicationBar'); if(bar)bar.innerHTML=applicationBar(path);
  const ctx=document.getElementById('topContext'); if(ctx)ctx.textContent=activeApp.label;
  document.getElementById('accountMenu')?.classList.remove('open');
  closeChromeDrawer();
}
async function renderCurrentRoute({scroll = true, allowSnapshot = true} = {}) {
  const path = normalizedPath();
  if(path!=='/tasks')stopTaskCenterPolling();
  if(path!=='/updates')stopUpdatePagePolling();
  if(!(path==='/storage' && routeView()==='usb'))stopUSBDrivePolling();
  document.body.classList.toggle('office-workspace-mode', path === '/office/open');
  const route = routes[path];
  if (IX2_HARDWARE_PORT && (/^\/(docker|apps)(\/|$)/.test(path) || /^\/office(\/|$)/.test(path))) {
    pageError(new Error('This application requires a container runtime or office service unavailable on ARMv5 ix2-ng. No software was installed.')); return;
  }
  if (!route) { pageError(new Error('Unknown Zero1Local route')); return; }
  updateNavActive();
  const content = document.getElementById('content');
  const started = performance.now();
  let snapshotPainted = false;
  if (allowSnapshot && content) {
    const snap = routeSnapshot(path);
    if (snap) {
      content.innerHTML = snap.html;
      officialLayoutPolish(content);
      makeTablesSortable(content);
      content.classList.remove('route-loading');
      content.classList.add('route-refreshing');
      snapshotPainted = true;
      if (scroll) document.querySelector('.workspace')?.scrollTo?.({top:0, behavior:'instant'});
    }
  }

  if (activeRouteController) activeRouteController.abort();
  const controller = new AbortController();
  activeRouteController = controller;
  if (content && !snapshotPainted) {
    content.innerHTML = routeLoadingShell(path);
    content.classList.add('route-loading');
    if (scroll) document.querySelector('.workspace')?.scrollTo?.({top:0, behavior:'instant'});
    await nextPaint();
    if (controller.signal.aborted || normalizedPath() !== path) return;
  }
  try {
    routeRequestSignal = controller.signal;
    const routePromise = route();
    routeRequestSignal = null;
    await routePromise;
    if (controller.signal.aborted || normalizedPath() !== path) return;
    updateNavActive();
    officialLayoutPolish(document.getElementById('content'));
    makeTablesSortable(document.getElementById('content') || document);
    document.querySelector('.sidebar')?.classList.remove('open');
    storeRouteSnapshot(path);
    refreshChromeStatus();
    if (scroll && !snapshotPainted) document.querySelector('.workspace')?.scrollTo?.({top:0, behavior:'instant'});
    const apiTimes = recentAPITimings.filter(x => x.route === path && x.at >= started);
    const slowestAPI = apiTimes.slice().sort((a,b) => b.elapsed_ms - a.elapsed_ms)[0];
    rememberRoutePerformance(path, {
      total_ms: Math.round((performance.now() - started) * 10) / 10,
      slowest_api_ms: slowestAPI?.elapsed_ms || 0,
      slowest_endpoint: slowestAPI?.endpoint || '',
      api_calls: apiTimes.length,
      snapshot: snapshotPainted
    });
    scheduleApplicationPrefetch();
  } catch (err) {
    if (err?.name !== 'AbortError' && err?.name !== 'Zero1AuthRequired' && !controller.signal.aborted) pageError(err);
  } finally {
    routeRequestSignal = null;
    if (activeRouteController === controller) activeRouteController = null;
    const node = document.getElementById('content');
    node?.classList.remove('route-loading');
    node?.classList.remove('route-refreshing');
  }
}
async function navigateTo(href, {replace = false, scroll = true} = {}) {
  const u = new URL(href, location.href);
  if (u.origin !== location.origin || !routes[normalizedPath(u.pathname)]) { location.href = u.href; return; }
  const nextPath = normalizedPath(u.pathname);
  const currentPath = normalizedPath();
  if (nextPath === currentPath && u.search === location.search && u.hash === location.hash) return;
  if (replace) history.replaceState({}, '', u.pathname + u.search + u.hash); else history.pushState({}, '', u.pathname + u.search + u.hash);
  updateNavActive();
  await renderCurrentRoute({scroll, allowSnapshot:true});
}



document.addEventListener('keydown',e=>{
  if((e.ctrlKey||e.metaKey)&&String(e.key).toLowerCase()==='k'){
    e.preventDefault(); const input=document.getElementById('globalSearch'); input?.focus(); input?.select(); hydrateGlobalSearchCatalog();
  }
  if(e.key==='/'&&!e.ctrlKey&&!e.metaKey&&!e.altKey&&!['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName||'')){
    e.preventDefault(); const input=document.getElementById('globalSearch'); input?.focus(); hydrateGlobalSearchCatalog();
  }
});


async function boot() {
  applyTheme(preferredTheme());
  const status = await api('/api/status');
  bootStatus = status || {};
  currentVersion = status.version || '';
  if (!IX2_HARDWARE_PORT && currentVersion && UI_BUILD_VERSION && currentVersion !== UI_BUILD_VERSION) {
    const mismatch = `${UI_BUILD_VERSION}->${currentVersion}`;
    const reloadKey = 'zero1local.ui-build-reload';
    if (sessionStorage.getItem(reloadKey) !== mismatch) {
      sessionStorage.setItem(reloadKey, mismatch);
      const u = new URL(location.href);
      u.searchParams.set('_z1ui', currentVersion);
      u.searchParams.set('_z1t', String(Date.now()));
      location.replace(u.pathname + u.search + u.hash);
      return;
    }
  } else {
    try { sessionStorage.removeItem('zero1local.ui-build-reload'); } catch (_) {}
  }
  const powerCompletion = completedPowerMessage(status);
  if (status.setup_required) { await authSetup(); return; }
  try { await api('/api/system'); } catch (e) { if (String(e.message).includes('authentication')) { authLogin(powerCompletion); return; } throw e; }
  currentSession = await api('/api/session',{busy:false}).catch(()=>({username:'admin',role:'administrator',root:true}));
  // Existing ix2 web admin is an appliance administrator, not a Linux root username.
  currentSession.root = currentSession.role === 'administrator';
  layout();
  await renderCurrentRoute({scroll:false});
  if(window.__zero1ChromeTimer)clearInterval(window.__zero1ChromeTimer);window.__zero1ChromeTimer=setInterval(()=>{if(!document.hidden)refreshChromeStatus();},30000);
  if (powerCompletion) setTimeout(()=>flash(powerCompletion,'good'),150);
}

boot().catch(err => { if (document.getElementById('content')) pageError(err); else app.innerHTML = `<div class="auth-shell"><section class="auth-card simple"><div class="auth-form"><h1>Unable to start Zero1Local</h1><div class="form-error">${esc(err.message)}</div></div></section></div>`; });

queueMicrotask(()=>refreshFriendlyUI(document.body));
