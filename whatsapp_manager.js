const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const pino = require('pino');
const QRCode = require('qrcode');
const path = require('path');
const fs = require('fs');

const AUTH_DIR = path.join(__dirname, 'auth_info_baileys');
const CONFIG_FILE = path.join(__dirname, 'whatsapp_config.json');

class WhatsAppManager {
    constructor(callbacks = {}) {
        this.sock = null;
        this.state = "desconectado"; // desconectado, conectando, qr, conectado
        this.qrCodeBuffer = null;
        this.qrCodeString = null;
        this.pairingCode = null;
        this.userNumber = null;
        this.callbacks = callbacks;
        // Rastreia a última mensagem enviada para cada JID (para deletar antes de enviar nova)
        this.lastSentKeys = {}; // jid -> { key, timestamp }
        this.config = {
            adminNumber: null,
            adminName: null,
            pendingAdminRequest: null
        };
        this.loadConfig();
    }

    loadConfig() {
        try {
            if (fs.existsSync(CONFIG_FILE)) {
                this.config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
            }
        } catch (e) {
            console.error('[WA] Erro ao carregar whatsapp_config.json:', e.message);
        }
    }

    saveConfig() {
        try {
            fs.writeFileSync(CONFIG_FILE, JSON.stringify(this.config, null, 2), 'utf8');
        } catch (e) {
            console.error('[WA] Erro ao salvar whatsapp_config.json:', e.message);
        }
    }

    async init() {
        if (!fs.existsSync(AUTH_DIR)) {
            fs.mkdirSync(AUTH_DIR, { recursive: true });
        }
        await this.connect();
    }

    async connect(phoneNumberForPairing = null) {
        try {
            this.state = "conectando";
            if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.state);

            const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
            const { version } = await fetchLatestBaileysVersion();

            this.sock = makeWASocket({
                version,
                auth: state,
                logger: pino({ level: 'silent' }),
                printQRInTerminal: false,
                browser: ['Ph4nt0m Bot', 'Chrome', '1.0.0'],
                generateHighQualityLinkPreview: true
            });

            this.sock.ev.on('creds.update', saveCreds);

            this.sock.ev.on('connection.update', async (update) => {
                const { connection, lastDisconnect, qr } = update;

                if (qr) {
                    this.state = "qr";
                    this.qrCodeString = qr;
                    try {
                        this.qrCodeBuffer = await QRCode.toBuffer(qr, { width: 400, margin: 2 });
                        if (this.callbacks.onQR) {
                            this.callbacks.onQR(this.qrCodeBuffer, qr);
                        }
                    } catch (err) {
                        console.error('[WA] Erro ao gerar buffer QR Code:', err.message);
                    }
                }

                if (connection === 'close') {
                    const statusCode = lastDisconnect?.error?.output?.statusCode;
                    const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
                    this.state = "desconectado";
                    this.qrCodeBuffer = null;
                    this.userNumber = null;
                    this.lastSentKeys = {};
                    if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.state);
                    console.log(`[WA] Conexão fechada. Motivo: ${statusCode}. Reconectar: ${shouldReconnect}`);

                    if (shouldReconnect) {
                        setTimeout(() => this.connect(), 5000);
                    }
                } else if (connection === 'open') {
                    this.state = "conectado";
                    this.qrCodeBuffer = null;
                    this.pairingCode = null;
                    this.userNumber = this.sock.user?.id ? this.sock.user.id.split(':')[0] : "Desconhecido";
                    console.log(`[WA] ✅ WhatsApp conectado! Número: +${this.userNumber}`);
                    if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.state, this.userNumber);
                }
            });

            // Se o usuário solicitou pairing code por número
            if (phoneNumberForPairing && !this.sock.authState.creds.registered) {
                setTimeout(async () => {
                    try {
                        const code = await this.sock.requestPairingCode(phoneNumberForPairing.replace(/[^0-9]/g, ''));
                        this.pairingCode = code;
                        console.log(`[WA] Código de emparelhamento gerado: ${code}`);
                        if (this.callbacks.onPairingCode) {
                            this.callbacks.onPairingCode(code);
                        }
                    } catch (e) {
                        console.error('[WA] Erro ao gerar pairing code:', e.message);
                    }
                }, 2000);
            }

            // Listener de mensagens recebidas
            this.sock.ev.on('messages.upsert', async (m) => {
                const msg = m.messages[0];
                if (!msg || !msg.message || msg.key.fromMe) return;

                const senderJid = msg.key.remoteJid;
                const pushName = msg.pushName || "Usuário";
                let text = msg.message.conversation || msg.message.extendedTextMessage?.text || "";
                text = text.trim();
                if (!text) return;

                const senderNumber = senderJid.split('@')[0];
                console.log(`[WA-MSG] De: +${senderNumber} (${pushName}) — "${text}"`);

                if (this.callbacks.onLog) {
                    this.callbacks.onLog(`Mensagem de +${senderNumber} (${pushName}): "${text}"`);
                }

                // Verifica se é o Administrador cadastrado
                if (this.config.adminNumber && (senderJid === this.config.adminNumber || senderNumber === this.config.adminNumber.split('@')[0])) {
                    await this.handleAdminCommand(senderJid, pushName, text);
                } else {
                    this.config.pendingAdminRequest = {
                        jid: senderJid,
                        number: senderNumber,
                        name: pushName,
                        text: text,
                        timestamp: Date.now()
                    };
                    this.saveConfig();

                    await this.sendAndReplace(senderJid,
                        `╭──────────────────────────────╮\n` +
                        `│ 📱 *PH4NT0M BOT — AUTORIZAÇÃO*   │\n` +
                        `╰──────────────────────────────╯\n` +
                        `> 👤 *Nome:* ${pushName}\n` +
                        `> 📱 *Número:* +${senderNumber}\n` +
                        `> ⏳ *Status:* Solicitação enviada ao Discord para autorização!\n\n` +
                        `_Assim que o dono confirmar no Discord, você poderá controlar tudo pelo WhatsApp!_`
                    );

                    if (this.callbacks.onAdminRequest) {
                        this.callbacks.onAdminRequest(this.config.pendingAdminRequest);
                    }
                }
            });

        } catch (e) {
            console.error('[WA] Erro fatal na conexão do Baileys:', e);
            this.state = "desconectado";
            if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.state);
        }
    }

    /**
     * Apaga a última mensagem enviada para este JID (se existir) e envia uma nova.
     * Garante que só a mensagem mais recente fique visível na conversa.
     */
    async sendAndReplace(jid, text) {
        if (!this.sock || this.state !== "conectado") return null;
        const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;

        // Apaga a mensagem anterior se existir
        const prev = this.lastSentKeys[targetJid];
        if (prev && prev.key) {
            try {
                await this.sock.sendMessage(targetJid, { delete: prev.key });
                console.log(`[WA] Mensagem anterior deletada para ${targetJid}`);
            } catch (e) {
                // Ignora erros de deleção (ex: mensagem muito antiga)
            }
        }

        // Envia a nova mensagem e salva a key
        try {
            const sent = await this.sock.sendMessage(targetJid, { text });
            if (sent?.key) {
                this.lastSentKeys[targetJid] = { key: sent.key, timestamp: Date.now() };
            }
            return sent;
        } catch (e) {
            console.error('[WA] Erro ao enviar mensagem:', e.message);
            return null;
        }
    }

    async handleAdminCommand(jid, name, text) {
        // Se pediu menu ou opções
        if (/^(menu|ajuda|0|oi|start|#menu|help)$/i.test(text.trim())) {
            if (this.callbacks.onGetMenuEmbed) {
                const embedText = await this.callbacks.onGetMenuEmbed();
                await this.sendAndReplace(jid, embedText);
            }
            return;
        }

        // Executa comando via callback para o discord_bot.js
        if (this.callbacks.onCommand) {
            const replyText = await this.callbacks.onCommand(text.trim().toLowerCase(), text.trim());
            if (replyText) {
                await this.sendAndReplace(jid, replyText);
            }
        }
    }

    async sendDirectMessage(jid, text) {
        if (!this.sock || this.state !== "conectado") return false;
        try {
            const targetJid = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
            await this.sock.sendMessage(targetJid, { text });
            return true;
        } catch (e) {
            console.error('[WA] Erro ao enviar mensagem direta:', e.message);
            return false;
        }
    }

    async sendAdminAlert(text) {
        if (this.config.adminNumber) {
            return await this.sendAndReplace(this.config.adminNumber, text);
        }
        return false;
    }

    confirmAdmin(jid, name) {
        this.config.adminNumber = jid.includes('@') ? jid : `${jid}@s.whatsapp.net`;
        this.config.adminName = name;
        this.config.pendingAdminRequest = null;
        this.saveConfig();

        if (this.callbacks.onGetMenuEmbed) {
            this.callbacks.onGetMenuEmbed().then(menuText => {
                this.sendAndReplace(this.config.adminNumber,
                    `╭──────────────────────────────╮\n` +
                    `│ 🎉 *AUTORIZAÇÃO CONCLUÍDA!*   │\n` +
                    `╰──────────────────────────────╯\n` +
                    `Olá *${name}*, seu número foi vinculado como *Administrador Oficial*!\n\n` +
                    menuText
                );
            });
        }
        return true;
    }

    rejectAdmin() {
        if (this.config.pendingAdminRequest) {
            const jid = this.config.pendingAdminRequest.jid;
            this.sendDirectMessage(jid, `❌ Sua solicitação de administrador foi recusada.`);
            this.config.pendingAdminRequest = null;
            this.saveConfig();
        }
    }

    async logout() {
        try {
            if (this.sock) {
                await this.sock.logout();
            }
            if (fs.existsSync(AUTH_DIR)) {
                fs.rmSync(AUTH_DIR, { recursive: true, force: true });
            }
            this.state = "desconectado";
            this.qrCodeBuffer = null;
            this.userNumber = null;
            this.lastSentKeys = {};
            if (this.callbacks.onStatusChange) this.callbacks.onStatusChange(this.state);
            return true;
        } catch (e) {
            console.error('[WA] Erro ao deslogar:', e.message);
            return false;
        }
    }
}

module.exports = WhatsAppManager;
