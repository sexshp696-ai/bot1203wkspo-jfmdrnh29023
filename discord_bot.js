try{ require('dotenv').config(); }catch{}
const { Client, GatewayIntentBits, ChannelType, PermissionFlagsBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const net = require('net');
const WhatsAppManager = require('./whatsapp_manager');

// ============ CONFIG ============
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || "1540883450708623370";
const OWNER_ID = process.env.OWNER_ID || "1390600304214544525";
if(!DISCORD_TOKEN){
    console.error("❌ Faltando DISCORD_TOKEN no .env!");
    process.exit(1);
}

let MC_HOST = "3ww123.play.hosting";
let MC_PORT = 25565;
let MC_USER = "Ph4nt0m";
let MC_VERSION = "26.2 (776)";

// ============ PYTHON SPAWN HELPER ============
const PYTHON_CANDIDATES = ["python3", "python", "py"];
function getPythonExe() {
    for (const exe of PYTHON_CANDIDATES) {
        try {
            const result = require('child_process').spawnSync(exe, ["--version"], { timeout: 3000, encoding: "utf8" });
            if (result.status === 0 || (result.output && result.output.join("").includes("Python"))) {
                console.log(`[PY] Usando '${exe}' (${(result.stdout||result.stderr||"").trim()})`);
                return exe;
            }
        } catch {}
    }
    console.warn("[PY] Fallback para 'python'");
    return "python";
}
const PYTHON_EXE = getPythonExe();

// ============ STATE DO BOT AFK ============
let mcProcess = null;
let mcState = "desligado"; // desligado, conectando, online, caido
let mcStartTime = null;
let mcInfo = {
    coords: "Desconhecido",
    entityId: "?",
    ping: "?",
    motivo: "",
    tentativas: 0,
    kaCount: 0,
    gamemode: "?",
    chatmode: "?"
};
let autoReconnect = true;
let shuttingDown = false;
let liveMessage = null;
let liveInterval = null;
let sessionLogs = [];
let allLogs = [];
let sessionStartStr = "";
let botInitTime = Date.now();
let runningBotId = null;
const LOG_INDEX = path.join(__dirname, "logs", "index.json");

// ============ STATE DO SERVIDOR MINECRAFT (SLP) ============
let serverState = {
    online: false,
    firstOnlineTime: null,
    lastOnlineTime: null,
    lastOfflineTime: null,
    ping: -1,
    version: "26.2",
    players: { online: 0, max: 20, list: [] },
    motd: "A Minecraft Server"
};
let serverStatusMessage = null;
let previousPlayerList = new Set();

// Canais dedicados de log e monitoramento
let serverStatusChannel = null;
let serverChatChannel = null;
let logsHtmlChannel = null;
let eventsChannel = null;
let alertsChannel = null;
let whatsappControlChannel = null;
let whatsappLogsChannel = null;

let whatsappControlMessage = null;

function loadLogs() {
    try {
        const dir = path.join(__dirname, "logs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(LOG_INDEX)) {
            const data = JSON.parse(fs.readFileSync(LOG_INDEX, "utf8"));
            if (Array.isArray(data)) allLogs = data;
        }
        const files = fs.readdirSync(dir).filter(f=>f.endsWith(".html")).sort().reverse();
        for (const fname of files) {
            if (!allLogs.find(l=>l.fname===fname)) {
                const fpath = path.join(dir, fname);
                const stat = fs.statSync(fpath);
                allLogs.push({ fname, fpath, time: stat.mtime.toISOString(), reason: "Recuperado de disco", type: "desconectado", uptime: "?", ka: "?", tent: "?" });
            }
        }
        allLogs.sort((a,b)=> new Date(b.time) - new Date(a.time));
        if (allLogs.length > 100) allLogs = allLogs.slice(0, 100);
        const maxTent = Math.max(0, ...allLogs.map(l=>parseInt(l.tent)||0));
        if (maxTent > mcInfo.tentativas) mcInfo.tentativas = maxTent;
        if (fs.readdirSync(dir).filter(f=>f.endsWith(".html")).length !== allLogs.filter(l=>fs.existsSync(l.fpath)).length || !fs.existsSync(LOG_INDEX)) saveLogs();
    } catch(e){ console.error("Erro loadLogs:", e.message); }
}

function saveLogs() {
    try {
        const dir = path.join(__dirname, "logs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(LOG_INDEX, JSON.stringify(allLogs.slice(0,100), null, 2), "utf8");
    } catch(e){ console.error("Erro saveLogs:", e.message); }
}

loadLogs();

// ============ BOTS CONFIG ============
const BOTS_FILE = path.join(__dirname, "bots.json");
let bots = [];
function loadBots(){
    try{
        if(fs.existsSync(BOTS_FILE)) bots = JSON.parse(fs.readFileSync(BOTS_FILE,"utf8"));
        if(!Array.isArray(bots) || bots.length===0) throw new Error("vazio");
    }catch{
        bots = [{ id:"phant0m", name:"Ph4nt0m", host:MC_HOST, port:MC_PORT, user:MC_USER, version:MC_VERSION, enabled:true, createdAt:new Date().toISOString() }];
        saveBots();
    }
}
function saveBots(){ try{ fs.writeFileSync(BOTS_FILE, JSON.stringify(bots,null,2), "utf8"); }catch(e){ console.error("saveBots",e.message); } }
function getSelectedBot(){ return bots[0] || null; }
function syncPrimary(){
    const p = bots[0];
    if(p){ MC_HOST = p.host; MC_PORT = p.port; MC_USER = p.user; MC_VERSION = p.version; }
}
loadBots();
syncPrimary();

// ============ PROTOCOLO MINECRAFT SERVER LIST PING (SLP) ============
function writeVarInt(val) {
    const bytes = [];
    while (true) {
        let b = val & 0x7F;
        val >>>= 7;
        if (val !== 0) b |= 0x80;
        bytes.push(b);
        if (val === 0) break;
    }
    return Buffer.from(bytes);
}

function readVarInt(buf, offset = 0) {
    let result = 0;
    let shift = 0;
    let cursor = offset;
    while (cursor < buf.length) {
        const b = buf[cursor++];
        result |= (b & 0x7F) << shift;
        if (!(b & 0x80)) return { value: result, offset: cursor };
        shift += 7;
    }
    return null;
}

function pingMinecraftServer(host, port = 25565, timeout = 4000) {
    return new Promise((resolve) => {
        const start = Date.now();
        const clientSock = new net.Socket();
        let buffer = Buffer.alloc(0);
        let resolved = false;

        const timer = setTimeout(() => {
            if (!resolved) {
                resolved = true;
                clientSock.destroy();
                resolve({ online: false, ping: -1, error: "timeout" });
            }
        }, timeout);

        clientSock.connect(port, host, () => {
            const hostBuf = Buffer.from(host, 'utf8');
            const portBuf = Buffer.alloc(2);
            portBuf.writeUInt16BE(port);

            const handPayload = Buffer.concat([
                writeVarInt(0x00),
                writeVarInt(776),
                writeVarInt(hostBuf.length),
                hostBuf,
                portBuf,
                writeVarInt(1)
            ]);
            clientSock.write(Buffer.concat([writeVarInt(handPayload.length), handPayload]));

            const reqPayload = writeVarInt(0x00);
            clientSock.write(Buffer.concat([writeVarInt(reqPayload.length), reqPayload]));
        });

        clientSock.on('data', (data) => {
            buffer = Buffer.concat([buffer, data]);
            try {
                const pktLen = readVarInt(buffer, 0);
                if (!pktLen) return;
                if (buffer.length < pktLen.offset + pktLen.value) return;

                const pktId = readVarInt(buffer, pktLen.offset);
                if (!pktId) return;

                const strLen = readVarInt(buffer, pktId.offset);
                if (!strLen) return;

                const jsonStr = buffer.slice(strLen.offset, strLen.offset + strLen.value).toString('utf8');
                const ping = Date.now() - start;
                resolved = true;
                clearTimeout(timer);
                clientSock.destroy();

                try {
                    const parsed = JSON.parse(jsonStr);
                    resolve({
                        online: true,
                        ping,
                        version: parsed.version?.name || "26.2",
                        players: {
                            online: parsed.players?.online || 0,
                            max: parsed.players?.max || 20,
                            list: (parsed.players?.sample || []).map(p => p.name)
                        },
                        motd: typeof parsed.description === 'string' ? parsed.description : (parsed.description?.text || "A Minecraft Server"),
                        raw: parsed
                    });
                } catch {
                    resolve({ online: true, ping, version: "26.2", players: { online: 0, max: 20, list: [] }, motd: "A Minecraft Server" });
                }
            } catch {}
        });

        clientSock.on('error', (err) => {
            if (!resolved) {
                resolved = true;
                clearTimeout(timer);
                resolve({ online: false, ping: -1, error: err.message });
            }
        });
    });
}

// ============ HELPERS ============
function mentionOwner() { return `<@${OWNER_ID}>`; }

function getUptime() {
    if (!mcStartTime) return "0s";
    const s = Math.floor((Date.now() - mcStartTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function getServerUptime() {
    if (!serverState.firstOnlineTime) return "—";
    const s = Math.floor((Date.now() - serverState.firstOnlineTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function getBotUptime() {
    const s = Math.floor((Date.now() - botInitTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function addLog(type, msg, detail="") {
    sessionLogs.push({ time: new Date().toISOString(), ts: Date.now(), type, msg, detail });
    if (sessionLogs.length > 10000) sessionLogs.shift();
    
    if (eventsChannel) {
        try {
            const timeStr = new Date().toLocaleTimeString('pt-BR');
            const icon = { connect:"🔌", keepalive:"💓", play:"🎮", kick:"🥾", ban:"🔨", death:"💀", disconnect:"⚠️", error:"❌", info:"ℹ️", chat:"💬" }[type] || "•";
            eventsChannel.send(`\`[${timeStr}]\` ${icon} **${type.toUpperCase()}** — ${msg} ${detail ? `| *${detail}*` : ""}`).catch(()=>{});
        } catch {}
    }
}
function clearSessionLogs() { sessionLogs = []; sessionStartStr = new Date().toLocaleString('pt-BR'); }

function generateHTMLLog(reason, type) {
    try {
        const dir = path.join(__dirname, "logs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const now = new Date();
        const fname = `Ph4nt0m_${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}-${String(now.getDate()).padStart(2,'0')}_${String(now.getHours()).padStart(2,'0')}-${String(now.getMinutes()).padStart(2,'0')}-${String(now.getSeconds()).padStart(2,'0')}.html`;
        const fpath = path.join(dir, fname);
        const uptime = getUptime();
        const start = sessionStartStr || "—";
        const end = now.toLocaleString('pt-BR');
        const ka = mcInfo.kaCount;
        const tent = mcInfo.tentativas;
        const coords = mcInfo.coords;
        const typeCounts = {};
        sessionLogs.forEach(l=> typeCounts[l.type] = (typeCounts[l.type]||0)+1);
        const breakdown = Object.entries(typeCounts).map(([k,v])=> `<span style="display:inline-block;margin:4px 6px;padding:6px 12px;border-radius:20px;background:#1e1e2a;border:1px solid #2a2a3a;font-size:12px;"><b style="color:#fff;">${k.toUpperCase()}</b> <span style="background:${{connect:"#3498db",keepalive:"#2ecc71",play:"#f1c40f",kick:"#e74c3c",ban:"#992d22",death:"#9b59b6",disconnect:"#e67e22",error:"#e74c3c",info:"#95a5a6",chat:"#5865F2"}[k]||"#95a5a6"};color:#fff;padding:1px 7px;border-radius:10px;margin-left:6px;">${v}</span></span>`).join("");
        const rows = sessionLogs.map((l,i) => {
            const d = new Date(l.ts);
            const t = d.toLocaleTimeString('pt-BR');
            const dt = d.toLocaleDateString('pt-BR');
            const colors = { connect:"#3498db", keepalive:"#2ecc71", play:"#f1c40f", kick:"#e74c3c", ban:"#992d22", death:"#9b59b6", disconnect:"#e67e22", error:"#e74c3c", info:"#95a5a6", chat:"#5865F2" };
            const c = colors[l.type] || "#95a5a6";
            const icon = { connect:"🔌", keepalive:"💓", play:"🎮", kick:"🥾", ban:"🔨", death:"💀", disconnect:"⚠️", error:"❌", info:"ℹ️", chat:"💬" }[l.type] || "•";
            const ago = Math.floor((now - d)/1000); let agoStr = ago<60? `${ago}s atrás` : ago<3600? `${Math.floor(ago/60)}m atrás` : `${Math.floor(ago/3600)}h atrás`;
            return `<tr><td style="color:#888;">${i+1}</td><td><div style="font-weight:600;">${t}</div><div style="font-size:11px;color:#888;">${dt} • ${agoStr}</div></td><td><span style="background:${c};padding:3px 9px;border-radius:20px;color:#fff;font-size:11px;font-weight:700;letter-spacing:.5px;box-shadow:0 2px 8px ${c}55;">${l.type.toUpperCase()}</span></td><td style="font-weight:500;">${icon} ${escapeHtml(l.msg)}</td><td style="font-size:12px;color:#bbb;max-width:320px;word-break:break-word;">${escapeHtml(l.detail)||'<span style="color:#666;">—</span>'}</td></tr>`;
        }).join("");
        const html = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Ph4nt0m Log ${fname} — #${tent}</title><style>
*{box-sizing:border-box}body{margin:0;font-family:'Segoe UI',Roboto,Arial;background:#0a0a0f;color:#e6e6ea}
.header{background:linear-gradient(135deg,#5865F2 0%,#9b59b6 45%,#ff6b6b 100%);padding:32px 24px;text-align:center;position:relative;overflow:hidden}
.header::before{content:"";position:absolute;inset:0;background:radial-gradient(ellipse at 30% 20%,rgba(255,255,255,.15),transparent 60%)}
.header h1{margin:0;font-size:28px;position:relative;text-shadow:0 2px 12px rgba(0,0,0,.3)}
.header p{opacity:.95;margin:8px 0;position:relative}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:14px;padding:18px;max-width:1180px;margin:0 auto}
.card{background:linear-gradient(145deg,#1a1a26,#1e1e2a);border:1px solid #2a2a3a;border-radius:16px;padding:16px;box-shadow:0 4px 20px rgba(0,0,0,.25);transition:.2s}
.card:hover{transform:translateY(-2px);border-color:#3a3a5a;box-shadow:0 8px 28px rgba(88,101,242,.15)}
.card h3{margin:0 0 6px;font-size:11px;letter-spacing:1.2px;color:#9aa0b6}
.card p{margin:0;font-size:15px;font-weight:700;color:#fff;word-break:break-all}
.badge{display:inline-block;padding:5px 12px;border-radius:20px;font-size:12px;font-weight:800;color:#fff;letter-spacing:.5px;box-shadow:0 2px 10px rgba(0,0,0,.2)}
.badge.online{background:#2ecc71}.badge.caido{background:#e74c3c}.badge.desconectado{background:#e67e22}.badge.kickado{background:#e74c3c}.badge.banido{background:#992d22}.badge.morto{background:#9b59b6}.badge.erro{background:#e74c3c}
.timeline{max-width:1180px;margin:0 auto;padding:0 16px 28px}
.summary{background:#14141e;border:1px solid #2a2a3a;border-radius:16px;padding:16px;margin:14px auto;max-width:1180px}
.summary h3{margin:0 0 10px;font-size:13px;color:#ccc;letter-spacing:.8px}
.table-wrap{background:#12121a;border:1px solid #23233a;border-radius:16px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,.35)}
.table-scroll{max-height:75vh;overflow:auto}
table{width:100%;border-collapse:collapse;background:#12121a}
th{position:sticky;top:0;background:#1e1e32;text-align:left;padding:12px 10px;font-size:11px;color:#9aa0b6;letter-spacing:.8px;z-index:1;border-bottom:1px solid #2a2a3a}
td{padding:10px;border-top:1px solid #1f1f2e;font-size:13px;vertical-align:top}
tr:hover{background:#1a1a2a}
tr:nth-child(even){background:#15151f}tr:nth-child(even):hover{background:#1e1e32}
.footer{text-align:center;padding:22px;color:#777;font-size:12px;background:#0f0f14;border-top:1px solid #1a1a2a}
.kpi{display:inline-flex;align-items:center;gap:6px;background:#1a1a26;border:1px solid #2a2a3a;padding:6px 10px;border-radius:20px;font-size:12px;margin:4px}
::-webkit-scrollbar{width:8px;height:8px}::-webkit-scrollbar-thumb{background:#2a2a4a;border-radius:8px}::-webkit-scrollbar-track{background:#0f0f14}
</style></head><body>
<div class="header"><h1>🤖 Ph4nt0m — Log Detalhado</h1><p style="font-size:15px;">${escapeHtml(reason||"Sem motivo")} • <span class="badge ${type}">${type.toUpperCase()}</span> • Sessão <b>#${tent}</b></p><p style="font-size:13px;opacity:.9;">Sessão: ${start} → ${end} • Uptime: <b>${uptime}</b> • Total eventos: <b>${sessionLogs.length.toLocaleString('pt-BR')}</b></p></div>
<div class="stats">
<div class="card"><h3>🌐 SERVIDOR</h3><p>${MC_HOST}:${MC_PORT}</p></div>
<div class="card"><h3>👤 NICK</h3><p>${MC_USER}</p></div>
<div class="card"><h3>⏱️ UPTIME SESSÃO</h3><p>${uptime}</p></div>
<div class="card"><h3>💓 KEEPALIVES</h3><p>${ka}</p></div>
<div class="card"><h3>🔢 TENTATIVA</h3><p>#${tent}</p></div>
<div class="card"><h3>📍 COORDS</h3><p>${escapeHtml(coords)}</p></div>
<div class="card"><h3>📜 TOTAL EVENTOS</h3><p>${sessionLogs.length.toLocaleString('pt-BR')}</p></div>
<div class="card"><h3>🕐 MONITORANDO HÁ</h3><p>${getBotUptime()}</p></div>
</div>
<div class="summary"><h3>📊 Breakdown por tipo</h3><div>${breakdown || '<span style="color:#888;">Nenhum evento</span>'}</div></div>
<div class="timeline"><h2>📜 Timeline Completa</h2><div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>#</th><th>Hora</th><th>Tipo</th><th>Evento</th><th>Detalhe Completo</th></tr></thead><tbody>${rows || '<tr><td colspan=5 style="text-align:center;color:#888;padding:24px;">Nenhum evento registrado</td></tr>'}</tbody></table></div></div></div>
<div class="footer">Gerado em ${end} • Ph4nt0m AFK Manager</div>
</body></html>`;
        fs.writeFileSync(fpath, html, "utf8");
        allLogs.unshift({ fname, fpath, time: now.toISOString(), reason, type, uptime, ka, tent: mcInfo.tentativas });
        if (allLogs.length > 500) allLogs.pop();
        saveLogs();

        if (logsHtmlChannel) {
            try {
                const file = new AttachmentBuilder(fpath);
                const logEmbed = new EmbedBuilder()
                    .setColor(type === "kickado" || type === "banido" || type === "erro" ? 0xe74c3c : 0x3498db)
                    .setTitle(`📄 Novo Relatório de Sessão Gerado — #${tent}`)
                    .setDescription(
                        `**A sessão do bot/player foi finalizada no servidor.**\n` +
                        `> 🌐 **Servidor:** \`${MC_HOST}:${MC_PORT}\` | 👤 **Nick:** \`${MC_USER}\`\n` +
                        `> ⏱️ **Uptime da Sessão:** \`${uptime}\` | 💓 **KeepAlives:** \`${ka}\`\n` +
                        `> 📍 **Últimas Coords:** \`${coords}\`\n` +
                        `> ⚠️ **Motivo:** \`${(reason||"Encerramento de sessão").slice(0, 200)}\`\n\n` +
                        `*O arquivo HTML com a timeline completa e interativa de eventos foi anexado abaixo:*`
                    )
                    .setTimestamp()
                    .setFooter({ text: `Ph4nt0m Logs • Arquivo: ${fname}` });
                
                logsHtmlChannel.send({ embeds: [logEmbed], files: [file] }).catch(err => console.error("Erro ao enviar HTML no canal:", err.message));
            } catch (err) {
                console.error("Erro no anexo de log:", err.message);
            }
        }

        return fpath;
    } catch(e){ console.error("Erro ao gerar HTML:", e.message); return null; }
}
function escapeHtml(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ============ GERENCIADOR DO WHATSAPP ============
const whatsappManager = new WhatsAppManager({
    onQR: async (qrBuffer) => {
        console.log("[WA] Novo QR Code gerado para autenticação.");
        if (whatsappControlChannel) {
            await updateWhatsAppControlPanel(qrBuffer);
        }
    },
    onPairingCode: async (code) => {
        console.log(`[WA] Pairing code: ${code}`);
        if (whatsappControlChannel) {
            await updateWhatsAppControlPanel(null, code);
        }
    },
    onStatusChange: async (state, userNumber) => {
        console.log(`[WA] Status alterado para: ${state} (Número: ${userNumber || '—'})`);
        if (whatsappControlChannel) {
            await updateWhatsAppControlPanel();
        }
        if (whatsappLogsChannel) {
            whatsappLogsChannel.send(`ℹ️ **[STATUS WHATSAPP]** Estado atual: \`${state.toUpperCase()}\` ${userNumber ? `(Número: +${userNumber})` : ""}`).catch(()=>{});
        }
    },
    onAdminRequest: async (req) => {
        if (whatsappControlChannel) {
            const embed = new EmbedBuilder()
                .setColor(0xf1c40f)
                .setTitle("📱 Solicitação de Vinculação de Administrador — WhatsApp")
                .setDescription(
                    `**Um novo número enviou mensagem para o bot no WhatsApp e deseja se tornar Administrador!**\n\n` +
                    `> 👤 **Nome do Contato:** \`${req.name}\`\n` +
                    `> 📱 **Número:** \`+${req.number}\`\n` +
                    `> 💬 **Mensagem enviada:** "${req.text}"\n` +
                    `> ⏰ **Horário:** <t:${Math.floor(req.timestamp/1000)}:T>\n\n` +
                    `*Ao confirmar, este número terá acesso total a todos os comandos numéricos de controle do Minecraft pelo WhatsApp!*`
                )
                .setTimestamp();

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId("btn_wa_confirm_admin").setLabel(`✅ Confirmar +${req.number}`).setStyle(ButtonStyle.Success),
                new ButtonBuilder().setCustomId("btn_wa_reject_admin").setLabel("❌ Recusar").setStyle(ButtonStyle.Danger)
            );

            whatsappControlChannel.send({ content: `${mentionOwner()}`, embeds: [embed], components: [row] });
        }
    },
    onGetMenuEmbed: async () => {
        const total = bots.length;
        const isOnline = mcState === "online";
        const statusGlobal = isOnline ? "🟢 1 Bot Ativo" : mcState === "conectando" ? "🟡 Conectando..." : "⚫ Todos Offline";
        const sel = getSelectedBot() || { name: "Ph4nt0m", host: MC_HOST, port: MC_PORT, user: MC_USER, version: MC_VERSION };

        let coordStr = mcInfo.coords !== "Desconhecido" ? mcInfo.coords : "Aguardando spawn...";
        const gmStr = mcInfo.gamemode !== "?" ? mcInfo.gamemode : "Detectado no Login";
        const up = isOnline ? getUptime() : "—";
        const ka = isOnline ? `${mcInfo.kaCount} pacotes` : "0";

        let botsListText = bots.map((b, i) => {
            const isPrimary = i === 0;
            const st = (isPrimary && isOnline) ? "🟢 ONLINE" : (isPrimary && mcState === "conectando") ? "🟡 CONECTANDO" : "⚫ OFFLINE";
            return `${isPrimary ? "⭐" : "🤖"} *#${i+1} — ${b.name}* ${isPrimary ? "*(Principal)*" : ""}\n` +
                   `> 🌐 *Servidor:* ${b.host}:${b.port}\n` +
                   `> 👤 *Nick:* ${b.user} • 📦 *Versão:* ${b.version}\n` +
                   `> 📡 *Status:* ${st}\n` +
                   `> 💓 *KeepAlives:* ${isPrimary ? ka : "0"} • ⏳ *Uptime:* ${isPrimary ? up : "—"}\n` +
                   `> 📍 *Posição:* ${isPrimary ? coordStr : "—"}\n` +
                   `> 🎮 *Gamemode:* ${isPrimary ? gmStr : "—"}`;
        }).join("\n\n");

        return `╭──────────────────────────────╮\n` +
               `│ 🎮 *PH4NT0M MANAGER — PAINEL* │\n` +
               `╰──────────────────────────────╯\n` +
               `> 🤖 *Total de Bots:* ${total} | 🌐 *Status:* ${statusGlobal}\n` +
               `> 🔄 *Auto-Reconnect:* ${autoReconnect ? "✅ ATIVADO (5s)" : "❌ DESATIVADO"}\n` +
               `> ⏱️ *Monitorando há:* ${getBotUptime()}\n` +
               `> 🖥️ *Servidor:* ${serverState.online ? "🟢 ONLINE (" + serverState.players.online + " players)" : "🔴 OFFLINE"}\n\n` +
               `${botsListText}\n\n` +
               `┌────────────────────────────┐\n` +
               `│   🎮 *PAINEL DE CONTROLE*    │\n` +
               `└────────────────────────────┘\n` +
               `*1.* ▶️ Iniciar Bot Principal\n` +
               `*2.* ⏹️ Parar Bot AFK\n` +
               `*3.* 🔄 Forçar Reconexão\n` +
               `*4.* 🎮 Mudar Gamemode (/gamemode)\n` +
               `*5.* 📊 Status do Servidor & Bot\n` +
               `*6.* 🔄 Alternar Auto-Reconnect (ON/OFF)\n` +
               `*7.* 👥 Jogadores Online no Servidor\n` +
               `*8.* 💬 Enviar Comando/Chat (ex: *8 /time set day*)\n` +
               `*9.* 📜 Logs & Relatórios HTML\n` +
               `*10.* ⚙️ Configurar IP (ex: *10 host:porta*)\n` +
               `*11.* 📝 Renomear Nick (ex: *11 NovoNick*)\n` +
               `*12.* ➕ Criar Bot (ex: *12 Nome host:port nick*)\n` +
               `*13.* 🗑️ Deletar Bot\n` +
               `*0.* 🔄 Atualizar Painel\n\n` +
               `_Envie o número do botão desejado (ex: *1*, *4.2*, *8*)._`;
    },
    onCommand: async (cmd, rawText) => {
        const parts = rawText.trim().split(/\s+/);
        const option = parts[0].toLowerCase();

        // 1. Iniciar Bot
        if (option === '1' || option === '1.1' || option === 'iniciar' || option === 'ligar') {
            if (mcState === "online") {
                return `╭──────────────────────────────╮\n` +
                       `│ ⚠️ *BOT JÁ CONECTADO*          │\n` +
                       `╰──────────────────────────────╯\n` +
                       `> 🌐 *Servidor:* ${MC_HOST}:${MC_PORT}\n` +
                       `> 👤 *Nick:* ${MC_USER}\n` +
                       `> ⏳ *Uptime:* ${getUptime()}\n` +
                       `> 📍 *Posição:* ${mcInfo.coords}\n\n` +
                       `*Ações:* [2] Parar | [3] Reconectar | [4] Gamemode | [5] Status`;
            }
            startMC();
            return `╭──────────────────────────────╮\n` +
                   `│ 🔄 *INICIANDO CONEXÃO...*     │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🌐 *Servidor:* ${MC_HOST}:${MC_PORT}\n` +
                   `> 👤 *Nick:* ${MC_USER}\n` +
                   `> 📦 *Versão:* ${MC_VERSION}\n` +
                   `> 📡 *Status:* 🟡 Conectando ao mundo...\n\n` +
                   `_Aguarde alguns segundos, você receberá a confirmação assim que entrar!_`;
        }

        // 2. Parar Bot
        if (option === '2' || option === 'parar' || option === 'desconectar') {
            shuttingDown = true; killMC(); mcState = "desligado"; shuttingDown = false;
            return `╭──────────────────────────────╮\n` +
                   `│ 🔌 *BOT DESCONECTADO*         │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 👤 *Bot:* ${MC_USER}\n` +
                   `> 🌐 *Servidor:* ${MC_HOST}:${MC_PORT}\n` +
                   `> 📡 *Status:* ⚫ OFFLINE\n\n` +
                   `*Ações:* [1] Iniciar | [5] Status | [0] Menu`;
        }

        // 3. Reconectar
        if (option === '3' || option === 'reconectar') {
            killMC();
            setTimeout(() => startMC(), 1500);
            return `╭──────────────────────────────╮\n` +
                   `│ 🔄 *RECONEXÃO FORÇADA*        │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 👤 *Bot:* ${MC_USER}\n` +
                   `> ⏳ *Ação:* Reiniciando processo em 1.5s...\n\n` +
                   `_Conexão sendo reestabelecida automaticamente._`;
        }

        // 4. Gamemode
        if (option === '4') {
            return `╭──────────────────────────────╮\n` +
                   `│ 🎮 *ALTERAR GAMEMODE*         │\n` +
                   `╰──────────────────────────────╯\n` +
                   `Envie o número do modo de jogo desejado:\n\n` +
                   `*4.1* 🟢 Sobrevivência (Survival)\n` +
                   `*4.2* 🟣 Criativo (Creative - Imortal)\n` +
                   `*4.3* 🔵 Aventura (Adventure)\n` +
                   `*4.4* 👁️ Espectador (Spectator)\n\n` +
                   `_Exemplo: Envie *4.2* para modo Criativo._`;
        }
        if (option === '4.1' || option === 'survival') {
            setBotGamemode('survival');
            mcInfo.gamemode = "Sobrevivência (0)";
            return `╭──────────────────────────────╮\n` +
                   `│ 🎮 *GAMEMODE ATUALIZADO*      │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🟢 *Novo Modo:* Sobrevivência (Survival)\n` +
                   `> 💬 *Comando:* \`/gamemode survival\` emitido no servidor!\n\n` +
                   `*Ações:* [4] Outro Modo | [5] Status | [0] Menu`;
        }
        if (option === '4.2' || option === 'creative') {
            setBotGamemode('creative');
            mcInfo.gamemode = "Criativo (1)";
            return `╭──────────────────────────────╮\n` +
                   `│ 🎮 *GAMEMODE ATUALIZADO*      │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🟣 *Novo Modo:* Criativo (Creative - Imortal)\n` +
                   `> 💬 *Comando:* \`/gamemode creative\` emitido no servidor!\n\n` +
                   `*Ações:* [4] Outro Modo | [5] Status | [0] Menu`;
        }
        if (option === '4.3' || option === 'adventure') {
            setBotGamemode('adventure');
            mcInfo.gamemode = "Aventura (2)";
            return `╭──────────────────────────────╮\n` +
                   `│ 🎮 *GAMEMODE ATUALIZADO*      │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🔵 *Novo Modo:* Aventura (Adventure)\n` +
                   `> 💬 *Comando:* \`/gamemode adventure\` emitido no servidor!\n\n` +
                   `*Ações:* [4] Outro Modo | [5] Status | [0] Menu`;
        }
        if (option === '4.4' || option === 'spectator') {
            setBotGamemode('spectator');
            mcInfo.gamemode = "Espectador (3)";
            return `╭──────────────────────────────╮\n` +
                   `│ 🎮 *GAMEMODE ATUALIZADO*      │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 👁️ *Novo Modo:* Espectador (Spectator)\n` +
                   `> 💬 *Comando:* \`/gamemode spectator\` emitido no servidor!\n\n` +
                   `*Ações:* [4] Outro Modo | [5] Status | [0] Menu`;
        }

        // 5. Status Completo
        if (option === '5' || option === 'status') {
            const isOnline = mcState === "online";
            const serverSt = serverState.online ? "🟢 ONLINE (Acessível)" : "🔴 OFFLINE";
            const botSt = isOnline ? `🟢 ONLINE (Uptime: ${getUptime()})` : `⚫ ${mcState.toUpperCase()}`;
            const playersList = serverState.players.list.length > 0 ? serverState.players.list.join(", ") : "Nenhum no momento";

            return `╭──────────────────────────────╮\n` +
                   `│ 📊 *STATUS COMPLETO — AO VIVO*│\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🌐 *Servidor:* ${MC_HOST}:${MC_PORT}\n` +
                   `> 📡 *Status Servidor:* ${serverSt}\n` +
                   `> ⏱️ *Servidor Ligado há:* ${getServerUptime()}\n` +
                   `> 🏓 *Ping:* ${serverState.ping > 0 ? serverState.ping + " ms" : "—"} • 📦 *Versão:* ${serverState.version}\n` +
                   `> 👥 *Players Online:* ${serverState.players.online}/${serverState.players.max} (${playersList})\n\n` +
                   `> 🤖 *Bot AFK (${MC_USER}):* ${botSt}\n` +
                   `> 📍 *Posição:* ${mcInfo.coords}\n` +
                   `> 🎮 *Gamemode:* ${mcInfo.gamemode}\n` +
                   `> 💓 *KeepAlives:* ${mcInfo.kaCount} pacotes respondidos\n` +
                   `> 🔄 *Auto-Reconnect:* ${autoReconnect ? "✅ ATIVADO (5s)" : "❌ DESATIVADO"}\n` +
                   `> 🔢 *Sessão:* #${mcInfo.tentativas}\n\n` +
                   `┌────────────────────────────┐\n` +
                   `│   🎮 *AÇÕES RÁPIDAS*         │\n` +
                   `└────────────────────────────┘\n` +
                   `[1] Iniciar  [2] Parar  [3] Reconectar  [4] Gamemode\n` +
                   `[6] Auto-Rec [7] Players [8] Chat/Cmd   [0] Menu`;
        }

        // 6. Auto-reconnect
        if (option === '6' || option === 'autoreconnect' || option === 'auto') {
            autoReconnect = !autoReconnect;
            if (autoReconnect && mcState !== "online" && serverState.online) setTimeout(() => startMC(), 2000);
            return `╭──────────────────────────────╮\n` +
                   `│ 🔄 *AUTO-RECONNECT ALTERADO*  │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> ⚙️ *Estado:* ${autoReconnect ? "✅ ATIVADO (Reconecta em 5s se cair)" : "❌ DESATIVADO (Manual)"}\n\n` +
                   `*Ações:* [1] Iniciar | [5] Status | [0] Menu`;
        }

        // 7. Players Online
        if (option === '7' || option === 'players') {
            const list = serverState.players.list.length > 0 ? serverState.players.list.map(p => `> • *${p}*`).join("\n") : "> *Nenhum jogador online no momento.*";
            return `╭──────────────────────────────╮\n` +
                   `│ 👥 *JOGADORES NO SERVIDOR*    │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🌐 *Servidor:* ${MC_HOST}:${MC_PORT}\n` +
                   `> 📊 *Total:* ${serverState.players.online}/${serverState.players.max}\n\n` +
                   `**Lista de Jogadores:**\n${list}\n\n` +
                   `*Ações:* [5] Status | [0] Menu`;
        }

        // 8. Enviar Comando / Chat
        if (option === '8' || option.startsWith('8.')) {
            const cmdToSend = rawText.replace(/^[0-9.]+\s*/, '').trim();
            if (!cmdToSend) {
                return `╭──────────────────────────────╮\n` +
                       `│ 💬 *ENVIAR COMANDO / CHAT*    │\n` +
                       `╰──────────────────────────────╯\n` +
                       `Envie o comando após o *8*.\n\n` +
                       `*Exemplos:*\n` +
                       `> *8 /time set day*\n` +
                       `> *8 /weather clear*\n` +
                       `> *8 Olá a todos no servidor!*`;
            }
            sendBotCommand(cmdToSend);
            return `╭──────────────────────────────╮\n` +
                   `│ 💬 *COMANDO / CHAT ENVIADO*   │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 📤 *Enviado:* \`${cmdToSend}\`\n` +
                   `> 🤖 *Player:* ${MC_USER}\n\n` +
                   `*Ações:* [5] Status | [0] Menu`;
        }

        // 9. Logs
        if (option === '9' || option === 'logs') {
            return `╭──────────────────────────────╮\n` +
                   `│ 📜 *HISTÓRICO DE LOGS*        │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> ⏱️ *Monitorando há:* ${getBotUptime()}\n` +
                   `> 🔢 *Sessão Atual:* #${mcInfo.tentativas} (${sessionLogs.length} eventos)\n` +
                   `> 📍 *Últimas Coords:* ${mcInfo.coords}\n` +
                   `> 🎮 *Gamemode:* ${mcInfo.gamemode}\n` +
                   `> 📁 *Relatórios HTML Salvos:* ${allLogs.length} arquivos\n\n` +
                   `*Ações:* [5] Status | [0] Menu`;
        }

        // 10. Configurar IP
        if (option === '10') {
            const arg = rawText.replace(/^[0-9.]+\s*/, '').trim();
            if (!arg || !arg.includes(':')) {
                return `╭──────────────────────────────╮\n` +
                       `│ ⚙️ *CONFIGURAR IP/HOST*       │\n` +
                       `╰──────────────────────────────╯\n` +
                       `Envie o IP e a porta após o *10*.\n\n` +
                       `*Exemplo:* *10 meuserver.play.hosting:25565*`;
            }
            const [host, port] = arg.split(':');
            bots[0].host = host;
            bots[0].port = parseInt(port) || 25565;
            saveBots(); syncPrimary();
            return `╭──────────────────────────────╮\n` +
                   `│ ⚙️ *ENDEREÇO ATUALIZADO*      │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🌐 *Novo Servidor:* \`${bots[0].host}:${bots[0].port}\`\n\n` +
                   `*Ações:* [1] Iniciar | [5] Status | [0] Menu`;
        }

        // 11. Renomear Nick
        if (option === '11') {
            const newNick = rawText.replace(/^[0-9.]+\s*/, '').trim();
            if (!newNick) {
                return `╭──────────────────────────────╮\n` +
                       `│ 📝 *RENOMEAR NICK DO BOT*     │\n` +
                       `╰──────────────────────────────╯\n` +
                       `Envie o novo nick após o *11*.\n\n` +
                       `*Exemplo:* *11 Ph4nt0m_Pro*`;
            }
            bots[0].user = newNick;
            saveBots(); syncPrimary();
            return `╭──────────────────────────────╮\n` +
                   `│ 📝 *NICK ATUALIZADO*          │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 👤 *Novo Nick:* \`${newNick}\`\n\n` +
                   `*Ações:* [1] Iniciar | [5] Status | [0] Menu`;
        }

        // 12. Criar Bot
        if (option === '12') {
            const rest = rawText.replace(/^[0-9.]+\s*/, '').trim().split(/\s+/);
            if (rest.length < 3) {
                return `╭──────────────────────────────╮\n` +
                       `│ ➕ *CRIAR NOVO BOT*           │\n` +
                       `╰──────────────────────────────╯\n` +
                       `Envie: *12 <Nome> <IP:Porta> <Nick>*\n\n` +
                       `*Exemplo:* *12 Phantom2 3ww123.play.hosting:25565 Ph4nt0m2*`;
            }
            const [name, hostPort, nick] = rest;
            const [host, port] = hostPort.split(':');
            const id = name.toLowerCase().replace(/[^a-z0-9]/g, "") || `bot${Date.now()}`;
            bots.push({ id, name, host, port: parseInt(port)||25565, user: nick, version: MC_VERSION, enabled: true, createdAt: new Date().toISOString() });
            saveBots();
            return `╭──────────────────────────────╮\n` +
                   `│ ✅ *NOVO BOT CRIADO!*         │\n` +
                   `╰──────────────────────────────╯\n` +
                   `> 🤖 *Nome:* ${name}\n` +
                   `> 🌐 *Servidor:* ${host}:${port||25565}\n` +
                   `> 👤 *Nick:* ${nick}\n\n` +
                   `*Ações:* [0] Ver Menu de Bots`;
        }

        // 13. Deletar Bot
        if (option === '13') {
            if (bots.length <= 1) {
                return `❌ *Você não pode deletar o único bot cadastrado!*`;
            }
            const removed = bots.pop();
            saveBots();
            return `🗑️ *Bot \`${removed.name}\` foi removido com sucesso!*`;
        }

        return `╭──────────────────────────────╮\n` +
               `│ ❓ *OPÇÃO NÃO RECONHECIDA*    │\n` +
               `╰──────────────────────────────╯\n` +
               `Envie *0* ou *menu* para ver todas as opções disponíveis.`;
    },
    onLog: (msg) => {
        if (whatsappLogsChannel) {
            whatsappLogsChannel.send(`💬 \`[${new Date().toLocaleTimeString('pt-BR')}]\` ${msg}`).catch(()=>{});
        }
    }
});

// ============ CRIAÇÃO AUTOMÁTICA DOS CANAIS ============
async function setupLogChannels(guild) {
    if (!guild) return;
    try {
        const channelsToEnsure = [
            { name: "🟢・status-servidor", topic: "Status em tempo real do servidor Minecraft e tempo ligado (Uptime)", key: "status" },
            { name: "📱・whatsapp", topic: "Painel de controle e pareamento do WhatsApp com QR Code e vinculação de Admin", key: "wa_control" },
            { name: "📲・logs-whatsapp", topic: "Histórico de mensagens e comandos executados pelo WhatsApp", key: "wa_logs" },
            { name: "💬・chat-servidor", topic: "Retransmissão ao vivo de chat, jogadores entrando/saindo e mortes", key: "chat" },
            { name: "📜・logs-html", topic: "Download automático de relatórios .html de cada sessão encerrada", key: "html" },
            { name: "⚡・logs-eventos", topic: "Eventos ao vivo do bot no Minecraft (Conexões, Chunks, KeepAlives)", key: "events" },
            { name: "🚨・alertas-quedas", topic: "Alertas críticos de servidor ligou/caiu, kicks, bans e reinícios", key: "alerts" }
        ];

        let category = guild.channels.cache.find(c => c.type === ChannelType.GuildCategory && c.name.includes("LOGS & MONITORAMENTO"));
        if (!category) {
            try {
                category = await guild.channels.create({
                    name: "📊 LOGS & MONITORAMENTO",
                    type: ChannelType.GuildCategory
                });
            } catch {}
        }

        for (const item of channelsToEnsure) {
            let ch = guild.channels.cache.find(c => c.name === item.name);
            if (!ch) {
                try {
                    ch = await guild.channels.create({
                        name: item.name,
                        type: ChannelType.GuildText,
                        parent: category ? category.id : null,
                        topic: item.topic
                    });
                    console.log(`[CANAIS] Canal criado: ${item.name}`);
                } catch (e) {
                    console.error(`[CANAIS] Erro ao criar ${item.name}:`, e.message);
                }
            }
            if (ch) {
                if (item.key === "status") serverStatusChannel = ch;
                else if (item.key === "wa_control") whatsappControlChannel = ch;
                else if (item.key === "wa_logs") whatsappLogsChannel = ch;
                else if (item.key === "chat") serverChatChannel = ch;
                else if (item.key === "html") logsHtmlChannel = ch;
                else if (item.key === "events") eventsChannel = ch;
                else if (item.key === "alerts") alertsChannel = ch;
            }
        }
        console.log(`[CANAIS] Todos os 7 canais de monitoramento configurados.`);
    } catch (e) {
        console.error("[CANAIS] Erro no setupLogChannels:", e.message);
    }
}

// ============ PAINEL WHATSAPP NO DISCORD ============
async function updateWhatsAppControlPanel(qrBuffer = null, pairingCode = null) {
    if (!whatsappControlChannel) return;

    const isConnected = whatsappManager.state === "conectado";
    const isWaitingQR = whatsappManager.state === "qr" || qrBuffer !== null;
    const admin = whatsappManager.config.adminNumber ? `\`+${whatsappManager.config.adminNumber.split('@')[0]}\` (${whatsappManager.config.adminName || 'Admin'})` : `*Nenhum (Envie mensagem para o WhatsApp do bot para vincular)*`;

    const embed = new EmbedBuilder()
        .setColor(isConnected ? 0x2ecc71 : isWaitingQR ? 0xf1c40f : 0x95a5a6)
        .setTitle("📱 Gerenciador WhatsApp — Ph4nt0m Integration")
        .setDescription(
            `### 🌟 Controle o Bot do Minecraft direto pelo WhatsApp!\n\n` +
            `> 📡 **Status do WhatsApp:** \`${whatsappManager.state.toUpperCase()}\`\n` +
            `> 🤖 **Número do Bot Conectado:** \`${whatsappManager.userNumber ? '+' + whatsappManager.userNumber : 'Desconectado'}\`\n` +
            `> 👤 **Administrador Vinculado:** ${admin}\n` +
            `> 🔒 **Controle por Códigos:** \`1: Ligar • 2: Desligar • 3: Reconectar • 4: Gamemode • 5: Status\`\n\n` +
            `**📲 Como conectar seu WhatsApp:**\n` +
            `> 1. Clique em **📱 Gerar QR Code** e escaneie com seu WhatsApp.\n` +
            `> 2. Ou clique em **🔢 Conectar por Código** e digite seu número para receber o código de 8 dígitos.\n` +
            `> 3. Envie qualquer mensagem do seu WhatsApp pessoal para o bot para solicitar a vinculação de Administrador!\n`
        )
        .setTimestamp()
        .setFooter({ text: `WhatsApp Baileys Integration • 24/7 Render Deploy` });

    if (pairingCode) {
        embed.addFields({ name: "🔢 Código de Emparelhamento (Pairing Code)", value: `\`\`\`${pairingCode}\`\`\`\n*Digite este código no seu WhatsApp em Aparelhos Conectados → Conectar com número de telefone.*`, inline: false });
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_wa_connect_qr").setLabel("📱 Gerar QR Code").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_wa_pairing_code").setLabel("🔢 Conectar por Código").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_wa_disconnect").setLabel("🔌 Desconectar WhatsApp").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_wa_refresh").setLabel("🔄 Atualizar Status").setStyle(ButtonStyle.Secondary)
    );

    const files = [];
    if (qrBuffer) {
        const attachment = new AttachmentBuilder(qrBuffer, { name: "qrcode.png" });
        embed.setImage("attachment://qrcode.png");
        files.push(attachment);
    }

    try {
        if (whatsappControlMessage) {
            await whatsappControlMessage.edit({ embeds: [embed], components: [row], files }).catch(async () => {
                whatsappControlMessage = await whatsappControlChannel.send({ embeds: [embed], components: [row], files });
            });
        } else {
            whatsappControlMessage = await whatsappControlChannel.send({ embeds: [embed], components: [row], files });
        }
    } catch (e) {
        console.error("[WA-PANEL] Erro ao atualizar painel WhatsApp:", e.message);
    }
}

// ============ EMBED DE STATUS DO SERVIDOR (SLP) ============
function serverStatusEmbed() {
    const isOnline = serverState.online;
    const color = isOnline ? 0x2ecc71 : 0xe74c3c;
    const title = isOnline ? "🟢 SERVIDOR MINECRAFT — ONLINE & ATIVO" : "🔴 SERVIDOR MINECRAFT — OFFLINE (DESLIGADO)";
    const serverUptimeStr = getServerUptime();
    
    const playersList = serverState.players.list.length > 0 
        ? serverState.players.list.map(p => `\`${p}\``).join(", ") 
        : "*Nenhum jogador online no momento*";

    const botStatus = mcState === "online" ? `\`🟢 Online há ${getUptime()}\`` : mcState === "conectando" ? "`🟡 Conectando...`" : "`⚫ Desconectado`";

    const e = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(
            `### 🌐 Monitoramento Contínuo do Servidor\n` +
            `> 📡 **Status de Conexão:** ${isOnline ? "`🟢 ONLINE (Acessível)`" : "`🔴 OFFLINE (Sem resposta)`"}\n` +
            `> ⏱️ **Servidor Ligado há:** \`${serverUptimeStr}\`\n` +
            `> 🏓 **Latência / Ping:** \`${serverState.ping > 0 ? serverState.ping + " ms" : "—"}\`\n` +
            `> 👥 **Jogadores Online:** \`${serverState.players.online}/${serverState.players.max}\`\n\n` +
            `**📋 Lista de Jogadores:**\n> ${playersList}\n\n` +
            `**⚙️ Informações do Sistema:**\n` +
            `> 🌐 **IP / Endereço:** \`${MC_HOST}:${MC_PORT}\`\n` +
            `> 📦 **Versão:** \`${serverState.version}\` (Protocolo 776)\n` +
            `> 🤖 **Bot AFK (${MC_USER}):** ${botStatus}\n` +
            `> 📱 **WhatsApp:** \`${whatsappManager.state.toUpperCase()}\`\n` +
            `> 📜 **MOTD:** \`${serverState.motd}\`\n`
        )
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(MC_USER)}/128`)
        .setTimestamp()
        .setFooter({ text: `Atualizado automaticamente a cada 6s • Render Deploy 24/7`, iconURL: `https://mc-heads.net/avatar/${encodeURIComponent(MC_USER)}/32` });

    return e;
}

function serverStatusRow() {
    return [
        new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("btn_server_refresh").setLabel("🔄 Atualizar Status").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId("btn_bot_start").setLabel("▶️ Conectar Bot AFK").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("btn_logs").setLabel("📜 Logs de Sessão").setStyle(ButtonStyle.Secondary)
        )
    ];
}

// ============ LOOP DE MONITORAMENTO CONTÍNUO DO SERVIDOR ============
async function updateServerStatusLoop() {
    try {
        const res = await pingMinecraftServer(MC_HOST, MC_PORT);
        const wasOnline = serverState.online;

        if (res.online) {
            if (!wasOnline) {
                serverState.online = true;
                serverState.firstOnlineTime = Date.now();
                console.log(`[SERVER-MONITOR] 🟢 Servidor ${MC_HOST}:${MC_PORT} ACABOU DE LIGAR!`);
                
                // Notificação no WhatsApp
                whatsappManager.sendAdminAlert(
                    `╭──────────────────────────────╮\n` +
                    `│ 🟢 *SERVIDOR MINECRAFT LIGOU!* │\n` +
                    `╰──────────────────────────────╯\n` +
                    `> 🌐 *Endereço:* ${MC_HOST}:${MC_PORT}\n` +
                    `> ⏱️ *Horário:* ${new Date().toLocaleTimeString('pt-BR')}\n` +
                    `> 🤖 *Auto-Reconnect:* ${autoReconnect ? "Conectando bot em 3s..." : "Aguardando comando."}\n\n` +
                    `*Ações:* [1] Conectar Bot | [5] Status | [0] Menu`
                );

                if (alertsChannel) {
                    alertsChannel.send({
                        content: `${mentionOwner()} @everyone 🟢 **O SERVIDOR MINECRAFT ACABOU DE LIGAR!**\n> 🌐 **Endereço:** \`${MC_HOST}:${MC_PORT}\`\n> ⏱️ Horário: <t:${Math.floor(Date.now()/1000)}:T>`
                    }).catch(()=>{});
                }
                if (eventsChannel) {
                    eventsChannel.send(`🟢 **[SERVIDOR LIGOU]** O servidor Minecraft ${MC_HOST}:${MC_PORT} está online e acessível!`).catch(()=>{});
                }

                if (autoReconnect && mcState !== "online" && mcState !== "conectando") {
                    console.log("[SERVER-MONITOR] Servidor ligou e auto-reconnect ativo: iniciando bot em 3s...");
                    setTimeout(() => startMC(), 3000);
                }
            }

            serverState.ping = res.ping;
            serverState.version = res.version || serverState.version;
            serverState.motd = res.motd || serverState.motd;

            const currentList = new Set(res.players.list || []);
            if (serverChatChannel && previousPlayerList.size > 0) {
                for (const player of currentList) {
                    if (!previousPlayerList.has(player) && player !== MC_USER) {
                        serverChatChannel.send(`📥 **\`${player}\`** entrou no servidor Minecraft!`).catch(()=>{});
                    }
                }
                for (const player of previousPlayerList) {
                    if (!currentList.has(player) && player !== MC_USER) {
                        serverChatChannel.send(`📤 **\`${player}\`** saiu do servidor Minecraft.`).catch(()=>{});
                    }
                }
            }
            previousPlayerList = currentList;
            serverState.players = res.players;

        } else {
            if (wasOnline) {
                serverState.online = false;
                serverState.firstOnlineTime = null;
                console.log(`[SERVER-MONITOR] 🔴 Servidor ${MC_HOST}:${MC_PORT} DESLIGOU / CAIU!`);
                
                // Notificação no WhatsApp
                whatsappManager.sendAdminAlert(
                    `╭──────────────────────────────╮\n` +
                    `│ 🚨 *SERVIDOR MINECRAFT CAIU!* │\n` +
                    `╰──────────────────────────────╯\n` +
                    `> 🌐 *Endereço:* ${MC_HOST}:${MC_PORT}\n` +
                    `> ⏱️ *Horário:* ${new Date().toLocaleTimeString('pt-BR')}\n` +
                    `> ⚠️ *Status:* Sem resposta (Offline)\n\n` +
                    `*Ações:* [5] Status | [0] Menu`
                );

                if (alertsChannel) {
                    alertsChannel.send({
                        content: `${mentionOwner()} @everyone 🚨 **O SERVIDOR MINECRAFT DESLIGOU OU CAIU!**\n> 🌐 **Endereço:** \`${MC_HOST}:${MC_PORT}\`\n> ⏱️ Horário: <t:${Math.floor(Date.now()/1000)}:T>`
                    }).catch(()=>{});
                }
                if (eventsChannel) {
                    eventsChannel.send(`🔴 **[SERVIDOR CAIU/DESLIGOU]** O servidor Minecraft ${MC_HOST}:${MC_PORT} parou de responder.`).catch(()=>{});
                }
                previousPlayerList.clear();
            }
            serverState.online = false;
            serverState.ping = -1;
            serverState.players = { online: 0, max: 20, list: [] };
        }

        if (serverStatusChannel) {
            if (serverStatusMessage) {
                await serverStatusMessage.edit({
                    embeds: [serverStatusEmbed()],
                    components: serverStatusRow()
                }).catch(async () => {
                    serverStatusMessage = await serverStatusChannel.send({
                        embeds: [serverStatusEmbed()],
                        components: serverStatusRow()
                    }).catch(()=>{});
                });
            } else {
                serverStatusMessage = await serverStatusChannel.send({
                    embeds: [serverStatusEmbed()],
                    components: serverStatusRow()
                }).catch(()=>{});
            }
        }

    } catch (e) {
        console.error("[SERVER-MONITOR] Erro no updateServerStatusLoop:", e.message);
    }
}

// ============ EMBEDS GIGANTES E ULTRA DETALHADOS ============
function botsEmbed(){
    const total = bots.length;
    const isOnline = mcState === "online";
    const statusGlobal = isOnline ? "🟢 **1 Bot Ativo**" : mcState === "conectando" ? "🟡 **Conectando...**" : "⚫ **Todos Offline**";
    
    const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🎮 Ph4nt0m Manager — Painel de Controle de Bots")
        .setDescription(
            `### 🌟 Painel Central AFK 24/7\n` +
            `Gerencie seus bots Minecraft diretamente por aqui com suporte a reconexão automática, logs em tempo real e monitoramento de chunks.\n\n` +
            `**📊 Status Geral do Sistema:**\n` +
            `> 🤖 **Total de Bots:** \`${total}\` | 🌐 **Status Atual:** ${statusGlobal}\n` +
            `> 🔄 **Auto-Reconnect:** \`${autoReconnect ? "✅ ATIVADO (5s)" : "❌ DESATIVADO"}\`\n` +
            `> ⏱️ **Monitoramento Contínuo:** \`${getBotUptime()}\`\n` +
            `> 🖥️ **Status do Servidor:** \`${serverState.online ? "🟢 ONLINE (" + serverState.players.online + " players)" : "🔴 OFFLINE"}\`\n` +
            `> 📱 **WhatsApp Bot:** \`${whatsappManager.state.toUpperCase()}\`\n\n` +
            `**🛠️ Ações Rápidas Disponíveis:**\n` +
            `> ➕ **Criar Bot:** Cadastra novo host/porta/nick\n` +
            `> ⚙️ **Configurar IP:** Modifica endereço do bot selecionado\n` +
            `> 📝 **Renomear:** Altera o nick do bot no Minecraft\n` +
            `> 🎮 **Gamemode:** Altera o modo de jogo do bot (/gamemode)\n` +
            `> ▶️ **Iniciar Bot:** Dispara a conexão com o embed ao vivo\n` +
            `> ⏹️ **Parar Bot:** Encerra a conexão com segurança\n`
        )
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(MC_USER)}/128`)
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m AFK Manager • ${total} bot(s) configurado(s)`, iconURL: `https://mc-heads.net/avatar/${encodeURIComponent(MC_USER)}/32` });

    bots.forEach((b, i) => {
        const isPrimary = i === 0;
        let stText = "⚫ OFFLINE";
        if (isPrimary) {
            if (mcState === "online") stText = "🟢 ONLINE & ATIVO";
            else if (mcState === "conectando") stText = "🟡 CONECTANDO...";
            else if (mcState === "caido") stText = "🔴 DESCONECTADO / CAÍDO";
            else stText = "⭐ SELECIONADO (PRONTO)";
        }
        
        const up = (isPrimary && mcState === "online") ? getUptime() : "—";
        const ka = (isPrimary && mcState === "online") ? `${mcInfo.kaCount} pacotes` : "0";

        e.addFields({
            name: `${isPrimary ? "⭐" : "🤖"} #${i+1} — ${b.name} ${isPrimary ? "*(Principal)*" : ""}`,
            value: 
                `> 🌐 **Servidor:** \`${b.host}:${b.port}\`\n` +
                `> 👤 **Nick:** \`${b.user}\` • 📦 **Versão:** \`${b.version}\`\n` +
                `> 📡 **Status:** \`${stText}\`\n` +
                `> 💓 **KeepAlives:** \`${ka}\` • ⏳ **Uptime:** \`${up}\`\n` +
                `> 📅 **Criado em:** <t:${Math.floor(new Date(b.createdAt).getTime()/1000)}:R>`,
            inline: false
        });
    });

    return e;
}

function botsRows(){
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_bot_start").setLabel("▶️ Iniciar Bot").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_bot_stop").setLabel("⏹️ Parar Bot").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_gamemode").setLabel("🎮 Gamemode").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_bot_config_ip").setLabel("⚙️ Configurar IP").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_bot_rename").setLabel("📝 Renomear").setStyle(ButtonStyle.Secondary),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_bot_create").setLabel("➕ Criar Bot").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_bot_delete").setLabel("🗑️ Deletar Bot").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_autoreconnect").setLabel(autoReconnect ? "🔄 Auto: ON" : "🔄 Auto: OFF").setStyle(autoReconnect ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_bot_refresh").setLabel("🔄 Atualizar").setStyle(ButtonStyle.Secondary),
    );

    let rows = [row1, row2];
    if(bots.length > 1){
        const select = new StringSelectMenuBuilder()
            .setCustomId("select_bot")
            .setPlaceholder("🎯 Selecione o bot primário para operar")
            .addOptions(bots.slice(0, 25).map((b, i) => ({
                label: `${b.name} (${b.user})`,
                value: b.id,
                description: `${b.host}:${b.port} • Versão ${b.version}`,
                default: i === 0
            })));
        rows.push(new ActionRowBuilder().addComponents(select));
    }
    return rows;
}

function gamemodeRow() {
    const select = new StringSelectMenuBuilder()
        .setCustomId("select_gamemode")
        .setPlaceholder("🎮 Escolha o modo de jogo (Gamemode)")
        .addOptions([
            { label: "Sobrevivência (Survival)", value: "survival", description: "Modo padrão de sobrevivência", emoji: "🟢" },
            { label: "Criativo (Creative)", value: "creative", description: "Imortalidade e blocos infinitos", emoji: "🟣" },
            { label: "Aventura (Adventure)", value: "adventure", description: "Modo mapa de aventura", emoji: "🔵" },
            { label: "Espectador (Spectator)", value: "spectator", description: "Voar livremente pelo mapa", emoji: "👁️" }
        ]);
    return new ActionRowBuilder().addComponents(select);
}

function initiatingEmbed(botCfg = getSelectedBot()) {
    const user = botCfg ? botCfg.user : MC_USER;
    const host = botCfg ? botCfg.host : MC_HOST;
    const port = botCfg ? botCfg.port : MC_PORT;
    const ver = botCfg ? botCfg.version : MC_VERSION;

    return new EmbedBuilder()
        .setColor(0xf1c40f)
        .setTitle(`🔄 ${botCfg ? botCfg.name : "Ph4nt0m"} AFK — INICIANDO CONEXÃO...`)
        .setDescription(
            `${mentionOwner()} @everyone\n\n` +
            `> ⏳ **Estabelecendo handshake TCP & autenticação...**\n` +
            `> *Esta mensagem será atualizada automaticamente assim que o bot entrar no mundo!*`
        )
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(user)}/128`)
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m AFK Manager • Conectando a ${host}:${port}`, iconURL: `https://mc-heads.net/avatar/${encodeURIComponent(user)}/32` })
        .addFields(
            { name: "🌐 Servidor", value: `\`${host}:${port}\``, inline: true },
            { name: "👤 Nick do Bot", value: `\`${user}\``, inline: true },
            { name: "📦 Versão & Protocolo", value: `\`${ver}\``, inline: true },
            { name: "🔢 Sessão / Tentativa", value: `\`#${mcInfo.tentativas}\``, inline: true },
            { name: "📡 Status", value: "`🟡 CONECTANDO AO MUNDO...`", inline: true },
            { name: "🔄 Auto-Reconnect", value: autoReconnect ? "`✅ ATIVADO (5s)`" : "`❌ DESATIVADO`", inline: true },
            { name: "📍 Posição no Mapa", value: "`⏳ Aguardando spawn...`", inline: true },
            { name: "🎮 Gamemode", value: "`⏳ Aguardando pacotes...`", inline: true },
            { name: "💬 Modo de Chat", value: "`⏳ Configurando...`", inline: true },
        );
}

function liveConnectedEmbed(botCfg = getSelectedBot()) {
    const user = botCfg ? botCfg.user : MC_USER;
    const host = botCfg ? botCfg.host : MC_HOST;
    const port = botCfg ? botCfg.port : MC_PORT;
    const ver = botCfg ? botCfg.version : MC_VERSION;
    const uptime = getUptime();

    let coordStr = mcInfo.coords !== "Desconhecido" ? mcInfo.coords : "📍 Coordenadas em sincronização...";
    let netherStr = "—";
    
    if (mcInfo.coords && mcInfo.coords.includes("X:")) {
        try {
            const matches = mcInfo.coords.match(/X:\s*([-\d.]+),\s*Y:\s*([-\d.]+),\s*Z:\s*([-\d.]+)/);
            if (matches) {
                const nx = (parseFloat(matches[1]) / 8).toFixed(1);
                const nz = (parseFloat(matches[3]) / 8).toFixed(1);
                const cx = Math.floor(parseFloat(matches[1]) / 16);
                const cz = Math.floor(parseFloat(matches[3]) / 16);
                netherStr = `Nether: \`X: ${nx}, Z: ${nz}\` • Chunk: \`[${cx}, ${cz}]\``;
            }
        } catch {}
    }

    const gmStr = mcInfo.gamemode !== "?" ? mcInfo.gamemode : "Detectado no Login";
    const chatStr = mcInfo.chatmode !== "?" ? (mcInfo.chatmode === "enabled" ? "Habilitado (Chat & Comandos)" : mcInfo.chatmode) : "Habilitado";

    const e = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle(`🟢 ${botCfg ? botCfg.name : "Ph4nt0m"} AFK — ONLINE & CONECTADO`)
        .setDescription(
            `${mentionOwner()} @everyone\n\n` +
            `> ✅ **Bot conectado com sucesso ao servidor Minecraft!**\n` +
            `> ⏱️ Uptime sincronizado ao vivo • Atualizado <t:${Math.floor(Date.now()/1000)}:R>`
        )
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(user)}/128`)
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m AFK • 24/7 Ativo • Uptime: ${uptime} • Server ON há ${getBotUptime()}`, iconURL: `https://mc-heads.net/avatar/${encodeURIComponent(user)}/32` })
        .addFields(
            { name: "🌐 Servidor", value: `\`${host}:${port}\``, inline: true },
            { name: "👤 Nick", value: `\`${user}\``, inline: true },
            { name: "📦 Versão & Protocolo", value: `\`${ver}\``, inline: true },
            { name: "📡 Estado Atual", value: "`🟢 ONLINE (PLAY STATE)`", inline: true },
            { name: "⏱️ Conectado em", value: `<t:${Math.floor((mcStartTime||Date.now())/1000)}:T>`, inline: true },
            { name: "⏳ Uptime da Sessão", value: `\`${uptime}\``, inline: true },
            { name: "🎮 Gamemode", value: `\`${gmStr}\``, inline: true },
            { name: "💬 Modo de Chat", value: `\`${chatStr}\``, inline: true },
            { name: "💓 KeepAlives", value: `\`${mcInfo.kaCount} pacotes respondidos\``, inline: true },
            { name: "📍 Posição Overworld", value: `\`${coordStr}\``, inline: false },
            { name: "🧭 Navegação & Chunk", value: netherStr !== "—" ? netherStr : "`Sincronizando chunks...`", inline: false },
            { name: "🔄 Auto-Reconnect", value: autoReconnect ? "`✅ ATIVADO (Reconecta em 5s se cair)`" : "`❌ DESATIVADO (Manual)`", inline: true },
            { name: "🔢 Sessão #", value: `\`#${mcInfo.tentativas}\``, inline: true },
            { name: "📜 Eventos Gravados", value: `\`${sessionLogs.length} eventos nesta sessão\``, inline: true }
        );
    return e;
}

function disconnectedEmbed(reason, type = "desconectado", botCfg = getSelectedBot()) {
    const user = botCfg ? botCfg.user : MC_USER;
    const host = botCfg ? botCfg.host : MC_HOST;
    const port = botCfg ? botCfg.port : MC_PORT;

    let title = "⚠️ Ph4nt0m Desconectado";
    let color = 0xe67e22;
    if (type === "kickado") { title = "🥾 Ph4nt0m foi Kickado!"; color = 0xe74c3c; }
    else if (type === "banido") { title = "🔨 Ph4nt0m foi Banido!"; color = 0x992d22; }
    else if (type === "morto") { title = "💀 Ph4nt0m Morreu no Servidor!"; color = 0x71368a; }
    else if (type === "erro") { title = "❌ Erro de Conexão no Ph4nt0m"; color = 0xe74c3c; }

    const uptime = mcStartTime ? getUptime() : "—";
    const e = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(`${mentionOwner()} @everyone\n\n> ⚠️ **A conexão com o servidor foi encerrada.**`)
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(user)}/128`)
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m Bot • Status: ${type}`, iconURL: `https://mc-heads.net/avatar/${encodeURIComponent(user)}/32` })
        .addFields(
            { name: "🌐 Servidor", value: `\`${host}:${port}\``, inline: true },
            { name: "👤 Nick", value: `\`${user}\``, inline: true },
            { name: "⏱️ Ficou online por", value: `\`${uptime}\``, inline: true },
            { name: "📍 Última posição", value: `\`${mcInfo.coords}\``, inline: true },
            { name: "💓 KeepAlives", value: `\`${mcInfo.kaCount}\``, inline: true },
            { name: "🔁 Tentativa #", value: `\`#${mcInfo.tentativas}\``, inline: true },
            { name: `📄 Motivo do Encerramento (${type})`, value: `\`\`\`${(reason || "Desconexão sem motivo explícito (timeout / reinício do servidor)").slice(0, 1000)}\`\`\``, inline: false },
            { name: "🔄 Próxima Ação", value: autoReconnect ? "> 🔄 **Tentando reconectar automaticamente em 5s...**\n> *(Clique em Disconnect para cancelar)*" : "> 🛑 **Auto-reconnect desativado.** Clique em **Reconectar Agora** ou no painel `/bots`.", inline: false }
        );
    return e;
}

function fallenRow() {
    const autoLabel = autoReconnect ? "🔄 Auto: ON" : "🔄 Auto: OFF";
    const autoStyle = autoReconnect ? ButtonStyle.Success : ButtonStyle.Secondary;
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_reconectar").setLabel("🔄 Reconectar Agora").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_desligar").setLabel("🔴 Disconnect").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_gamemode").setLabel("🎮 Gamemode").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_kill").setLabel("💀 Kill").setStyle(ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_autoreconnect").setLabel(autoLabel).setStyle(autoStyle),
        new ButtonBuilder().setCustomId("btn_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_bot_menu").setLabel("🤖 Painel Bots").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_server_refresh").setLabel("🌐 Status Servidor").setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2];
}

// ============ MC CONNECTION MANAGER ============
async function sendToChannel(payload) {
    try {
        const ch = await client.channels.fetch(CHANNEL_ID);
        if (!ch) return null;
        return await ch.send(payload);
    } catch (e) { console.error("Erro ao enviar mensagem:", e.message); return null; }
}

function startLiveUpdate() {
    if (liveInterval) clearInterval(liveInterval);
    liveInterval = setInterval(async () => {
        if (mcState !== "online" || !liveMessage) {
            clearInterval(liveInterval);
            liveInterval = null;
            return;
        }
        try {
            await liveMessage.edit({
                content: `${mentionOwner()} @everyone`,
                embeds: [liveConnectedEmbed()],
                components: fallenRow(),
                allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
            });
        } catch(e) {}
    }, 1000);
}

function stopLiveUpdate() {
    if (liveInterval) { clearInterval(liveInterval); liveInterval = null; }
}

function killMC() {
    stopLiveUpdate();
    if (mcProcess) {
        try { mcProcess.kill(); } catch {}
        mcProcess = null;
    }
}

function sendBotCommand(cmd) {
    if (mcProcess && mcProcess.stdin && mcProcess.stdin.writable) {
        try {
            mcProcess.stdin.write(`cmd:${cmd}\n`);
            console.log(`[MC-STDIN] Comando enviado: ${cmd}`);
            return true;
        } catch (e) {
            console.error("Erro ao enviar comando para o bot:", e.message);
        }
    }
    return false;
}

function setBotGamemode(mode) {
    if (mcProcess && mcProcess.stdin && mcProcess.stdin.writable) {
        try {
            mcProcess.stdin.write(`gm:${mode}\n`);
            console.log(`[MC-STDIN] Gamemode set: ${mode}`);
            return true;
        } catch (e) {
            console.error("Erro ao setar gamemode:", e.message);
        }
    }
    return false;
}

function startMC() {
    if (mcProcess) killMC();
    if (shuttingDown) return;

    syncPrimary();
    const botCfg = getSelectedBot();
    const host = botCfg ? botCfg.host : MC_HOST;
    const port = botCfg ? botCfg.port : MC_PORT;
    const user = botCfg ? botCfg.user : MC_USER;

    mcState = "conectando";
    mcInfo.tentativas++;
    mcInfo.kaCount = 0;
    mcInfo.coords = "Desconhecido";
    mcInfo.gamemode = "?";
    mcInfo.chatmode = "?";
    mcInfo.motivo = "";
    mcStartTime = Date.now();
    clearSessionLogs();
    runningBotId = botCfg ? botCfg.id : "phant0m";

    addLog("connect", `Tentativa #${mcInfo.tentativas} — Conectando em ${host}:${port} como ${user}`, `Bot: ${botCfg ? botCfg.name : "Ph4nt0m"}`);
    console.log(`[MC] Iniciando conexão (#${mcInfo.tentativas}) → ${host}:${port} como ${user}`);

    sendToChannel({
        content: `${mentionOwner()} @everyone`,
        embeds: [initiatingEmbed(botCfg)],
        components: fallenRow(),
        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
    }).then(msg => {
        if (msg) liveMessage = msg;
    });

    const botPath = path.join(__dirname, "bot.py");
    mcProcess = spawn(PYTHON_EXE, [botPath, host, String(port), user], { cwd: __dirname });

    let buffer = "";
    mcProcess.stdout.on("data", (data) => {
        const text = data.toString();
        buffer += text;
        const lines = text.split("\n");
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            console.log(`[MC] ${line}`);

            if (line.startsWith("[COORDS]")) {
                const m = line.match(/X=([-\d.]+)\s+Y=([-\d.]+)\s+Z=([-\d.]+)/);
                if (m) {
                    const x = parseFloat(m[1]), y = parseFloat(m[2]), z = parseFloat(m[3]);
                    mcInfo.coords = `X: ${x.toFixed(1)}, Y: ${y.toFixed(1)}, Z: ${z.toFixed(1)}`;
                }
            } else if (line.startsWith("[GAMEMODE]")) {
                const m = line.match(/\[GAMEMODE\]\s*(\d+)\s*\(([^)]+)\)/);
                if (m) mcInfo.gamemode = `${m[2]} (${m[1]})`;
                else { const raw2 = line.replace("[GAMEMODE]","").trim(); if(raw2) mcInfo.gamemode = raw2; }
            } else if (line.startsWith("[CHATMODE]")) {
                const val = line.replace("[CHATMODE]","").trim();
                if (val) mcInfo.chatmode = val;
            } else if (line.includes("[+] PLAY STATE!") || line.includes("PLAY STATE")) {
                mcState = "online";
                mcStartTime = Date.now();
                addLog("play", "Entrou no servidor — PLAY STATE", `Coords: ${mcInfo.coords}`);
                
                // Notificação de Rejoin/Conexão no WhatsApp!
                whatsappManager.sendAdminAlert(
                    `╭──────────────────────────────╮\n` +
                    `│ 🟢 *PH4NT0M — ONLINE & CONECTADO* │\n` +
                    `╰──────────────────────────────╯\n` +
                    `> 🌐 *Servidor:* ${host}:${port}\n` +
                    `> 👤 *Nick:* ${user}\n` +
                    `> 📦 *Versão:* ${MC_VERSION}\n` +
                    `> 📡 *Estado:* 🟢 ONLINE (PLAY STATE)\n` +
                    `> ⏱️ *Conectado em:* ${new Date().toLocaleTimeString('pt-BR')}\n` +
                    `> ⏳ *Uptime:* 0s\n` +
                    `> 🎮 *Gamemode:* ${mcInfo.gamemode}\n` +
                    `> 📍 *Posição:* ${mcInfo.coords}\n` +
                    `> 🔄 *Auto-Reconnect:* ${autoReconnect ? "✅ ATIVADO (5s)" : "❌ DESATIVADO"}\n` +
                    `> 🔢 *Sessão:* #${mcInfo.tentativas}\n\n` +
                    `┌────────────────────────────┐\n` +
                    `│   🎮 *AÇÕES RÁPIDAS*         │\n` +
                    `└────────────────────────────┘\n` +
                    `[1] Iniciar  [2] Parar  [3] Reconectar  [4] Gamemode\n` +
                    `[5] Status   [6] Auto   [7] Players     [8] Chat/Cmd   [0] Menu`
                );

                if (liveMessage) {
                    liveMessage.edit({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [liveConnectedEmbed(botCfg)],
                        components: fallenRow(),
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    }).catch(() => {
                        sendToChannel({
                            content: `${mentionOwner()} @everyone`,
                            embeds: [liveConnectedEmbed(botCfg)],
                            components: fallenRow(),
                            allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                        }).then(msg => { if (msg) liveMessage = msg; });
                    });
                } else {
                    sendToChannel({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [liveConnectedEmbed(botCfg)],
                        components: fallenRow(),
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    }).then(msg => { if (msg) liveMessage = msg; });
                }
                startLiveUpdate();
            } else if (line.includes("[KA #")) {
                const m = line.match(/\[KA #(\d+)\]/);
                if (m) {
                    mcInfo.kaCount = parseInt(m[1]);
                    if (mcInfo.kaCount % 5 === 0) {
                        addLog("keepalive", `KeepAlive #${m[1]} respondido com sucesso`, `Uptime ${getUptime()}`);
                    }
                }
            } else if (line.includes("[!] Kick")) {
                mcInfo.motivo = line;
                const lower = line.toLowerCase();
                let type = "kickado";
                if (lower.includes("ban")) type = "banido";
                mcState = "caido";
                addLog(type, line.slice(0,200), `Uptime ${getUptime()} KA ${mcInfo.kaCount}`);
                
                // Notificação no WhatsApp de Kick/Ban!
                whatsappManager.sendAdminAlert(
                    `╭──────────────────────────────╮\n` +
                    `│ 🚨 *ALERTA: PH4NT0M FOI ${type.toUpperCase()}!* │\n` +
                    `╰──────────────────────────────╯\n` +
                    `> 🌐 *Servidor:* ${host}:${port}\n` +
                    `> 👤 *Nick:* ${user}\n` +
                    `> ⏱️ *Ficou online por:* ${getUptime()}\n` +
                    `> 📍 *Últimas Coords:* ${mcInfo.coords}\n` +
                    `> 💓 *KeepAlives:* ${mcInfo.kaCount}\n` +
                    `> 📄 *Motivo:* ${(line || "Kick").slice(0, 200)}\n` +
                    `> 🔄 *Próxima Ação:* ${autoReconnect ? "Tentando reconectar automaticamente em 5s..." : "Auto-reconnect desativado."}\n\n` +
                    `┌────────────────────────────┐\n` +
                    `│   🎮 *AÇÕES RÁPIDAS*         │\n` +
                    `└────────────────────────────┘\n` +
                    `[1] Reconectar Agora  [2] Desligar  [5] Status  [0] Menu`
                );

                if (alertsChannel) {
                    alertsChannel.send({
                        content: `${mentionOwner()} @everyone 🚨 **ALERTA: O BOT FOI KICKADO/BANIDO!**`,
                        embeds: [disconnectedEmbed(line, type, botCfg)]
                    }).catch(()=>{});
                }

                stopLiveUpdate();
                if (liveMessage) {
                    liveMessage.edit({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [disconnectedEmbed(line, type, botCfg)],
                        components: fallenRow(),
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    }).catch(() => sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [disconnectedEmbed(line, type, botCfg)], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
                    liveMessage = null;
                }
            } else if (line.includes("Player morreu")) {
                mcInfo.motivo = "Morto por Phantom/mob — respawn automático";
                console.log("[MC] Morte detectada, respawnando...");
                addLog("death", "Player morreu — respawn automático enviado", `Coords: ${mcInfo.coords}`);
                if (serverChatChannel) {
                    serverChatChannel.send(`💀 **\`${MC_USER}\`** morreu no servidor (respawn automático acionado).`).catch(()=>{});
                }
            }
        }
    });

    mcProcess.stderr.on("data", (data) => {
        const txt = data.toString().trim();
        if (txt) console.error(`[MC-ERR] ${txt}`);
        if (txt.toLowerCase().includes("ban")) mcInfo.motivo = txt;
    });

    mcProcess.on("close", (code) => {
        console.log(`[MC] Processo finalizado (code=${code}) state=${mcState}`);
        const uptime = mcStartTime ? getUptime() : "—";
        if (shuttingDown) { mcState = "desligado"; return; }

        stopLiveUpdate();
        let sendType = "desconectado";
        if (mcState === "conectando") {
            mcState = "caido";
            mcInfo.motivo = `Falha ao conectar no servidor (code ${code})`;
            sendType = "erro";
        } else if (mcState === "online") {
            mcState = "caido";
            if (!mcInfo.motivo) mcInfo.motivo = `Desconectado após ${uptime} online`;
            if (buffer.includes("morreu")) sendType = "morto";
        } else {
            mcState = "caido";
            if (!mcInfo.motivo) mcInfo.motivo = `Desconectado (code ${code})`;
        }

        if (mcInfo.motivo.toLowerCase().includes("ban")) sendType = "banido";
        else if (mcInfo.motivo.toLowerCase().includes("kick")) sendType = "kickado";

        addLog(sendType, mcInfo.motivo.slice(0,300), `Uptime ${uptime} KA ${mcInfo.kaCount} Code ${code}`);
        generateHTMLLog(mcInfo.motivo, sendType);

        // Notifica queda no WhatsApp se não foi kick (kick já notificou)
        if (sendType !== "kickado" && sendType !== "banido") {
            whatsappManager.sendAdminAlert(
                `╭──────────────────────────────╮\n` +
                `│ ⚠️ *PH4NT0M DESCONECTADO*     │\n` +
                `╰──────────────────────────────╯\n` +
                `> 🌐 *Servidor:* ${host}:${port}\n` +
                `> 👤 *Nick:* ${user}\n` +
                `> ⏱️ *Ficou online por:* ${uptime}\n` +
                `> 📍 *Últimas Coords:* ${mcInfo.coords}\n` +
                `> 💓 *KeepAlives:* ${mcInfo.kaCount}\n` +
                `> 📄 *Motivo:* ${mcInfo.motivo}\n` +
                `> 🔄 *Auto-Reconnect:* ${autoReconnect ? "Reconectando em 5s..." : "Desativado"}\n\n` +
                `┌────────────────────────────┐\n` +
                `│   🎮 *AÇÕES RÁPIDAS*         │\n` +
                `└────────────────────────────┘\n` +
                `[1] Reconectar Agora  [2] Desligar  [5] Status  [0] Menu`
            );
        }

        if (alertsChannel && (sendType === "kickado" || sendType === "banido" || sendType === "erro")) {
            alertsChannel.send({
                content: `${mentionOwner()} @everyone 🚨 **O bot AFK foi desconectado do servidor!**`,
                embeds: [disconnectedEmbed(mcInfo.motivo, sendType, botCfg)]
            }).catch(()=>{});
        }

        const embed = disconnectedEmbed(mcInfo.motivo, sendType, botCfg);
        if (liveMessage) {
            liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } })
                .catch(() => sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
            liveMessage = null;
        } else {
            sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } });
        }

        runningBotId = null;
        mcProcess = null;

        if (autoReconnect && !shuttingDown && serverState.online) {
            console.log("[MC] Auto-reconnect ATIVADO: reconectando em 5 segundos...");
            setTimeout(() => startMC(), 5000);
        }
    });

    mcProcess.on("error", (err) => {
        console.error("[MC] Spawn error:", err.message);
        mcState = "caido";
        runningBotId = null;
        mcInfo.motivo = `Erro ao iniciar processo Python: ${err.message}`;
        addLog("error", mcInfo.motivo, err.stack?.slice(0,500)||"");
        generateHTMLLog(mcInfo.motivo, "erro");
        sendToChannel({
            content: `${mentionOwner()} @everyone`,
            embeds: [disconnectedEmbed(mcInfo.motivo, "erro", botCfg)],
            components: fallenRow(),
            allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
        });
        if (autoReconnect && serverState.online) setTimeout(() => startMC(), 5000);
    });
}

// ============ DISCORD CLIENT & EVENTS ============
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

client.on("ready", async () => {
    console.log(`[DISCORD] Logado com sucesso como ${client.user.tag}`);

    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder().setName("bots").setDescription("🤖 Painel Central de Gerenciamento de Bots").toJSON(),
        new SlashCommandBuilder().setName("whatsapp").setDescription("📱 Abre o painel de pareamento e controle do WhatsApp").toJSON(),
        new SlashCommandBuilder().setName("servidor").setDescription("🟢 Exibe o status ao vivo do servidor Minecraft").toJSON(),
        new SlashCommandBuilder().setName("conectar").setDescription("🟢 Conecta o bot principal no servidor Minecraft").toJSON(),
        new SlashCommandBuilder().setName("desconectar").setDescription("🔴 Desconecta o bot do servidor Minecraft").toJSON(),
        new SlashCommandBuilder().setName("reconectar").setDescription("🔄 Força a reconexão imediata do bot").toJSON(),
        new SlashCommandBuilder().setName("gamemode").setDescription("🎮 Altera o modo de jogo do bot no servidor").toJSON(),
        new SlashCommandBuilder().setName("status").setDescription("📊 Exibe o status completo e métricas do bot").toJSON(),
        new SlashCommandBuilder().setName("logs").setDescription("📜 Baixa e visualiza os logs detalhados em HTML").toJSON(),
    ];
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("[DISCORD] Slash commands registrados com sucesso");
    } catch (e) { console.error("Erro ao registrar comandos:", e.message); }

    try {
        const ch = await client.channels.fetch(CHANNEL_ID);
        if (ch) {
            if (ch.guild) {
                await setupLogChannels(ch.guild);
            }
            await ch.send({
                content: `${mentionOwner()} @everyone`,
                embeds: [botsEmbed()],
                components: botsRows(),
                allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
            });
            console.log("[DISCORD] Painel /bots inicial enviado");
        }
    } catch (e) { console.error("Erro ao enviar painel inicial:", e.message); }

    // Inicializa WhatsApp Manager
    console.log("[WA] Inicializando WhatsApp Manager...");
    whatsappManager.init();

    // Inicia loop de ping e monitoramento do servidor Minecraft (a cada 6s)
    updateServerStatusLoop();
    setInterval(updateServerStatusLoop, 6000);
});

client.on("interactionCreate", async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            const cmd = interaction.commandName;
            if (cmd === "bots") {
                await interaction.reply({ embeds: [botsEmbed()], components: botsRows(), ephemeral: false });
            } else if (cmd === "whatsapp") {
                await updateWhatsAppControlPanel();
                await interaction.reply({ content: "📱 **Painel do WhatsApp atualizado no canal dedicado!**", ephemeral: true });
            } else if (cmd === "servidor") {
                await interaction.reply({ embeds: [serverStatusEmbed()], components: serverStatusRow(), ephemeral: false });
            } else if (cmd === "conectar") {
                await interaction.deferReply();
                if (mcState === "online") {
                    await interaction.editReply({ content: `⚠️ **O bot já está online há \`${getUptime()}\` em \`${MC_HOST}:${MC_PORT}\`!**` });
                    return;
                }
                shuttingDown = false;
                await interaction.editReply({ content: "🚀 **Iniciando conexão... Acompanhe o embed abaixo!**" });
                startMC();
            } else if (cmd === "desconectar") {
                await interaction.deferReply();
                shuttingDown = true;
                killMC();
                mcState = "desligado";
                shuttingDown = false;
                await interaction.editReply({ content: "🔴 **Bot desconectado manualmente.**" });
            } else if (cmd === "reconectar") {
                await interaction.deferReply();
                killMC();
                await interaction.editReply({ content: "🔄 **Reiniciando conexão em 1.5s...**" });
                setTimeout(() => startMC(), 1500);
            } else if (cmd === "gamemode") {
                await interaction.reply({ content: "🎮 **Selecione o modo de jogo desejado abaixo:**", components: [gamemodeRow()], ephemeral: true });
            } else if (cmd === "status") {
                const isOnline = mcState === "online";
                const embed = isOnline ? liveConnectedEmbed() : disconnectedEmbed(mcInfo.motivo, mcState);
                await interaction.reply({ embeds: [embed], ephemeral: false });
            } else if (cmd === "logs") {
                await showLogsModalOrEmbed(interaction);
            }
        } else if (interaction.isButton()) {
            const id = interaction.customId;
            if (id === "btn_bot_start" || id === "btn_conectar") {
                await interaction.deferUpdate();
                if (mcState === "online") {
                    await interaction.followUp({ content: `⚠️ **O bot já está online há \`${getUptime()}\`!**`, ephemeral: true });
                    return;
                }
                shuttingDown = false;
                startMC();
            } else if (id === "btn_bot_stop" || id === "btn_desligar") {
                await interaction.deferUpdate();
                shuttingDown = true;
                killMC();
                mcState = "desligado";
                if (liveMessage) {
                    try {
                        await liveMessage.edit({
                            content: `${mentionOwner()} @everyone`,
                            embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle("🔌 Ph4nt0m Desconectado").setDescription(`Bot desconectado manualmente por <@${interaction.user.id}>.\nUse **▶️ Iniciar Bot** para religar.`).setTimestamp()],
                            components: fallenRow(),
                            allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                        });
                    } catch {}
                    liveMessage = null;
                }
                shuttingDown = false;
            } else if (id === "btn_reconectar") {
                await interaction.deferUpdate();
                shuttingDown = false;
                killMC();
                setTimeout(() => startMC(), 1500);
            } else if (id === "btn_gamemode") {
                await interaction.reply({ content: "🎮 **Escolha o Gamemode para aplicar no bot:**", components: [gamemodeRow()], ephemeral: true });
            } else if (id === "btn_server_refresh") {
                await updateServerStatusLoop();
                if (interaction.message) {
                    await interaction.update({ embeds: [serverStatusEmbed()], components: serverStatusRow() });
                } else {
                    await interaction.reply({ embeds: [serverStatusEmbed()], components: serverStatusRow(), ephemeral: true });
                }
            } else if (id === "btn_wa_connect_qr") {
                await interaction.deferReply({ ephemeral: true });
                await whatsappManager.connect();
                await interaction.editReply({ content: "📱 **Tentando gerar novo QR Code... Verifique o painel do WhatsApp!**" });
                await updateWhatsAppControlPanel();
            } else if (id === "btn_wa_pairing_code") {
                const modal = new ModalBuilder().setCustomId("modal_wa_pairing").setTitle("🔢 Conectar WhatsApp por Código");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("wa_phone_number").setLabel("Número com DDD (ex: 5511999999999)").setStyle(TextInputStyle.Short).setPlaceholder("5511999999999").setRequired(true))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_wa_disconnect") {
                await interaction.deferReply({ ephemeral: true });
                await whatsappManager.logout();
                await interaction.editReply({ content: "🔌 **Sessão do WhatsApp deslogada e resetada com sucesso.**" });
                await updateWhatsAppControlPanel();
            } else if (id === "btn_wa_refresh") {
                await interaction.deferUpdate();
                await updateWhatsAppControlPanel();
            } else if (id === "btn_wa_confirm_admin") {
                if (whatsappManager.config.pendingAdminRequest) {
                    const req = whatsappManager.config.pendingAdminRequest;
                    whatsappManager.confirmAdmin(req.jid, req.name);
                    await interaction.update({
                        content: `✅ **Número \`+${req.number}\` (${req.name}) foi AUTORIZADO como Administrador do WhatsApp com sucesso!**`,
                        embeds: [],
                        components: []
                    });
                    await updateWhatsAppControlPanel();
                } else {
                    await interaction.reply({ content: "❌ Nenhuma solicitação pendente no momento.", ephemeral: true });
                }
            } else if (id === "btn_wa_reject_admin") {
                whatsappManager.rejectAdmin();
                await interaction.update({
                    content: `❌ **Solicitação de vinculação de administrador foi recusada.**`,
                    embeds: [],
                    components: []
                });
            } else if (id === "btn_kill") {
                await interaction.deferUpdate();
                shuttingDown = true;
                killMC();
                mcState = "desligado";
                try {
                    await sendToChannel({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [new EmbedBuilder().setColor(0x000000).setTitle("💀 PROCESSO ENCERRADO").setDescription(`**Aplicação finalizada por <@${interaction.user.id}>**\nAuto-reconnect desativado.`).setTimestamp()],
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    });
                } catch {}
                setTimeout(async () => {
                    try { await client.destroy(); } catch {}
                    process.exit(0);
                }, 1500);
            } else if (id === "btn_autoreconnect") {
                autoReconnect = !autoReconnect;
                addLog("info", `Auto-Reconnect alterado para: ${autoReconnect ? "ATIVADO (5s)" : "DESATIVADO"}`);

                try {
                    if (interaction.message) {
                        if (interaction.message.embeds?.[0]?.title?.includes("Manager")) {
                            await interaction.update({ embeds: [botsEmbed()], components: botsRows() });
                        } else {
                            await interaction.update({ components: fallenRow() });
                        }
                    } else {
                        await interaction.deferUpdate();
                    }
                } catch {
                    try { await interaction.deferUpdate(); } catch {}
                }

                if (autoReconnect && mcState !== "online" && mcState !== "conectando" && serverState.online) {
                    console.log("[MC] Auto-reconnect ativado: iniciando conexão em 2s...");
                    setTimeout(() => startMC(), 2000);
                }
            } else if (id === "btn_bot_refresh") {
                await interaction.update({ embeds: [botsEmbed()], components: botsRows() });
            } else if (id === "btn_bot_menu") {
                await interaction.reply({ embeds: [botsEmbed()], components: botsRows(), ephemeral: true });
            } else if (id === "btn_logs") {
                await showLogsModalOrEmbed(interaction);
            } else if (id.startsWith("btn_viewlog_")) {
                const idx = parseInt(id.split("_").pop());
                const log = allLogs[idx];
                if (!log || !fs.existsSync(log.fpath)) {
                    await interaction.reply({ content: "❌ Arquivo de log não encontrado.", ephemeral: true });
                    return;
                }
                const file = new AttachmentBuilder(log.fpath);
                const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`📜 Log #${log.tent||idx+1} — ${log.fname}`).setDescription(`**Tipo:** \`${log.type}\` • **Uptime:** \`${log.uptime}\`\n**Data:** <t:${Math.floor(new Date(log.time).getTime()/1000)}:F>\n\`\`\`${(log.reason||"").slice(0, 500)}\`\`\``).setTimestamp(new Date(log.time));
                await interaction.reply({ embeds: [e], files: [file], ephemeral: true });
            } else if (id === "btn_bot_create") {
                const modal = new ModalBuilder().setCustomId("modal_bot_create").setTitle("➕ Criar Novo Bot");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_name").setLabel("Nome de Identificação").setStyle(TextInputStyle.Short).setPlaceholder("Ex: Ph4nt0m_Overworld").setRequired(true).setMaxLength(32)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_host").setLabel("IP / Host").setStyle(TextInputStyle.Short).setValue(MC_HOST).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_port").setLabel("Porta").setStyle(TextInputStyle.Short).setValue(String(MC_PORT)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_nick").setLabel("Nick no Minecraft").setStyle(TextInputStyle.Short).setPlaceholder("Ex: Ph4nt0m").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_version").setLabel("Versão").setStyle(TextInputStyle.Short).setValue(MC_VERSION).setRequired(false))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_bot_config_ip") {
                const sel = getSelectedBot();
                const modal = new ModalBuilder().setCustomId("modal_bot_config_ip").setTitle(`⚙️ Configurar IP — ${sel.name}`);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_host").setLabel("IP / Host").setStyle(TextInputStyle.Short).setValue(sel.host).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_port").setLabel("Porta").setStyle(TextInputStyle.Short).setValue(String(sel.port)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_version").setLabel("Versão").setStyle(TextInputStyle.Short).setValue(sel.version).setRequired(false))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_bot_rename") {
                const sel = getSelectedBot();
                const modal = new ModalBuilder().setCustomId("modal_bot_rename").setTitle(`📝 Renomear — ${sel.name}`);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("new_nick").setLabel("Novo Nick no Minecraft").setStyle(TextInputStyle.Short).setValue(sel.user).setRequired(true).setMaxLength(16))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_bot_delete") {
                if (bots.length <= 1) {
                    await interaction.reply({ content: "❌ **Você não pode deletar o único bot cadastrado!**", ephemeral: true });
                    return;
                }
                const removed = bots.shift();
                saveBots();
                syncPrimary();
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("🗑️ Bot Deletado").setDescription(`O bot \`${removed.name}\` foi removido com sucesso.`).setTimestamp()] });
            }
        } else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "select_bot") {
                const chosenId = interaction.values[0];
                const idx = bots.findIndex(b => b.id === chosenId);
                if (idx > 0) {
                    const [bot] = bots.splice(idx, 1);
                    bots.unshift(bot);
                    saveBots();
                    syncPrimary();
                }
                await interaction.update({ embeds: [botsEmbed()], components: botsRows() });
            } else if (interaction.customId === "select_gamemode") {
                const selectedMode = interaction.values[0];
                const modesPt = { survival: "Sobrevivência", creative: "Criativo", adventure: "Aventura", spectator: "Espectador" };
                
                setBotGamemode(selectedMode);
                mcInfo.gamemode = `${modesPt[selectedMode] || selectedMode} (${selectedMode})`;
                addLog("info", `Comando /gamemode ${selectedMode} enviado`, `Executado por ${interaction.user.tag}`);

                if (liveMessage && mcState === "online") {
                    try {
                        await liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [liveConnectedEmbed()], components: fallenRow() });
                    } catch {}
                }

                await interaction.update({
                    content: `✅ **Modo de jogo alterado para \`${modesPt[selectedMode] || selectedMode}\`!**\n> *(Comando \`/gamemode ${selectedMode}\` emitido no servidor)*`,
                    components: []
                });
            }
        } else if (interaction.isModalSubmit()) {
            if (interaction.customId === "modal_bot_create") {
                const name = interaction.fields.getTextInputValue("bot_name").trim();
                const host = interaction.fields.getTextInputValue("bot_host").trim();
                const port = parseInt(interaction.fields.getTextInputValue("bot_port")) || 25565;
                const nick = interaction.fields.getTextInputValue("bot_nick").trim();
                const ver = interaction.fields.getTextInputValue("bot_version")?.trim() || "26.2 (776)";
                const id = name.toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 16) || `bot${Date.now()}`;
                bots.push({ id, name, host, port, user: nick, version: ver, enabled: true, createdAt: new Date().toISOString() });
                saveBots();
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle("✅ Bot Criado!").setDescription(`**${name}** (\`${host}:${port}\` • Nick: \`${nick}\`) foi adicionado.`).setTimestamp()] });
            } else if (interaction.customId === "modal_bot_config_ip") {
                const host = interaction.fields.getTextInputValue("cfg_host").trim();
                const port = parseInt(interaction.fields.getTextInputValue("cfg_port")) || 25565;
                const ver = interaction.fields.getTextInputValue("cfg_version")?.trim() || bots[0].version;
                bots[0].host = host; bots[0].port = port; bots[0].version = ver;
                saveBots(); syncPrimary();
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x3498db).setTitle("⚙️ Configurações Atualizadas!").setDescription(`Novo endereço do bot **${bots[0].name}**: \`${host}:${port}\` (Versão: \`${ver}\`).`).setTimestamp()] });
            } else if (interaction.customId === "modal_bot_rename") {
                const nick = interaction.fields.getTextInputValue("new_nick").trim();
                bots[0].user = nick;
                saveBots(); syncPrimary();
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(0x2ecc71).setTitle("📝 Nick Atualizado!").setDescription(`Nick do bot no Minecraft alterado para: \`${nick}\`.`).setTimestamp()] });
            } else if (interaction.customId === "modal_wa_pairing") {
                const phone = interaction.fields.getTextInputValue("wa_phone_number").trim();
                await interaction.deferReply({ ephemeral: true });
                await whatsappManager.connect(phone);
                await interaction.editReply({ content: `🔢 **Gerando código de emparelhamento para \`${phone}\`... Acompanhe no canal 📱・whatsapp!**` });
            }
        }
    } catch (e) { console.error("Erro na interação:", e); }
});

async function showLogsModalOrEmbed(interaction) {
    const count = allLogs.length;
    const sessionCount = sessionLogs.length;
    const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("📜 Histórico de Logs & Sessões — Ph4nt0m")
        .setDescription(`**Monitorando há:** \`${getBotUptime()}\` • **Sessão atual:** \`${mcState === "online" ? getUptime() : "—"}\` (\`#${mcInfo.tentativas}\`)\n**Logs HTML salvos:** \`${count}\` • **Eventos nesta sessão:** \`${sessionCount}\``)
        .setThumbnail(`https://mc-heads.net/avatar/${encodeURIComponent(MC_USER)}/100`)
        .setTimestamp();

    if (count > 0) {
        e.addFields({
            name: `📁 Últimos ${Math.min(5, count)} Logs de Desconexão`,
            value: allLogs.slice(0, 5).map((l, i) => {
                const d = new Date(l.time);
                const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                return `\`${i+1}.\` **#${l.tent||"?"}** — ${dt} • \`${l.type.toUpperCase()}\` • Uptime: \`${l.uptime}\``;
            }).join("\n"),
            inline: false
        });
    }

    const comps = [];
    if (count > 0) {
        const row = new ActionRowBuilder();
        for (let i = 0; i < Math.min(5, count); i++) {
            const l = allLogs[i];
            const d = new Date(l.time);
            const label = `#${l.tent||i+1} (${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')})`;
            row.addComponents(new ButtonBuilder().setCustomId(`btn_viewlog_${i}`).setLabel(`📄 ${label}`).setStyle(ButtonStyle.Primary));
        }
        comps.push(row);
    }

    if (interaction.replied || interaction.deferred) {
        await interaction.followUp({ embeds: [e], components: comps, ephemeral: true });
    } else {
        await interaction.reply({ embeds: [e], components: comps, ephemeral: true });
    }
}

// ============ WEB SERVER (Render keep-alive) ============
const WEB_PORT = process.env.PORT || 3000;
try {
    const express = require('express');
    const web = express();
    web.get('/', (req,res)=> res.send(`<h1>Ph4nt0m Bot & WhatsApp Online ✅</h1><p>Bot Uptime: ${getBotUptime()}<br>Server Uptime: ${getServerUptime()}<br>MC State: ${mcState}<br>WA State: ${whatsappManager.state}<br>${new Date().toISOString()}</p>`));
    web.get('/health', (req,res)=> res.json({ status:'ok', botUptime: getBotUptime(), serverUptime: getServerUptime(), mcState, serverState, waState: whatsappManager.state, timestamp: new Date().toISOString() }));
    const server = web.listen(WEB_PORT, ()=> console.log(`[WEB] ✅ Health check ouvindo em :${WEB_PORT}`));
    server.on('error', (err) => {
        if (err.code === 'EADDRINUSE') {
            web.listen(0, function() { console.log(`[WEB] ✅ Health check ouvindo na porta dinâmica :${this.address().port}`); });
        }
    });
    setInterval(()=> { try{ require('http').get(`http://localhost:${WEB_PORT}/health`,()=>{}).on('error',()=>{}); }catch{} }, 9*60*1000);
} catch(e){ console.log("[WEB] Sem web server:", e.message); }

// Shutdown
process.on("SIGINT", () => { shuttingDown = true; killMC(); client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { shuttingDown = true; killMC(); client.destroy(); process.exit(0); });

client.login(DISCORD_TOKEN).catch(e => { console.error("Login falhou:", e.message); process.exit(1); });
console.log("[DISCORD] Inicializando Ph4nt0m Bot, Monitor de Servidor & WhatsApp...");
