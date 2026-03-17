const statusEl = document.getElementById('serverStatus');
const sessionIdEl = document.getElementById('sessionId');
const createSessionBtn = document.getElementById('createSession');
const refreshQrBtn = document.getElementById('refreshQr');
const deleteSessionBtn = document.getElementById('deleteSession');
const qrBox = document.getElementById('qrBox');
const sessionStatus = document.getElementById('sessionStatus');

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

function setStatus(text, ok = true) {
  statusEl.textContent = text;
  statusEl.style.color = ok ? 'var(--accent-2)' : 'var(--danger)';
}

async function checkServer() {
  try {
    const res = await fetch('/health');
    if (!res.ok) throw new Error('Server not ready');
    setStatus('Server online');
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
    await refreshSessions();
  } catch (err) {
    sessionStatus.textContent = err.message;
    renderQr(null);
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

  if (!confirm('Logout this session?')) return;
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
      const label = document.createElement('span');
      const connectedNumber = session.connectedNumber ? ` (${session.connectedNumber})` : '';
      label.textContent = `${session.sessionId}${connectedNumber}`;
      li.appendChild(label);

      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Use';
      btn.onclick = () => {
        sessionIdEl.value = session.sessionId;
        msgSessionIdEl.value = session.sessionId;
        simSessionIdEl.value = session.sessionId;
        simRecipientPhoneEl.value = session.connectedNumber || '';
      };
      li.appendChild(btn);
      sessionList.appendChild(li);
    });
    if (!data.sessionDetails || data.sessionDetails.length === 0) {
      sessionList.innerHTML = '<li class="muted">No active sessions</li>';
    }
  } catch (err) {
    sessionList.innerHTML = '<li class="muted">Failed to load sessions</li>';
  }
}

createSessionBtn.addEventListener('click', initSession);
refreshQrBtn.addEventListener('click', refreshQr);
deleteSessionBtn.addEventListener('click', deleteSession);
sendMessageBtn.addEventListener('click', sendMessage);
simulateInboundBtn.addEventListener('click', simulateInbound);
refreshSessionsBtn.addEventListener('click', refreshSessions);

checkServer();
refreshSessions();
