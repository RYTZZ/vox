/* ============================================================
   SorSU TikTalk — app.js
   ============================================================ */
'use strict';

// ============================================================
// CONSTANTS
// ============================================================
const EMOJIS = [
    '👍', '❤️', '😂', '😮', '😢', '🔥',
    '👏', '🎉', '😡', '🤔', '💯', '✨',
    '😎', '🙏', '💀'
];

const BAN_DURATIONS = {
    'temp-1h': 3_600_000,
    'temp-6h': 21_600_000,
    'temp-24h': 86_400_000,
    'temp-7d': 604_800_000,
};

const HEART_THRESHOLD_MS = 2.5 * 60 * 1000;  // 2 minutes 30 seconds
const HEART_COUNTDOWN_SEC = 30;

// ============================================================
// STATE
// ============================================================
let ws = null;
let myNick = '';
let myCampus = '';
let myId = '';
let currentPanel = 'global';
let replyTo = null;
let replyPreview = '';
let pendingReport = null;
let pendingEmojiId = null;
let dmTarget = null;
let isAdmin = false;

/** @type {Object.<string, Array>} */
const dmHistory = {};

// DM-specific state
let dmReplyTo = null;
let dmEditingId = null;
let pendingDMReport = null;
let pendingDMEmoji = null;

// Stranger-specific state
let strangerSessionId = null;
let strangerStartTime = null;
let strangerDurationTimer = null;
let strangerHeartTimer = null;
let strangerHeartCountdown = null;
let strangerMyHeartClicked = false;
let strangerHeartShown = false;  // ← one-shot flag: heart shown only ONCE per match
let strangerReplyTo = null;
let strangerEditingId = null;
let pendingStrangerEmoji = null;
let pendingStrangerReport = null;

/** @type {Array} stranger message history for this session */
const strangerMsgs = [];

// ── Reaction de-duplicate tracking ────────────────────────────────
// Global chat: server enforces one-react-per-user via react_update broadcasts.
// DM / Stranger: client-side Sets track which messages THIS user has reacted to.
// Key: msgId. Stored per-session (cleared on DM switch / stranger session end).
const myDMReacted = new Set(); // dmMsgId values this user already reacted to
const myStrangerReacted = new Set(); // stranger msgId values this user already reacted to

// ── Typing indicator state ─────────────────────────────────────
// Map of nickname -> clearTimeout handle for global chat typers
const globalTypers = new Map();
// DM typing: just a single clearTimeout handle (only one person can DM us at a time in practice)
let dmTypingTimeout = null;
// Stranger typing: single flag
let strangerTypingTimeout = null;

let dmMsgCounter = 0;
let smsgCounter = 0;
function newDMId() { return `dm_${Date.now()}_${++dmMsgCounter}`; }
function newSmsgId() { return `sm_${Date.now()}_${++smsgCounter}`; }

// ============================================================
// UTILITY HELPERS
// ============================================================
function escapeHTML(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function nickColor(nick) {
    let h = 0;
    for (let i = 0; i < nick.length; i++) h = nick.charCodeAt(i) + ((h << 5) - h);
    const palettes = [
        'linear-gradient(135deg,#4f8ef7,#a78bfa)',
        'linear-gradient(135deg,#34d399,#4f8ef7)',
        'linear-gradient(135deg,#f59e0b,#ef4444)',
        'linear-gradient(135deg,#ec4899,#8b5cf6)',
        'linear-gradient(135deg,#06b6d4,#3b82f6)',
        'linear-gradient(135deg,#f97316,#eab308)',
    ];
    return palettes[Math.abs(h) % palettes.length];
}

function formatTime(ts) {
    return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function formatDateTime(ts) {
    return new Date(ts).toLocaleString();
}

function formatDuration(ms) {
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    return [h, m, sec].map(v => String(v).padStart(2, '0')).join(':');
}

// ============================================================
// TOAST
// ============================================================
function toast(msg, type = 'info') {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(() => {
        el.style.opacity = '0';
        el.style.transition = 'opacity 0.4s';
        setTimeout(() => el.remove(), 400);
    }, 3500);
}

// ============================================================
// MODAL
// ============================================================
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ============================================================
// MOBILE SIDEBAR TOGGLE
// ============================================================
function openSidebar() {
    document.getElementById('sidebar').classList.add('open');
    document.getElementById('sidebar-overlay').classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeSidebar() {
    document.getElementById('sidebar').classList.remove('open');
    document.getElementById('sidebar-overlay').classList.remove('show');
    document.body.style.overflow = '';
}

// ============================================================
// THEME
// ============================================================
function toggleTheme() {
    const html = document.documentElement;
    const isDark = html.getAttribute('data-theme') === 'dark';
    html.setAttribute('data-theme', isDark ? 'light' : 'dark');
    document.querySelectorAll('.toggle').forEach(t => t.classList.toggle('on', !isDark));
}

// ============================================================
// PAGE NAVIGATION
// ============================================================
function showPage(page) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(page + '-page').classList.add('active');
}

// ============================================================
// CHAT PANEL SWITCHING
// ============================================================
function showPanel(name) {
    document.querySelectorAll('.chat-panel').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    currentPanel = name;

    const panelId = {
        global: 'panel-global', ann: 'panel-ann', dm: 'panel-dm',
        stranger: 'panel-stranger', suggest: 'panel-suggest'
    }[name];
    if (panelId) document.getElementById(panelId).classList.add('active');

    const navId = {
        global: 'nav-global', ann: 'nav-ann',
        stranger: 'nav-stranger', suggest: 'nav-suggest'
    }[name];
    if (navId) { const el = document.getElementById(navId); if (el) el.classList.add('active'); }

    // Auto-fill campus on the Suggestion Box panel from user's known campus
    if (name === 'suggest' && myCampus) {
        const el = document.getElementById('suggest-campus');
        if (el && !el.value) el.value = myCampus;
    }

    // Auto-close sidebar on mobile after navigation
    if (window.innerWidth <= 900) closeSidebar();
}

// ============================================================
// ENTER / LEAVE CHAT
// ============================================================
function enterChat() {
    const nick = document.getElementById('nick-input').value.trim();
    const campus = document.getElementById('campus-select').value;
    if (!nick) return toast('Please enter a nickname.', 'error');
    if (!campus) return toast('Please select your campus.', 'error');

    myNick = nick;
    myCampus = campus;
    document.getElementById('me-name').textContent = nick;
    document.getElementById('me-campus').textContent = campus.split(' - ')[0];
    document.getElementById('me-avatar').textContent = nick[0].toUpperCase();

    showPage('chat');
    connectWS();
}

function leaveChat() {
    if (ws) ws.close();
    strangerCleanupUI();
    showPage('front');
}

// ============================================================
// WEBSOCKET
// ============================================================
function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
        ws.send(JSON.stringify({ type: 'join', nickname: myNick, campus: myCampus }));
        toast('Connected to TikTalk!', 'success');
        // Flush any suggestions queued before connection was ready
        setTimeout(flushSuggestionQueue, 300);
    };

    ws.onmessage = (e) => {
        try { handleServerMessage(JSON.parse(e.data)); }
        catch (err) { console.error('Parse error:', err); }
    };

    ws.onclose = () => {
        toast('Disconnected. Reconnecting in 3s…', 'error');
        setTimeout(connectWS, 3000);
    };

    ws.onerror = () => ws.close();

    // Respond to server keep-alive pings (Render free tier prevention)
    ws.addEventListener('message', (e) => {
        if (e.data === '__ping__') ws.send('__pong__');
    });
}

function wsSend(payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ============================================================
// SERVER MESSAGE ROUTER
// ============================================================
function handleServerMessage(data) {
    switch (data.type) {
        case 'chat': renderChatMsg(data); break;
        case 'system': renderSystemMsg(data.message); break;
        case 'user_list': renderUserList(data.users); break;
        case 'react_update': applyReaction(data); break;
        case 'announcement': renderAnnouncement(data.announcement); break;
        case 'report_ack': toast('Report submitted to admin.', 'success'); break;
        case 'suggestion_ack': toast('💡 Suggestion sent to admin! Thank you.', 'success'); break;
        case 'error': toast(data.message, 'error'); break;
        case 'banned': handleBanned(data.message); break;

        // DM events
        case 'dm': receiveDM(data); break;
        case 'dm_sent':      /* optimistic render */ break;
        case 'dm_edit': receiveDMEdit(data); break;
        case 'dm_delete': receiveDMDelete(data); break;
        case 'dm_react': receiveDMReact(data); break;

        // Stranger events
        case 'stranger_waiting': strangerOnWaiting(); break;
        case 'stranger_cancelled': strangerOnCancelled(); break;
        case 'stranger_matched': strangerOnMatched(data); break;
        case 'stranger_msg': strangerReceiveMsg(data); break;
        case 'stranger_msg_sent': strangerOnMsgSent(data); break;
        case 'stranger_edit': strangerReceiveEdit(data); break;
        case 'stranger_delete': strangerReceiveDelete(data); break;
        case 'stranger_react': strangerReceiveReact(data); break;
        case 'stranger_ended': strangerOnEnded(data); break;
        case 'stranger_heart_received': strangerOnHeartReceived(); break;
        case 'stranger_move_to_dm': strangerMoveToDM(data); break;

        case 'joined':
            myId = data.id;
            if (Array.isArray(data.announcements)) {
                data.announcements.forEach(a => renderAnnouncement(a, false));
            }
            break;

        // ── Typing indicators ────────────────────────────────────
        case 'typing_global': handleGlobalTyping(data.nickname, true); break;
        case 'stop_typing_global': handleGlobalTyping(data.nickname, false); break;
        case 'typing_dm': handleDMTyping(data.from, true); break;
        case 'stop_typing_dm': handleDMTyping(data.from, false); break;
        case 'typing_stranger': handleStrangerTyping(true); break;
        case 'stop_typing_stranger': handleStrangerTyping(false); break;

        // Admin events are handled by handleAdminMessage on the adminWs.
        // These cases are kept as fallback only (e.g. if someone calls wsSend admin_auth on chat ws)
        case 'admin_ok':
            isAdmin = true;
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-dashboard').style.display = '';
            renderAdminData(data.reports, data.bannedIPs, data.suggestions);
            break;
        case 'admin_fail': toast('Invalid admin secret.', 'error'); break;
        case 'new_report': appendReport(data.report); break;
        case 'new_suggestion': appendSuggestion(data.suggestion); break;
        case 'admin_data': renderAdminData(data.reports, data.bannedIPs, data.suggestions); break;
        case 'ban_ok': toast('User banned.', 'success'); adminWsSend({ type: 'admin_get_data' }); break;
        case 'unban_ok': toast('User unbanned.', 'success'); renderAdminData(null, data.bannedIPs); break;
    }
}

function handleBanned(message) {
    alert('⛔ ' + message);
    if (ws) ws.close();
    showPage('front');
}

// ============================================================
// TYPING INDICATORS — receive side
// ============================================================

/** Update the global chat typing indicator bar */
function handleGlobalTyping(nick, isTyping) {
    const el = document.getElementById('global-typing-indicator');
    if (!el) return;

    if (isTyping) {
        // Clear any existing auto-stop timer for this nick
        if (globalTypers.has(nick)) clearTimeout(globalTypers.get(nick));
        // Auto-clear if server misses the stop event (safety net: 4s)
        const t = setTimeout(() => {
            globalTypers.delete(nick);
            updateGlobalTypingDisplay();
        }, 4000);
        globalTypers.set(nick, t);
    } else {
        if (globalTypers.has(nick)) { clearTimeout(globalTypers.get(nick)); globalTypers.delete(nick); }
    }
    updateGlobalTypingDisplay();
}

/** Build the animated dots HTML string */
function typingDotsHTML() {
    return '<span class="typing-dots"><span></span><span></span><span></span></span>';
}

function updateGlobalTypingDisplay() {
    const el = document.getElementById('global-typing-indicator');
    if (!el) return;
    const typers = Array.from(globalTypers.keys());
    if (!typers.length) { el.innerHTML = ''; el.classList.remove('active'); return; }
    const label = typers.length === 1
        ? `${escapeHTML(typers[0])} is typing`
        : `${typers.slice(0, 2).map(escapeHTML).join(', ')} ${typers.length > 2 ? `and ${typers.length - 2} others` : 'are'} typing`;
    el.innerHTML = `${typingDotsHTML()} <span class="typing-label">${label}…</span>`;
    el.classList.add('active');
}

/** Update the DM typing indicator */
function handleDMTyping(from, isTyping) {
    const el = document.getElementById('dm-typing-indicator');
    if (!el) return;

    if (dmTypingTimeout) { clearTimeout(dmTypingTimeout); dmTypingTimeout = null; }

    if (isTyping) {
        el.innerHTML = `${typingDotsHTML()} <span class="typing-label">${escapeHTML(from)} is typing…</span>`;
        el.classList.add('active');
        // Auto-clear safety net
        dmTypingTimeout = setTimeout(() => {
            el.innerHTML = ''; el.classList.remove('active');
        }, 4000);
    } else {
        el.innerHTML = ''; el.classList.remove('active');
    }
}

/** Update the stranger typing indicator */
function handleStrangerTyping(isTyping) {
    const el = document.getElementById('stranger-typing-indicator');
    if (!el) return;

    if (strangerTypingTimeout) { clearTimeout(strangerTypingTimeout); strangerTypingTimeout = null; }

    if (isTyping) {
        el.innerHTML = `${typingDotsHTML()} <span class="typing-label">Stranger is typing…</span>`;
        el.classList.add('active');
        // Auto-clear safety net
        strangerTypingTimeout = setTimeout(() => {
            el.innerHTML = ''; el.classList.remove('active');
        }, 4000);
    } else {
        el.innerHTML = ''; el.classList.remove('active');
    }
}

// ============================================================
// TYPING INDICATORS — send side (debounced)
// Each textarea fires typing_* on first keystroke and
// stop_typing_* after 2s of inactivity or on message send.
// ============================================================

let globalTypingSent = false;
let globalTypingStopTimer = null;

function onGlobalTyping() {
    if (!myNick || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!globalTypingSent) {
        globalTypingSent = true;
        wsSend({ type: 'typing_global' });
    }
    if (globalTypingStopTimer) clearTimeout(globalTypingStopTimer);
    globalTypingStopTimer = setTimeout(stopGlobalTyping, 2000);
}

function stopGlobalTyping() {
    if (!globalTypingSent) return;
    globalTypingSent = false;
    if (globalTypingStopTimer) { clearTimeout(globalTypingStopTimer); globalTypingStopTimer = null; }
    wsSend({ type: 'stop_typing_global' });
}

let dmTypingSent = false;
let dmTypingStopTimer = null;

function onDMTyping() {
    if (!myNick || !dmTarget || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!dmTypingSent) {
        dmTypingSent = true;
        wsSend({ type: 'typing_dm', targetNick: dmTarget });
    }
    if (dmTypingStopTimer) clearTimeout(dmTypingStopTimer);
    dmTypingStopTimer = setTimeout(stopDMTyping, 2000);
}

function stopDMTyping() {
    if (!dmTypingSent) return;
    dmTypingSent = false;
    if (dmTypingStopTimer) { clearTimeout(dmTypingStopTimer); dmTypingStopTimer = null; }
    if (dmTarget) wsSend({ type: 'stop_typing_dm', targetNick: dmTarget });
}

let strangerTypingSent = false;
let strangerTypingStopTimer = null;

function onStrangerTyping() {
    if (!strangerSessionId || !ws || ws.readyState !== WebSocket.OPEN) return;
    if (!strangerTypingSent) {
        strangerTypingSent = true;
        wsSend({ type: 'typing_stranger' });
    }
    if (strangerTypingStopTimer) clearTimeout(strangerTypingStopTimer);
    strangerTypingStopTimer = setTimeout(stopStrangerTyping, 2000);
}

function stopStrangerTyping() {
    if (!strangerTypingSent) return;
    strangerTypingSent = false;
    if (strangerTypingStopTimer) { clearTimeout(strangerTypingStopTimer); strangerTypingStopTimer = null; }
    wsSend({ type: 'stop_typing_stranger' });
}

// ============================================================
// GLOBAL CHAT RENDERING
// ============================================================
function renderChatMsg(data) {
    const wrap = document.getElementById('messages-wrap');
    const div = document.createElement('div');
    div.className = 'msg';
    div.id = data.id;
    div.dataset.nick = data.nickname;
    div.dataset.campus = data.campus;
    div.dataset.message = data.message;

    const time = formatTime(data.timestamp);
    const initial = data.nickname[0].toUpperCase();
    const campus = escapeHTML((data.campus || '').split(' - ')[0] || data.campus);
    const replyHTML = data.replyTo
        ? `<div class="msg-reply-preview">↩ ${escapeHTML(data.replyPreview || '…')}</div>` : '';

    div.innerHTML = `
    <div class="msg-avatar"><div class="avatar sm" style="background:${nickColor(data.nickname)}">${initial}</div></div>
    <div class="msg-body">
      <div class="msg-header">
        <span class="msg-nick" data-dm-nick="${escapeHTML(data.nickname)}">${escapeHTML(data.nickname)}</span>
        <span class="msg-campus">${campus}</span>
        <span class="msg-time">${time}</span>
      </div>
      ${replyHTML}
      <div class="msg-text">${escapeHTML(data.message)}</div>
      <div class="msg-reactions" id="react-${data.id}"></div>
    </div>
    <div class="msg-actions">
      <button class="msg-action-btn" data-reply-id="${data.id}" data-reply-nick="${escapeHTML(data.nickname)}" data-reply-msg="${escapeHTML(data.message)}" title="Reply">↩<span class="btn-label"> Reply</span></button>
      <button class="msg-action-btn" data-emoji-id="${data.id}" title="React">😊<span class="btn-label"> React</span></button>
      <button class="msg-action-btn report" data-report-id="${data.id}" data-report-nick="${escapeHTML(data.nickname)}" data-report-campus="${escapeHTML(data.campus)}" data-report-msg="${escapeHTML(data.message)}" title="Report">🚨<span class="btn-label"> Report</span></button>
    </div>`;

    wrap.appendChild(div);
    scrollToBottom();
}

function renderSystemMsg(text) {
    const wrap = document.getElementById('messages-wrap');
    const div = document.createElement('div');
    div.className = 'system-msg';
    div.textContent = text;
    wrap.appendChild(div);
    scrollToBottom();
}

function scrollToBottom() {
    const w = document.getElementById('messages-wrap');
    w.scrollTop = w.scrollHeight;
}

// ============================================================
// SEND GLOBAL CHAT
// ============================================================
function sendChat() {
    const input = document.getElementById('chat-input');
    const msg = input.value.trim();
    if (!msg) return;
    stopGlobalTyping();
    wsSend({ type: 'chat', message: msg, replyTo, replyPreview });
    input.value = '';
    input.style.height = '';
    clearReply();
}

function handleChatKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

// ============================================================
// GLOBAL REPLY
// ============================================================
function startReply(msgId, nick, text) {
    replyTo = msgId;
    replyPreview = `${nick}: ${text.slice(0, 60)}`;
    document.getElementById('reply-preview-text').textContent =
        `↩ Replying to ${nick}: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`;
    document.getElementById('reply-banner').classList.add('show');
    document.getElementById('chat-input').focus();
}

function clearReply() {
    replyTo = null; replyPreview = '';
    document.getElementById('reply-banner').classList.remove('show');
}

// ============================================================
// GLOBAL EMOJI REACTIONS
// ============================================================
function openEmojiModal(msgId) {
    pendingEmojiId = msgId;
    const grid = document.getElementById('emoji-grid');
    grid.innerHTML = '';
    EMOJIS.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn global-emoji-btn';
        btn.textContent = em;
        btn.dataset.globalEmoji = em;
        grid.appendChild(btn);
    });
    openModal('emoji-modal');
}

function sendEmoji(emoji, msgId) {
    const targetId = msgId || pendingEmojiId;
    if (!targetId) return;
    wsSend({ type: 'react', msgId: targetId, emoji });
    pendingEmojiId = null;
}

function applyReaction(data) {
    // Receives react_update: { msgId, counts: { emoji: N, ... } }
    // counts is the authoritative server-computed tally.
    const container = document.getElementById('react-' + data.msgId);
    if (!container) return;
    container.innerHTML = '';
    if (!data.counts) return;
    Object.entries(data.counts).forEach(([emoji, count]) => {
        if (count <= 0) return;
        const pill = document.createElement('div');
        pill.className = 'reaction-pill';
        pill.dataset.emoji = emoji;
        pill.textContent = `${emoji} ${count}`;
        pill.title = 'React';
        container.appendChild(pill);
    });
}

// ============================================================
// GLOBAL REPORT
// ============================================================
function openReportModal(msgId, nick, campus, message) {
    pendingReport = { msgId, nick, campus, message, source: 'Global Chat' };
    // Show the reported message as a preview
    const box = document.getElementById('report-preview-box');
    box.textContent = `${nick}: "${message.slice(0, 120)}${message.length > 120 ? '…' : ''}"`;
    // Clear previous reason
    document.getElementById('report-reason').value = '';
    openModal('report-modal');
}

function submitReport() {
    if (!pendingReport) return;
    const category = document.getElementById('report-category').value;
    const details = document.getElementById('report-reason').value.trim();
    const reason = details ? `${category} — ${details}` : category;
    wsSend({
        type: 'report',
        msgId: pendingReport.msgId,
        targetNick: pendingReport.nick,
        targetCampus: pendingReport.campus,
        message: pendingReport.message,
        reason,
        source: pendingReport.source || 'Global Chat',
    });
    closeModal('report-modal');
    document.getElementById('report-reason').value = '';
    pendingReport = null;
    toast('Report submitted to admin.', 'success');
}

// ============================================================
// ONLINE USER LIST
// ============================================================
function renderUserList(users) {
    const list = document.getElementById('online-list');
    const count = document.getElementById('online-count');
    count.textContent = users.length;
    list.innerHTML = '';
    users.forEach(u => {
        if (u.nickname === myNick) return;
        const div = document.createElement('div');
        div.className = 'online-user';
        div.dataset.dmNick = u.nickname;
        const campus = escapeHTML((u.campus || '').split(' - ')[0]);
        div.innerHTML = `
      <div class="avatar sm" style="background:${nickColor(u.nickname)}">${u.nickname[0].toUpperCase()}</div>
      <div class="online-info">
        <div class="online-name">${escapeHTML(u.nickname)}</div>
        <div class="online-campus">${campus}</div>
      </div>
      <div class="online-dot"></div>`;
        list.appendChild(div);
    });
}

// ============================================================
// ANNOUNCEMENTS
// ============================================================
function renderAnnouncement(ann, animate = true) {
    const list = document.getElementById('ann-list');
    const empty = list.querySelector('.ann-empty');
    if (empty) empty.remove();
    const card = document.createElement('div');
    card.className = 'ann-card';
    if (!animate) card.style.animation = 'none';
    card.innerHTML = `
    <div class="ann-card-time">📅 ${formatDateTime(ann.timestamp)}</div>
    <div class="ann-card-text">${escapeHTML(ann.text)}</div>
    <div style="margin-top:10px;display:flex;justify-content:flex-end">
      <button class="ann-report-btn"
        data-ann-report-id="${escapeHTML(ann.id)}"
        data-ann-report-text="${escapeHTML(ann.text)}">🚨 Report</button>
    </div>`;
    list.prepend(card);
    if (animate) toast('📣 New announcement!', 'info');
}

// ============================================================
// DIRECT MESSAGING
// ============================================================

function openDM(nick) {
    if (!nick || nick === myNick) return;
    dmTarget = nick;
    document.getElementById('dm-with-name').textContent = nick;
    document.getElementById('dm-avatar').textContent = nick[0].toUpperCase();
    const msgs = document.getElementById('dm-messages');
    msgs.innerHTML = '';
    myDMReacted.clear(); // reset per-user react tracking for new DM conversation
    clearDMReply();
    clearDMEdit();
    (dmHistory[nick] || []).forEach(m => msgs.appendChild(buildDMBubble(m)));
    msgs.scrollTop = msgs.scrollHeight;
    showPanel('dm');
    updateDMNav(nick);
    document.getElementById('dm-input').focus();
    // Auto-close sidebar on mobile
    if (window.innerWidth <= 900) closeSidebar();
}

function updateDMNav(nick) {
    const section = document.getElementById('dm-nav-section');
    section.style.display = '';
    const list = document.getElementById('dm-nav-list');
    const exists = [...list.querySelectorAll('[data-dm-nav]')].some(el => el.dataset.dmNav === nick);
    if (!exists) {
        const div = document.createElement('div');
        div.className = 'nav-item';
        div.dataset.dmNav = nick;
        div.innerHTML = `<span class="icon">💬</span> ${escapeHTML(nick)}`;
        div.addEventListener('click', () => openDM(nick));
        list.appendChild(div);
    }
}

function closeDM() {
    dmTarget = null;
    clearDMReply();
    clearDMEdit();
    showPanel('global');
}

/**
 * Build a DM bubble.
 * KEY FIX: Action buttons are rendered INLINE in document flow,
 * never absolutely-positioned. This prevents overflow-clipping
 * and the hover-leaves-target issue.
 */
function buildDMBubble(m) {
    const wrap = document.createElement('div');
    wrap.className = `dm-msg ${m.sent ? 'sent' : 'recv'}${m.deleted ? ' deleted' : ''}`;
    wrap.id = 'dm-bubble-' + m.id;
    wrap.dataset.dmId = m.id;

    const speakerNick = m.sent ? myNick : (dmTarget || '');
    const time = formatTime(m.time);
    const bubbleText = m.deleted ? '🗑 This message was deleted.' : escapeHTML(m.text);
    const editedBadge = m.edited && !m.deleted ? `<span class="dm-edited-badge">edited</span>` : '';
    const replyHTML = m.replyTo
        ? `<div class="dm-reply-preview">↩ ${escapeHTML(m.replyTo.nick)}: "${escapeHTML(m.replyTo.text.slice(0, 50))}"</div>` : '';
    const reactHTML = buildDMReactionHTML(m);

    // Build action buttons as inline DOM elements (not HTML string injection into .innerHTML)
    // This avoids any possibility of pointer-events CSS fighting with the layout.
    let actionsEl = null;
    if (!m.deleted) {
        actionsEl = document.createElement('div');
        actionsEl.className = 'dm-actions';

        // React — always shown
        const reactBtn = document.createElement('button');
        reactBtn.className = 'dm-action-btn';
        reactBtn.dataset.dmReact = m.id;
        reactBtn.title = 'React';
        reactBtn.innerHTML = '😊<span class="btn-label"> React</span>';
        actionsEl.appendChild(reactBtn);

        // Reply — always shown
        const replyBtn = document.createElement('button');
        replyBtn.className = 'dm-action-btn';
        replyBtn.dataset.dmReply = m.id;
        replyBtn.dataset.dmReplyNick = speakerNick;
        replyBtn.dataset.dmReplyText = m.text;
        replyBtn.title = 'Reply';
        replyBtn.innerHTML = '↩<span class="btn-label"> Reply</span>';
        actionsEl.appendChild(replyBtn);

        // Edit — only on sent
        if (m.sent) {
            const editBtn = document.createElement('button');
            editBtn.className = 'dm-action-btn dm-act-edit';
            editBtn.dataset.dmEdit = m.id;
            editBtn.title = 'Edit';
            editBtn.innerHTML = '✏️<span class="btn-label"> Edit</span>';
            actionsEl.appendChild(editBtn);
        }

        // Delete — only on sent
        if (m.sent) {
            const delBtn = document.createElement('button');
            delBtn.className = 'dm-action-btn dm-act-delete';
            delBtn.dataset.dmDelete = m.id;
            delBtn.title = 'Delete';
            delBtn.innerHTML = '🗑<span class="btn-label"> Delete</span>';
            actionsEl.appendChild(delBtn);
        }

        // Report — only on received
        if (!m.sent) {
            const repBtn = document.createElement('button');
            repBtn.className = 'dm-action-btn dm-act-report';
            repBtn.dataset.dmReport = m.id;
            repBtn.dataset.dmReportNick = speakerNick;
            repBtn.dataset.dmReportText = m.text;
            repBtn.title = 'Report';
            repBtn.innerHTML = '🚨<span class="btn-label"> Report</span>';
            actionsEl.appendChild(repBtn);
        }
    }

    // Build main bubble HTML
    wrap.innerHTML = `
    <div class="dm-bubble">${replyHTML}${bubbleText}</div>
    <div class="dm-reactions">${reactHTML}</div>
    <div class="dm-meta"><span>${time}</span>${editedBadge}</div>`;

    // Insert actions AFTER the meta (below the bubble)
    if (actionsEl) wrap.appendChild(actionsEl);

    return wrap;
}

function buildDMReactionHTML(m) {
    if (!m.reactions || !Object.keys(m.reactions).length) return '';
    return Object.entries(m.reactions).map(([emoji, count]) =>
        `<span class="dm-reaction-pill" data-dm-pill-id="${m.id}" data-dm-pill-emoji="${emoji}">${emoji} ${count}</span>`
    ).join('');
}

function refreshDMBubble(dmMsgId, nick) {
    const history = dmHistory[nick];
    if (!history) return;
    const entry = history.find(m => m.id === dmMsgId);
    if (!entry) return;
    const existing = document.getElementById('dm-bubble-' + dmMsgId);
    if (!existing) return;
    existing.replaceWith(buildDMBubble(entry));
}

// ── Send DM ────────────────────────────────────────────────
function sendDM() {
    const input = document.getElementById('dm-input');
    const msg = input.value.trim();
    if (!msg || !dmTarget) return;

    if (dmEditingId) {
        const entry = (dmHistory[dmTarget] || []).find(m => m.id === dmEditingId);
        if (entry) {
            entry.text = msg;
            entry.edited = true;
            refreshDMBubble(dmEditingId, dmTarget);
            wsSend({ type: 'dm_edit', targetNick: dmTarget, dmMsgId: dmEditingId, newText: msg });
        }
        input.value = ''; input.style.height = '';
        clearDMEdit();
        return;
    }

    const dmId = newDMId();
    const entry = { id: dmId, text: msg, sent: true, time: Date.now(), reactions: {}, deleted: false, edited: false, replyTo: dmReplyTo ? { id: dmReplyTo.dmMsgId, nick: dmReplyTo.nick, text: dmReplyTo.text } : null };
    if (!dmHistory[dmTarget]) dmHistory[dmTarget] = [];
    dmHistory[dmTarget].push(entry);

    const msgs = document.getElementById('dm-messages');
    msgs.appendChild(buildDMBubble(entry));
    msgs.scrollTop = msgs.scrollHeight;

    wsSend({ type: 'dm', targetNick: dmTarget, message: msg, dmMsgId: dmId, replyTo: entry.replyTo });
    stopDMTyping();
    input.value = ''; input.style.height = '';
    clearDMReply();
}

function handleDMKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendDM(); }
}

// ── DM Reply ───────────────────────────────────────────────
function startDMReply(dmMsgId, nick, text) {
    dmReplyTo = { dmMsgId, nick, text };
    clearDMEdit();
    document.getElementById('dm-reply-preview-text').textContent =
        `↩ ${nick}: "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`;
    document.getElementById('dm-reply-banner').classList.add('show');
    document.getElementById('dm-input').focus();
}

function clearDMReply() {
    dmReplyTo = null;
    const b = document.getElementById('dm-reply-banner');
    if (b) b.classList.remove('show');
}

// ── DM Edit ────────────────────────────────────────────────
function startDMEdit(dmMsgId) {
    const entry = (dmHistory[dmTarget] || []).find(m => m.id === dmMsgId);
    if (!entry || !entry.sent) return;
    clearDMReply();
    dmEditingId = dmMsgId;
    const input = document.getElementById('dm-input');
    input.value = entry.text;
    autoResize(input);
    input.focus();
    document.getElementById('dm-edit-banner').classList.add('show');
}

function clearDMEdit() {
    dmEditingId = null;
    const b = document.getElementById('dm-edit-banner');
    if (b) b.classList.remove('show');
    const input = document.getElementById('dm-input');
    if (input) { input.value = ''; input.style.height = ''; }
}

function cancelDMEdit() {
    dmEditingId = null;
    document.getElementById('dm-edit-banner').classList.remove('show');
    const input = document.getElementById('dm-input');
    input.value = ''; input.style.height = '';
}

// ── DM Delete ──────────────────────────────────────────────
function deleteDMMsg(dmMsgId) {
    const entry = (dmHistory[dmTarget] || []).find(m => m.id === dmMsgId);
    if (!entry || !entry.sent) return;
    entry.deleted = true; entry.text = '';
    refreshDMBubble(dmMsgId, dmTarget);
    wsSend({ type: 'dm_delete', targetNick: dmTarget, dmMsgId });
}

// ── DM React ───────────────────────────────────────────────
function openDMEmojiModal(dmMsgId) {
    pendingDMEmoji = dmMsgId;
    const grid = document.getElementById('dm-emoji-grid');
    grid.innerHTML = '';
    EMOJIS.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn dm-emoji-btn';
        btn.textContent = em;
        btn.dataset.dmPickEmoji = em;
        grid.appendChild(btn);
    });
    openModal('dm-emoji-modal');
}

function sendDMReaction(emoji, dmMsgId) {
    const id = dmMsgId || pendingDMEmoji;
    if (!id || !dmTarget) return;
    // BUG 2 FIX: one react per user per DM message (client-side guard).
    // DM reactions are point-to-point so the server cannot easily enforce
    // per-user dedup without shared state; we guard on the sender side.
    if (myDMReacted.has(id)) { pendingDMEmoji = null; return; }
    myDMReacted.add(id);
    applyDMReaction(dmTarget, id, emoji);
    wsSend({ type: 'dm_react', targetNick: dmTarget, dmMsgId: id, emoji });
    pendingDMEmoji = null;
}

function applyDMReaction(nick, dmMsgId, emoji) {
    const history = dmHistory[nick];
    if (!history) return;
    const entry = history.find(m => m.id === dmMsgId);
    if (!entry) return;
    if (!entry.reactions) entry.reactions = {};
    entry.reactions[emoji] = (entry.reactions[emoji] || 0) + 1;
    if (dmTarget === nick) refreshDMBubble(dmMsgId, nick);
}

// ── DM Report ──────────────────────────────────────────────
function openDMReportModal(dmMsgId, nick, text) {
    pendingDMReport = { dmMsgId, nick, text };
    const box = document.getElementById('dm-report-preview-box');
    box.textContent = `${nick}: "${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
    document.getElementById('dm-report-reason').value = '';
    openModal('dm-report-modal');
}

function submitDMReport() {
    if (!pendingDMReport) return;
    const category = document.getElementById('dm-report-category').value;
    const details = document.getElementById('dm-report-reason').value.trim();
    const reason = details ? `${category} — ${details}` : category;
    wsSend({
        type: 'dm_report',
        dmMsgId: pendingDMReport.dmMsgId,
        targetNick: pendingDMReport.nick,
        message: pendingDMReport.text,
        reason,
        source: 'Direct Message',
    });
    closeModal('dm-report-modal');
    document.getElementById('dm-report-reason').value = '';
    toast('DM reported to admin.', 'success');
    pendingDMReport = null;
}

// ── DM Receive events ──────────────────────────────────────
function receiveDM(data) {
    toast(`💬 DM from ${data.from}: "${data.message.slice(0, 40)}"`, 'info');
    if (!dmHistory[data.from]) dmHistory[data.from] = [];
    const entry = { id: data.dmMsgId || newDMId(), text: data.message, sent: false, time: data.timestamp, reactions: {}, deleted: false, edited: false, replyTo: data.replyTo || null };
    dmHistory[data.from].push(entry);
    updateDMNav(data.from);
    if (dmTarget === data.from) {
        const msgs = document.getElementById('dm-messages');
        msgs.appendChild(buildDMBubble(entry));
        msgs.scrollTop = msgs.scrollHeight;
    }
}

function receiveDMEdit(data) {
    const history = dmHistory[data.from];
    if (!history) return;
    const entry = history.find(m => m.id === data.dmMsgId);
    if (entry) { entry.text = data.newText; entry.edited = true; if (dmTarget === data.from) refreshDMBubble(data.dmMsgId, data.from); }
}

function receiveDMDelete(data) {
    const history = dmHistory[data.from];
    if (!history) return;
    const entry = history.find(m => m.id === data.dmMsgId);
    if (entry) { entry.deleted = true; entry.text = ''; if (dmTarget === data.from) refreshDMBubble(data.dmMsgId, data.from); }
}

function receiveDMReact(data) {
    applyDMReaction(data.from, data.dmMsgId, data.emoji);
}

// ============================================================
// STRANGER MATCHING
// ============================================================

function strangerFind() {
    wsSend({ type: 'stranger_find' });
}

function strangerCancel() {
    wsSend({ type: 'stranger_cancel_find' });
}

function strangerEnd() {
    wsSend({ type: 'stranger_end' });
    strangerCleanupAll();
    strangerShowLobby();
    toast('Stranger chat ended.', 'info');
}

// ── Stranger lobby / search UI ─────────────────────────────
function strangerShowLobby() {
    document.getElementById('stranger-lobby').style.display = '';
    document.getElementById('stranger-searching').style.display = 'none';
    document.getElementById('stranger-chat').style.display = 'none';
}

function strangerShowSearching() {
    document.getElementById('stranger-lobby').style.display = 'none';
    document.getElementById('stranger-searching').style.display = '';
    document.getElementById('stranger-chat').style.display = 'none';
}

function strangerShowChat() {
    document.getElementById('stranger-lobby').style.display = 'none';
    document.getElementById('stranger-searching').style.display = 'none';
    document.getElementById('stranger-chat').style.display = '';
}

// ── Server event handlers ──────────────────────────────────
function strangerOnWaiting() {
    strangerShowSearching();
}

function strangerOnCancelled() {
    strangerShowLobby();
}

function strangerOnMatched(data) {
    strangerSessionId = data.sessionId;
    strangerStartTime = Date.now();
    strangerMyHeartClicked = false;
    strangerHeartShown = false;  // reset for new match
    strangerMsgs.length = 0;
    strangerReplyTo = null;
    strangerEditingId = null;

    document.getElementById('stranger-messages').innerHTML = '';
    document.getElementById('stranger-heart-banner').style.display = 'none';
    document.getElementById('stranger-reply-banner').classList.remove('show');
    document.getElementById('stranger-edit-banner').classList.remove('show');
    document.getElementById('stranger-input').value = '';
    const heartBtn = document.getElementById('stranger-heart-btn');
    heartBtn.classList.remove('clicked');
    heartBtn.disabled = false;
    heartBtn.textContent = '❤️ Yes, Continue!';

    strangerShowChat();
    showPanel('stranger');
    document.getElementById('stranger-messages').innerHTML =
        `<div class="system-msg">🎲 You've been matched with an anonymous stranger! Say hi!</div>`;

    // Start duration timer — ticks every second to update elapsed time display
    if (strangerDurationTimer) clearInterval(strangerDurationTimer);
    strangerDurationTimer = setInterval(() => {
        const elapsed = Date.now() - strangerStartTime;
        document.getElementById('stranger-duration').textContent = formatDuration(elapsed);

        // Show heart banner ONCE after threshold — then this check never fires again
        if (!strangerHeartShown && elapsed >= HEART_THRESHOLD_MS) {
            strangerHeartShown = true;  // ← one-shot lock; duration timer ignores this branch forever
            const banner = document.getElementById('stranger-heart-banner');
            banner.style.display = 'flex';
            strangerStartHeartCountdown();
            // No need to stop the duration timer — it still updates the clock display,
            // but the !strangerHeartShown guard means the heart logic never re-fires.
        }
    }, 1000);

    toast('🎲 Matched with a stranger!', 'success');
}

function strangerStartHeartCountdown() {
    let remaining = HEART_COUNTDOWN_SEC;
    document.getElementById('heart-countdown').textContent = remaining;

    // Clear any stale interval (defensive)
    if (strangerHeartCountdown) clearInterval(strangerHeartCountdown);

    strangerHeartCountdown = setInterval(() => {
        remaining--;
        const el = document.getElementById('heart-countdown');
        if (el) el.textContent = remaining;

        if (remaining <= 0) {
            // ── Countdown finished — hide banner PERMANENTLY for this match ──
            clearInterval(strangerHeartCountdown);
            strangerHeartCountdown = null;
            // strangerHeartShown is already true → the duration timer will never re-show it
            const banner = document.getElementById('stranger-heart-banner');
            if (banner) banner.style.display = 'none';
            toast('💔 Time expired. Continue chatting as strangers.', 'info');
        }
    }, 1000);
}

function strangerOnHeartReceived() {
    toast('❤️ Your stranger clicked heart! Click yours too within the countdown!', 'info');
}

function strangerMoveToDM(data) {
    // Clean up stranger session first
    strangerCleanupAll();
    strangerShowLobby();
    toast('💕 Moving to Direct Message! Your identities are now revealed.', 'success');
    // Open DM with this person
    openDM(data.partnerNick);
}

function strangerOnEnded(data) {
    strangerCleanupAll();
    strangerShowLobby();
    const reason = data.reason === 'partner_disconnected' ? 'Your stranger disconnected.' :
        data.reason === 'partner_ended' ? 'Your stranger ended the chat.' : 'Chat ended.';
    toast(`👋 ${reason}`, 'info');
    const msgs = document.getElementById('stranger-messages');
    if (msgs) msgs.innerHTML = '';
}

function strangerCleanupAll() {
    strangerSessionId = null;
    strangerStartTime = null;
    strangerMyHeartClicked = false;
    strangerHeartShown = false;  // reset for next match
    strangerReplyTo = null;
    strangerEditingId = null;
    strangerMsgs.length = 0;
    myStrangerReacted.clear(); // reset per-user react tracking for new stranger session
    if (strangerDurationTimer) { clearInterval(strangerDurationTimer); strangerDurationTimer = null; }
    if (strangerHeartCountdown) { clearInterval(strangerHeartCountdown); strangerHeartCountdown = null; }
}

function strangerCleanupUI() {
    strangerCleanupAll();
    strangerShowLobby();
}

// ── Heart click ────────────────────────────────────────────
function strangerClickHeart() {
    if (strangerMyHeartClicked) return;
    strangerMyHeartClicked = true;
    wsSend({ type: 'stranger_heart' });
    const btn = document.getElementById('stranger-heart-btn');
    btn.textContent = '❤️ Waiting for stranger…';
    btn.classList.add('clicked');
    btn.disabled = true;
    toast('❤️ You clicked heart! Waiting for stranger…', 'info');
}

// ── Send stranger message ──────────────────────────────────
function sendStrangerMsg() {
    const input = document.getElementById('stranger-input');
    const msg = input.value.trim();
    if (!msg || !strangerSessionId) return;

    if (strangerEditingId) {
        const entry = strangerMsgs.find(m => m.id === strangerEditingId);
        if (entry) {
            entry.text = msg;
            entry.edited = true;
            refreshStrangerBubble(strangerEditingId);
            wsSend({ type: 'stranger_edit', msgId: strangerEditingId, newText: msg });
        }
        input.value = ''; input.style.height = '';
        clearStrangerEdit();
        return;
    }

    const smsgId = newSmsgId();
    const entry = { id: smsgId, text: msg, sent: true, time: Date.now(), reactions: {}, deleted: false, edited: false, replyTo: strangerReplyTo ? { ...strangerReplyTo } : null };
    strangerMsgs.push(entry);

    const msgs = document.getElementById('stranger-messages');
    msgs.appendChild(buildStrangerBubble(entry));
    msgs.scrollTop = msgs.scrollHeight;

    wsSend({ type: 'stranger_msg', message: msg, msgId: smsgId, replyTo: entry.replyTo });
    stopStrangerTyping();
    input.value = ''; input.style.height = '';
    clearStrangerReply();
}

function handleStrangerKey(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendStrangerMsg(); }
}

// ── Receive stranger messages ──────────────────────────────
function strangerReceiveMsg(data) {
    const entry = { id: data.msgId, text: data.message, sent: false, time: data.timestamp, reactions: {}, deleted: false, edited: false, replyTo: data.replyTo || null };
    strangerMsgs.push(entry);
    const msgs = document.getElementById('stranger-messages');
    msgs.appendChild(buildStrangerBubble(entry));
    msgs.scrollTop = msgs.scrollHeight;
}

function strangerOnMsgSent(data) {
    // Already rendered optimistically
}

function strangerReceiveEdit(data) {
    const entry = strangerMsgs.find(m => m.id === data.msgId);
    if (entry) { entry.text = data.newText; entry.edited = true; refreshStrangerBubble(data.msgId); }
}

function strangerReceiveDelete(data) {
    const entry = strangerMsgs.find(m => m.id === data.msgId);
    if (entry) { entry.deleted = true; entry.text = ''; refreshStrangerBubble(data.msgId); }
}

function strangerReceiveReact(data) {
    const entry = strangerMsgs.find(m => m.id === data.msgId);
    if (!entry) return;
    if (!entry.reactions) entry.reactions = {};
    entry.reactions[data.emoji] = (entry.reactions[data.emoji] || 0) + 1;
    refreshStrangerBubble(data.msgId);
}

// ── Stranger reply/edit ────────────────────────────────────
function startStrangerReply(msgId, text) {
    strangerReplyTo = { msgId, text };
    clearStrangerEdit();
    document.getElementById('stranger-reply-text').textContent =
        `↩ "${text.slice(0, 50)}${text.length > 50 ? '…' : ''}"`;
    document.getElementById('stranger-reply-banner').classList.add('show');
    document.getElementById('stranger-input').focus();
}

function clearStrangerReply() {
    strangerReplyTo = null;
    const b = document.getElementById('stranger-reply-banner');
    if (b) b.classList.remove('show');
}

function startStrangerEdit(msgId) {
    const entry = strangerMsgs.find(m => m.id === msgId);
    if (!entry || !entry.sent) return;
    clearStrangerReply();
    strangerEditingId = msgId;
    const input = document.getElementById('stranger-input');
    input.value = entry.text;
    autoResize(input);
    input.focus();
    document.getElementById('stranger-edit-banner').classList.add('show');
}

function clearStrangerEdit() {
    strangerEditingId = null;
    const b = document.getElementById('stranger-edit-banner');
    if (b) b.classList.remove('show');
    const input = document.getElementById('stranger-input');
    if (input) { input.value = ''; input.style.height = ''; }
}

function cancelStrangerEdit() {
    strangerEditingId = null;
    document.getElementById('stranger-edit-banner').classList.remove('show');
    const input = document.getElementById('stranger-input');
    input.value = ''; input.style.height = '';
}

// ── Delete stranger message ────────────────────────────────
function deleteStrangerMsg(msgId) {
    const entry = strangerMsgs.find(m => m.id === msgId);
    if (!entry || !entry.sent) return;
    entry.deleted = true; entry.text = '';
    refreshStrangerBubble(msgId);
    wsSend({ type: 'stranger_delete', msgId });
}

// ── Stranger react ─────────────────────────────────────────
function openStrangerEmojiModal(msgId) {
    pendingStrangerEmoji = msgId;
    const grid = document.getElementById('stranger-emoji-grid');
    grid.innerHTML = '';
    EMOJIS.forEach(em => {
        const btn = document.createElement('button');
        btn.className = 'emoji-btn stranger-emoji-btn';
        btn.textContent = em;
        btn.dataset.strangerPickEmoji = em;
        grid.appendChild(btn);
    });
    openModal('stranger-emoji-modal');
}

function sendStrangerReaction(emoji, msgId) {
    const id = msgId || pendingStrangerEmoji;
    if (!id || !strangerSessionId) return;
    // BUG 2 FIX: one react per user per stranger message (client-side guard).
    if (myStrangerReacted.has(id)) { pendingStrangerEmoji = null; return; }
    myStrangerReacted.add(id);
    wsSend({ type: 'stranger_react', msgId: id, emoji });
    pendingStrangerEmoji = null;
}

// ── Stranger report ────────────────────────────────────────
function openStrangerReportModal(msgId, text) {
    pendingStrangerReport = { msgId, text };
    const box = document.getElementById('stranger-report-preview-box');
    box.textContent = `"${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
    document.getElementById('stranger-report-reason').value = '';
    openModal('stranger-report-modal');
}

function submitStrangerReport() {
    if (!pendingStrangerReport) return;
    const category = document.getElementById('stranger-report-category').value;
    const details = document.getElementById('stranger-report-reason').value.trim();
    const reason = details ? `${category} — ${details}` : category;
    wsSend({
        type: 'stranger_report',
        msgId: pendingStrangerReport.msgId,
        message: pendingStrangerReport.text,
        reason,
        source: 'Anonymous Stranger Chat',
    });
    closeModal('stranger-report-modal');
    document.getElementById('stranger-report-reason').value = '';
    toast('Report submitted to admin.', 'success');
    pendingStrangerReport = null;
}

// ── Announcement report ────────────────────────────────────
let pendingAnnReport = null;

function openAnnReportModal(annId, text) {
    pendingAnnReport = { annId, text };
    const box = document.getElementById('ann-report-preview-box');
    box.textContent = `"${text.slice(0, 120)}${text.length > 120 ? '…' : ''}"`;
    document.getElementById('ann-report-reason').value = '';
    openModal('ann-report-modal');
}

function submitAnnReport() {
    if (!pendingAnnReport) return;
    const reason = document.getElementById('ann-report-reason').value.trim();
    wsSend({
        type: 'report',
        msgId: pendingAnnReport.annId,
        targetNick: 'Admin',
        targetCampus: 'All Campuses',
        message: pendingAnnReport.text,
        reason: reason || '(no reason provided)',
        source: 'Announcement',
    });
    closeModal('ann-report-modal');
    document.getElementById('ann-report-reason').value = '';
    toast('Announcement reported to admin.', 'success');
    pendingAnnReport = null;
}

// ── Build stranger message bubble ──────────────────────────
/**
 * Same fix as DM: inline always-visible action buttons.
 */
function buildStrangerBubble(m) {
    const wrap = document.createElement('div');
    wrap.className = `smsg ${m.sent ? 'sent' : 'recv'}${m.deleted ? ' deleted' : ''}`;
    wrap.id = 'smsg-bubble-' + m.id;
    wrap.dataset.smsgId = m.id;

    const time = formatTime(m.time);
    const bubbleText = m.deleted ? '🗑 Message deleted.' : escapeHTML(m.text);
    const editedBadge = m.edited && !m.deleted ? `<span class="smsg-edited-badge">edited</span>` : '';
    const replyHTML = m.replyTo
        ? `<div class="smsg-reply-preview">↩ "${escapeHTML(m.replyTo.text.slice(0, 50))}"</div>` : '';

    // Reactions
    let reactHTML = '';
    if (m.reactions && Object.keys(m.reactions).length) {
        reactHTML = Object.entries(m.reactions).map(([emoji, count]) =>
            `<span class="smsg-reaction-pill" data-spill-id="${m.id}" data-spill-emoji="${emoji}">${emoji} ${count}</span>`
        ).join('');
    }

    wrap.innerHTML = `
    <div class="smsg-bubble">${replyHTML}${bubbleText}</div>
    <div class="smsg-reactions">${reactHTML}</div>
    <div class="smsg-meta"><span>${time}</span>${editedBadge}</div>`;

    // Inline action buttons
    if (!m.deleted) {
        const actionsEl = document.createElement('div');
        actionsEl.className = 'smsg-actions';

        const reactBtn = document.createElement('button');
        reactBtn.className = 'smsg-action-btn';
        reactBtn.dataset.sReact = m.id;
        reactBtn.title = 'React';
        reactBtn.innerHTML = '😊<span class="btn-label"> React</span>';
        actionsEl.appendChild(reactBtn);

        const replyBtn = document.createElement('button');
        replyBtn.className = 'smsg-action-btn';
        replyBtn.dataset.sReply = m.id;
        replyBtn.dataset.sReplyText = m.text;
        replyBtn.title = 'Reply';
        replyBtn.innerHTML = '↩<span class="btn-label"> Reply</span>';
        actionsEl.appendChild(replyBtn);

        if (m.sent) {
            const editBtn = document.createElement('button');
            editBtn.className = 'smsg-action-btn smsg-act-edit';
            editBtn.dataset.sEdit = m.id;
            editBtn.title = 'Edit';
            editBtn.innerHTML = '✏️<span class="btn-label"> Edit</span>';
            actionsEl.appendChild(editBtn);

            const delBtn = document.createElement('button');
            delBtn.className = 'smsg-action-btn smsg-act-delete';
            delBtn.dataset.sDelete = m.id;
            delBtn.title = 'Delete';
            delBtn.innerHTML = '🗑<span class="btn-label"> Delete</span>';
            actionsEl.appendChild(delBtn);
        }

        if (!m.sent) {
            const repBtn = document.createElement('button');
            repBtn.className = 'smsg-action-btn smsg-act-report';
            repBtn.dataset.sReport = m.id;
            repBtn.dataset.sReportText = m.text;
            repBtn.title = 'Report';
            repBtn.innerHTML = '🚨<span class="btn-label"> Report</span>';
            actionsEl.appendChild(repBtn);
        }

        wrap.appendChild(actionsEl);
    }

    return wrap;
}

function refreshStrangerBubble(msgId) {
    const entry = strangerMsgs.find(m => m.id === msgId);
    if (!entry) return;
    const existing = document.getElementById('smsg-bubble-' + msgId);
    if (!existing) return;
    existing.replaceWith(buildStrangerBubble(entry));
}

// ============================================================
// SUGGESTION BOX
// ============================================================

// ============================================================
// SUGGESTION BOX — ROBUST IMPLEMENTATION
// Queue-based: suggestions are stored locally if ws isn't ready,
// then flushed automatically when the connection opens.
// Works on ALL pages regardless of connection state.
// ============================================================

/** Pending suggestions to send once WS connects */
const suggestionQueue = [];

/**
 * Flush any queued suggestions as soon as WS is open.
 * Called from connectWS() onopen handler.
 */
function flushSuggestionQueue() {
    while (suggestionQueue.length > 0) {
        const item = suggestionQueue.shift();
        wsSend({ type: 'suggestion', text: item.text, source: item.source, campus: item.campus || '' });
    }
}

/**
 * Open the universal suggestion modal from anywhere.
 * @param {string} source — which page/context opened it
 */
function openSuggestModal(source) {
    const srcEl = document.getElementById('suggest-modal-source');
    if (srcEl) srcEl.textContent = source || 'Chat';

    const campusEl = document.getElementById('suggest-modal-campus');
    if (campusEl) {
        // Auto-fill from user's campus if they're logged into chat
        campusEl.value = myCampus || '';
    }

    const input = document.getElementById('suggest-modal-input');
    if (input) {
        input.value = '';
        const counter = document.getElementById('suggest-modal-char');
        if (counter) counter.textContent = '0';
    }
    openModal('suggest-modal');
    // Focus textarea directly if campus is already set; otherwise focus campus select first
    setTimeout(() => {
        if (campusEl && !campusEl.value) campusEl.focus();
        else if (input) input.focus();
    }, 80);
}

/**
 * Submit from the universal modal.
 */
function submitSuggestModal() {
    const input = document.getElementById('suggest-modal-input');
    const text = input ? input.value.trim() : '';
    const source = document.getElementById('suggest-modal-source')?.textContent || 'Chat';
    const campusEl = document.getElementById('suggest-modal-campus');
    const campus = campusEl ? campusEl.value.trim() : '';

    if (!campus) {
        toast('Please select your campus.', 'error');
        if (campusEl) campusEl.focus();
        return;
    }
    if (!text) {
        toast('Please type your suggestion first.', 'error');
        if (input) input.focus();
        return;
    }

    // Try to send immediately; queue if ws not ready
    if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'suggestion', text, source, campus });
    } else {
        // Queue it — will be sent on next ws.onopen
        suggestionQueue.push({ text, source, campus });
        // Also try to connect if not connected yet (e.g., front page)
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            tryAnonymousConnect();
        }
        toast('💡 Suggestion queued — will send when connected!', 'info');
    }

    if (input) input.value = '';
    const counter = document.getElementById('suggest-modal-char');
    if (counter) counter.textContent = '0';
    if (campusEl) campusEl.value = '';
    closeModal('suggest-modal');

    // Also clear the main panel textarea if it exists
    const panelInput = document.getElementById('suggest-input');
    if (panelInput) panelInput.value = '';
    const panelCounter = document.getElementById('suggest-char');
    if (panelCounter) panelCounter.textContent = '0';
}

/**
 * Submit from the Suggestion Box panel (full page form).
 * Same logic — queues if not connected.
 */
function submitSuggestPanel() {
    const input = document.getElementById('suggest-input');
    const text = input ? input.value.trim() : '';
    const campusEl = document.getElementById('suggest-campus');
    const campus = campusEl ? campusEl.value.trim() : '';

    if (!campus) {
        toast('Please select your campus.', 'error');
        if (campusEl) campusEl.focus();
        return;
    }
    if (!text) {
        toast('Please type your suggestion first.', 'error');
        if (input) input.focus();
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'suggestion', text, source: 'Suggestion Box', campus });
        toast('💡 Suggestion sent! Thank you.', 'success');
    } else {
        suggestionQueue.push({ text, source: 'Suggestion Box', campus });
        toast('💡 Suggestion queued — will send when connected!', 'info');
    }

    if (input) input.value = '';
    const counter = document.getElementById('suggest-char');
    if (counter) counter.textContent = '0';
    if (campusEl) campusEl.value = '';
}

/**
 * Submit from the legacy front-page modal (kept for compat).
 * Queues if ws not connected.
 */
function submitFrontSuggest() {
    const input = document.getElementById('front-suggest-input');
    const text = input ? input.value.trim() : '';
    const campusEl = document.getElementById('front-suggest-campus');
    const campus = campusEl ? campusEl.value.trim() : '';

    if (!campus) {
        toast('Please select your campus.', 'error');
        if (campusEl) campusEl.focus();
        return;
    }
    if (!text) {
        toast('Please type your suggestion first.', 'error');
        if (input) input.focus();
        return;
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        wsSend({ type: 'suggestion', text, source: 'Front Page', campus });
    } else {
        suggestionQueue.push({ text, source: 'Front Page', campus });
        if (!ws || ws.readyState === WebSocket.CLOSED || ws.readyState === WebSocket.CLOSING) {
            tryAnonymousConnect();
        }
        toast('💡 Suggestion queued — will send when connected!', 'info');
    }

    if (input) input.value = '';
    if (campusEl) campusEl.value = '';
    closeModal('front-suggest-modal');
}

/**
 * Open an anonymous WS connection purely to drain the suggestion queue.
 * Only used when user submits from the front page before entering chat.
 */
function tryAnonymousConnect() {
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const tempWs = new WebSocket(`${proto}://${location.host}`);
    tempWs.onopen = () => {
        // Send anonymous join so server accepts the connection
        tempWs.send(JSON.stringify({ type: 'join', nickname: 'Anonymous', campus: 'Unknown' }));
        // Flush queue using this temp connection
        while (suggestionQueue.length > 0) {
            const item = suggestionQueue.shift();
            tempWs.send(JSON.stringify({ type: 'suggestion', text: item.text, source: item.source, campus: item.campus || '' }));
        }
        // Close cleanly after flushing
        setTimeout(() => tempWs.close(), 500);
        toast('💡 Suggestion sent! Thank you.', 'success');
    };
    tempWs.onerror = () => {
        toast('Could not connect. Suggestion saved for when you enter chat.', 'error');
    };
}

/**
 * Append a single suggestion card to the admin suggestions list.
 * Called both on realtime new_suggestion and on admin login.
 */
function appendSuggestion(s) {
    const list = document.getElementById('suggestions-list');
    if (!list) return;

    const placeholder = list.querySelector('.empty-state');
    if (placeholder) placeholder.remove();

    // Source icon map
    const srcIcon = s.source === 'Front Page' ? '🏠'
        : s.source === 'Stranger Matching' ? '🎲'
            : s.source === 'Suggestion Box' ? '💡'
                : s.source === 'Direct Message' ? '💬'
                    : '🌐';

    const campusHTML = s.campus
        ? `<span class="suggestion-campus">🏫 ${escapeHTML(s.campus)}</span>`
        : '';

    const card = document.createElement('div');
    card.className = 'suggestion-card';
    card.id = 'sug-' + s.id;
    card.innerHTML = `
    <div class="suggestion-meta">
      <span class="suggestion-source">${srcIcon} ${escapeHTML(s.source)}</span>
      ${campusHTML}
      <span class="suggestion-time">${formatDateTime(s.timestamp)}</span>
      <button class="suggestion-review-btn" data-sug-id="${escapeHTML(s.id)}" title="Mark as reviewed">✓ Mark Reviewed</button>
    </div>
    <div class="suggestion-text">${escapeHTML(s.text)}</div>`;

    list.prepend(card);

    // Update badge count
    const badge = document.getElementById('suggest-count-badge');
    if (badge) badge.textContent = parseInt(badge.textContent || 0) + 1;
}

/**
 * Toggle the "reviewed" visual state on a suggestion card.
 */
function markSuggestionReviewed(sugId) {
    const card = document.getElementById('sug-' + sugId);
    if (!card) return;
    const already = card.classList.toggle('reviewed');
    const btn = card.querySelector('[data-sug-id]');
    if (btn) btn.textContent = already ? '✓ Reviewed' : '✓ Mark Reviewed';
}

// ============================================================
// ADMIN LOGIN
// ============================================================

/** Dedicated WS for admin — separate from the chat ws */
let adminWs = null;
let adminSecret = '';
let adminReconnectTimer = null;
let adminConnected = false;   // true once admin_ok received on CURRENT connection
let adminPollTimer = null;    // periodic data refresh

/** Start 30-second polling to keep suggestions in sync */
function startAdminPolling() {
    stopAdminPolling();
    adminPollTimer = setInterval(() => {
        if (adminConnected) adminWsSend({ type: 'admin_get_data' });
    }, 30_000);
}

function stopAdminPolling() {
    if (adminPollTimer) { clearInterval(adminPollTimer); adminPollTimer = null; }
}

function adminLogin() {
    adminSecret = document.getElementById('admin-secret-input').value.trim();
    if (!adminSecret) return toast('Enter the admin secret.', 'error');
    connectAdminWS();
}

function connectAdminWS() {
    // Clear any pending reconnect timer
    if (adminReconnectTimer) { clearTimeout(adminReconnectTimer); adminReconnectTimer = null; }

    // Don't double-connect if already connecting or open
    if (adminWs && (adminWs.readyState === WebSocket.OPEN || adminWs.readyState === WebSocket.CONNECTING)) return;

    adminConnected = false;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    adminWs = new WebSocket(`${proto}://${location.host}`);

    adminWs.onopen = () => {
        // Register this connection with the server so it's tracked in clients map
        adminWs.send(JSON.stringify({ type: 'join', nickname: '__admin__', campus: 'Admin' }));
        // Authenticate after a brief delay to ensure join is processed first
        setTimeout(() => {
            if (adminWs && adminWs.readyState === WebSocket.OPEN) {
                adminWs.send(JSON.stringify({ type: 'admin_auth', secret: adminSecret }));
            }
        }, 150);
    };

    adminWs.onmessage = (e) => {
        // Respond to server keep-alive pings so Render proxy doesn't kill the connection
        if (e.data === '__ping__') { adminWs.send('__pong__'); return; }
        try { handleAdminMessage(JSON.parse(e.data)); } catch { }
    };

    adminWs.onclose = () => {
        adminConnected = false;
        // Reconnect if we have a secret and the admin page is still open
        // Use adminSecret (not isAdmin flag) so reconnect works even before first auth_ok
        if (adminSecret && document.getElementById('admin-page').classList.contains('active')) {
            adminReconnectTimer = setTimeout(connectAdminWS, 3000);
        }
    };

    adminWs.onerror = () => {
        if (adminWs) adminWs.close();
    };
}

/** Send a message via the dedicated admin WS */
function adminWsSend(payload) {
    if (adminWs && adminWs.readyState === WebSocket.OPEN) {
        adminWs.send(JSON.stringify(payload));
    }
}

/** Handle messages received on the admin WS */
function handleAdminMessage(data) {
    switch (data.type) {
        case 'admin_ok':
            isAdmin = true;
            adminConnected = true;
            document.getElementById('admin-login').style.display = 'none';
            document.getElementById('admin-dashboard').style.display = '';
            renderAdminData(data.reports, data.bannedIPs, data.suggestions);
            // Request fresh data immediately after auth to catch any suggestions
            // that arrived between server restart and admin login
            setTimeout(() => adminWsSend({ type: 'admin_get_data' }), 300);
            // Start polling every 30s so suggestions never silently disappear
            startAdminPolling();
            break;
        case 'admin_fail':
            toast('Invalid admin secret.', 'error');
            isAdmin = false;
            adminConnected = false;
            stopAdminPolling();
            // Clear secret so reconnect doesn't loop with wrong password
            adminSecret = '';
            break;
        case 'new_report':
            appendReport(data.report);
            break;
        case 'new_suggestion':
            appendSuggestion(data.suggestion);
            break;
        case 'admin_data':
            renderAdminData(data.reports, data.bannedIPs, data.suggestions);
            break;
        case 'ban_ok':
            toast('User banned.', 'success');
            adminWsSend({ type: 'admin_get_data' });
            break;
        case 'unban_ok':
            toast('User unbanned.', 'success');
            renderAdminData(null, data.bannedIPs);
            break;
        case 'announcement':
            // Ignore announcements on admin ws (they go to chat ws)
            break;
        default:
            // Silently ignore all other events (chat messages, etc.)
            break;
    }
}

/** Redirect all admin wsSend calls to adminWsSend */
function adminSend(payload) { adminWsSend(payload); }

// ============================================================
// ADMIN DATA RENDERING
// ============================================================
function renderAdminData(reports, bannedIPs, suggestions) {
    if (reports != null) {
        const list = document.getElementById('reports-list');
        list.innerHTML = '';
        document.getElementById('report-count-badge').textContent = reports.length;
        if (!reports.length) { list.innerHTML = '<div class="empty-state">No reports yet.</div>'; }
        else { reports.forEach(r => appendReport(r)); }
    }
    if (bannedIPs != null) {
        const list = document.getElementById('bans-list');
        list.innerHTML = '';
        if (!bannedIPs.length) { list.innerHTML = '<div class="empty-state">No active bans.</div>'; }
        else { bannedIPs.forEach(([ip, info]) => appendBanRow(ip, info)); }
    }
    if (suggestions != null) {
        const list = document.getElementById('suggestions-list');
        if (list) {
            list.innerHTML = '';
            const badge = document.getElementById('suggest-count-badge');
            if (badge) badge.textContent = 0;
            if (!suggestions.length) { list.innerHTML = '<div class="empty-state">No suggestions yet.</div>'; }
            else { suggestions.forEach(s => appendSuggestion(s)); }
        }
    }
}

function appendReport(r) {
    const list = document.getElementById('reports-list');
    const placeholder = list.querySelector('.empty-state');
    if (placeholder) placeholder.remove();

    const card = document.createElement('div');
    card.className = 'report-card';
    const time = formatDateTime(r.timestamp);

    // Source tag — shows where the report came from
    const sourceLabel = r.source || (r.isStranger ? 'Anonymous Stranger Chat' : r.isDM ? 'Direct Message' : 'Global Chat');
    const sourceIcon = r.source === 'Announcement' ? '📣'
        : r.isStranger || r.source === 'Anonymous Stranger Chat' ? '🎲'
            : r.isDM || r.source === 'Direct Message' ? '💬' : '🌐';
    const sourceTag = `<span class="report-tag tag-type">${sourceIcon} ${escapeHTML(sourceLabel)}</span>`;

    card.innerHTML = `
    <div class="report-meta">
      <span class="report-tag tag-nick">👤 ${escapeHTML(r.targetNick)}</span>
      <span class="report-tag tag-campus">🏫 ${escapeHTML(r.targetCampus || 'Direct Message')}</span>
      ${sourceTag}
      <span style="font-size:0.72rem;color:var(--text3);margin-left:auto">${time}</span>
    </div>
    <div class="ip-block">
      <div class="ip-entry">
        <span class="ip-label">🚫 Reported User IP</span>
        <span class="ip-value">${escapeHTML(r.ip || 'unknown')}</span>
      </div>
      <div class="ip-entry">
        <span class="ip-label">📨 Reporter IP</span>
        <span class="ip-value" style="color:var(--text2)">${escapeHTML(r.reporterIP || 'unknown')}</span>
      </div>
    </div>
    <div class="report-message">"${escapeHTML(r.message || '')}"</div>
    <div class="report-reason-block">
      <span class="report-reason-label">📝 Reason:</span>
      <span class="report-reason-text">${escapeHTML(r.reason || '(no reason provided)')}</span>
    </div>
    <div style="font-size:0.78rem;color:var(--text2);margin:6px 0 12px"><strong>Reported by:</strong> ${escapeHTML(r.reporterNick || 'Anonymous')}</div>
    <div class="report-actions">
      <button class="btn btn-danger btn-xs" data-ban-ip="${escapeHTML(r.ip || '')}" data-ban-nick="${escapeHTML(r.targetNick)}">🚫 Ban User</button>
    </div>`;

    list.appendChild(card);
    const badge = document.getElementById('report-count-badge');
    badge.textContent = parseInt(badge.textContent || 0) + 1;
}

function appendBanRow(ip, info) {
    const list = document.getElementById('bans-list');
    const type = info.permanent ? '🔴 Permanent' : `⏱ Temporary (expires ${formatDateTime(info.expiry)})`;
    const row = document.createElement('div');
    row.className = 'ban-row';
    row.innerHTML = `
    <div>
      <div class="ban-ip">${escapeHTML(ip)}</div>
      <div class="ban-type">${type} · ${escapeHTML(info.nickname || '')}</div>
    </div>
    <button class="btn btn-ghost btn-xs" data-unban-ip="${escapeHTML(ip)}">Unban</button>`;
    list.appendChild(row);
}

function openBanModal(ip, nick) {
    document.getElementById('ban-modal-ip').value = ip;
    document.getElementById('ban-modal-nick').value = nick;
    document.getElementById('ban-modal-sub').textContent = `Ban ${nick} (${ip})`;
    openModal('ban-modal');
}

function executeBan() {
    const ip = document.getElementById('ban-modal-ip').value;
    const nick = document.getElementById('ban-modal-nick').value;
    const sel = document.getElementById('ban-type-select').value;
    const permanent = sel === 'permanent';
    const duration = permanent ? 0 : (BAN_DURATIONS[sel] || 3_600_000);
    adminWsSend({ type: 'admin_ban', ip, nickname: nick, permanent, duration });
    closeModal('ban-modal');
}

function unbanIP(ip) { adminWsSend({ type: 'admin_unban', ip }); }

function postAnnouncement() {
    const text = document.getElementById('ann-input').value.trim();
    if (!text) return;
    adminWsSend({ type: 'admin_announce', text });
    document.getElementById('ann-input').value = '';
    toast('Announcement posted!', 'success');
}

// ============================================================
// EVENT DELEGATION — clicks
// Single listener on document. Uses closest() so clicking
// child elements of buttons still works correctly.
// ============================================================
document.addEventListener('click', (e) => {
    const t = e.target;
    const closest = (sel) => t.closest(sel);

    // ── Mobile sidebar ──
    if (t.id === 'hamburger-btn') return openSidebar();
    if (t.id === 'sidebar-close-btn') return closeSidebar();
    if (t.id === 'sidebar-overlay') return closeSidebar();
    if (closest('#sidebar-overlay')) return closeSidebar();
    if (closest('#mobile-theme-toggle')) return toggleTheme();

    // ── Theme ──
    if (closest('#theme-toggle') || closest('#chat-theme-toggle')) return toggleTheme();

    // ── Front page ──
    if (t.id === 'enter-chat-btn') return enterChat();
    if (t.id === 'go-admin-btn') return showPage('admin');

    // ── Chat page ──
    if (t.id === 'leave-chat-btn') return leaveChat();
    if (t.id === 'scroll-bottom-btn') return scrollToBottom();
    if (t.id === 'send-chat-btn') return sendChat();
    if (t.id === 'reply-close-btn') return clearReply();
    if (t.id === 'send-dm-btn') return sendDM();
    if (t.id === 'close-dm-btn') return closeDM();
    if (t.id === 'dm-reply-close-btn') return clearDMReply();
    if (t.id === 'dm-edit-cancel-btn') return cancelDMEdit();

    // ── Suggestion Box — ALL ENTRY POINTS ──
    // Inline suggest buttons in each input row
    if (t.id === 'suggest-fab-btn') return openSuggestModal('Chat');
    if (t.id === 'suggest-fab-dm-btn') return openSuggestModal('Direct Message');
    if (t.id === 'suggest-fab-stranger-btn') return openSuggestModal('Stranger Matching');
    // Universal modal submit
    if (t.id === 'submit-suggest-modal-btn') return submitSuggestModal();
    // Panel submit button (full-page suggestion panel)
    if (t.id === 'submit-suggest-btn') return submitSuggestPanel();
    // Front page button → open universal modal with Front Page source
    if (t.id === 'front-suggest-btn') return openSuggestModal('Front Page');
    // Legacy front page modal submit
    if (t.id === 'submit-front-suggest-btn') return submitFrontSuggest();
    // Stranger lobby button → open universal modal
    if (t.id === 'stranger-lobby-suggest-btn') return openSuggestModal('Stranger Matching');

    // Mark suggestion reviewed (admin dashboard)
    const sugReviewBtn = closest('[data-sug-id]');
    if (sugReviewBtn) return markSuggestionReviewed(sugReviewBtn.dataset.sugId);

    // ── Stranger controls ──
    if (t.id === 'stranger-find-btn') return strangerFind();
    if (t.id === 'stranger-cancel-btn') return strangerCancel();
    if (t.id === 'stranger-end-btn') return strangerEnd();
    if (t.id === 'stranger-heart-btn') return strangerClickHeart();
    if (t.id === 'send-stranger-btn') return sendStrangerMsg();
    if (t.id === 'stranger-reply-close-btn') return clearStrangerReply();
    if (t.id === 'stranger-edit-cancel-btn') return cancelStrangerEdit();

    // ── Sidebar nav ──
    const navItem = closest('.nav-item[data-panel]');
    if (navItem) return showPanel(navItem.dataset.panel);

    const msgNick = closest('.msg-nick[data-dm-nick]');
    if (msgNick) return openDM(msgNick.dataset.dmNick);

    const onlineUser = closest('.online-user[data-dm-nick]');
    if (onlineUser) return openDM(onlineUser.dataset.dmNick);

    const dmNavItem = closest('[data-dm-nav]');
    if (dmNavItem) return openDM(dmNavItem.dataset.dmNav);

    // ── Announcement report button ──
    const annReportBtn = closest('[data-ann-report-id]');
    if (annReportBtn) return openAnnReportModal(annReportBtn.dataset.annReportId, annReportBtn.dataset.annReportText);

    // ── Global chat actions ──
    const replyBtn = closest('[data-reply-id]');
    if (replyBtn) return startReply(replyBtn.dataset.replyId, replyBtn.dataset.replyNick, replyBtn.dataset.replyMsg);

    const emojiBtn = closest('[data-emoji-id]');
    if (emojiBtn) return openEmojiModal(emojiBtn.dataset.emojiId);

    const reportBtn = closest('[data-report-id]');
    if (reportBtn) return openReportModal(reportBtn.dataset.reportId, reportBtn.dataset.reportNick, reportBtn.dataset.reportCampus, reportBtn.dataset.reportMsg);

    const reactionPill = closest('.reaction-pill[data-emoji]');
    if (reactionPill) { const msgEl = reactionPill.closest('.msg'); if (msgEl) sendEmoji(reactionPill.dataset.emoji, msgEl.id); return; }

    // ── DM actions ──
    const dmReactBtn = closest('[data-dm-react]');
    if (dmReactBtn) return openDMEmojiModal(dmReactBtn.dataset.dmReact);

    const dmReplyBtn = closest('[data-dm-reply]');
    if (dmReplyBtn) return startDMReply(dmReplyBtn.dataset.dmReply, dmReplyBtn.dataset.dmReplyNick, dmReplyBtn.dataset.dmReplyText);

    const dmEditBtn = closest('[data-dm-edit]');
    if (dmEditBtn) return startDMEdit(dmEditBtn.dataset.dmEdit);

    const dmDeleteBtn = closest('[data-dm-delete]');
    if (dmDeleteBtn) { if (confirm('Delete this message?')) deleteDMMsg(dmDeleteBtn.dataset.dmDelete); return; }

    const dmReportBtn = closest('[data-dm-report]');
    if (dmReportBtn) return openDMReportModal(dmReportBtn.dataset.dmReport, dmReportBtn.dataset.dmReportNick, dmReportBtn.dataset.dmReportText);

    const dmPill = closest('.dm-reaction-pill[data-dm-pill-id]');
    if (dmPill) { sendDMReaction(dmPill.dataset.dmPillEmoji, dmPill.dataset.dmPillId); return; }

    // ── Stranger actions ──
    const sReactBtn = closest('[data-s-react]');
    if (sReactBtn) return openStrangerEmojiModal(sReactBtn.dataset.sReact);

    const sReplyBtn = closest('[data-s-reply]');
    if (sReplyBtn) return startStrangerReply(sReplyBtn.dataset.sReply, sReplyBtn.dataset.sReplyText);

    const sEditBtn = closest('[data-s-edit]');
    if (sEditBtn) return startStrangerEdit(sEditBtn.dataset.sEdit);

    const sDeleteBtn = closest('[data-s-delete]');
    if (sDeleteBtn) { if (confirm('Delete this message?')) deleteStrangerMsg(sDeleteBtn.dataset.sDelete); return; }

    const sReportBtn = closest('[data-s-report]');
    if (sReportBtn) return openStrangerReportModal(sReportBtn.dataset.sReport, sReportBtn.dataset.sReportText);

    const sPill = closest('.smsg-reaction-pill[data-spill-id]');
    if (sPill) { sendStrangerReaction(sPill.dataset.spillEmoji, sPill.dataset.spillId); return; }

    // ── Emoji modals — check specific BEFORE generic ──
    const strangerEmoji = closest('.stranger-emoji-btn[data-stranger-pick-emoji]');
    if (strangerEmoji) { sendStrangerReaction(strangerEmoji.dataset.strangerPickEmoji); closeModal('stranger-emoji-modal'); return; }

    const dmEmoji = closest('.dm-emoji-btn[data-dm-pick-emoji]');
    if (dmEmoji) { sendDMReaction(dmEmoji.dataset.dmPickEmoji); closeModal('dm-emoji-modal'); return; }

    const globalEmoji = closest('.global-emoji-btn[data-global-emoji]');
    if (globalEmoji) { sendEmoji(globalEmoji.dataset.globalEmoji); closeModal('emoji-modal'); return; }

    // ── Report modals ──
    if (t.id === 'submit-report-btn') return submitReport();
    if (t.id === 'submit-dm-report-btn') return submitDMReport();
    if (t.id === 'submit-stranger-report-btn') return submitStrangerReport();
    if (t.id === 'submit-ann-report-btn') return submitAnnReport();

    // ── Ban modal ──
    const banBtn = closest('[data-ban-ip]');
    if (banBtn) return openBanModal(banBtn.dataset.banIp, banBtn.dataset.banNick);
    if (t.id === 'execute-ban-btn') return executeBan();

    const unbanBtn = closest('[data-unban-ip]');
    if (unbanBtn) return unbanIP(unbanBtn.dataset.unbanIp);

    // ── Admin page ──
    if (t.id === 'admin-login-btn') return adminLogin();
    if (t.id === 'admin-back-btn') return showPage('front');
    if (t.id === 'admin-exit-btn') return showPage('front');
    if (t.id === 'post-ann-btn') return postAnnouncement();
    if (t.id === 'refresh-suggestions-btn') {
        adminWsSend({ type: 'admin_get_data' });
        toast('Refreshing suggestions…', 'info');
        return;
    }

    // ── Generic modal close ──
    const closeModalBtn = closest('[data-close-modal]');
    if (closeModalBtn) return closeModal(closeModalBtn.dataset.closeModal);

    if (t.classList.contains('modal-overlay')) return closeModal(t.id);
});

// ============================================================
// EVENT DELEGATION — keyboard
// ============================================================
document.addEventListener('keydown', (e) => {
    if (e.target.id === 'chat-input') return handleChatKey(e);
    if (e.target.id === 'dm-input') return handleDMKey(e);
    if (e.target.id === 'stranger-input') return handleStrangerKey(e);
    if (e.target.id === 'admin-secret-input' && e.key === 'Enter') return adminLogin();
    if (e.target.id === 'ann-input' && e.key === 'Enter') return postAnnouncement();
    // Ctrl+Enter or Cmd+Enter to submit suggestion from modal
    if ((e.target.id === 'suggest-modal-input' || e.target.id === 'suggest-input' || e.target.id === 'front-suggest-input') && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        if (e.target.id === 'suggest-modal-input') return submitSuggestModal();
        if (e.target.id === 'suggest-input') return submitSuggestPanel();
        if (e.target.id === 'front-suggest-input') return submitFrontSuggest();
    }
});

// ============================================================
// EVENT DELEGATION — textarea auto-resize
// ============================================================
document.addEventListener('input', (e) => {
    if (e.target.classList.contains('chat-textarea')) autoResize(e.target);

    // ── Typing indicator events ───────────────────────────────
    if (e.target.id === 'chat-input') onGlobalTyping();
    if (e.target.id === 'dm-input') onDMTyping();
    if (e.target.id === 'stranger-input') onStrangerTyping();

    // Suggestion char counters
    if (e.target.id === 'suggest-input') {
        const counter = document.getElementById('suggest-char');
        if (counter) counter.textContent = e.target.value.length;
    }
    if (e.target.id === 'suggest-modal-input') {
        const counter = document.getElementById('suggest-modal-char');
        if (counter) counter.textContent = e.target.value.length;
    }
    if (e.target.id === 'front-suggest-input') {
        const counter = document.getElementById('front-suggest-char');
        if (counter) counter.textContent = e.target.value.length;
    }
});