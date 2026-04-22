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

$('job-selector').addEventListener('change', () => {
  currentJobId = $('job-selector').value || null;
  $('btn-delete-job').disabled = !currentJobId;
});

// ── History ────────────────────────────────────────────────────────────

async function loadHistory() {
  const history = await fetch('/api/history').then(r=>r.json()).catch(()=>[]);
  const container = $('history-container');
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

$('log-container').addEventListener('scroll', () => {
  const el=$('log-container');
  autoScroll = el.scrollTop+el.clientHeight >= el.scrollHeight-20;
});

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
});

socket.on('sync:resumed', ({count, savedAt}) => {
  appendLog('info', `Checkpoint detected — resuming from ${count} previously completed files (saved ${formatDate(new Date(savedAt))})`);
});

socket.on('sync:stats', (stats) => updateStats(stats));

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

  if ((stats?.failed||0) === 0) $('btn-retry').style.display='none';
});

socket.on('log', ({ts, level, message}) => appendLog(level, message, ts));
socket.on('disconnect', () => appendLog('warning','Connection lost — reconnecting…'));
socket.on('reconnect',  () => appendLog('info','Reconnected to server'));

// ── Init ───────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
  initBwChart();
  loadLocalConfig();
  updatePipelineLabels();
  $('log-filter-all').classList.add('active');
  setStatus('idle','Idle');
  refreshJobs();
  loadHistory();
});
