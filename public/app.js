/* ── S3 Backup Studio — Frontend ─────────────────────────────────────── */

const socket = io();

// ── State ──────────────────────────────────────────────────────────────
let uiRunning    = false;
let logFilter    = 'all';
let logEntries   = [];
let autoScroll   = true;
let elapsedTimer = null;
let countdownTimer = null;
let startedAt    = null;
let bwChart      = null;
let bwSamples    = Array(60).fill(0);
let lastBytes    = 0;
let bwTimer      = null;
let currentJobId = null;
let jobs         = [];

// ── Backup state ───────────────────────────────────────────────────────
let _backupStorageTargets = [];
let _currentBackupJobId   = null;
let _restoreBackupId      = null;

// ── Helpers ────────────────────────────────────────────────────────────

function $(id) { return document.getElementById(id); }
function v(id)  { const e = $(id); return e ? e.value.trim() : ''; }

function formatBytes(b) {
  if (!b || b === 0) return '0 B';
  const u = ['B','KB','MB','GB','TB'];
  const i = Math.floor(Math.log(b) / Math.log(1024));
  return (b / Math.pow(1024,i)).toFixed(i===0?0:1) + ' ' + u[i];
}
function formatElapsed(ms) {
  const s = Math.floor(ms/1000), m = Math.floor(s/60), h = Math.floor(m/60);
  if (h) return `${h}h ${m%60}m ${s%60}s`;
  if (m) return `${m}m ${s%60}s`;
  return `${s}s`;
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit',second:'2-digit'});
}
function formatDate(ts) {
  return new Date(ts).toLocaleString([],{month:'short',day:'numeric',hour:'2-digit',minute:'2-digit'});
}
function escapeHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Config collection ──────────────────────────────────────────────────

function getConfig() {
  return {
    name: v('job-name') || undefined,
    source: {
      type: v('src-type'),
      region: v('src-region') || 'us-east-1',
      bucket: v('src-bucket'),
      accessKeyId: v('src-access-key'),
      secretAccessKey: v('src-secret-key'),
      endpoint: v('src-type') === 'compatible' ? v('src-endpoint') : null,
      prefix: v('src-prefix'),
    },
    dest: {
      type: v('dst-type'),
      region: v('dst-region') || 'us-west-2',
      bucket: v('dst-bucket'),
      accessKeyId: v('dst-access-key'),
      secretAccessKey: v('dst-secret-key'),
      endpoint: v('dst-type') === 'compatible' ? v('dst-endpoint') : null,
    },
    settings: {
      intervalSeconds:    parseInt(v('setting-interval'))    || 0,
      concurrency:        parseInt(v('setting-concurrency')) || 5,
      multipartThresholdMb: parseInt(v('setting-threshold'))|| 100,
      maxBandwidthMbps:   parseFloat(v('setting-bandwidth'))|| 0,
      fileTimeoutMinutes: parseInt(v('setting-timeout'))    || 30,
      deleteOrphaned:     $('setting-delete-orphaned').checked,
      includePatterns:    v('filter-include').split('\n').map(s=>s.trim()).filter(Boolean),
      excludePatterns:    v('filter-exclude').split('\n').map(s=>s.trim()).filter(Boolean),
    },
    notifications: {
      webhook: {
        url:        v('notif-webhook-url'),
        onComplete: $('notif-webhook-complete').checked,
        onFailure:  $('notif-webhook-failure').checked,
      },
      email: {
        host:       v('notif-email-host'),
        port:       v('notif-email-port') || '587',
        user:       v('notif-email-user'),
        pass:       v('notif-email-pass'),
        from:       v('notif-email-from'),
        to:         v('notif-email-to'),
        onComplete: $('notif-email-complete').checked,
        onFailure:  $('notif-email-failure').checked,
      },
    },
  };
}

function applyConfig(cfg) {
  if (!cfg) return;
  const set = (id, val) => { const e=$(id); if(e&&val!=null) e.value=val; };
  const chk = (id, val) => { const e=$(id); if(e) e.checked=!!val; };

  set('job-name', cfg.name);

  if (cfg.source) {
    set('src-type', cfg.source.type);
    set('src-region', cfg.source.region);
    set('src-bucket', cfg.source.bucket);
    set('src-access-key', cfg.source.accessKeyId);
    set('src-secret-key', cfg.source.secretAccessKey);
    set('src-endpoint', cfg.source.endpoint);
    set('src-prefix', cfg.source.prefix);
    toggleEndpoint('src');
  }
  if (cfg.dest) {
    set('dst-type', cfg.dest.type);
    set('dst-region', cfg.dest.region);
    set('dst-bucket', cfg.dest.bucket);
    set('dst-access-key', cfg.dest.accessKeyId);
    set('dst-secret-key', cfg.dest.secretAccessKey);
    set('dst-endpoint', cfg.dest.endpoint);
    toggleEndpoint('dst');
  }
  if (cfg.settings) {
    set('setting-interval',    cfg.settings.intervalSeconds);
    set('setting-concurrency', cfg.settings.concurrency);
    set('setting-threshold',   cfg.settings.multipartThresholdMb);
    set('setting-bandwidth',   cfg.settings.maxBandwidthMbps);
    set('setting-timeout',     cfg.settings.fileTimeoutMinutes);
    chk('setting-delete-orphaned', cfg.settings.deleteOrphaned);
    set('filter-include', (cfg.settings.includePatterns||[]).join('\n'));
    set('filter-exclude', (cfg.settings.excludePatterns||[]).join('\n'));
  }
  if (cfg.notifications) {
    const wh = cfg.notifications.webhook || {};
    set('notif-webhook-url', wh.url);
    chk('notif-webhook-complete', wh.onComplete !== false);
    chk('notif-webhook-failure',  wh.onFailure  !== false);
    const em = cfg.notifications.email || {};
    set('notif-email-host', em.host); set('notif-email-port', em.port);
    set('notif-email-user', em.user); set('notif-email-pass', em.pass);
    set('notif-email-from', em.from); set('notif-email-to',   em.to);
    chk('notif-email-complete', em.onComplete !== false);
    chk('notif-email-failure',  em.onFailure  !== false);
  }

  updatePipelineLabels();
}

// ── LocalStorage persistence ───────────────────────────────────────────

const LS_KEY = 's3bs_v2';
let saveDeb;
document.addEventListener('input', () => {
  clearTimeout(saveDeb);
  saveDeb = setTimeout(() => {
    localStorage.setItem(LS_KEY, JSON.stringify(getConfig()));
    updatePipelineLabels();
    resetConnDot('src'); resetConnDot('dst');
  }, 400);
});

function loadLocalConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) applyConfig(JSON.parse(raw));
  } catch {}
}

// ── UI: tabs ───────────────────────────────────────────────────────────

function switchTab(tab) {
  ['config','filters','notifications'].forEach(t => {
    $(`tab-${t}`).style.display = t === tab ? '' : 'none';
    $(`tab-btn-${t}`).classList.toggle('active', t === tab);
  });
}

// ── UI: endpoint visibility ────────────────────────────────────────────

function toggleEndpoint(side) {
  const show = $(`${side}-type`).value === 'compatible';
  $(`${side}-endpoint-row`).style.display = show ? 'block' : 'none';
}

function toggleSecret(id) {
  const e = $(id); e.type = e.type === 'password' ? 'text' : 'password';
}

function updatePipelineLabels() {
  $('pipeline-src').textContent = v('src-bucket') || '—';
  $('pipeline-dst').textContent = v('dst-bucket') || '—';
}

function resetConnDot(side) {
  const d = $(`${side}-status-dot`);
  if (d) { d.style.background='#334155'; d.title=''; }
}

// ── Status bar ─────────────────────────────────────────────────────────

function setStatus(st, label) {
  const styles = {
    idle:      {dot:'#475569', color:'#64748b', border:'#334155', bg:'#1e293b'},
    running:   {dot:'#60a5fa', color:'#93c5fd', border:'#2563eb55', bg:'#1e3a5f33', pulse:true},
    dryrun:    {dot:'#c084fc', color:'#d8b4fe', border:'#7c3aed55', bg:'#3b0d7a22', pulse:true},
    completed: {dot:'#34d399', color:'#6ee7b7', border:'#05966955', bg:'#05966920'},
    error:     {dot:'#f87171', color:'#fca5a5', border:'#dc262655', bg:'#dc262620'},
    stopping:  {dot:'#fbbf24', color:'#fcd34d', border:'#d9770655', bg:'#d9770620'},
  };
  const s = styles[st] || styles.idle;
  $('status-dot').style.background = s.dot;
  $('status-dot').className = s.pulse ? 'pulse' : '';
  $('status-label').textContent = label;
  $('status-label').style.color = s.color;
  $('status-badge').style.borderColor = s.border;
  $('status-badge').style.background  = s.bg;
}

function startElapsedTimer() {
  $('elapsed-badge').style.display = 'flex';
  clearInterval(elapsedTimer);
  elapsedTimer = setInterval(() => {
    if (startedAt) $('elapsed-text').textContent = formatElapsed(Date.now() - startedAt);
  }, 1000);
}
function stopElapsedTimer() {
  clearInterval(elapsedTimer); elapsedTimer = null;
}
function startCountdown(sec) {
  const endsAt = Date.now() + sec*1000;
  clearInterval(countdownTimer);
  countdownTimer = setInterval(() => {
    const r = Math.max(0, Math.ceil((endsAt-Date.now())/1000));
    $('next-sync-label').textContent = `Next sync in ${r}s`;
    $('next-sync-label').style.display = '';
    if (!r) clearInterval(countdownTimer);
  }, 1000);
}
function stopCountdown() {
  clearInterval(countdownTimer); countdownTimer=null;
  $('next-sync-label').style.display='none';
}

// ── Bandwidth chart ────────────────────────────────────────────────────

function initBwChart() {
  const ctx = $('bw-chart').getContext('2d');
  bwChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: Array(60).fill(''),
      datasets: [{
        data: bwSamples,
        borderColor: '#3b82f6',
        backgroundColor: 'rgba(59,130,246,.08)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false, animation: false,
      plugins: { legend: { display: false }, tooltip: {
        callbacks: { label: ctx => formatBytes(ctx.raw) + '/s' }
      }},
      scales: {
        x: { display: false },
        y: {
          display: true, min: 0,
          ticks: { color:'#64748b', font:{size:10}, callback: v => v===0?'0':formatBytes(v)+'/s', maxTicksLimit:3 },
          grid: { color:'#1e293b' },
        }
      }
    }
  });
}

function startBwTimer() {
  clearInterval(bwTimer);
  lastBytes = 0;
  bwTimer = setInterval(() => {
    // currentBytes is updated from sync:stats events
    const delta = Math.max(0, window._currentBytes - lastBytes);
    lastBytes = window._currentBytes || 0;
    bwSamples.push(delta);
    bwSamples.shift();

    if (bwChart) {
      bwChart.data.datasets[0].data = [...bwSamples];
      bwChart.update('none');
    }

    const peak = Math.max(...bwSamples);
    $('bw-peak').textContent = peak > 0 ? `Peak: ${formatBytes(peak)}/s` : '';
    if (window._currentBytes) {
      const elapsed = (Date.now() - startedAt) / 1000;
      const rate = window._currentBytes / elapsed;
      $('stat-rate').textContent = `${formatBytes(rate)}/s`;
      $('stat-rate').style.display = '';
    }
  }, 1000);
}

function stopBwTimer() { clearInterval(bwTimer); bwTimer=null; }

// ── Actions: sync ──────────────────────────────────────────────────────

async function startSync(isDryRun = false) {
  const cfg = getConfig();
  if (!cfg.source.bucket || !cfg.source.accessKeyId || !cfg.source.secretAccessKey)
    return appendLog('error','Source configuration is incomplete');
  if (!cfg.dest.bucket   || !cfg.dest.accessKeyId   || !cfg.dest.secretAccessKey)
    return appendLog('error','Destination configuration is incomplete');

  // Disable immediately to prevent double-submit before server responds
  $('btn-start').disabled = true;
  $('btn-dry-run').disabled = true;

  if (isDryRun) cfg.settings.dryRun = true;

  localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  setRunning(true, isDryRun);
  startedAt = Date.now();
  window._currentBytes = 0;
  startElapsedTimer();
  startBwTimer();

  const res = await fetch('/api/start', {
    method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(cfg),
  }).then(r=>r.json()).catch(err=>({ ok:false, error:err.message }));

  if (!res.ok) {
    appendLog('error', res.error || 'Failed to start');
    setRunning(false);
    stopElapsedTimer();
    stopBwTimer();
  }
}

function startDryRun() { startSync(true); }

function stopSync() {
  setStatus('stopping','Stopping…');
  $('btn-stop').disabled = true;
  fetch('/api/stop',{method:'POST'}).catch(()=>{});
}

async function retryFailed() {
  const res = await fetch('/api/retry-failed',{method:'POST'}).then(r=>r.json()).catch(()=>({ok:false}));
  if (!res.ok) return appendLog('error', res.error || 'Nothing to retry');
  appendLog('info', `Retrying ${res.count} failed files…`);
  setRunning(true, false);
  startedAt = Date.now();
  window._currentBytes = 0;
  startElapsedTimer();
  startBwTimer();
}

function setRunning(running, isDryRun=false) {
  uiRunning = running;
  $('btn-start').style.display   = running ? 'none' : '';
  $('btn-dry-run').style.display = running ? 'none' : '';
  $('btn-stop').style.display    = running ? '' : 'none';
  $('btn-stop').disabled         = false;
  $('dry-run-badge').style.display = (running && isDryRun) ? '' : 'none';

  if (running) {
    setStatus(isDryRun ? 'dryrun' : 'running', isDryRun ? 'Dry Run' : 'Syncing');
    updatePipelineLabels();
    $('pipeline-arrow').style.borderColor='#2563eb55';
    $('pipeline-arrow').style.background='#1e3a5f33';
    $('pipeline-arrow').innerHTML=`<svg class="spin" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>`;
  } else {
    $('pipeline-arrow').style.borderColor='#334155';
    $('pipeline-arrow').style.background='#1e293b';
    $('pipeline-arrow').innerHTML=`<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#64748b" stroke-width="2" stroke-linecap="round"><polyline points="9 18 15 12 9 6"/></svg>`;
  }
}

// ── Actions: test connection ───────────────────────────────────────────

async function testConn(side) {
  const cfg = side==='source' ? getConfig().source : getConfig().dest;
  const pfx = side==='source' ? 'src' : 'dst';
  const lbl = $(`${pfx}-test-label`);
  const dot = $(`${pfx}-status-dot`);
  lbl.textContent='…'; dot.style.background='#fbbf24';
  const res = await fetch('/api/test-connection',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:cfg}),
  }).then(r=>r.json()).catch(err=>({ok:false,error:err.message}));
  lbl.textContent='Test';
  if (res.ok) {
    dot.style.background='#34d399'; dot.title='Connected';
    appendLog('success',`${side} connection OK — ${cfg.bucket}`);
  } else {
    dot.style.background='#f87171'; dot.title=res.error||'Failed';
    appendLog('error',`${side} failed — ${res.error||'Unknown error'}`);
  }
}

// ── Actions: notifications ─────────────────────────────────────────────

async function testWebhook() {
  const url = v('notif-webhook-url');
  if (!url) return appendLog('error','Enter a webhook URL first');
  const res = await fetch('/api/test-webhook',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url}),
  }).then(r=>r.json()).catch(err=>({ok:false,error:err.message}));
  appendLog(res.ok?'success':'error', res.ok ? 'Test webhook delivered' : `Webhook failed: ${res.error}`);
}

async function testEmail() {
  const cfg = {
    host:v('notif-email-host'), port:v('notif-email-port'),
    user:v('notif-email-user'), pass:v('notif-email-pass'),
    from:v('notif-email-from'), to:v('notif-email-to'),
  };
  if (!cfg.host||!cfg.to) return appendLog('error','Enter SMTP host and recipient first');
  appendLog('info','Sending test email…');
  const res = await fetch('/api/test-email',{
    method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({config:cfg}),
  }).then(r=>r.json()).catch(err=>({ok:false,error:err.message}));
  appendLog(res.ok?'success':'error', res.ok ? 'Test email sent' : `Email failed: ${res.error}`);
}

// ── Actions: export log ────────────────────────────────────────────────

function exportLog() {
  const lines = logEntries.map(e=>`${formatTime(e.ts)} [${e.level.toUpperCase().padEnd(7)}] ${e.message}`);
  const blob  = new Blob([lines.join('\n')], {type:'text/plain'});
  const url   = URL.createObjectURL(blob);
  const a     = document.createElement('a');
  a.href      = url;
  a.download  = `s3backup-log-${new Date().toISOString().slice(0,19)}.txt`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Jobs ───────────────────────────────────────────────────────────────

async function refreshJobs() {
  jobs = await fetch('/api/jobs').then(r=>r.json()).catch(()=>[]);
  const sel = $('job-selector');
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Unsaved config —</option>';
  jobs.forEach(j => {
    const opt = document.createElement('option');
    opt.value = j.id; opt.textContent = j.name || j.id;
    sel.appendChild(opt);
  });
  if (prev) sel.value = prev;
  $('btn-delete-job').disabled = !sel.value;
}

async function loadSelectedJob() {
  const id = $('job-selector').value;
  if (!id) return;
  const job = await fetch(`/api/jobs/${id}`).then(r=>r.json());
  if (!job || job.error) return;
  currentJobId = id;
  applyConfig(job);
  $('btn-delete-job').disabled = false;
  appendLog('info', `Loaded job: ${job.name}`);
}

async function saveJob() {
  const cfg = getConfig();
  const name = cfg.name || `Job ${new Date().toLocaleTimeString()}`;

  if (currentJobId) {
    await fetch(`/api/jobs/${currentJobId}`,{
      method:'PUT', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({...cfg, name}),
    });
    appendLog('success', `Job updated: ${name}`);
  } else {
    const job = await fetch('/api/jobs',{
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({...cfg, name}),
    }).then(r=>r.json());
    currentJobId = job.id;
    appendLog('success', `Job saved: ${name}`);
  }
  await refreshJobs();
  $('job-selector').value = currentJobId;
  $('btn-delete-job').disabled = false;
}

async function deleteJob() {
  const id = $('job-selector').value || currentJobId;
  if (!id) return;
  if (!confirm('Delete this job?')) return;
  await fetch(`/api/jobs/${id}`,{method:'DELETE'});
  currentJobId = null;
  $('job-selector').value = '';
  $('btn-delete-job').disabled = true;
  appendLog('info','Job deleted');
  await refreshJobs();
}

// ── History ────────────────────────────────────────────────────────────
async function loadHistory() {
  const history = await fetch('/api/history').then(r=>r.json()).catch(()=>[]);
  const container = $('history-container');
  if (!container) return;
  $('history-empty')?.remove();

  if (history.length === 0) {
    container.innerHTML = '<div id="history-empty" style="text-align:center;color:#334155;font-size:13px;padding:24px 0;">No sync history yet</div>';
    return;
  }

  container.innerHTML = history.map(h => {
    const ok = h.reason === 'completed';
    const statusColor = ok ? '#34d399' : h.reason==='user_stopped' ? '#fbbf24' : '#f87171';
    const statusLabel = ok ? 'Completed' : h.reason==='user_stopped' ? 'Stopped' : 'Failed';
    return `
    <div class="history-row">
      <div>
        <div style="font-size:12px;font-weight:500;color:#e2e8f0;margin-bottom:2px;">
          ${escapeHtml(h.source||'')} → ${escapeHtml(h.dest||'')}
          ${h.dryRun?'<span style="font-size:10px;background:rgba(168,85,247,.2);color:#c084fc;border-radius:3px;padding:1px 5px;margin-left:4px;">DRY RUN</span>':''}
        </div>
        <div style="font-size:11px;color:#64748b;">${formatDate(h.completedAt||h.startedAt)} · ${h.elapsed}s · ${formatBytes(h.stats?.bytesTransferred||0)}</div>
      </div>
      <div style="text-align:right;font-size:11px;color:#64748b;">
        <div style="color:#34d399;">${h.stats?.synced||0} synced</div>
        ${h.stats?.failed>0?`<div style="color:#f87171;">${h.stats.failed} failed</div>`:''}
      </div>
      <div style="font-size:11px;font-weight:600;color:${statusColor};">${statusLabel}</div>
    </div>`;
  }).join('');
}

async function clearHistory() {
  if (!confirm('Clear all sync history?')) return;
  await fetch('/api/history',{method:'DELETE'});
  loadHistory();
}

// ── Stats update ───────────────────────────────────────────────────────

function updateStats(stats) {
  $('stat-total').textContent   = stats.total   ?? 0;
  $('stat-synced').textContent  = stats.synced  ?? 0;
  $('stat-failed').textContent  = stats.failed  ?? 0;
  $('stat-skipped').textContent = stats.skipped ?? 0;
  $('stat-size').textContent    = formatBytes(stats.bytesTransferred||0);

  window._currentBytes = stats.bytesTransferred || 0;

  const done = (stats.synced||0)+(stats.failed||0)+(stats.skipped||0);
  const pct  = stats.total>0 ? Math.round(done/stats.total*100) : 0;
  $('progress-bar').style.width = pct+'%';
  $('progress-pct').textContent = pct+'%';
  $('progress-detail').textContent = stats.total>0
    ? `${done} / ${stats.total} files processed`
    : 'Waiting to start…';

  if (stats.failed > 0) {
    $('btn-retry').style.display = '';
    $('retry-label').textContent = `Retry Failed (${stats.failed})`;
  }
}

// ── Activity log ───────────────────────────────────────────────────────

const LOG_STYLES = {
  debug:   {border:'#334155', color:'#64748b', icon:'·'},
  info:    {border:'#2563eb', color:'#93c5fd', icon:'●'},
  success: {border:'#059669', color:'#34d399', icon:'✓'},
  error:   {border:'#dc2626', color:'#f87171', icon:'✗'},
  skip:    {border:'#334155', color:'#64748b', icon:'○'},
  warning: {border:'#d97706', color:'#fbbf24', icon:'!'},
};

function appendLog(level, message, ts=Date.now()) {
  const entry = {level, message, ts};
  logEntries.push(entry);
  if (logEntries.length > 2000) logEntries = logEntries.slice(-2000);
  $('log-empty')?.remove();
  if (logFilter==='all' || logFilter===level) renderLogLine(entry);
}

function renderLogLine(entry) {
  const c = $('log-container');
  const s = LOG_STYLES[entry.level] || LOG_STYLES.info;
  const d = document.createElement('div');
  d.className = 'log-line fade-in';
  d.dataset.level = entry.level;
  d.style.cssText = `border-left:2px solid ${s.border};padding-left:8px;margin-left:2px;`;
  d.innerHTML = `
    <span style="color:#475569;">${formatTime(entry.ts)}</span>
    <span style="color:${s.border};">${s.icon}</span>
    <span style="color:${s.color};word-break:break-all;">${escapeHtml(entry.message)}</span>`;
  c.appendChild(d);
  if (autoScroll) c.scrollTop = c.scrollHeight;
}

function setLogFilter(f) {
  logFilter = f;
  $('log-filter-all').classList.toggle('active', f==='all');
  $('log-filter-error').classList.toggle('active', f==='error');
  const c = $('log-container');
  c.innerHTML='';
  const filtered = f==='all' ? logEntries : logEntries.filter(e=>e.level===f);
  if (!filtered.length) {
    c.innerHTML=`<div id="log-empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:#334155;font-size:13px;">No ${f==='all'?'':''+f+' '}entries</div>`;
  } else {
    filtered.forEach(renderLogLine);
    c.scrollTop=c.scrollHeight;
  }
}

function clearLog() {
  logEntries=[];
  $('log-container').innerHTML=`<div id="log-empty" style="display:flex;align-items:center;justify-content:center;height:100%;color:#334155;font-size:13px;">Log cleared</div>`;
}

// ── Socket events ──────────────────────────────────────────────────────

socket.on('connect', () => {
  fetch('/api/status').then(r=>r.json()).then(d => {
    if (d.running) { setRunning(true); startedAt=d.startedAt; startElapsedTimer(); startBwTimer(); }
    if (d.stats) updateStats(d.stats);
    if (d.failedCount > 0) {
      $('btn-retry').style.display='';
      $('retry-label').textContent=`Retry Failed (${d.failedCount})`;
    }
  }).catch(()=>{});
});

socket.on('sync:init', ({running, failedCount}) => {
  if (failedCount>0) {
    $('btn-retry').style.display='';
    $('retry-label').textContent=`Retry Failed (${failedCount})`;
  }
});

socket.on('sync:started', ({totalFiles, totalBytes, toCopy, toSkip, toDelete, dryRun, resumed, isRetry}) => {
  const label = dryRun ? '[DRY RUN] Preview' : isRetry ? 'Retry' : 'Sync';
  appendLog('info',
    `${label} started — ${totalFiles} files (${formatBytes(totalBytes)}) | ` +
    `${toCopy} to copy, ${toSkip} skipped${toDelete>0?`, ${toDelete} to delete`:''}` +
    (resumed?` | Resuming from checkpoint`:''));
  renderActiveJobs();
});

socket.on('sync:resumed', ({count, savedAt}) => {
  appendLog('info', `Checkpoint detected — resuming from ${count} previously completed files (saved ${formatDate(new Date(savedAt))})`);
});

socket.on('sync:stats', (stats) => {
  updateStats(stats);
  renderActiveJobs();
});

socket.on('sync:file_done', ({key, action, bytes, dryRun}) => {
  const level  = action==='deleted' ? 'warning' : dryRun ? 'info' : 'success';
  const prefix = dryRun ? '[DRY RUN] Would ' : '';
  const label  = action==='synced' ? 'Synced' : action==='deleted' ? 'Deleted' : 'Skipped';
  appendLog(level, `${prefix}${label}: ${key}${bytes>0?' ('+formatBytes(bytes)+')':''}`);
});

socket.on('sync:file_error', ({key, error}) => {
  appendLog('error', `Failed: ${key} — ${error}`);
});

socket.on('sync:stopped', ({reason, stats, elapsed}) => {
  setRunning(false);
  stopElapsedTimer();
  stopBwTimer();
  stopCountdown();
  if (stats) updateStats(stats);

  const msgs = {
    completed: '✓ Sync completed successfully',
    user_stopped: 'Sync stopped by user',
    fatal_error: '✗ Sync failed — check the log for details',
  };
  const lvl = reason==='completed'?'success':reason==='fatal_error'?'error':'info';
  appendLog(lvl, msgs[reason]||'Sync stopped');
  setStatus(
    reason==='completed'?'completed':reason==='fatal_error'?'error':'idle',
    reason==='completed'?'Completed':reason==='fatal_error'?'Error':'Idle'
  );

  if (reason==='completed') {
    loadHistory();
    const interval = parseInt(v('setting-interval'))||0;
    if (interval>0) startCountdown(interval);
  }
  renderActiveJobs();
  if ((stats?.failed||0) === 0) $('btn-retry').style.display='none';
});

socket.on('log', ({ts, level, message}) => appendLog(level, message, ts));
socket.on('disconnect', () => appendLog('warning','Connection lost — reconnecting…'));
socket.on('reconnect',  () => appendLog('info','Reconnected to server'));

// ── Jobs rendering ─────────────────────────────────────────────────────

function formatJobTime(ts) {
  if (!ts) return '—';
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function renderActiveJobs() {
  const container = $('jobs-container');
  if (!container) return;

  fetch('/api/jobs').then(r => r.json()).then(jobs => {
    const jobList = Array.isArray(jobs) ? jobs : (jobs.jobs || []);

    if (jobList.length === 0) {
      container.innerHTML = '<div id="jobs-empty" style="text-align:center;color:#334155;font-size:13px;padding:24px 0;">No active jobs - start a sync to create one</div>';
      return;
    }

    container.innerHTML = jobList.map(job => {
      const statusColor = { running: '#60a5fa', paused: '#fbbf24', completed: '#34d399', failed: '#f87171', pending: '#94a3b8' }[job.status] || '#94a3b8';
      const statusLabel = { running: 'Running', paused: 'Paused', completed: 'Completed', failed: 'Failed', pending: 'Pending' }[job.status] || job.status;
      const elapsed = job.startedAt ? formatElapsed(Date.now() - job.startedAt) : '—';
      const progress = job.progress || 0;

      return `
        <div class="fade-in" style="padding:10px 0;border-bottom:1px solid #1e293b;">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">
            <span style="width:8px;height:8px;border-radius:50%;background:${statusColor};${job.status === 'running' ? 'animation:pulse 2s infinite' : ''}"></span>
            <span style="font-size:12px;font-weight:600;color:#e2e8f0;">${escapeHtml(job.name || 'Unnamed')}</span>
            <span style="font-size:10px;color:#64748b;">${job.type?.toUpperCase() || 'S3'}</span>
            <span style="font-size:10px;font-weight:500;color:${statusColor};margin-left:auto;">${statusLabel}</span>
          </div>
          <div style="font-size:11px;color:#475569;margin-bottom:6px;">
            ${job.source?.bucket ? job.source.bucket : job.source?.host ? `${job.source.host}/${job.source.database}` : '—'}
            →
            ${job.dest?.bucket ? job.dest.bucket : job.dest?.host ? `${job.dest.host}/${job.dest.database}` : '—'}
          </div>
          ${job.status === 'running' || job.status === 'paused' ? `
          <div style="height:4px;background:#1e293b;border-radius:4px;margin-bottom:6px;overflow:hidden;">
            <div style="height:100%;width:${progress}%;background:${statusColor};border-radius:4px;"></div>
          </div>
          ` : ''}
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;font-size:11px;color:#475569;">
            <span>Elapsed: ${elapsed}</span>
            <span>•</span>
            <span>${formatBytes(job.bytesTransferred || 0)} transferred</span>
            ${job.filesProcessed !== undefined ? `<span>•</span><span>${job.filesProcessed} files</span>` : ''}
          </div>
          <div style="display:flex;gap:4px;">
            ${job.status === 'running' ? `
              <button onclick="pauseJob('${job.id}')" class="btn btn-amber" style="padding:3px 8px;font-size:10px;">Pause</button>
            ` : ''}
            ${job.status === 'paused' ? `
              <button onclick="resumeJob('${job.id}')" class="btn btn-primary" style="padding:3px 8px;font-size:10px;">Resume</button>
            ` : ''}
            ${job.status === 'running' || job.status === 'paused' ? `
              <button onclick="stopJob('${job.id}')" class="btn btn-danger" style="padding:3px 8px;font-size:10px;">Stop</button>
            ` : ''}
            <button onclick="deleteJob('${job.id}')" class="btn btn-ghost" style="padding:3px 8px;font-size:10px;">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }).catch(() => {
    container.innerHTML = '<div style="text-align:center;color:#f87171;font-size:13px;padding:24px 0;">Failed to load jobs</div>';
  });
}

// ── Init ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  // ── Safe event listener helper ─────────────────────────────────────────
  function safeAddEventListener(elementId, eventType, handler) {
    const element = $(elementId);
    if (element) {
      element.addEventListener(eventType, handler);
      return true;
    }
    console.warn(`Element '${elementId}' not found, skipping event listener`);
    return false;
  }

  initBwChart();
  loadLocalConfig();
  toggleEndpoint('src');
  toggleEndpoint('dst');
  updatePipelineLabels();
  $('log-filter-all').classList.add('active');
  setStatus('idle','Idle');
  refreshJobs();
  renderActiveJobs();
  loadHistory();

  // ── Event wiring (replaces inline onclick/onchange blocked by CSP) ─────
  $('src-type').addEventListener('change', () => toggleEndpoint('src'));
  $('dst-type').addEventListener('change', () => toggleEndpoint('dst'));

  $('tab-btn-config').addEventListener('click', () => switchTab('config'));
  $('tab-btn-filters').addEventListener('click', () => switchTab('filters'));
  $('tab-btn-notifications').addEventListener('click', () => switchTab('notifications'));

  $('btn-job-load').addEventListener('click', loadSelectedJob);
  $('btn-job-save').addEventListener('click', saveJob);
  $('btn-delete-job').addEventListener('click', deleteJob);
  $('job-selector').addEventListener('change', () => {
    currentJobId = $('job-selector').value || null;
    $('btn-delete-job').disabled = !currentJobId;
  });

  $('btn-src-test').addEventListener('click', () => testConn('source'));
  $('btn-src-secret').addEventListener('click', () => toggleSecret('src-secret-key'));
  $('btn-dst-test').addEventListener('click', () => testConn('dest'));
  $('btn-dst-secret').addEventListener('click', () => toggleSecret('dst-secret-key'));

  $('btn-dry-run').addEventListener('click', startDryRun);
  $('btn-start').addEventListener('click', () => startSync());
  $('btn-stop').addEventListener('click', stopSync);
  $('btn-retry').addEventListener('click', retryFailed);
  $('btn-export-log').addEventListener('click', exportLog);

  $('log-filter-all').addEventListener('click', () => setLogFilter('all'));
  $('log-filter-error').addEventListener('click', () => setLogFilter('error'));
  $('btn-clear-log').addEventListener('click', clearLog);
  $('log-container').addEventListener('scroll', () => {
    const el = $('log-container');
    autoScroll = el.scrollTop + el.clientHeight >= el.scrollHeight - 20;
  });

  safeAddEventListener('btn-history-refresh', 'click', loadHistory);
  safeAddEventListener('btn-history-clear', 'click', clearHistory);

  $('btn-test-webhook').addEventListener('click', testWebhook);
  $('btn-test-email').addEventListener('click', testEmail);
  $('btn-email-secret').addEventListener('click', () => toggleSecret('notif-email-pass'));

  // ── Mode Toggle ─────────────────────────────────────────────────────────
  let currentMode = 's3';

  function switchMode(mode) {
    currentMode = mode;
    $('mode-s3').classList.toggle('active', mode === 's3');
    $('mode-db').classList.toggle('active', mode === 'db');
    $('mode-cluster').classList.toggle('active', mode === 'cluster');
    $('mode-backup').classList.toggle('active', mode === 'backup');

    const mainEl = document.querySelector('main');
    if (mainEl) mainEl.style.display = mode === 'backup' ? 'none' : '';

    $('backup-panel').style.display = mode === 'backup' ? '' : 'none';

    $('tab-config').style.display = mode === 's3' ? '' : 'none';
    $('tab-filters').style.display = mode === 's3' ? '' : 'none';
    $('tab-notifications').style.display = mode === 's3' ? '' : 'none';
    $('db-config-panel').style.display = mode === 'db' ? '' : 'none';
    $('db-controls').style.display = mode === 'db' ? 'flex' : 'none';
    $('cluster-config-panel').style.display = mode === 'cluster' ? '' : 'none';
    $('s3-stats-row').style.display = mode === 's3' ? 'grid' : 'none';
    $('db-stats-row').style.display = mode === 'db' ? 'grid' : 'none';

    if (mode === 'backup') refreshBackupJobs();
  }

  function switchBackupTab(tab) {
    ['jobs', 'catalog', 'run'].forEach(t => {
      $(`backup-tab-${t}`).classList.toggle('active', t === tab);
      $(`backup-${t}-section`).style.display = t === tab ? '' : 'none';
    });
    if (tab === 'catalog') loadBackupCatalog();
  }

  $('mode-s3').addEventListener('click', () => switchMode('s3'));
  $('mode-db').addEventListener('click', () => switchMode('db'));
  $('mode-cluster').addEventListener('click', () => switchMode('cluster'));
  $('mode-backup').addEventListener('click', () => switchMode('backup'));

  safeAddEventListener('backup-tab-jobs',    'click', () => switchBackupTab('jobs'));
  safeAddEventListener('backup-tab-catalog', 'click', () => switchBackupTab('catalog'));
  safeAddEventListener('backup-tab-run',     'click', () => switchBackupTab('run'));

  // ── DB Config helpers ──────────────────────────────────────────────────

  function getDbConfig() {
    return {
      source: {
        host: v('db-src-host'),
        port: parseInt(v('db-src-port')) || 5432,
        database: v('db-src-database'),
        user: v('db-src-user'),
        password: v('db-src-password'),
      },
      dest: {
        host: v('db-dst-host'),
        port: parseInt(v('db-dst-port')) || 5432,
        database: v('db-dst-database'),
        user: v('db-dst-user'),
        password: v('db-dst-password'),
      },
      settings: {
        sourceSchema: v('db-src-schema') || 'public',
        destSchema: v('db-dst-schema') || 'public',
        concurrency: parseInt(v('db-setting-concurrency')) || 5,
        intervalSeconds: parseInt(v('db-setting-interval')) || 0,
        includeTables: v('db-setting-include-tables').split('\n').map(s => s.trim()).filter(Boolean),
        excludeTables: v('db-setting-exclude-tables').split('\n').map(s => s.trim()).filter(Boolean),
      },
    };
  }

  function applyDbConfig(cfg) {
    if (!cfg) return;
    const set = (id, val) => { const e = $(id); if (e && val != null) e.value = val; };
    if (cfg.source) {
      set('db-src-host', cfg.source.host);
      set('db-src-port', cfg.source.port);
      set('db-src-database', cfg.source.database);
      set('db-src-user', cfg.source.user);
      set('db-src-password', cfg.source.password);
      set('db-src-schema', cfg.source.schema);
    }
    if (cfg.dest) {
      set('db-dst-host', cfg.dest.host);
      set('db-dst-port', cfg.dest.port);
      set('db-dst-database', cfg.dest.database);
      set('db-dst-user', cfg.dest.user);
      set('db-dst-password', cfg.dest.password);
      set('db-dst-schema', cfg.dest.schema);
    }
    if (cfg.settings) {
      set('db-setting-concurrency', cfg.settings.concurrency);
      set('db-setting-interval', cfg.settings.intervalSeconds);
      set('db-setting-include-tables', (cfg.settings.includeTables || []).join('\n'));
      set('db-setting-exclude-tables', (cfg.settings.excludeTables || []).join('\n'));
    }
  }

  // ── DB Sync actions ──────────────────���────────────────────────────────────────

  let dbRunning = false;
  let dbStartedAt = null;
  let dbElapsedTimer = null;

  async function startDbSync(isDryRun = false) {
    const cfg = getDbConfig();
    if (!cfg.source.host || !cfg.source.database || !cfg.source.user || !cfg.source.password)
      return appendLog('error', 'Source database configuration is incomplete');
    if (!cfg.dest.host || !cfg.dest.database || !cfg.dest.user || !cfg.dest.password)
      return appendLog('error', 'Destination database configuration is incomplete');

    $('btn-db-start').disabled = true;
    $('btn-db-dry-run').disabled = true;

    if (isDryRun) cfg.settings.dryRun = true;

    setDbRunning(true, isDryRun);
    dbStartedAt = Date.now();
    startDbElapsedTimer();

    const res = await fetch('/api/db/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cfg),
    }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

    if (!res.ok) {
      appendLog('error', res.error || 'Failed to start DB sync');
      setDbRunning(false);
      stopDbElapsedTimer();
    }
  }

  function startDbDryRun() { startDbSync(true); }

  function stopDbSync() {
    setStatus('stopping', 'Stopping DB…');
    $('btn-db-stop').disabled = true;
    fetch('/api/db/stop', { method: 'POST' }).catch(() => {});
  }

  function setDbRunning(running, isDryRun = false) {
    dbRunning = running;
    $('btn-db-start').style.display = running ? 'none' : '';
    $('btn-db-dry-run').style.display = running ? 'none' : '';
    $('btn-db-stop').style.display = running ? '' : 'none';
    $('btn-db-stop').disabled = false;
    $('dry-run-badge').style.display = (running && isDryRun) ? '' : 'none';

    if (running) {
      setStatus(isDryRun ? 'dryrun' : 'running', isDryRun ? 'DB Dry Run' : 'DB Syncing');
    } else {
      setStatus('idle', 'Idle');
    }
  }

  function updateDbStats(stats) {
    $('db-stat-tables').textContent = stats.totalTables || 0;
    $('db-stat-synced-tables').textContent = stats.syncedTables || 0;
    $('db-stat-rows').textContent = formatBytes(stats.syncedRows || 0).replace(' B', '').replace(' KB', 'k').replace(' MB', 'M').replace(' GB', 'G');
    $('db-stat-failed').textContent = stats.failedTables || 0;
  }

  function startDbElapsedTimer() {
    $('elapsed-badge').style.display = 'flex';
    clearInterval(dbElapsedTimer);
    dbElapsedTimer = setInterval(() => {
      if (dbStartedAt) $('elapsed-text').textContent = formatElapsed(Date.now() - dbStartedAt);
    }, 1000);
  }

  function stopDbElapsedTimer() {
    clearInterval(dbElapsedTimer);
    dbElapsedTimer = null;
  }

  // ── DB Connection test ─────────────────────────────────────────────────

  async function testDbConn(side) {
    const cfg = side === 'source' ? getDbConfig().source : getDbConfig().dest;
    const pfx = side === 'source' ? 'db-src' : 'db-dst';
    const lbl = $(`${pfx}-test-label`);
    const dot = $(`${pfx}-status-dot`);
    lbl.textContent = '…';
    dot.style.background = '#fbbf24';
    const res = await fetch('/api/db/test-connection', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg }),
    }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));
    lbl.textContent = 'Test';
    if (res.ok) {
      dot.style.background = '#34d399';
      appendLog('success', `${side} DB connected — ${cfg.host}/${cfg.database}`);
    } else {
      dot.style.background = '#f87171';
      appendLog('error', `${side} DB failed — ${res.error || 'Unknown error'}`);
    }
  }

  // ── DB Socket events ──────────���─��───────────────────────────────────────────

  socket.on('db:sync:init', ({ running, failedCount }) => {
    if (failedCount > 0) {
      $('btn-db-retry').style.display = '';
      $('db-retry-label').textContent = `Retry Failed (${failedCount})`;
    }
  });

socket.on('db:sync:started', ({ totalTables, dryRun, isRetry }) => {
  appendLog('info', `DB Sync started — ${totalTables} tables to sync`);
  renderActiveJobs();
});

  socket.on('db:sync:stats', (stats) => updateDbStats(stats));

  socket.on('db:sync:table_done', ({ table, action, rows, bytes, dryRun }) => {
    const level = dryRun ? 'info' : 'success';
    const prefix = dryRun ? '[DRY RUN] ' : '';
    const label = action === 'synced' ? 'Synced' : action === 'skipped' ? 'Skipped' : 'Deleted';
    appendLog(level, `${prefix}Table ${label}: ${table}${rows > 0 ? ` (${rows} rows)` : ''}`);
  });

  socket.on('db:sync:table_error', ({ table, error }) => {
    appendLog('error', `Failed table: ${table} — ${error}`);
  });

  socket.on('db:sync:stopped', ({ reason, stats, elapsed }) => {
    setDbRunning(false);
    stopDbElapsedTimer();
    if (stats) updateDbStats(stats);
    if ((stats?.failedTables || 0) === 0) $('btn-db-retry').style.display = 'none';
    renderActiveJobs();
  });

  // ── DB Event wiring ────────────────────────────────────────────────────────

  $('btn-db-src-test').addEventListener('click', () => testDbConn('source'));
  $('btn-db-dst-test').addEventListener('click', () => testDbConn('dest'));
  $('btn-db-src-secret').addEventListener('click', () => toggleSecret('db-src-password'));
  $('btn-db-dst-secret').addEventListener('click', () => toggleSecret('db-dst-password'));
  $('btn-db-dry-run').addEventListener('click', startDbDryRun);
  $('btn-db-start').addEventListener('click', () => startDbSync());
  $('btn-db-stop').addEventListener('click', stopDbSync);

  // ── Cluster Management ──────────────────────────────────────────────────

  function getClusterConfig() {
    return {
      source: {
        host: v('cluster-src-host'),
        port: parseInt(v('cluster-src-port')) || 5432,
        database: v('cluster-src-database'),
        user: v('cluster-src-user'),
        password: v('cluster-src-password'),
      },
      dest: {
        host: v('cluster-dst-host'),
        port: parseInt(v('cluster-dst-port')) || 5432,
        database: v('cluster-dst-database'),
        user: v('cluster-dst-user'),
        password: v('cluster-dst-password'),
      },
    };
  }

  function setClusterStatus(connected, data = null) {
    const dot = $('cluster-status-dot');
    dot.style.background = connected ? '#34d399' : '#334155';
    $('cluster-primary-status').textContent = connected ? 'Connected' : 'Disconnected';
    
    if (data && data.replicas) {
      $('cluster-replicas').textContent = data.replicas.replica_count || 0;
      $('cluster-sync').textContent = data.replicas.sync_replicas || 0;
      $('cluster-async').textContent = data.replicas.async_replicas || 0;
    }
  }

  async function connectCluster() {
    const cfg = getClusterConfig();
    if (!cfg.source.host || !cfg.source.database || !cfg.source.user || !cfg.source.password)
      return appendLog('error', 'Primary database configuration is incomplete');

    appendLog('info', `Connecting to cluster: ${cfg.source.host}/${cfg.source.database}…`);
    
    const res = await fetch('/api/cluster/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config: cfg.source }),
    }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

    if (res.ok) {
      setClusterStatus(true, res);
      appendLog('success', `Connected to cluster: ${cfg.source.host}/${cfg.source.database}`);
      
      $('replica-node-1').style.opacity = '1';
      $('replica-node-2').style.opacity = '1';
    } else {
      setClusterStatus(false);
      appendLog('error', `Cluster error: ${res.error}`);
      $('replica-node-1').style.opacity = '0.3';
      $('replica-node-2').style.opacity = '0.3';
    }
  }

  async function createReplica() {
    const cfg = getClusterConfig();
    if (!cfg.source.host || !cfg.source.database)
      return appendLog('error', 'Source (Primary) database not connected');
    if (!cfg.dest.host || !cfg.dest.database || !cfg.dest.user || !cfg.dest.password)
      return appendLog('error', 'Replica configuration is incomplete');

    appendLog('info', `Creating read replica on ${cfg.dest.host}…`);
    
    const res = await fetch('/api/cluster/create-replica', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: cfg.source, dest: cfg.dest }),
    }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

    if (res.ok) {
      appendLog('success', `Read replica created: ${cfg.dest.host}/${cfg.dest.database}`);
      refreshClusterStatus();
    } else {
      appendLog('error', `Create replica error: ${res.error}`);
    }
  }

  async function promoteReplica() {
    appendLog('info', 'Promoting replica to primary…');
    appendLog('warning', 'Promote action requires manual setup. Please configure replication on destination.');
  }

  async function refreshClusterStatus() {
    const res = await fetch('/api/cluster/status').then(r => r.json()).catch(() => ({ ok: false }));
    
    if (res.ok) {
      $('cluster-replicas').textContent = res.replicas?.replica_count || 0;
      $('cluster-sync').textContent = res.replicas?.sync_replicas || 0;
      $('cluster-async').textContent = res.replicas?.async_replicas || 0;
      
      const lagRes = await fetch('/api/cluster/lag').then(r => r.json()).catch(() => ({ ok: false }));
      if (lagRes.ok) {
        const lagMB = (lagRes.maxLag / 1024 / 1024).toFixed(2);
        $('cluster-lag').textContent = lagMB + ' MB';
        $('cluster-lag').style.color = lagRes.lagAlert > 100 ? '#f87171' : '#34d399';
      }
      
      appendLog('info', 'Cluster status refreshed');
    }
  }

  async function disconnectCluster() {
    await fetch('/api/cluster/disconnect', { method: 'POST' });
    setClusterStatus(false);
    $('cluster-replicas').textContent = '0';
    $('cluster-sync').textContent = '0';
    $('cluster-async').textContent = '0';
    $('cluster-lag').textContent = '0 MB';
    $('replica-node-1').style.opacity = '0.3';
    $('replica-node-2').style.opacity = '0.3';
    appendLog('info', 'Disconnected from cluster');
  }


async function pauseJob(jobId) {
  await fetch(`/api/jobs/${jobId}/pause`, { method: 'POST' });
  renderActiveJobs();
}

async function resumeJob(jobId) {
  await fetch(`/api/jobs/${jobId}/resume`, { method: 'POST' });
  renderActiveJobs();
}

async function stopJob(jobId) {
  await fetch(`/api/jobs/${jobId}/stop`, { method: 'POST' });
  renderActiveJobs();
}

async function deleteJob(jobId) {
  if (!confirm('Delete this job?')) return;
  await fetch(`/api/jobs/${jobId}`, { method: 'DELETE' });
  renderActiveJobs();
}

  $('btn-jobs-refresh').addEventListener('click', renderActiveJobs);

  $('btn-cluster-connect').addEventListener('click', connectCluster);
  $('btn-cluster-create-replica').addEventListener('click', createReplica);
  $('btn-cluster-promote').addEventListener('click', promoteReplica);
  $('btn-cluster-refresh').addEventListener('click', refreshClusterStatus);
  $('btn-cluster-disconnect').addEventListener('click', disconnectCluster);

  // ── Backup event wiring (Tasks 13.2, 13.3) ──────────────────────────
  safeAddEventListener('btn-bkp-add-s3',    'click', addS3Target);
  safeAddEventListener('btn-bkp-add-local', 'click', addLocalTarget);
  safeAddEventListener('btn-bkp-save-job',  'click', saveBackupJob);
  safeAddEventListener('btn-bkp-run-now',   'click', () => { const cfg = getBackupJobConfig(); runBackupNowWithConfig(cfg); });
  safeAddEventListener('btn-bkp-refresh-jobs',    'click', refreshBackupJobs);
  safeAddEventListener('btn-bkp-refresh-catalog', 'click', loadBackupCatalog);
  safeAddEventListener('btn-bkp-test-notification', 'click', testBackupNotification);
  safeAddEventListener('btn-bkp-test-webhook', 'click', testBackupWebhook);
  safeAddEventListener('btn-bkp-src-test', 'click', testBackupSourceConn);
  ['bkp-src-host','bkp-src-port','bkp-src-database','bkp-src-user','bkp-src-password','bkp-src-ssl'].forEach(id => { safeAddEventListener(id, 'input', resetBackupSrcDot); safeAddEventListener(id, 'change', resetBackupSrcDot); });
  safeAddEventListener('bkp-db-type', 'change', () => {
    const dbType = document.getElementById('bkp-db-type')?.value;
    if (dbType) updateBackupFormForDbType(dbType);
  });
  safeAddEventListener('btn-restore-submit', 'click', submitRestore);
  safeAddEventListener('btn-restore-cancel', 'click', () => { const m = document.getElementById('restore-modal'); if (m) m.style.display = 'none'; });

  safeAddEventListener('bkp-encrypt-enabled', 'change', () => {
    const row = document.getElementById('bkp-passphrase-row');
    if (row) row.style.display = document.getElementById('bkp-encrypt-enabled').checked ? '' : 'none';
  });
  safeAddEventListener('bkp-compression', 'change', () => {
    const row = document.getElementById('bkp-compression-level-row');
    if (row) row.style.display = document.getElementById('bkp-compression').value === 'gzip' ? 'flex' : 'none';
  });
  safeAddEventListener('bkp-compression-level', 'input', () => {
    const val = document.getElementById('bkp-compression-level-val');
    if (val) val.textContent = document.getElementById('bkp-compression-level').value;
  });
});

// ── Backup: Storage targets ────────────────────────────────────────────

function renderStorageTargets() {
  const container = document.getElementById('backup-storage-targets');
  if (!container) return;
  if (_backupStorageTargets.length === 0) {
    container.innerHTML = '<div style="font-size:12px;color:#475569;text-align:center;padding:12px 0;">No storage targets — add S3 or local</div>';
    return;
  }
  container.innerHTML = _backupStorageTargets.map((t, i) => {
    if (t.type === 's3') {
      return `<div style="background:#1e293b;border-radius:8px;padding:12px;position:relative;">
        <div style="font-size:11px;font-weight:600;color:#60a5fa;margin-bottom:8px;">S3 Target #${i+1}</div>
        <div style="display:flex;flex-direction:column;gap:6px;">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;">
            <div><label class="label">Region</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.region||'')}" oninput="_backupStorageTargets[${i}].region=this.value" placeholder="us-east-1"/></div>
            <div><label class="label">Bucket</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.bucket||'')}" oninput="_backupStorageTargets[${i}].bucket=this.value" placeholder="my-bucket"/></div>
          </div>
          <div><label class="label">Prefix</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.prefix||'')}" oninput="_backupStorageTargets[${i}].prefix=this.value" placeholder="backups/"/></div>
          <div><label class="label">Access Key ID</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.accessKeyId||'')}" oninput="_backupStorageTargets[${i}].accessKeyId=this.value" placeholder="AKIA…"/></div>
          <div><label class="label">Secret Access Key</label><input class="inp" type="password" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.secretAccessKey||'')}" oninput="_backupStorageTargets[${i}].secretAccessKey=this.value" placeholder="••••••••"/></div>
          <div><label class="label">Endpoint (optional)</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.endpoint||'')}" oninput="_backupStorageTargets[${i}].endpoint=this.value" placeholder="https://s3.example.com"/></div>
        </div>
        <button onclick="_backupStorageTargets.splice(${i},1);renderStorageTargets();" style="position:absolute;top:8px;right:8px;background:none;border:none;cursor:pointer;color:#f87171;font-size:16px;" title="Remove">×</button>
      </div>`;
    } else {
      return `<div style="background:#1e293b;border-radius:8px;padding:12px;position:relative;">
        <div style="font-size:11px;font-weight:600;color:#34d399;margin-bottom:8px;">Local Target #${i+1}</div>
        <div><label class="label">Local Path</label><input class="inp" style="font-size:12px;padding:5px 8px;" value="${escapeHtml(t.localPath||'')}" oninput="_backupStorageTargets[${i}].localPath=this.value" placeholder="/var/backups/postgres"/></div>
        <button onclick="_backupStorageTargets.splice(${i},1);renderStorageTargets();" style="position:absolute;top:8px;right:8px;background:none;border:none;cursor:pointer;color:#f87171;font-size:16px;" title="Remove">×</button>
      </div>`;
    }
  }).join('');
}

function addS3Target() {
  _backupStorageTargets.push({ type: 's3', region: 'us-east-1', bucket: '', prefix: 'backups/', accessKeyId: '', secretAccessKey: '', endpoint: '' });
  renderStorageTargets();
}

function addLocalTarget() {
  _backupStorageTargets.push({ type: 'local', localPath: '' });
  renderStorageTargets();
}

// ── Backup: Adaptive form for database type ────────────────────────────

// Task 12.1: Define FORMAT_OPTIONS object mapping dbTypes to valid formats
const FORMAT_OPTIONS = {
  postgresql: [
    { value: 'custom',    label: 'custom (pg_dump -Fc, recommended)' },
    { value: 'plain',     label: 'plain SQL (-Fp)' },
    { value: 'directory', label: 'directory (-Fd, parallel restore)' },
    { value: 'tar',       label: 'tar (-Ft)' },
  ],
  mysql: [
    { value: 'sql', label: 'SQL Dump' }
  ],
  mariadb: [
    { value: 'sql', label: 'SQL Dump' }
  ],
  mongodb: [
    { value: 'archive',   label: 'archive (single-file BSON)' },
    { value: 'directory', label: 'directory (multi-file BSON)' },
  ],
};

// Task 12.2: Implement updateFormatOptionsForDbType(dbType)
function updateFormatOptionsForDbType(dbType) {
  const formatSelect = document.getElementById('bkp-format');
  if (!formatSelect) return;
  
  const options = FORMAT_OPTIONS[dbType] || FORMAT_OPTIONS.postgresql;
  
  // Clear existing options
  formatSelect.innerHTML = '';
  
  // Add new options
  options.forEach(opt => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    formatSelect.appendChild(option);
  });
  
  // Select the first option by default
  if (options.length > 0) {
    formatSelect.value = options[0].value;
  }
}

function updateBackupFormForDbType(dbType) {
  // Get current port value to check if it matches the old default
  const portField = $('bkp-src-port');
  const currentPort = portField ? parseInt(portField.value) : null;
  
  // Determine old default based on current form state (before change)
  // We'll check against both defaults to handle any state
  const oldDefaults = [5432, 3306, 27017];
  const isDefaultPort = oldDefaults.includes(currentPort);
  
  // Field visibility based on database type
  const showStandardFields = dbType === 'postgresql' || dbType === 'mysql' || dbType === 'mariadb';
  const showMongoFields = dbType === 'mongodb';
  const showSchemaField = dbType === 'postgresql';
  
  // Get field containers (we need to show/hide the parent divs)
  const hostRow = $('bkp-src-host')?.parentElement?.parentElement;
  const databaseField = $('bkp-src-database')?.parentElement;
  const userField = $('bkp-src-user')?.parentElement;
  const passwordField = $('bkp-src-password')?.parentElement;
  const sslField = $('bkp-src-ssl')?.parentElement;
  
  // MongoDB-specific fields (Task 11.1, 11.2)
  const connectionUriRow = $('bkp-src-connection-uri-row');
  const authDatabaseRow = $('bkp-src-auth-database-row');
  
  // Show/hide standard connection fields (host, port, database, username, password)
  if (hostRow) hostRow.style.display = showStandardFields ? '' : 'none';
  if (databaseField) databaseField.style.display = showStandardFields ? '' : 'none';
  if (userField) userField.style.display = showStandardFields ? '' : 'none';
  if (passwordField) passwordField.style.display = showStandardFields ? '' : 'none';
  if (sslField) sslField.style.display = showStandardFields ? '' : 'none';
  
  // Show/hide MongoDB-specific fields
  if (connectionUriRow) connectionUriRow.style.display = showMongoFields ? '' : 'none';
  if (authDatabaseRow) authDatabaseRow.style.display = showMongoFields ? '' : 'none';
  
  // Update port default if current value is a default port
  if (portField && isDefaultPort) {
    if (dbType === 'postgresql') {
      portField.value = '5432';
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      portField.value = '3306';
    } else if (dbType === 'mongodb') {
      portField.value = '27017';
    }
  }
  
  // Update port placeholder
  if (portField) {
    if (dbType === 'postgresql') {
      portField.placeholder = '5432';
    } else if (dbType === 'mysql' || dbType === 'mariadb') {
      portField.placeholder = '3306';
    } else if (dbType === 'mongodb') {
      portField.placeholder = '27017';
    }
  }
  
  // Task 12.3: Call updateFormatOptionsForDbType() when Database Type changes
  updateFormatOptionsForDbType(dbType);
}

// ── Backup: Job config collection ──────────────────────────────────────

function getBackupJobConfig() {
  const intOrNull = id => { const n = parseInt(document.getElementById(id)?.value); return isNaN(n) ? null : n; };
  const strOrNull = id => { const s = (document.getElementById(id)?.value||'').trim(); return s || null; };
  const lines = id => (document.getElementById(id)?.value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const chk = id => !!(document.getElementById(id)?.checked);

  const encEnabled = chk('bkp-encrypt-enabled');
  const keepLast = intOrNull('bkp-keep-last');
  const keepDaily = intOrNull('bkp-keep-daily');
  const keepWeekly = intOrNull('bkp-keep-weekly');
  const keepMonthly = intOrNull('bkp-keep-monthly');
  const hasRetention = keepLast||keepDaily||keepWeekly||keepMonthly;

  // Task 14.1: Extend getBackupConfig() to include dbType and MongoDB fields
  const dbType = document.getElementById('bkp-db-type')?.value || 'postgresql';
  
  const sourceConfig = {
    host: strOrNull('bkp-src-host') || '',
    port: parseInt(document.getElementById('bkp-src-port')?.value) || 5432,
    database: strOrNull('bkp-src-database') || '',
    user: strOrNull('bkp-src-user') || '',
    password: document.getElementById('bkp-src-password')?.value || '',
    sslMode: document.getElementById('bkp-src-ssl')?.value || 'disable',
  };
  
  // Add MongoDB-specific fields if dbType is mongodb
  if (dbType === 'mongodb') {
    sourceConfig.connectionUri = strOrNull('bkp-src-connection-uri') || '';
    sourceConfig.authDatabase = strOrNull('bkp-src-auth-database') || 'admin';
  }

  return {
    id: _currentBackupJobId || undefined,
    name: strOrNull('bkp-job-name') || 'Unnamed Backup',
    dbType: dbType,  // Add dbType to top level
    source: sourceConfig,
    format: document.getElementById('bkp-format')?.value || 'custom',
    compression: {
      type: document.getElementById('bkp-compression')?.value || 'gzip',
      level: parseInt(document.getElementById('bkp-compression-level')?.value) || 6,
    },
    includeTables: lines('bkp-include-tables'),
    excludeTables: lines('bkp-exclude-tables'),
    includeSchemas: lines('bkp-include-schemas'),
    excludeSchemas: lines('bkp-exclude-schemas'),
    storageTargets: _backupStorageTargets.map(t => ({...t})),
    schedule: strOrNull('bkp-schedule'),
    retentionPolicy: hasRetention ? { keepLast, keepDailyFor: keepDaily, keepWeeklyFor: keepWeekly, keepMonthlyFor: keepMonthly } : null,
    encryption: encEnabled ? { enabled: true, passphrase: document.getElementById('bkp-passphrase')?.value || '' } : null,
    notifications: {
      webhook: {
        url: strOrNull('bkp-webhook-url') || '',
        onComplete: chk('bkp-webhook-complete'),
        onFailure: chk('bkp-webhook-failure'),
      },
      email: {
        host: strOrNull('bkp-email-host') || '',
        port: strOrNull('bkp-email-port') || '587',
        user: strOrNull('bkp-email-user') || '',
        pass: document.getElementById('bkp-email-pass')?.value || '',
        from: strOrNull('bkp-email-from') || '',
        to: strOrNull('bkp-email-to') || '',
        onComplete: chk('bkp-email-complete'),
        onFailure: chk('bkp-email-failure'),
      },
    },
  };
}

function applyBackupJobConfig(job) {
  if (!job) return;
  const set = (id, val) => { const e = document.getElementById(id); if (e && val != null) e.value = val; };
  const chk = (id, val) => { const e = document.getElementById(id); if (e) e.checked = !!val; };

  set('bkp-job-name', job.name);
  
  // Task 14.2: Update loadBackupJob() to populate dbType and MongoDB fields
  const dbType = job.dbType || 'postgresql';
  set('bkp-db-type', dbType);
  
  // Update form visibility based on dbType
  updateBackupFormForDbType(dbType);
  
  if (job.source) {
    set('bkp-src-host', job.source.host);
    set('bkp-src-port', job.source.port || 5432);
    set('bkp-src-database', job.source.database);
    set('bkp-src-user', job.source.user);
    set('bkp-src-password', job.source.password);
    set('bkp-src-ssl', job.source.sslMode || 'disable');
    
    // Populate MongoDB-specific fields if present
    if (job.source.connectionUri) {
      set('bkp-src-connection-uri', job.source.connectionUri);
    }
    if (job.source.authDatabase) {
      set('bkp-src-auth-database', job.source.authDatabase);
    }
  }
  set('bkp-format', job.format || 'custom');
  if (job.compression) {
    set('bkp-compression', job.compression.type || 'gzip');
    set('bkp-compression-level', job.compression.level || 6);
    const lvlVal = document.getElementById('bkp-compression-level-val');
    if (lvlVal) lvlVal.textContent = job.compression.level || 6;
    const lvlRow = document.getElementById('bkp-compression-level-row');
    if (lvlRow) lvlRow.style.display = (job.compression.type === 'gzip') ? 'flex' : 'none';
  }
  set('bkp-include-tables', (job.includeTables||[]).join('\n'));
  set('bkp-exclude-tables', (job.excludeTables||[]).join('\n'));
  set('bkp-include-schemas', (job.includeSchemas||[]).join('\n'));
  set('bkp-exclude-schemas', (job.excludeSchemas||[]).join('\n'));
  set('bkp-schedule', job.schedule || '');
  if (job.retentionPolicy) {
    set('bkp-keep-last', job.retentionPolicy.keepLast || '');
    set('bkp-keep-daily', job.retentionPolicy.keepDailyFor || '');
    set('bkp-keep-weekly', job.retentionPolicy.keepWeeklyFor || '');
    set('bkp-keep-monthly', job.retentionPolicy.keepMonthlyFor || '');
  }
  if (job.encryption) {
    chk('bkp-encrypt-enabled', job.encryption.enabled);
    set('bkp-passphrase', job.encryption.passphrase || '');
    const row = document.getElementById('bkp-passphrase-row');
    if (row) row.style.display = job.encryption.enabled ? '' : 'none';
  }
  if (job.notifications) {
    const wh = job.notifications.webhook || {};
    set('bkp-webhook-url', wh.url);
    chk('bkp-webhook-complete', wh.onComplete !== false);
    chk('bkp-webhook-failure', wh.onFailure !== false);
    const em = job.notifications.email || {};
    set('bkp-email-host', em.host); set('bkp-email-port', em.port);
    set('bkp-email-user', em.user); set('bkp-email-pass', em.pass);
    set('bkp-email-from', em.from); set('bkp-email-to', em.to);
    chk('bkp-email-complete', em.onComplete !== false);
    chk('bkp-email-failure', em.onFailure !== false);
  }
  _backupStorageTargets = (job.storageTargets || []).map(t => ({...t}));
  renderStorageTargets();
}


// ── Backup: Job CRUD ───────────────────────────────────────────────────

async function saveBackupJob() {
  const cfg = getBackupJobConfig();
  if (!cfg.source.host || !cfg.source.database || !cfg.source.user || !cfg.source.password) {
    appendLog('error', 'Backup: source host, database, username and password are required');
    return;
  }
  if (!cfg.storageTargets || cfg.storageTargets.length === 0) {
    appendLog('error', 'Backup: at least one storage target is required');
    return;
  }
  try {
    if (_currentBackupJobId) {
      await fetch('/api/backup/jobs/' + _currentBackupJobId, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      });
      appendLog('success', 'Backup job updated: ' + (cfg.name || _currentBackupJobId));
    } else {
      const job = await fetch('/api/backup/jobs', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(cfg),
      }).then(r => r.json());
      if (job.ok === false) { appendLog('error', 'Save failed: ' + job.error); return; }
      _currentBackupJobId = job.id;
      appendLog('success', 'Backup job saved: ' + (job.name || job.id));
    }
    await refreshBackupJobs();
  } catch (err) {
    appendLog('error', 'Save error: ' + err.message);
  }
}

async function loadBackupJob(id) {
  try {
    const job = await fetch('/api/backup/jobs/' + id).then(r => r.json());
    if (!job || job.error) { appendLog('error', 'Job not found'); return; }
    _currentBackupJobId = id;
    applyBackupJobConfig(job);
    appendLog('info', 'Loaded backup job: ' + (job.name || id));
  } catch (err) {
    appendLog('error', 'Load error: ' + err.message);
  }
}

async function deleteBackupJobById(id) {
  if (!confirm('Delete this backup job?')) return;
  await fetch('/api/backup/jobs/' + id, { method: 'DELETE' });
  if (_currentBackupJobId === id) { _currentBackupJobId = null; }
  appendLog('info', 'Backup job deleted');
  await refreshBackupJobs();
}

async function refreshBackupJobs() {
  const jobs = await fetch('/api/backup/jobs').then(r => r.json()).catch(() => []);
  const container = document.getElementById('backup-job-list');
  if (!container) return;
  if (!jobs.length) {
    container.innerHTML = '<div style="font-size:12px;color:#475569;text-align:center;padding:24px 0;">No backup jobs saved yet</div>';
    return;
  }
  container.innerHTML = jobs.map(j => {
    const schedLabel = j.schedule ? '<span style="font-size:10px;color:#60a5fa;margin-left:6px;">' + escapeHtml(String(j.schedule)) + '</span>' : '';
    const active = _currentBackupJobId === j.id ? 'border:1px solid #3b82f6;' : 'border:1px solid #1e293b;';
    return '<div style="background:#1e293b;border-radius:8px;padding:10px 12px;' + active + '">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px;">' +
        '<span style="font-size:12px;font-weight:600;color:#e2e8f0;">' + escapeHtml(j.name || j.id) + '</span>' +
        '<span style="font-size:10px;color:#64748b;">' + escapeHtml(j.format || 'custom') + schedLabel + '</span>' +
      '</div>' +
      '<div style="display:flex;gap:5px;">' +
        '<button class="btn btn-ghost" style="padding:3px 8px;font-size:11px;" onclick="loadBackupJob(\'' + j.id + '\')">Load</button>' +
        '<button class="btn btn-purple" style="padding:3px 8px;font-size:11px;" onclick="runBackupNowById(\'' + j.id + '\')">Run Now</button>' +
        '<button class="btn btn-danger" style="padding:3px 8px;font-size:11px;" onclick="deleteBackupJobById(\'' + j.id + '\')">Delete</button>' +
      '</div>' +
    '</div>';
  }).join('');
}

async function runBackupNowById(id) {
  const job = await fetch('/api/backup/jobs/' + id).then(r => r.json()).catch(() => null);
  if (!job || job.error) { appendLog('error', 'Job not found'); return; }
  runBackupNowWithConfig(job);
}

async function runBackupNowWithConfig(cfg) {
  appendLog('info', 'Starting backup: ' + (cfg.name || 'unnamed'));
  const res = await fetch('/api/backup/run', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cfg),
  }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));
  if (res.ok) {
    appendLog('success', 'Backup started — ID: ' + res.backupId);
    switchBackupTab('run');
  } else {
    appendLog('error', 'Backup failed to start: ' + (res.error || 'Unknown error'));
  }
}

async function testBackupNotification() {
  const cfg = getBackupJobConfig();
  const webhookUrl = cfg.notifications?.webhook?.url?.trim();
  const emailHost  = cfg.notifications?.email?.host?.trim();

  if (!webhookUrl && !emailHost) {
    appendLog('error', 'Configure a webhook URL or SMTP host before sending a test notification');
    return;
  }

  appendLog('info', 'Sending test notification…');
  const res = await fetch('/api/backup/test-notification', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ notifications: cfg.notifications }),
  }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

  if (res.results?.webhook) {
    if (res.results.webhook.ok) {
      appendLog('success', `Webhook delivered (HTTP ${res.results.webhook.status})`);
    } else {
      appendLog('error', `Webhook failed — ${res.results.webhook.error || 'Unknown error'}`);
    }
  }
  if (res.results?.email) {
    if (res.results.email.ok) {
      appendLog('success', 'Test email sent');
    } else {
      appendLog('error', `Email failed — ${res.results.email.error || 'Unknown error'}`);
    }
  }
  if (!res.results?.webhook && !res.results?.email) {
    appendLog('error', res.error || 'No notification channels were triggered — check your configuration');
  }
}


// ── Backup: Job CRUD functions (Task 13.2) ─────────────────────────────

// ── Backup: Catalog rendering (Task 13.3) ─────────────────────────────

const BACKUP_STATUS_STYLES = {
  running:    { color: '#60a5fa', label: 'Running',   pulse: true  },
  completed:  { color: '#34d399', label: 'Completed', pulse: false },
  verified:   { color: '#2dd4bf', label: 'Verified',  pulse: false },
  failed:     { color: '#f87171', label: 'Failed',    pulse: false },
  corrupted:  { color: '#f87171', label: 'Corrupted', pulse: false },
  deleted:    { color: '#64748b', label: 'Deleted',   pulse: false },
  delete_failed: { color: '#fbbf24', label: 'Del Failed', pulse: false },
};

async function loadBackupCatalog() {
  const tbody = document.getElementById('backup-catalog-tbody');
  if (!tbody) return;
  tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:20px;color:#475569;">Loading…</td></tr>';
  const records = await fetch('/api/backup/catalog').then(r => r.json()).catch(() => []);
  if (!records.length) {
    tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;padding:32px;color:#475569;">No backups yet</td></tr>';
    return;
  }
  tbody.innerHTML = records.map(r => {
    const st = BACKUP_STATUS_STYLES[r.status] || { color: '#94a3b8', label: r.status, pulse: false };
    const dot = `<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:${st.color};${st.pulse ? 'animation:pulse 2s infinite;' : ''}margin-right:5px;"></span>`;
    const canRestore = ['completed','verified'].includes(r.status);
    const canVerify  = ['completed','verified'].includes(r.status);
    const canDelete  = !['deleted','running'].includes(r.status);
    return `<tr style="border-bottom:1px solid #1e293b;">
      <td style="padding:8px 10px;color:#e2e8f0;font-size:12px;">${escapeHtml(r.jobName||'—')}</td>
      <td style="padding:8px 10px;color:#94a3b8;font-size:11px;">${r.startedAt ? formatDate(r.startedAt) : '—'}</td>
      <td style="padding:8px 10px;color:#94a3b8;font-size:11px;">${escapeHtml(r.format||'—')}</td>
      <td style="padding:8px 10px;color:#94a3b8;font-size:11px;text-align:right;">${r.sizeBytes ? formatBytes(r.sizeBytes) : '—'}</td>
      <td style="padding:8px 10px;color:#94a3b8;font-size:11px;text-align:right;">${r.durationMs ? formatElapsed(r.durationMs) : '—'}</td>
      <td style="padding:8px 10px;font-size:11px;" id="catalog-status-${escapeHtml(r.backupId)}">${dot}${st.label}</td>
      <td style="padding:8px 10px;text-align:right;">
        <div style="display:flex;gap:4px;justify-content:flex-end;">
          ${canRestore ? `<button onclick="openRestoreModal('${escapeHtml(r.backupId)}',${!!r.encrypted})" class="btn btn-ghost" style="padding:3px 8px;font-size:10px;">Restore</button>` : ''}
          ${canVerify  ? `<button onclick="verifyBackupEntry('${escapeHtml(r.backupId)}')" class="btn btn-ghost" style="padding:3px 8px;font-size:10px;">Verify</button>` : ''}
          ${canDelete  ? `<button onclick="deleteCatalogEntry('${escapeHtml(r.backupId)}')" class="btn btn-danger" style="padding:3px 8px;font-size:10px;">Delete</button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
}

function openRestoreModal(backupId, encrypted) {
  _restoreBackupId = backupId;
  const modal = document.getElementById('restore-modal');
  const ppRow = document.getElementById('restore-passphrase-row');
  if (ppRow) ppRow.style.display = encrypted ? '' : 'none';
  if (modal) modal.style.display = 'flex';
}

async function submitRestore() {
  if (!_restoreBackupId) return;
  const target = {
    host:     document.getElementById('restore-host')?.value.trim(),
    port:     parseInt(document.getElementById('restore-port')?.value) || 5432,
    database: document.getElementById('restore-database')?.value.trim(),
    user:     document.getElementById('restore-user')?.value.trim(),
    password: document.getElementById('restore-password')?.value,
  };
  const passphrase = document.getElementById('restore-passphrase')?.value || null;
  const restoreOptions = {
    cleanBeforeRestore: document.getElementById('restore-clean')?.checked || false,
    createDatabase:     document.getElementById('restore-create-db')?.checked || false,
  };
  document.getElementById('restore-modal').style.display = 'none';
  appendLog('info', `Starting restore of backup ${_restoreBackupId} → ${target.host}/${target.database}…`);
  showToast('info', 'Restore started', `Restoring to ${target.host}/${target.database}…`);
  const res = await fetch('/api/backup/restore', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ backupId: _restoreBackupId, target, restoreOptions, passphrase }),
  }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));
  if (!res.ok) appendLog('error', 'Restore failed: ' + (res.error || 'Unknown error'));
}

async function verifyBackupEntry(backupId) {
  appendLog('info', `Verifying backup ${backupId}…`);
  const res = await fetch(`/api/backup/verify/${backupId}`, { method: 'POST' })
    .then(r => r.json()).catch(err => ({ ok: false, error: err.message }));
  if (res.ok) {
    appendLog('success', `Backup ${backupId} verified — status: ${res.status}`);
  } else {
    appendLog('error', `Verify failed: ${res.error || 'Unknown error'}`);
  }
  loadBackupCatalog();
}

async function deleteCatalogEntry(backupId) {
  if (!confirm('Delete this backup artifact and catalog record?')) return;
  const res = await fetch(`/api/backup/catalog/${backupId}`, { method: 'DELETE' })
    .then(r => r.json()).catch(err => ({ ok: false, error: err.message }));
  appendLog(res.ok ? 'info' : 'error', res.ok ? `Backup ${backupId} deleted` : `Delete failed: ${res.error}`);
  loadBackupCatalog();
}

// ── Backup: WebSocket progress events (Task 13.4) ─────────────────────

function updateBackupProgress({ phase, bytesWritten, elapsedMs, estimatedRemainingMs }) {
  const phaseEl   = document.getElementById('backup-phase');
  const dotEl     = document.getElementById('backup-phase-dot');
  const bytesEl   = document.getElementById('backup-bytes');
  const elapsedEl = document.getElementById('backup-elapsed');
  const remainEl  = document.getElementById('backup-remaining');
  const barEl     = document.getElementById('backup-progress-bar');
  if (phaseEl)   phaseEl.textContent   = phase || 'In progress…';
  if (dotEl)     dotEl.style.background = '#fbbf24';
  if (bytesEl)   bytesEl.textContent   = bytesWritten ? formatBytes(bytesWritten) : '—';
  if (elapsedEl) elapsedEl.textContent = elapsedMs ? formatElapsed(elapsedMs) : '—';
  if (remainEl)  remainEl.textContent  = estimatedRemainingMs ? formatElapsed(estimatedRemainingMs) : '—';
  if (barEl && bytesWritten) barEl.style.width = '50%';
}

socket.on('backup:started', ({ backupId, jobName, format, source }) => {
  appendLog('info', `Backup started: ${jobName || backupId} (${format}) from ${source?.host}/${source?.database}`);
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.innerHTML = `<div style="color:#e2e8f0;font-size:12px;font-weight:500;">${escapeHtml(jobName||backupId)}</div><div style="color:#64748b;font-size:11px;margin-top:4px;">${escapeHtml(format||'')} · ${escapeHtml((source?.host||'')+'/'+(source?.database||''))}</div>`;
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#fbbf24';
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Starting…';
  const barEl = document.getElementById('backup-progress-bar');
  if (barEl) barEl.style.width = '0%';
});

socket.on('backup:progress', (data) => {
  updateBackupProgress(data);
});

socket.on('backup:completed', ({ backupId, sizeBytes, durationMs, storagePaths }) => {
  appendLog('success', `Backup completed: ${backupId} — ${formatBytes(sizeBytes||0)} in ${formatElapsed(durationMs||0)}`);
  showToast('success', 'Backup completed', `${formatBytes(sizeBytes||0)} saved in ${formatElapsed(durationMs||0)}`);
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#34d399';
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Completed';
  const barEl = document.getElementById('backup-progress-bar');
  if (barEl) barEl.style.width = '100%';
  const summaryEl = document.getElementById('backup-last-summary');
  if (summaryEl) summaryEl.innerHTML = `<span style="color:#34d399;font-weight:500;">✓ Backup completed</span> — ${formatBytes(sizeBytes||0)} in ${formatElapsed(durationMs||0)}`;
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.textContent = 'No operation in progress.';
  if (document.getElementById('backup-catalog-section')?.style.display !== 'none') loadBackupCatalog();
});

socket.on('backup:failed', ({ backupId, errorMessage }) => {
  appendLog('error', `Backup failed: ${backupId} — ${errorMessage}`);
  showToast('error', 'Backup failed', errorMessage || 'Unknown error', 10000);
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#f87171';
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Failed';
  const summaryEl = document.getElementById('backup-last-summary');
  if (summaryEl) summaryEl.innerHTML = `<span style="color:#f87171;font-weight:500;">✗ Backup failed</span> — ${escapeHtml(errorMessage||'')}`;
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.textContent = 'No operation in progress.';
});

socket.on('backup:corrupted', ({ backupId, errorMessage }) => {
  appendLog('error', `Backup corrupted: ${backupId} — ${errorMessage}`);
  const statusEl = document.getElementById(`catalog-status-${backupId}`);
  if (statusEl) statusEl.innerHTML = '<span style="display:inline-block;width:7px;height:7px;border-radius:50%;background:#f87171;margin-right:5px;"></span>Corrupted';
  if (document.getElementById('backup-catalog-section')?.style.display !== 'none') loadBackupCatalog();
});

socket.on('restore:started', ({ backupId, target }) => {
  appendLog('info', `Restore started: ${backupId} → ${target?.host}/${target?.database}`);
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Downloading…';
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#fbbf24';
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.innerHTML = `<div style="color:#e2e8f0;font-size:12px;font-weight:500;">Restoring ${escapeHtml(backupId)}</div><div style="color:#64748b;font-size:11px;margin-top:4px;">→ ${escapeHtml((target?.host||'')+'/'+(target?.database||''))}</div>`;
});

socket.on('restore:progress', ({ backupId, phase, elapsedMs }) => {
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = phase || 'Restoring…';
  const elapsedEl = document.getElementById('backup-elapsed');
  if (elapsedEl) elapsedEl.textContent = elapsedMs ? formatElapsed(elapsedMs) : '—';
});

socket.on('restore:completed', ({ backupId, durationMs, target }) => {
  appendLog('success', `Restore completed: ${backupId} → ${target?.host}/${target?.database} in ${formatElapsed(durationMs||0)}`);
  showToast('success', 'Restore completed', `${target?.host}/${target?.database} restored in ${formatElapsed(durationMs||0)}`);
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#34d399';
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Restore completed';
  const summaryEl = document.getElementById('backup-last-summary');
  if (summaryEl) summaryEl.innerHTML = `<span style="color:#34d399;font-weight:500;">✓ Restore completed</span> in ${formatElapsed(durationMs||0)}`;
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.textContent = 'No operation in progress.';
});

socket.on('restore:failed', ({ backupId, errorMessage }) => {
  appendLog('error', `Restore failed: ${backupId} — ${errorMessage}`);
  showToast('error', 'Restore failed', errorMessage || 'Unknown error', 10000);
  const dotEl = document.getElementById('backup-phase-dot');
  if (dotEl) dotEl.style.background = '#f87171';
  const phaseEl = document.getElementById('backup-phase');
  if (phaseEl) phaseEl.textContent = 'Restore failed';
  const summaryEl = document.getElementById('backup-last-summary');
  if (summaryEl) summaryEl.innerHTML = `<span style="color:#f87171;font-weight:500;">✗ Restore failed</span> — ${escapeHtml(errorMessage||'')}`;
  const opEl = document.getElementById('backup-current-op');
  if (opEl) opEl.textContent = 'No operation in progress.';
});

// ── Backup: Source DB connection test ─────────────────────────────────

// Task 13.1: Implement getBackupConnectionTestPayload()
function getBackupConnectionTestPayload() {
  const dbType = document.getElementById('bkp-db-type')?.value || 'postgresql';
  
  if (dbType === 'mongodb') {
    // MongoDB uses Connection URI
    return {
      dbType: 'mongodb',
      connectionUri: document.getElementById('bkp-src-connection-uri')?.value.trim() || '',
      authDatabase: document.getElementById('bkp-src-auth-database')?.value.trim() || 'admin',
    };
  } else {
    // PostgreSQL, MySQL, MariaDB use individual fields
    return {
      dbType: dbType,
      host: document.getElementById('bkp-src-host')?.value.trim() || '',
      port: parseInt(document.getElementById('bkp-src-port')?.value) || 5432,
      database: document.getElementById('bkp-src-database')?.value.trim() || '',
      user: document.getElementById('bkp-src-user')?.value.trim() || '',
      password: document.getElementById('bkp-src-password')?.value || '',
    };
  }
}

// Task 13.2: Update Test button to use /api/backup/test-db-connection endpoint
async function testBackupSourceConn() {
  const payload = getBackupConnectionTestPayload();
  const dbType = payload.dbType || 'postgresql';

  // Validate required fields based on dbType
  const missing = [];
  if (dbType === 'mongodb') {
    if (!payload.connectionUri) missing.push('connection URI');
  } else {
    if (!payload.host)     missing.push('host');
    if (!payload.database) missing.push('database');
    if (!payload.user)     missing.push('username');
    if (!payload.password) missing.push('password');
  }
  
  if (missing.length > 0) {
    appendLog('error', `Backup source test: missing required fields — ${missing.join(', ')}`);
    return;
  }

  const lbl = document.getElementById('bkp-src-test-label');
  const dot = document.getElementById('bkp-src-status-dot');
  if (lbl) lbl.textContent = '…';
  if (dot) { dot.style.background = '#fbbf24'; dot.title = 'Testing…'; }

  const res = await fetch('/api/backup/test-db-connection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

  if (lbl) lbl.textContent = 'Test';
  if (res.ok) {
    if (dot) { dot.style.background = '#34d399'; dot.title = 'Connected'; }
    const connStr = dbType === 'mongodb' 
      ? payload.connectionUri.split('@')[1] || payload.connectionUri 
      : `${payload.host}/${payload.database}`;
    appendLog('success', `Backup source DB connected — ${connStr}${res.version ? ' (' + res.version + ')' : ''}`);
  } else {
    if (dot) { dot.style.background = '#f87171'; dot.title = res.error || 'Failed'; }
    appendLog('error', `Backup source DB failed — ${res.error || 'Unknown error'}`);
  }
}

function resetBackupSrcDot() {
  const dot = document.getElementById('bkp-src-status-dot');
  if (dot) { dot.style.background = '#334155'; dot.title = 'Not tested'; }
}

// ── Backup: Test webhook button ────────────────────────────────────────

async function testBackupWebhook() {
  const url = document.getElementById('bkp-webhook-url')?.value.trim();
  if (!url) {
    appendLog('error', 'Enter a webhook URL first');
    return;
  }

  const btn = document.getElementById('btn-bkp-test-webhook');
  if (btn) btn.disabled = true;
  appendLog('info', `Sending test webhook to ${url}…`);

  const res = await fetch('/api/backup/test-webhook', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  }).then(r => r.json()).catch(err => ({ ok: false, error: err.message }));

  if (btn) btn.disabled = false;

  if (res.ok) {
    appendLog('success', `Webhook delivered successfully (HTTP ${res.status || 200})`);
  } else {
    appendLog('error', `Webhook failed — ${res.error || 'Unknown error'}`);
  }
}

// ── Toast notifications ────────────────────────────────────────────────────

/**
 * Show a toast notification that auto-dismisses after `duration` ms.
 * @param {'success'|'error'|'info'|'warning'} type
 * @param {string} title   Bold heading line
 * @param {string} message Detail text (optional)
 * @param {number} duration  Auto-dismiss after this many ms (default 6000)
 */
function showToast(type, title, message = '', duration = 6000) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const colors = {
    success: { bg: '#0f2a1e', border: '#059669', icon: '✓', iconColor: '#34d399', titleColor: '#34d399' },
    error:   { bg: '#2a0f0f', border: '#dc2626', icon: '✗', iconColor: '#f87171', titleColor: '#f87171' },
    info:    { bg: '#0f1e2a', border: '#2563eb', icon: '●', iconColor: '#60a5fa', titleColor: '#93c5fd' },
    warning: { bg: '#2a1f0f', border: '#d97706', icon: '!', iconColor: '#fbbf24', titleColor: '#fcd34d' },
  };
  const c = colors[type] || colors.info;

  const toast = document.createElement('div');
  toast.style.cssText = `
    background:${c.bg};
    border:1px solid ${c.border};
    border-left:4px solid ${c.border};
    border-radius:10px;
    padding:14px 16px;
    min-width:280px;
    max-width:400px;
    box-shadow:0 8px 24px rgba(0,0,0,.5);
    pointer-events:all;
    cursor:pointer;
    animation:fadeIn .2s ease;
    display:flex;
    gap:12px;
    align-items:flex-start;
  `;

  toast.innerHTML = `
    <span style="font-size:18px;color:${c.iconColor};flex-shrink:0;line-height:1.2;">${c.icon}</span>
    <div style="flex:1;min-width:0;">
      <div style="font-size:13px;font-weight:600;color:${c.titleColor};margin-bottom:${message ? '4px' : '0'};">${escapeHtml(title)}</div>
      ${message ? `<div style="font-size:12px;color:#94a3b8;word-break:break-word;">${escapeHtml(message)}</div>` : ''}
    </div>
    <button onclick="this.closest('div[style]').remove()" style="background:none;border:none;color:#475569;cursor:pointer;font-size:16px;line-height:1;flex-shrink:0;padding:0 0 0 4px;">×</button>
  `;

  // Click anywhere on toast to dismiss
  toast.addEventListener('click', (e) => {
    if (e.target.tagName !== 'BUTTON') toast.remove();
  });

  container.appendChild(toast);

  // Auto-dismiss
  setTimeout(() => {
    toast.style.transition = 'opacity .4s ease';
    toast.style.opacity = '0';
    setTimeout(() => toast.remove(), 400);
  }, duration);
}
