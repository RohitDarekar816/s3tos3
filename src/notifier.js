import nodemailer from 'nodemailer';

function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const u = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(2)} ${u[i]}`;
}

// ── Webhook ────────────────────────────────────────────────────────────────

export async function sendWebhook(url, payload) {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'S3BackupStudio/1.0' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10_000),
    });
    return { ok: res.ok, status: res.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Email ──────────────────────────────────────────────────────────────────

function buildEmailBody(payload) {
  const statusIcon  = payload.reason === 'completed' ? '✅' : '❌';
  const statusLabel = payload.reason === 'completed' ? 'Completed' : payload.reason === 'user_stopped' ? 'Stopped' : 'Failed';
  const { stats } = payload;

  const text = [
    `S3 Backup Studio — ${statusLabel}`,
    '='.repeat(40),
    `Source    : ${payload.source}`,
    `Dest      : ${payload.dest}`,
    `Status    : ${statusLabel}`,
    `Duration  : ${payload.elapsed}s`,
    payload.dryRun ? 'Mode      : DRY RUN (no files were actually transferred)' : '',
    '',
    `Files     : ${stats.synced} synced, ${stats.skipped} skipped, ${stats.failed} failed`,
    `Data      : ${formatBytes(stats.bytesTransferred)} transferred`,
    '',
    `Completed : ${new Date().toLocaleString()}`,
  ].filter((l) => l !== undefined).join('\n');

  const html = `
<!DOCTYPE html>
<html>
<body style="font-family:system-ui,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#1e293b;background:#f8fafc;">
  <div style="background:white;border-radius:12px;padding:24px;box-shadow:0 1px 3px rgba(0,0,0,0.1);">
    <div style="display:flex;align-items:center;gap:10px;margin-bottom:20px;">
      <span style="font-size:24px;">${statusIcon}</span>
      <h2 style="margin:0;font-size:18px;">S3 Backup Studio — ${statusLabel}</h2>
    </div>
    ${payload.dryRun ? '<div style="background:#f0f9ff;border:1px solid #0ea5e9;border-radius:8px;padding:10px 14px;margin-bottom:16px;color:#0369a1;font-size:13px;">🔍 Dry Run — no files were actually transferred</div>' : ''}
    <table style="width:100%;border-collapse:collapse;font-size:13px;margin-bottom:20px;">
      <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Source</td><td style="padding:8px 12px;">${payload.source}</td></tr>
      <tr><td style="padding:8px 12px;font-weight:600;">Destination</td><td style="padding:8px 12px;">${payload.dest}</td></tr>
      <tr style="background:#f1f5f9;"><td style="padding:8px 12px;font-weight:600;">Duration</td><td style="padding:8px 12px;">${payload.elapsed}s</td></tr>
    </table>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:20px;">
      <div style="background:#f0fdf4;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#16a34a;">${stats.synced}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">Synced</div>
      </div>
      <div style="background:#f8fafc;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:#475569;">${stats.skipped}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">Skipped</div>
      </div>
      <div style="background:${stats.failed > 0 ? '#fef2f2' : '#f8fafc'};border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:22px;font-weight:700;color:${stats.failed > 0 ? '#dc2626' : '#475569'};">${stats.failed}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">Failed</div>
      </div>
      <div style="background:#eff6ff;border-radius:8px;padding:12px;text-align:center;">
        <div style="font-size:16px;font-weight:700;color:#2563eb;">${formatBytes(stats.bytesTransferred)}</div>
        <div style="font-size:11px;color:#64748b;margin-top:2px;">Transferred</div>
      </div>
    </div>
    <div style="font-size:11px;color:#94a3b8;text-align:center;">
      Sent by S3 Backup Studio · ${new Date().toLocaleString()}
    </div>
  </div>
</body>
</html>`.trim();

  return { text, html };
}

export async function sendEmail(cfg, payload) {
  if (!cfg?.host || !cfg?.to) return { ok: false, error: 'Email not configured' };

  try {
    const transporter = nodemailer.createTransport({
      host: cfg.host,
      port: parseInt(cfg.port) || 587,
      secure: parseInt(cfg.port) === 465,
      auth: cfg.user ? { user: cfg.user, pass: cfg.pass } : undefined,
    });

    const { text, html } = buildEmailBody(payload);
    const statusLabel = payload.reason === 'completed' ? '✅ Completed' : '❌ Failed';
    const subject = `[S3 Backup] ${statusLabel}: ${payload.source} → ${payload.dest}`;

    await transporter.sendMail({
      from: cfg.from || cfg.user || 's3backup@localhost',
      to: cfg.to,
      subject,
      text,
      html,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ── Dispatch (called by engine after each sync) ────────────────────────────

export async function notify(notifications, payload) {
  if (!notifications) return;
  const isFailure = payload.reason !== 'completed';

  const tasks = [];

  if (notifications.webhook?.url) {
    const wh = notifications.webhook;
    if ((isFailure && wh.onFailure) || (!isFailure && wh.onComplete)) {
      tasks.push(
        sendWebhook(wh.url, { ...payload, event: `sync_${payload.reason}` })
          .catch(() => {}),
      );
    }
  }

  if (notifications.email?.host && notifications.email?.to) {
    const em = notifications.email;
    if ((isFailure && em.onFailure) || (!isFailure && em.onComplete)) {
      tasks.push(sendEmail(em, payload).catch(() => {}));
    }
  }

  await Promise.allSettled(tasks);
}
