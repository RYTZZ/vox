/* ============================================================
   SorSU TikTalk — server.js
   Includes: global chat, DM, announcements, admin, stranger matching
   ============================================================ */
'use strict';

const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'kazee@SorSU_2026';

// ── In-memory state ───────────────────────────────────────────
const clients = new Map(); // ws -> { nickname, campus, ip, id, isAdmin }
const bannedIPs = new Map(); // ip -> { expiry, permanent, nickname }
const reports = [];
const announcements = [];
const msgLog = new Map(); // global msgId -> { nickname, campus, ip, message }
const dmMsgLog = new Map(); // dmMsgId -> { senderNick, senderIP, message }

// Stranger matching
const matchQueue = [];        // list of ws waiting for a match
const strangerSessions = new Map(); // sessionId -> { ws1, ws2, startTime }
const clientSession = new Map(); // ws -> sessionId
const heartClicks = new Map(); // sessionId -> Set of ws that clicked heart

let msgIdCounter = 0;
let reportIdCounter = 0;
let annIdCounter = 0;

// ── Static file server ────────────────────────────────────────
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript' };

const server = http.createServer((req, res) => {
    const safePath = req.url.replace(/\.\./g, '').split('?')[0];
    const filePath = path.join(__dirname, 'public', safePath === '/' ? 'index.html' : safePath);
    const ext = path.extname(filePath) || '.html';

    fs.readFile(filePath, (err, data) => {
        if (err) {
            fs.readFile(path.join(__dirname, 'public', 'index.html'), (_e, d) => {
                res.writeHead(200, { 'Content-Type': 'text/html' });
                res.end(d);
            });
        } else {
            res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
            res.end(data);
        }
    });
});

// ── WebSocket server ──────────────────────────────────────────
const wss = new WebSocket.Server({ server });

function getIP(req) {
    return (req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown')
        .split(',')[0].trim();
}

function isIPBanned(ip) {
    const ban = bannedIPs.get(ip);
    if (!ban) return false;
    if (ban.permanent) return true;
    if (Date.now() < ban.expiry) return true;
    bannedIPs.delete(ip);
    return false;
}

function send(ws, data) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

function broadcast(data, excludeWs = null) {
    const msg = JSON.stringify(data);
    wss.clients.forEach(c => {
        if (c.readyState === WebSocket.OPEN && c !== excludeWs) c.send(msg);
    });
}

function broadcastUserList() {
    const users = [];
    clients.forEach(info => {
        if (info.nickname) users.push({ nickname: info.nickname, campus: info.campus, id: info.id });
    });
    broadcast({ type: 'user_list', users });
}

function notifyAdmins(data) {
    wss.clients.forEach(c => {
        const ci = clients.get(c);
        if (ci && ci.isAdmin) send(c, data);
    });
}

function findWsByNick(nick) {
    let found = null;
    wss.clients.forEach(c => {
        const ci = clients.get(c);
        if (ci && ci.nickname === nick) found = c;
    });
    return found;
}

// ── Stranger matching helpers ─────────────────────────────────

function removeFromQueue(ws) {
    const idx = matchQueue.indexOf(ws);
    if (idx !== -1) matchQueue.splice(idx, 1);
}

function createStrangerSession(ws1, ws2) {
    const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    strangerSessions.set(sessionId, { ws1, ws2, startTime: Date.now() });
    clientSession.set(ws1, sessionId);
    clientSession.set(ws2, sessionId);
    heartClicks.set(sessionId, new Set());

    send(ws1, { type: 'stranger_matched', sessionId, role: 'A' });
    send(ws2, { type: 'stranger_matched', sessionId, role: 'B' });
    return sessionId;
}

function endStrangerSession(sessionId, reason = 'ended') {
    const session = strangerSessions.get(sessionId);
    if (!session) return;

    const { ws1, ws2 } = session;
    [ws1, ws2].forEach(ws => {
        send(ws, { type: 'stranger_ended', reason });
        clientSession.delete(ws);
    });

    strangerSessions.delete(sessionId);
    heartClicks.delete(sessionId);
}

function getPartner(ws) {
    const sessionId = clientSession.get(ws);
    if (!sessionId) return null;
    const session = strangerSessions.get(sessionId);
    if (!session) return null;
    return session.ws1 === ws ? session.ws2 : session.ws1;
}

// ── Connection handler ────────────────────────────────────────
wss.on('connection', (ws, req) => {
    const ip = getIP(req);

    if (isIPBanned(ip)) {
        send(ws, { type: 'banned', message: 'You are banned from SorSU TikTalk.' });
        ws.close();
        return;
    }

    const clientId = `u_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    clients.set(ws, { nickname: null, campus: null, ip, id: clientId, isAdmin: false });

    ws.on('message', raw => {
        let data;
        try { data = JSON.parse(raw); } catch { return; }

        const ci = clients.get(ws);
        if (!ci) return;

        if (data.type !== 'join' && isIPBanned(ci.ip)) {
            send(ws, { type: 'banned', message: 'You have been banned from SorSU TikTalk.' });
            ws.close();
            return;
        }

        switch (data.type) {

            // ── Join ─────────────────────────────────────────────────
            case 'join': {
                if (isIPBanned(ip)) { send(ws, { type: 'banned', message: 'You are banned.' }); ws.close(); return; }
                ci.nickname = String(data.nickname || 'Anonymous').slice(0, 30).trim() || 'Anonymous';
                ci.campus = String(data.campus || 'Unknown').slice(0, 60);
                send(ws, { type: 'joined', id: clientId, announcements });
                broadcast({ type: 'system', message: `${ci.nickname} joined the chat.`, timestamp: Date.now() });
                broadcastUserList();
                break;
            }

            // ── Global chat ──────────────────────────────────────────
            case 'chat': {
                if (!ci.nickname) return;
                const msgId = `m_${++msgIdCounter}`;
                const msgText = String(data.message || '').slice(0, 500);
                msgLog.set(msgId, { nickname: ci.nickname, campus: ci.campus, ip: ci.ip, message: msgText });
                if (msgLog.size > 1000) msgLog.delete(msgLog.keys().next().value);
                broadcast({
                    type: 'chat', id: msgId, nickname: ci.nickname, campus: ci.campus,
                    message: msgText, timestamp: Date.now(),
                    replyTo: data.replyTo || null, replyPreview: data.replyPreview || null,
                });
                break;
            }

            // ── Global reaction ──────────────────────────────────────
            case 'react': {
                if (!ci.nickname) return;
                const emoji = String(data.emoji || '').slice(0, 10);
                const msgId = String(data.msgId || '');
                if (!emoji || !msgId) return;
                broadcast({ type: 'react', msgId, emoji, userId: clientId });
                break;
            }

            // ── Global report ────────────────────────────────────────
            case 'report': {
                if (!ci.nickname) return;
                const logEntry = msgLog.get(String(data.msgId || ''));
                const rpt = {
                    id: `r_${++reportIdCounter}`,
                    reporterNick: ci.nickname, reporterIP: ci.ip,
                    targetNick: String(data.targetNick || '').slice(0, 30),
                    targetCampus: String(data.targetCampus || '').slice(0, 60),
                    message: String(data.message || '').slice(0, 500),
                    reason: String(data.reason || '(no reason provided)').slice(0, 500),
                    source: String(data.source || 'Global Chat').slice(0, 50),
                    ip: logEntry ? logEntry.ip : 'unknown',
                    timestamp: Date.now(),
                };
                reports.push(rpt);
                send(ws, { type: 'report_ack' });
                notifyAdmins({ type: 'new_report', report: rpt });
                break;
            }

            // ── Direct Message ───────────────────────────────────────
            case 'dm': {
                if (!ci.nickname) return;
                const targetWs = findWsByNick(data.targetNick);
                const dmText = String(data.message || '').slice(0, 500);
                const dmMsgId = String(data.dmMsgId || `sv_${Date.now()}`);
                dmMsgLog.set(dmMsgId, { senderNick: ci.nickname, senderIP: ci.ip, message: dmText });
                if (dmMsgLog.size > 2000) dmMsgLog.delete(dmMsgLog.keys().next().value);
                if (targetWs) {
                    send(targetWs, { type: 'dm', from: ci.nickname, fromCampus: ci.campus, message: dmText, dmMsgId, replyTo: data.replyTo || null, timestamp: Date.now() });
                    send(ws, { type: 'dm_sent', to: data.targetNick, dmMsgId, timestamp: Date.now() });
                } else {
                    send(ws, { type: 'error', message: 'User not found or offline.' });
                }
                break;
            }

            case 'dm_edit': {
                if (!ci.nickname) return;
                const tw = findWsByNick(data.targetNick);
                if (tw) send(tw, { type: 'dm_edit', from: ci.nickname, dmMsgId: String(data.dmMsgId || ''), newText: String(data.newText || '').slice(0, 500) });
                break;
            }

            case 'dm_delete': {
                if (!ci.nickname) return;
                const tw = findWsByNick(data.targetNick);
                if (tw) send(tw, { type: 'dm_delete', from: ci.nickname, dmMsgId: String(data.dmMsgId || '') });
                break;
            }

            case 'dm_react': {
                if (!ci.nickname) return;
                const tw = findWsByNick(data.targetNick);
                if (tw) send(tw, { type: 'dm_react', from: ci.nickname, dmMsgId: String(data.dmMsgId || ''), emoji: String(data.emoji || '').slice(0, 10) });
                break;
            }

            case 'dm_report': {
                if (!ci.nickname) return;
                const dmEntry = dmMsgLog.get(String(data.dmMsgId || ''));
                const rpt = {
                    id: `r_${++reportIdCounter}`, isDM: true,
                    reporterNick: ci.nickname, reporterIP: ci.ip,
                    targetNick: String(data.targetNick || '').slice(0, 30),
                    targetCampus: 'Direct Message',
                    message: String(data.message || '').slice(0, 500),
                    reason: String(data.reason || '(no reason provided)').slice(0, 500),
                    source: String(data.source || 'Direct Message').slice(0, 50),
                    ip: dmEntry ? dmEntry.senderIP : 'unknown',
                    timestamp: Date.now(),
                };
                reports.push(rpt);
                send(ws, { type: 'report_ack' });
                notifyAdmins({ type: 'new_report', report: rpt });
                break;
            }

            // ── Stranger Matching ────────────────────────────────────

            case 'stranger_find': {
                if (!ci.nickname) return;
                // Already in a session — ignore
                if (clientSession.has(ws)) return;
                // Already in queue — ignore
                if (matchQueue.includes(ws)) return;

                if (matchQueue.length > 0) {
                    const partner = matchQueue.shift();
                    // Make sure partner is still connected
                    if (partner.readyState !== WebSocket.OPEN) {
                        matchQueue.length = 0; // flush stale
                        matchQueue.push(ws);
                    } else {
                        createStrangerSession(ws, partner);
                    }
                } else {
                    matchQueue.push(ws);
                    send(ws, { type: 'stranger_waiting' });
                }
                break;
            }

            case 'stranger_cancel_find': {
                removeFromQueue(ws);
                send(ws, { type: 'stranger_cancelled' });
                break;
            }

            case 'stranger_msg': {
                if (!ci.nickname) return;
                const partner = getPartner(ws);
                if (!partner) return;
                const smsgId = `sm_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
                const smsgText = String(data.message || '').slice(0, 500);
                // Log for report lookups
                dmMsgLog.set(smsgId, { senderNick: ci.nickname, senderIP: ci.ip, message: smsgText });
                if (dmMsgLog.size > 2000) dmMsgLog.delete(dmMsgLog.keys().next().value);
                send(partner, {
                    type: 'stranger_msg', msgId: smsgId, message: smsgText,
                    timestamp: Date.now(), replyTo: data.replyTo || null,
                });
                send(ws, { type: 'stranger_msg_sent', msgId: smsgId, message: smsgText, timestamp: Date.now(), replyTo: data.replyTo || null });
                break;
            }

            case 'stranger_edit': {
                if (!ci.nickname) return;
                const partner = getPartner(ws);
                if (partner) send(partner, { type: 'stranger_edit', msgId: String(data.msgId || ''), newText: String(data.newText || '').slice(0, 500) });
                break;
            }

            case 'stranger_delete': {
                if (!ci.nickname) return;
                const partner = getPartner(ws);
                if (partner) send(partner, { type: 'stranger_delete', msgId: String(data.msgId || '') });
                break;
            }

            case 'stranger_react': {
                if (!ci.nickname) return;
                const partner = getPartner(ws);
                if (partner) send(partner, { type: 'stranger_react', msgId: String(data.msgId || ''), emoji: String(data.emoji || '').slice(0, 10) });
                // Also echo back to sender so both see it
                send(ws, { type: 'stranger_react', msgId: String(data.msgId || ''), emoji: String(data.emoji || '').slice(0, 10) });
                break;
            }

            case 'stranger_report': {
                if (!ci.nickname) return;
                const smsgId = String(data.msgId || '');
                const smEntry = dmMsgLog.get(smsgId);
                const rpt = {
                    id: `r_${++reportIdCounter}`, isStranger: true,
                    reporterNick: ci.nickname, reporterIP: ci.ip,
                    targetNick: 'Anonymous Stranger',
                    targetCampus: 'Stranger Chat',
                    message: String(data.message || '').slice(0, 500),
                    reason: String(data.reason || '(no reason provided)').slice(0, 500),
                    source: String(data.source || 'Anonymous Stranger Chat').slice(0, 50),
                    ip: smEntry ? smEntry.senderIP : 'unknown',
                    timestamp: Date.now(),
                };
                reports.push(rpt);
                send(ws, { type: 'report_ack' });
                notifyAdmins({ type: 'new_report', report: rpt });
                break;
            }

            case 'stranger_end': {
                const sessionId = clientSession.get(ws);
                if (sessionId) endStrangerSession(sessionId, 'partner_ended');
                else { removeFromQueue(ws); send(ws, { type: 'stranger_cancelled' }); }
                break;
            }

            // Heart button — mutual consent to move to DM
            case 'stranger_heart': {
                const sessionId = clientSession.get(ws);
                if (!sessionId) return;
                const session = strangerSessions.get(sessionId);
                if (!session) return;

                const clicks = heartClicks.get(sessionId);
                clicks.add(ws);

                // Notify partner that this user clicked heart
                const partner = getPartner(ws);
                if (partner) send(partner, { type: 'stranger_heart_received' });

                // If both clicked — move to DM
                if (clicks.size >= 2) {
                    const { ws1, ws2 } = session;
                    const ci1 = clients.get(ws1);
                    const ci2 = clients.get(ws2);
                    if (ci1 && ci2) {
                        // Clean up stranger session
                        clientSession.delete(ws1);
                        clientSession.delete(ws2);
                        strangerSessions.delete(sessionId);
                        heartClicks.delete(sessionId);
                        // Redirect both to DM with each other
                        send(ws1, { type: 'stranger_move_to_dm', partnerNick: ci2.nickname });
                        send(ws2, { type: 'stranger_move_to_dm', partnerNick: ci1.nickname });
                    }
                }
                break;
            }

            // ── Admin ────────────────────────────────────────────────
            case 'admin_auth': {
                if (data.secret === ADMIN_SECRET) {
                    ci.isAdmin = true;
                    send(ws, { type: 'admin_ok', reports, bannedIPs: Array.from(bannedIPs.entries()) });
                } else {
                    send(ws, { type: 'admin_fail' });
                }
                break;
            }

            case 'admin_ban': {
                if (!ci.isAdmin) return;
                const banIP = String(data.ip || '');
                if (!banIP) return;
                const permanent = !!data.permanent;
                const duration = parseInt(data.duration) || 3_600_000;
                bannedIPs.set(banIP, { permanent, expiry: permanent ? Infinity : Date.now() + duration, nickname: String(data.nickname || '') });
                wss.clients.forEach(c => {
                    const cic = clients.get(c);
                    if (cic && cic.ip === banIP) { send(c, { type: 'banned', message: 'You have been banned by an administrator.' }); c.close(); }
                });
                send(ws, { type: 'ban_ok', ip: banIP });
                break;
            }

            case 'admin_unban': {
                if (!ci.isAdmin) return;
                bannedIPs.delete(String(data.ip || ''));
                send(ws, { type: 'unban_ok', ip: data.ip, bannedIPs: Array.from(bannedIPs.entries()) });
                break;
            }

            case 'admin_announce': {
                if (!ci.isAdmin) return;
                const annText = String(data.text || '').slice(0, 1000).trim();
                if (!annText) return;
                const ann = { id: `a_${++annIdCounter}`, text: annText, timestamp: Date.now() };
                announcements.push(ann);
                broadcast({ type: 'announcement', announcement: ann });
                break;
            }

            case 'admin_get_data': {
                if (!ci.isAdmin) return;
                send(ws, { type: 'admin_data', reports, bannedIPs: Array.from(bannedIPs.entries()) });
                break;
            }
        }
    });

    ws.on('close', () => {
        const info = clients.get(ws);
        if (info && info.nickname) {
            broadcast({ type: 'system', message: `${info.nickname} left the chat.`, timestamp: Date.now() });
        }
        // Clean up stranger state
        removeFromQueue(ws);
        const sessionId = clientSession.get(ws);
        if (sessionId) endStrangerSession(sessionId, 'partner_disconnected');

        clients.delete(ws);
        broadcastUserList();
    });
});

server.listen(PORT, () => {
    console.log(`✅ SorSU TikTalk running on http://localhost:${PORT}`);
    console.log(`🛡  Admin secret: ${ADMIN_SECRET}`);
});

// Keep-alive: ping all connected clients every 30s to prevent
// Render free tier from sleeping and to detect dead connections.
setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.readyState === WebSocket.OPEN) {
            ws.ping();
        }
    });
}, 30_000);