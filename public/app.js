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

function renderQr(qr) {
  qrBox.innerHTML = '';
  if (!qr) {
    qrBox.innerHTML = '<span class="muted">QR will appear here</span>';
    return;
  }
  const canvas = document.createElement('canvas');
  qrBox.appendChild(canvas);
  window.QRCode.toCanvas(canvas, qr, { width: 180 }, err => {
    if (err) {
      qrBox.innerHTML = '<span class="muted">Failed to render QR</span>';
    }
  });
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
    renderQr(data.qr);
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
    renderQr(data.qr);
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

async function refreshSessions() {
  try {
    const res = await fetch('/sessions');
    const data = await res.json();
    sessionList.innerHTML = '';
    (data.sessions || []).forEach(id => {
      const li = document.createElement('li');
      li.textContent = id;
      const btn = document.createElement('button');
      btn.className = 'ghost';
      btn.textContent = 'Use';
      btn.onclick = () => {
        sessionIdEl.value = id;
        msgSessionIdEl.value = id;
      };
      li.appendChild(btn);
      sessionList.appendChild(li);
    });
    if (!data.sessions || data.sessions.length === 0) {
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
refreshSessionsBtn.addEventListener('click', refreshSessions);

checkServer();
refreshSessions();
