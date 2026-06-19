const statusEl = document.getElementById('serverStatus');
const sessionIdEl = document.getElementById('sessionId');
const createSessionBtn = document.getElementById('createSession');
const refreshQrBtn = document.getElementById('refreshQr');
const deleteSessionBtn = document.getElementById('deleteSession');
const qrBox = document.getElementById('qrBox');
const sessionStatus = document.getElementById('sessionStatus');

const webhookSessionIdEl = document.getElementById('webhookSessionId');
const webhookUrlEl = document.getElementById('webhookUrl');
const saveWebhookBtn = document.getElementById('saveWebhook');
const loadWebhookBtn = document.getElementById('loadWebhook');
const deleteWebhookBtn = document.getElementById('deleteWebhook');
const webhookLog = document.getElementById('webhookLog');

const msgSessionIdEl = document.getElementById('msgSessionId');
const msgToEl = document.getElementById('msgTo');
const msgTextEl = document.getElementById('msgText');
const sendMessageBtn = document.getElementById('sendMessage');
const messageLog = document.getElementById('messageLog');

const simSessionIdEl = document.getElementById('simSessionId');
const simRecipientPhoneEl = document.getElementById('simRecipientPhone');
const simSenderPhoneEl = document.getElementById('simSenderPhone');
const simPushNameEl = document.getElementById('simPushName');
const simTextEl = document.getElementById('simText');
const simulateInboundBtn = document.getElementById('simulateInbound');
const simulationLog = document.getElementById('simulationLog');

const refreshSessionsBtn = document.getElementById('refreshSessions');
const sessionList = document.getElementById('sessionList');

const webhookFireLog = document.getElementById('webhookFireLog');
const refreshWebhookFiresBtn = document.getElementById('refreshWebhookFires');
const autoWebhookFiresBtn = document.getElementById('autoWebhookFires');
const clearWebhookFiresBtn = document.getElementById('clearWebhookFires');
let webhookFiresTimer = null;

function setStatus(text, ok = true) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? 'var(--accent-2)' : 'var(--danger)';
}

async function checkServer() {
  try {
    const res = await fetch('/health', { cache: 'no-store' });
    const report = await res.json().catch(() => null);
    if (res.ok && report?.ok !== false) {
      setStatus('Server online');
      return;
    }

    if (report?.status) {
      setStatus(`Server ${report.status}`, false);
      return;
    }

    setStatus(`Server HTTP ${res.status}`, false);
  } catch (err) {
    setStatus('Server offline', false);
  }
}

function renderQr(qr, qrImage) {
  qrBox.innerHTML = '';
  if (!qr && !qrImage) {
    qrBox.innerHTML = '<span class="muted">QR will appear here</span>';
    return;
  }

  // Prefer server-generated image (most reliable)
  if (qrImage) {
    const img = document.createElement('img');
    img.src = qrImage;
    img.alt = 'Scan me';
    img.style.maxWidth = '100%';
    qrBox.appendChild(img);
    return;
  }

  // Fallback to client-side generation
  if (window.QRCode) {
    const canvas = document.createElement('canvas');
    qrBox.appendChild(canvas);
    window.QRCode.toCanvas(canvas, qr, { width: 180 }, err => {
      if (err) {
        console.error(err);
        qrBox.innerHTML = '<span class="muted">Failed to render QR</span>';
      }
    });
  } else {
    qrBox.innerHTML = '<span class="muted">Loading QR library...</span>';
  }
}

function setWebhookLog(value) {
  webhookLog.textContent = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

function useSession(session) {
  sessionIdEl.value = session.sessionId;
  msgSessionIdEl.value = session.sessionId;
  simSessionIdEl.value = session.sessionId;
  webhookSessionIdEl.value = session.sessionId;
  webhookUrlEl.value = session.webhook?.webhookUrl || '';
  simRecipientPhoneEl.value = session.connectedNumber || session.storedConnectedNumber || '';
  sessionStatus.textContent = session.qr
    ? 'Scan this QR code'
    : session.connectedNumber
    ? `Connected number: ${session.connectedNumber}`
    : session.storedConnectedNumber
    ? `Saved number: ${session.storedConnectedNumber}`
    : `Session ID: ${session.sessionId}`;
  renderQr(session.qr, session.qrImage);
}

async function initSession() {
  const sessionId = sessionIdEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');

  sessionStatus.textContent = 'Initializing...';
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to init session');

    sessionStatus.textContent = data.message || data.status;
    renderQr(data.qr, data.qrImage);
    msgSessionIdEl.value = sessionId;
    webhookSessionIdEl.value = sessionId;
    webhookUrlEl.value = data.webhook?.webhookUrl || webhookUrlEl.value;
    await refreshSessions();
  } catch (err) {
    sessionStatus.textContent = err.message;
    renderQr(null);
  }
}

async function saveWebhook() {
  const sessionId = webhookSessionIdEl.value.trim();
  const webhookUrl = webhookUrlEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');
  if (!webhookUrl) return alert('Enter a webhook URL');

  setWebhookLog('Saving webhook...');
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/webhook`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookUrl })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to save webhook');
    webhookUrlEl.value = data.webhookUrl || webhookUrl;
    setWebhookLog(data);
    await refreshSessions();
  } catch (err) {
    setWebhookLog(err.message);
  }
}

async function loadWebhook() {
  const sessionId = webhookSessionIdEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');

  setWebhookLog('Loading webhook...');
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/webhook`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Webhook not configured');
    webhookUrlEl.value = data.webhookUrl || '';
    setWebhookLog(data);
  } catch (err) {
    webhookUrlEl.value = '';
    setWebhookLog(err.message);
  }
}

async function deleteWebhook() {
  const sessionId = webhookSessionIdEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');
  if (!confirm(`Remove webhook for session ${sessionId}?`)) return;

  setWebhookLog('Removing webhook...');
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/webhook`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to remove webhook');
    webhookUrlEl.value = '';
    setWebhookLog(data);
    await refreshSessions();
  } catch (err) {
    setWebhookLog(err.message);
  }
}

async function refreshQr() {
  const sessionId = sessionIdEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');

  sessionStatus.textContent = 'Fetching QR...';
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}/qr`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'No QR yet');
    sessionStatus.textContent = 'Scan this QR code';
    renderQr(data.qr, data.qrImage);
  } catch (err) {
    sessionStatus.textContent = err.message;
    renderQr(null);
  }
}

async function deleteSession() {
  const sessionId = sessionIdEl.value.trim();
  if (!sessionId) return alert('Enter a session ID');

  if (!confirm('Logout and permanently delete this session?')) return;
  try {
    const res = await fetch(`/sessions/${encodeURIComponent(sessionId)}`, {
      method: 'DELETE'
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to delete session');
    sessionStatus.textContent = data.status || 'Logged out';
    renderQr(null);
    await refreshSessions();
  } catch (err) {
    sessionStatus.textContent = err.message;
  }
}

async function sendMessage() {
  const sessionId = msgSessionIdEl.value.trim();
  const to = msgToEl.value.trim();
  const text = msgTextEl.value.trim();
  if (!sessionId || !to || !text) return alert('Fill session, to, and message');

  messageLog.textContent = 'Sending...';
  try {
    const res = await fetch('/messages/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId, to, text })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Send failed');
    messageLog.textContent = JSON.stringify(data, null, 2);
  } catch (err) {
    messageLog.textContent = err.message;
  }
}

function prettySimulationResult(data) {
  const summary = {
    status: data.status,
    sessionId: data.sessionId,
    recipientPhone: data.recipientPhone,
    senderPhone: data.senderPhone,
    messageId: data.messageId,
    inboxStatus: data.inbox?.process_status || null,
    inboxAttempts: data.inbox?.process_attempts || 0,
    leadId: data.message?.lead_id || null,
    threadId: data.message?.thread_id || null,
    triggerWorked: !!data.triggerWorked,
    lastError: data.inbox?.last_error || null
  };

  return JSON.stringify({
    summary,
    inbox: data.inbox || null,
    message: data.message || null
  }, null, 2);
}

async function simulateInbound() {
  const sessionId = simSessionIdEl.value.trim();
  const recipientPhone = simRecipientPhoneEl.value.trim();
  const senderPhone = simSenderPhoneEl.value.trim();
  const pushName = simPushNameEl.value.trim();
  const text = simTextEl.value.trim();

  if (!senderPhone) return alert('Fill sender phone');
  if (!sessionId && !recipientPhone) return alert('Fill session ID or recipient WhatsApp number');

  simulationLog.textContent = 'Simulating inbound message...';
  try {
    const payload = { senderPhone };
    if (sessionId) payload.sessionId = sessionId;
    if (recipientPhone) payload.recipientPhone = recipientPhone;
    if (pushName) payload.pushName = pushName;
    if (text) payload.text = text;

    const res = await fetch('/simulate/inbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Simulation failed');
    simulationLog.textContent = prettySimulationResult(data);
  } catch (err) {
    simulationLog.textContent = err.message;
  }
}

async function refreshSessions() {
  try {
    const res = await fetch('/sessions');
    const data = await res.json();
    sessionList.innerHTML = '';
    (data.sessionDetails || []).forEach(session => {
      const li = document.createElement('li');
      const labelWrap = document.createElement('div');
      labelWrap.className = 'session-label-group';

      const label = document.createElement('span');
      label.className = 'session-label';
      label.textContent = session.connectedNumber || session.storedConnectedNumber || session.sessionId;
      labelWrap.appendChild(label);

      const statusSubtitle = document.createElement('span');
      statusSubtitle.className = session.connectedNumber ? 'session-subtitle webhook-set' : 'session-subtitle muted';
      statusSubtitle.textContent = session.connectedNumber
        ? `Connected · Session ID: ${session.sessionId}`
        : session.qr
        ? `QR pending · Session ID: ${session.sessionId}`
        : session.storedConnectedNumber
        ? `Saved, not connected · Session ID: ${session.sessionId}`
        : `${session.status || 'not connected'} · Session ID: ${session.sessionId}`;
      labelWrap.appendChild(statusSubtitle);

      const webhookSubtitle = document.createElement('span');
      webhookSubtitle.className = session.webhook?.webhookUrl ? 'session-subtitle webhook-set' : 'session-subtitle muted';
      webhookSubtitle.textContent = session.webhook?.webhookUrl
        ? `Webhook: ${session.webhook.webhookUrl}`
        : 'Webhook: not set';
      labelWrap.appendChild(webhookSubtitle);

      li.appendChild(labelWrap);

      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Use';
      btn.onclick = () => {
        useSession(session);
      };
      li.appendChild(btn);

      const deleteBtn = document.createElement('button');
      deleteBtn.className = 'danger ghost';
      deleteBtn.textContent = 'Delete Session';
      deleteBtn.style.marginLeft = '8px';
      deleteBtn.onclick = async () => {
        if (!confirm(`Logout and permanently delete session ${session.sessionId}?`)) return;
        try {
          const res = await fetch(`/sessions/${encodeURIComponent(session.sessionId)}`, {
            method: 'DELETE'
          });
          const data = await res.json();
          if (!res.ok) throw new Error(data.error || 'Failed to delete session');
          await refreshSessions();
          if (sessionIdEl.value === session.sessionId) {
            sessionStatus.textContent = 'Logged out';
            renderQr(null);
          }
        } catch (err) {
          alert(err.message);
        }
      };
      li.appendChild(deleteBtn);

      sessionList.appendChild(li);
    });
    if (!data.sessionDetails || data.sessionDetails.length === 0) {
      sessionList.innerHTML = '<li class="muted">No active sessions</li>';
    }
  } catch (err) {
    sessionList.innerHTML = '<li class="muted">Failed to load sessions</li>';
  }
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function renderWebhookFires(entries) {
  if (!entries || entries.length === 0) {
    webhookFireLog.innerHTML = '<span class="muted">No webhooks fired yet.</span>';
    return;
  }
  const rows = entries.map(e => {
    const ok = e.ok;
    const dot = ok ? '🟢' : '🔴';
    const status = e.status != null ? `HTTP ${e.status}` : (e.error ? 'FAILED' : '—');
    const when = (e.at || '').replace('T', ' ').replace('Z', '').slice(0, 19);
    const dur = e.durationMs != null ? `${e.durationMs}ms` : '';
    const line1 = `${dot} ${escapeHtml(when)}  ·  ${escapeHtml(e.kind)}  ·  ${escapeHtml(status)} ${escapeHtml(dur)}`;
    const line2 = `→ ${escapeHtml(e.url)}`;
    const line3 = `from ${escapeHtml(e.from || '—')}${e.contentPreview ? '  ·  "' + escapeHtml(e.contentPreview) + '"' : ''}`;
    const line4 = e.error ? `<span style="color:var(--danger)">error: ${escapeHtml(e.error)}</span>` : '';
    return `<div style="padding:8px 0;border-bottom:1px solid rgba(255,255,255,0.08)">`
      + `<div style="font-weight:600">${line1}</div>`
      + `<div class="muted" style="font-size:0.85em">${line2}</div>`
      + `<div class="muted" style="font-size:0.85em">${line3}</div>`
      + (line4 ? `<div style="font-size:0.85em">${line4}</div>` : '')
      + `</div>`;
  }).join('');
  webhookFireLog.innerHTML = rows;
}

async function refreshWebhookFires() {
  try {
    const res = await fetch('/webhook-log?limit=100', { cache: 'no-store' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load webhook log');
    renderWebhookFires(data.entries);
  } catch (err) {
    webhookFireLog.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}

function toggleAutoWebhookFires() {
  if (webhookFiresTimer) {
    clearInterval(webhookFiresTimer);
    webhookFiresTimer = null;
    autoWebhookFiresBtn.textContent = 'Auto-refresh: Off';
  } else {
    refreshWebhookFires();
    webhookFiresTimer = setInterval(refreshWebhookFires, 3000);
    autoWebhookFiresBtn.textContent = 'Auto-refresh: On';
  }
}

async function clearWebhookFires() {
  if (!confirm('Clear the webhook fire log?')) return;
  try {
    await fetch('/webhook-log', { method: 'DELETE' });
    await refreshWebhookFires();
  } catch (err) {
    webhookFireLog.innerHTML = `<span class="muted">${escapeHtml(err.message)}</span>`;
  }
}

refreshWebhookFiresBtn.addEventListener('click', refreshWebhookFires);
autoWebhookFiresBtn.addEventListener('click', toggleAutoWebhookFires);
clearWebhookFiresBtn.addEventListener('click', clearWebhookFires);

createSessionBtn.addEventListener('click', initSession);
refreshQrBtn.addEventListener('click', refreshQr);
deleteSessionBtn.addEventListener('click', deleteSession);
sendMessageBtn.addEventListener('click', sendMessage);
simulateInboundBtn.addEventListener('click', simulateInbound);
saveWebhookBtn.addEventListener('click', saveWebhook);
loadWebhookBtn.addEventListener('click', loadWebhook);
deleteWebhookBtn.addEventListener('click', deleteWebhook);
refreshSessionsBtn.addEventListener('click', refreshSessions);

checkServer();
refreshSessions();
refreshWebhookFires();
