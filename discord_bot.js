try{ require('dotenv').config(); }catch{}
const { Client, GatewayIntentBits, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, REST, Routes, SlashCommandBuilder, PermissionFlagsBits, AttachmentBuilder, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require('discord.js');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const https = require('https');

// ============ CONFIG (via .env — nunca hardcode token!) ============
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const CHANNEL_ID = process.env.CHANNEL_ID || "1540883450708623370";
const OWNER_ID = process.env.OWNER_ID || "1390600304214544525";
if(!DISCORD_TOKEN){ console.error("❌ Faltando DISCORD_TOKEN no .env / Environment Variables do Render!"); console.error("Crie .env com DISCORD_TOKEN=seu_token ou configure no Render → Environment"); process.exit(1); }

let MC_HOST = "3ww123.play.hosting";
let MC_PORT = 25565;
let MC_USER = "Ph4nt0m";
let MC_VERSION = "26.2 (776)";

// ============ STATE ============
let mcProcess = null;
let mcState = "desligado"; // desligado, conectando, online, caido
let mcStartTime = null;
let mcInfo = {
    coords: "Desconhecido",
    entityId: "?",
    ping: "?",
    motivo: "",
    tentativas: 0,
    kaCount: 0
};
let autoReconnect = false; // DESLIGADO conforme pedido
let shuttingDown = false;
let liveMessage = null; // mensagem que sera editada com uptime
let liveInterval = null;
let sessionLogs = []; // logs da sessao atual
let allLogs = []; // historico de sessoes — PERSISTIDO em logs/index.json
let sessionStartStr = "";
let botInitTime = Date.now(); // quando o bot do discord iniciou — para "server on há"
let runningBotId = null; // ID do bot que está rodando no MC (legado, agora multi)
let botInstances = new Map(); // id -> { process, state, info, liveMessage, liveInterval, startTime, botConfig }
const LOG_INDEX = path.join(__dirname, "logs", "index.json");
function loadLogs() {
    try {
        const dir = path.join(__dirname, "logs");
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        if (fs.existsSync(LOG_INDEX)) {
            const data = JSON.parse(fs.readFileSync(LOG_INDEX, "utf8"));
            if (Array.isArray(data)) allLogs = data;
        }
        // Recupera HTMLs órfãos que não estão no index
        const files = fs.readdirSync(dir).filter(f=>f.endsWith(".html")).sort().reverse();
        for (const fname of files) {
            if (!allLogs.find(l=>l.fname===fname)) {
                const fpath = path.join(dir, fname);
                const stat = fs.statSync(fpath);
                // Tenta extrair tent e tipo do nome ou deixa ?
                allLogs.push({ fname, fpath, time: stat.mtime.toISOString(), reason: "Recuperado de disco", type: "desconectado", uptime: "?", ka: "?", tent: "?" });
            }
        }
        // Ordena por data decrescente
        allLogs.sort((a,b)=> new Date(b.time) - new Date(a.time));
        if (allLogs.length>100) allLogs = allLogs.slice(0,100);
        // Restaura tentativas para não perder contagem
        const maxTent = Math.max(0, ...allLogs.map(l=>parseInt(l.tent)||0));
        if (maxTent > mcInfo.tentativas) mcInfo.tentativas = maxTent;
        console.log(`[LOG] Carregados ${allLogs.length} logs persistidos (tentativas=${mcInfo.tentativas})`);
        // Salva index para persistir órfãos recuperados
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

loadLogs(); // carrega logs persistidos do disco

// ============ BOTS MANAGER (multi-bot) ============
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
function getSelectedBot(){ return bots[0] || null; } // por enquanto o primário é o Ph4nt0m
function syncPrimary(){
    const p = bots[0];
    if(p){ MC_HOST = p.host; MC_PORT = p.port; MC_USER = p.user; MC_VERSION = p.version; }
}
loadBots();
syncPrimary();

function botsEmbed(){
    const total = bots.length;
    const online = mcState==="online" ? 1 : 0;
    const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🤖 Gerenciador de Bots — Ph4nt0m")
        .setDescription(
            `**Gerencie todos os seus bots aqui!**\n`+
            `> Total: \`${total}\` • Online: \`${online}\` • Offline: \`${total-online}\`\n`+
            `> Auto-Reconnect: \`${autoReconnect?"ON":"OFF"}\` • Monitorando há \`${getBotUptime()}\`\n\n`+
            `**Como usar:**\n`+
            `> ➕ **Criar Bot** — cria novo bot com IP/nome custom\n`+
            `> ⚙️ **Configurar IP** — altera host/porta do bot selecionado\n`+
            `> 📝 **Renomear** — muda nick do bot\n`+
            `> 🗑️ **Deletar** — remove bot\n`+
            `> ▶️ **Iniciar/Parar** — conecta/desconecta o bot\n`
        )
        .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m Manager • ${total} bots • Use os botões abaixo` });
    bots.forEach((b,i)=>{
        const inst = botInstances.get(b.id);
        const isMultiRunning = !!inst;
        const isSingleRunning = b.id === runningBotId && mcState==="online";
        const isRunning = isMultiRunning || isSingleRunning;
        const isPrimary = i===0;
        let status = "⚫ OFFLINE";
        if(inst){
            if(inst.state==="online") status = "🟢 ONLINE (RODANDO)";
            else if(inst.state==="conectando") status = "🟡 CONECTANDO";
            else if(inst.state==="caido") status = "🔴 CAÍDO";
        } else if(isSingleRunning) status = "🟢 ONLINE (RODANDO)";
        else if(isPrimary && mcState==="conectando") status = "🟡 CONECTANDO";
        else if(isPrimary && mcState==="caido") status = "🔴 CAÍDO";
        else if(isPrimary) status = "⭐ SELECIONADO";
        const ka = inst ? inst.info.kaCount : (isSingleRunning? mcInfo.kaCount : 0);
        const up = inst && inst.startTime ? `${Math.floor((Date.now()-inst.startTime)/1000)}s` : isSingleRunning? getUptime() : "—";
        e.addFields({ name: `${isRunning?"🟢":isPrimary?"⭐":"🤖"} Bot #${i+1} — ${b.name} ${isRunning?"(RODANDO)":isPrimary?"(SELECIONADO)":""}`, value: `> **ID:** \`${b.id}\`\n> **IP:** \`${b.host}:${b.port}\` • **Nick:** \`${b.user}\`\n> **Versão:** \`${b.version}\` • **Status:** ${status} • KA \`${ka}\` • Uptime \`${up}\`\n> **Criado:** <t:${Math.floor(new Date(b.createdAt).getTime()/1000)}:R>`, inline:false });
    });
    if(total===0) e.addFields({ name:"Nenhum bot", value: "Clique em ➕ Criar Bot para começar", inline:false });
    return e;
}
function botsRows(){
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_bot_create").setLabel("➕ Criar Bot").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_bot_config_ip").setLabel("⚙️ Configurar IP").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_bot_rename").setLabel("📝 Renomear").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_bot_delete").setLabel("🗑️ Deletar").setStyle(ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_bot_start").setLabel("▶️ Iniciar Bot").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_bot_stop").setLabel("⏹️ Parar Bot").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_bot_refresh").setLabel("🔄 Atualizar").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_randomize").setLabel("❓ ?").setStyle(ButtonStyle.Secondary),
    );
    // Select menu para escolher bot quando houver vários
    let rows = [row1, row2];
    if(bots.length>1){
        const select = new StringSelectMenuBuilder().setCustomId("select_bot").setPlaceholder("Selecione o bot para configurar").addOptions(bots.slice(0,25).map((b,i)=>({ label: `${b.name} (${b.host}:${b.port})`, value: b.id, description: `ID ${b.id} • ${b.user}`, default: i===0 })));
        rows.push(new ActionRowBuilder().addComponents(select));
    }
    return rows;
}

// ============ MULTI-BOT SUPPORT ============
function startBotMulti(botId){
    const botCfg = bots.find(b=>b.id===botId) || getSelectedBot();
    if(!botCfg) return;
    if(botInstances.has(botCfg.id) && botInstances.get(botCfg.id).process){
        console.log(`[MC-MULTI] Bot ${botCfg.name} já está rodando`);
        return;
    }
    console.log(`[MC-MULTI] Iniciando bot ${botCfg.name} (${botCfg.host}:${botCfg.port}) em paralelo — total ${botInstances.size+1} bots`);
    // Reusa startMC logic mas sem matar outros — cria instancia separada
    const instance = {
        process: null,
        state: "conectando",
        info: { coords:"Desconhecido", kaCount:0, motivo:"", tentativas: (botInstances.get(botCfg.id)?.info.tentativas||0)+1 },
        liveMessage: null,
        liveInterval: null,
        startTime: Date.now(),
        botConfig: botCfg
    };
    botInstances.set(botCfg.id, instance);
    // Spawn processo
    const botPath = path.join(__dirname, "bot.py");
    const proc = spawn("py", [botPath, botCfg.host, String(botCfg.port), botCfg.user], { cwd: __dirname });
    instance.process = proc;
    instance.state = "conectando";
    let buffer = "";
    proc.stdout.on("data", (data)=>{
        const text = data.toString();
        buffer += text;
        text.split("\n").forEach(raw=>{
            const line = raw.trim(); if(!line) return;
            console.log(`[MC:${botCfg.name}] ${line}`);
            addLog("info", `[${botCfg.name}] ${line.slice(0,180)}`, `Bot ${botCfg.id}`);
            if(line.includes("[+] PLAY STATE!") || line.includes("PLAY STATE")){
                instance.state = "online";
                instance.startTime = Date.now();
                addLog("play", `[${botCfg.name}] Entrou no servidor`, `IP ${botCfg.host}:${botCfg.port}`);
                sendToChannel({ content:`${mentionOwner()} @everyone`, embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${botCfg.name} Conectado!`).setDescription(`Bot **${botCfg.name}** (\`${botCfg.user}\`) entrou em \`${botCfg.host}:${botCfg.port}\``).setThumbnail("https://mc-heads.net/avatar/"+botCfg.user+"/100").setTimestamp().setFooter({text:`${botCfg.name} • Online`})], allowedMentions:{parse:["everyone"],users:[OWNER_ID]}}).then(msg=>{
                    if(msg){ instance.liveMessage = msg;
                        if(instance.liveInterval) clearInterval(instance.liveInterval);
                        instance.liveInterval = setInterval(async()=>{
                            if(instance.state!=="online" || !instance.liveMessage) return;
                            try{
                                const uptime = Math.floor((Date.now()-instance.startTime)/1000);
                                const h=Math.floor(uptime/3600), m=Math.floor((uptime%3600)/60), s=uptime%60;
                                const upStr = h>0? `${h}h ${m}m ${s}s` : m>0? `${m}m ${s}s` : `${s}s`;
                                await instance.liveMessage.edit({ content:`${mentionOwner()} @everyone`, embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle(`✅ ${botCfg.name} — Online`).setDescription(`Atualizado <t:${Math.floor(Date.now()/1000)}:R> • Uptime \`${upStr}\` • KA \`${instance.info.kaCount}\``).setThumbnail("https://mc-heads.net/avatar/"+botCfg.user+"/100").addFields({name:"IP",value:`\`${botCfg.host}:${botCfg.port}\``,inline:true},{name:"Nick",value:`\`${botCfg.user}\``,inline:true},{name:"Uptime",value:`\`${upStr}\``,inline:true}).setTimestamp().setFooter({text:`${botCfg.name} • Online`})], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}});
                            }catch{}
                        },1000);
                    }
                });
            } else if(line.includes("[KA #")){
                const m=line.match(/\[KA #(\d+)\]/); if(m) instance.info.kaCount=parseInt(m[1]);
            } else if(line.includes("[!] Kick")){
                instance.info.motivo=line; instance.state="caido";
                addLog("kick", `[${botCfg.name}] ${line.slice(0,200)}`, `Uptime ${Math.floor((Date.now()-instance.startTime)/1000)}s`);
                const embed = disconnectedEmbed(`[${botCfg.name}] ${line}`, line.toLowerCase().includes("ban")?"banido":"kickado");
                if(instance.liveMessage) instance.liveMessage.edit({ content:`${mentionOwner()} @everyone`, embeds:[embed], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}}).catch(()=> sendToChannel({content:`${mentionOwner()} @everyone`, embeds:[embed], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}}));
            }
        });
    });
    proc.stderr.on("data", d=>{ const t=d.toString().trim(); if(t) console.error(`[MC:${botCfg.name}-ERR] ${t}`); });
    proc.on("close", (code)=>{
        console.log(`[MC-MULTI] Bot ${botCfg.name} finalizado code=${code} state=${instance.state}`);
        if(instance.liveInterval) clearInterval(instance.liveInterval);
        const uptime = instance.startTime ? `${Math.floor((Date.now()-instance.startTime)/1000)}s` : "?";
        let sendType="desconectado";
        if(!instance.info.motivo) instance.info.motivo=`Desconectado após ${uptime} (code ${code})`;
        if(instance.info.motivo.toLowerCase().includes("ban")) sendType="banido";
        addLog(sendType, `[${botCfg.name}] ${instance.info.motivo.slice(0,200)}`, `Uptime ${uptime}`);
        const htmlPath = generateHTMLLog(`[${botCfg.name}] ${instance.info.motivo}`, sendType);
        const embed = disconnectedEmbed(`[${botCfg.name}] ${instance.info.motivo}`, sendType);
        if(instance.liveMessage){
            instance.liveMessage.edit({ content:`${mentionOwner()} @everyone`, embeds:[embed], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}}).catch(()=> sendToChannel({content:`${mentionOwner()} @everyone`, embeds:[embed], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}}));
        } else {
            sendToChannel({ content:`${mentionOwner()} @everyone`, embeds:[embed], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}});
        }
        botInstances.delete(botCfg.id);
        if(autoReconnect && !shuttingDown){
            console.log(`[MC-MULTI] Auto-reconnect para ${botCfg.name} em 5s...`);
            setTimeout(()=> startBotMulti(botCfg.id), 5000);
        }
    });
    proc.on("error", err=>{
        console.error(`[MC-MULTI] Erro bot ${botCfg.name}:`, err.message);
        instance.state="caido"; instance.info.motivo=`Erro: ${err.message}`;
        sendToChannel({ content:`${mentionOwner()} @everyone`, embeds:[disconnectedEmbed(`[${botCfg.name}] ${err.message}`,"erro")], components: fallenRow(), allowedMentions:{parse:["everyone"],users:[OWNER_ID]}});
        botInstances.delete(botCfg.id);
    });
}
function stopBotMulti(botId){
    const inst = botInstances.get(botId);
    if(inst){
        if(inst.liveInterval) clearInterval(inst.liveInterval);
        try{ inst.process.kill(); }catch{}
        botInstances.delete(botId);
        return true;
    }
    // fallback para bot legado single
    if(botId===getSelectedBot()?.id && mcProcess){
        killMC(); return true;
    }
    return false;
}

// ============ DISCORD CLIENT ============
const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent]
});

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
function getBotUptime() {
    const s = Math.floor((Date.now() - botInitTime) / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m ${sec}s`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
}

function colorForState(state) {
    if (state === "online") return 0x2ecc71;
    if (state === "conectando") return 0xf1c40f;
    if (state === "caido") return 0xe74c3c;
    return 0x95a5a6;
}

function emojiForState(state) {
    if (state === "online") return "🟢";
    if (state === "conectando") return "🟡";
    if (state === "caido") return "🔴";
    return "⚫";
}

// ============ RANDOMIZE PROFILE (? botao) — nunca repete — FIXADO PRA FUNCIONAR TUDO ============
const usedProfiles = new Set();
const ADJS = ["Sombrio","Lunar","Solar","Fantasma","Neon","Cyber","Mistico","Abissal","Estelar","Vortex","Nether","Ender","Crimson","Obsidian","Emerald","Diamond","Shadow","Frost","Blazing","Toxic","Quantum","Nova","Apex","Omega","Alpha","Delta","Sigma","Titan","Specter","Phantom","Giga","Mega","Ultra","Hyper","Psycho","Crazy","Insano","Brabo","Zika","Lendario","Mitico","Divino","Supremo","Caotico","Anarquico","Rebelde","Selvagem","Feroz","Voraz","Sanguinario","Maldito","Amaldicoado","Bendito","Sagrado","Profano"];
const NOUNS = ["Blade","Wraith","Specter","Reaper","Hunter","Guardian","Seeker","Voyager","Rider","Walker","Slayer","Keeper","Breaker","Weaver","Stalker","Drifter","Nomad","Titan","Prime","Core","Pulse","Echo","Nexus","Abyss","Void","Storm","Flame","Frost","Venom","Havoc","Destroyer","Annihilator","Overlord","Emperor","King","God","Demon","Angel","Beast","Monster","Machine","Cyborg","Android","Mutant","Freak","Psycho","Maniac","Lunatic","Berserker","Warlord","Champion","Legend","Myth","Saga","Epos","Chronos","Nebula","Quasar","Pulsar"];
const BIOS = [
    "Caçador de Phantoms nas noites sem lua 🌙", "Guardião do servidor 24/7 — nunca dorme 😴❌", "Viajante interdimensional do Nether 👾🔥",
    "Sombra que protege o spawn com a vida", "Eco do End — ouvindo o vazio há milênios", "Lenda viva do 3ww123.play.hosting — respeita!",
    "Forjado em obsidian e redstone no limite do mundo", "Assombração amigável que dá bom dia no chat", "Vigia noturno — anti-AFK supremo, nunca cai",
    "Entidade quântica em forma de bot — bug da matrix", "Fragmento de alma do Ender Dragon domesticado 🐉", "Protocolo 776 encarnado — sou a atualização",
    "Sussurro do chat global que ninguém cala", "Sentinela de chunks infinitos — carrego o mundo nas costas", "Mestre do keepalive eterno — meu ping é -1",
    "Nômade do overworld sem casa, sem rumo", "Guardião da criatividade — modo criativo é meu habitat", "Signo de pureza — nunca morro, só respawno",
    "Nunca offline, sempre vigilante 👁️ 24/7", "Randomizado pelo caos — único no universo, nunca repete",
    "Comi 64 pães de uma vez e não morri 🍞", "Fiz parkour no teto do Nether e sobrevivi", "Já vi o Herobrine e ele me deu autógrafo",
    "Meu skin é tão feia que o Creeper tem medo de mim 💥", "Dormi no Nether e acordei no End — como?", "Tentei domar um Ghast e ele me adotou",
    "Sou o motivo do lag — com orgulho", "Minha picareta é de diamante mas meu coração é de terra", "Já morri 100x pra Phantom e voltei 101x 💀",
    "Rei do PvP com 2 FPS", "Lenda do servidor que ninguém conhece mas todos respeitam", "Bot mais brabo que player pro — chama no x1",
    "Viciado em redstone e café ☕", "Construí uma casa de terra e chamei de mansão", "Meu inventário é só batata e esperança 🥔",
    "Fui banido do céu por ser bom demais", "Anjo caído que virou bot — história triste", "Demônio que largou o capeta pra jogar Minecraft",
    "Cyborg com coração de redstone pulsante", "Mutante radioativo do bioma radioativo ☢️", "Psicopata que ama ovelha rosa 🐑💗"
];
const AVATAR_BASES = [
    "https://mc-heads.net/avatar/", // PNG OK
    "https://api.dicebear.com/7.x/bottts/png?seed=", // PNG fix (era SVG que quebrava!)
    "https://api.dicebear.com/7.x/pixel-art/png?seed=",
    "https://api.dicebear.com/7.x/thumbs/png?seed=",
    "https://robohash.org/", // PNG
    "https://i.pravatar.cc/512?u=", // JPG
    "https://picsum.photos/seed/", // JPG
];
function randomName(){
    let n; let tries=0;
    do{ n = `${ADJS[Math.floor(Math.random()*ADJS.length)]}${NOUNS[Math.floor(Math.random()*NOUNS.length)]}_${Math.random().toString(36).slice(2,6).toUpperCase()}${Math.floor(Math.random()*99)}`; tries++; if(tries>100) break; }while(usedProfiles.has("name:"+n));
    return n;
}
function randomBio(){
    const b = BIOS[Math.floor(Math.random()*BIOS.length)] + ` • #${Math.random().toString(36).slice(2,7)}`;
    return b;
}
function randomAvatarUrl(name){
    const r = Math.random();
    if(r<0.30) return `https://mc-heads.net/avatar/${encodeURIComponent(name)}/512`;
    if(r<0.50) return `https://api.dicebear.com/7.x/bottts/png?seed=${encodeURIComponent(name+Math.random().toString(36).slice(2,8))}&backgroundColor=${["5865F2","57F287","FEE75C","EB459E","9b59b6","2ecc71"][Math.floor(Math.random()*6)]}`;
    if(r<0.65) return `https://robohash.org/${encodeURIComponent(name+Math.random().toString(36).slice(2,8))}.png?set=set1&bgset=bg1`;
    if(r<0.80) return `https://i.pravatar.cc/512?u=${encodeURIComponent(name+Date.now())}`;
    return `https://picsum.photos/seed/${encodeURIComponent(name+Math.random().toString(36).slice(2,8))}/512/512`;
}
async function fetchAvatarBuffer(url){
    return new Promise((resolve,reject)=>{
        const lib = url.startsWith("https") ? https : require('http');
        const req = lib.get(url, { headers: { "User-Agent":"Ph4nt0mBot/2.0" } }, res=>{
            if(res.statusCode>=300 && res.statusCode<400 && res.headers.location){
                // redirect
                fetchAvatarBuffer(res.headers.location).then(resolve).catch(reject);
                return;
            }
            if(res.statusCode!==200) return reject(new Error(`HTTP ${res.statusCode}`));
            const chunks=[]; res.on('data',c=>chunks.push(c)); res.on('end',()=> resolve(Buffer.concat(chunks)));
        });
        req.on('error',reject);
        req.setTimeout(8000, ()=>{ req.destroy(); reject(new Error("timeout")); });
    });
}
function randomDescription(){
    const descs = [
        `Bot randomizado em ${new Date().toLocaleString('pt-BR')} — único e irrepetível. Seed: ${Math.random().toString(36).slice(2,10)}`,
        `Entidade ${Math.random().toString(36).slice(2,8).toUpperCase()} — forjada no caos quântico. Nunca vista antes.`,
        `Assinatura #${Date.now().toString(36).toUpperCase()} — DNA digital único.`,
        `Mutante do protocolo 776 — hash ${Math.random().toString(16).slice(2,10).toUpperCase()}`,
    ];
    return descs[Math.floor(Math.random()*descs.length)];
}
function generateUniqueProfile(){
    let tries=0;
    while(tries<200){
        const name = randomName();
        const bio = randomBio();
        const desc = randomDescription();
        const avatar = randomAvatarUrl(name);
        const key = `${name}|${bio}|${desc}|${avatar}`;
        if(!usedProfiles.has(key)){
            usedProfiles.add(key);
            // persiste pra nunca repetir mesmo após reiniciar
            try{
                const pFile = path.join(__dirname, "logs", "used_profiles.json");
                let arr=[]; if(fs.existsSync(pFile)) try{arr=JSON.parse(fs.readFileSync(pFile,"utf8"))}catch{}
                arr.push(key); if(arr.length>5000) arr=arr.slice(-5000);
                fs.writeFileSync(pFile, JSON.stringify(arr,null,2));
                arr.forEach(k=> usedProfiles.add(k));
            }catch{}
            return { name, bio, desc, avatar, key };
        }
        tries++;
    }
    // fallback
    return { name: `Ph4nt0m_${Date.now().toString(36).slice(-4).toUpperCase()}`, bio: randomBio(), desc: randomDescription(), avatar: `https://mc-heads.net/avatar/Ph4nt0m_${Math.random().toString(36).slice(2,6)}/512`, key: Date.now().toString() };
}
// Carrega perfis já usados do disco
try{
    const pFile = path.join(__dirname, "logs", "used_profiles.json");
    if(fs.existsSync(pFile)){ JSON.parse(fs.readFileSync(pFile,"utf8")).forEach(k=> usedProfiles.add(k)); }
}catch{}

// ============ LOG SYSTEM ============
function addLog(type, msg, detail="") {
    sessionLogs.push({ time: new Date().toISOString(), ts: Date.now(), type, msg, detail });
    if (sessionLogs.length > 10000) sessionLogs.shift(); // aumentado de 500 para 10000 — guarda TUDO
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
        const breakdown = Object.entries(typeCounts).map(([k,v])=> `<span style="display:inline-block;margin:4px 6px;padding:6px 12px;border-radius:20px;background:#1e1e2a;border:1px solid #2a2a3a;font-size:12px;"><b style="color:#fff;">${k.toUpperCase()}</b> <span style="background:${{connect:"#3498db",keepalive:"#2ecc71",play:"#f1c40f",kick:"#e74c3c",ban:"#992d22",death:"#9b59b6",disconnect:"#e67e22",error:"#e74c3c",info:"#95a5a6"}[k]||"#95a5a6"};color:#fff;padding:1px 7px;border-radius:10px;margin-left:6px;">${v}</span></span>`).join("");
        const rows = sessionLogs.map((l,i) => {
            const d = new Date(l.ts);
            const t = d.toLocaleTimeString('pt-BR');
            const dt = d.toLocaleDateString('pt-BR');
            const colors = { connect:"#3498db", keepalive:"#2ecc71", play:"#f1c40f", kick:"#e74c3c", ban:"#992d22", death:"#9b59b6", disconnect:"#e67e22", error:"#e74c3c", info:"#95a5a6" };
            const c = colors[l.type] || "#95a5a6";
            const icon = { connect:"🔌", keepalive:"💓", play:"🎮", kick:"🥾", ban:"🔨", death:"💀", disconnect:"⚠️", error:"❌", info:"ℹ️" }[l.type] || "•";
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
<div class="header"><h1>🤖 Ph4nt0m — Log Detalhado</h1><p style="font-size:15px;">${escapeHtml(reason||"Sem motivo")} • <span class="badge ${type}">${type.toUpperCase()}</span> • Sessão <b>#${tent}</b></p><p style="font-size:13px;opacity:.9;">Sessão: ${start} → ${end} • Uptime: <b>${uptime}</b> • Total eventos: <b>${sessionLogs.length.toLocaleString('pt-BR')}</b> (TODOS inclusos)</p><p style="font-size:11px;opacity:.7;">Bot iniciado há ${getBotUptime()} • Protocolo ${MC_VERSION} • Gerado ${end}</p></div>
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
<div class="summary"><h3>📊 Breakdown por tipo</h3><div>${breakdown || '<span style="color:#888;">Nenhum evento</span>'}</div><div style="margin-top:10px;display:flex;flex-wrap:wrap;gap:6px;"><span class="kpi">📦 Protocolo ${MC_VERSION}</span><span class="kpi">🕐 Iniciado ${start}</span><span class="kpi">🏁 Finalizado ${end}</span><span class="kpi">📄 ${fname}</span></div></div>
<div class="timeline"><div style="display:flex;justify-content:space-between;align-items:center;"><h2 style="margin:16px 0 8px;">📜 Timeline Completa — ${sessionLogs.length.toLocaleString('pt-BR')} eventos (TODOS)</h2><span style="font-size:12px;color:#888;">Scroll para ver tudo ↓</span></div><div class="table-wrap"><div class="table-scroll"><table><thead><tr><th>#</th><th>Hora</th><th>Tipo</th><th>Evento</th><th>Detalhe Completo</th></tr></thead><tbody>${rows || '<tr><td colspan=5 style="text-align:center;color:#888;padding:24px;">Nenhum evento registrado</td></tr>'}</tbody></table></div></div><p style="text-align:center;color:#666;font-size:11px;margin-top:8px;">Mostrando TODOS os ${sessionLogs.length} logs — sem limite de 500 • Gerado com Ph4nt0m Bot</p></div>
<div class="footer">Gerado em ${end} • Ph4nt0m Bot • Protocolo ${MC_VERSION} • Monitorando há ${getBotUptime()}<br>Arquivo: ${fname} • <span style="color:#5865F2;">Toda a timeline inclusa — sem cortes</span></div>
</body></html>`;
        fs.writeFileSync(fpath, html, "utf8");
        allLogs.unshift({ fname, fpath, time: now.toISOString(), reason, type, uptime, ka, tent: mcInfo.tentativas });
        if (allLogs.length > 500) allLogs.pop();
        saveLogs();
        console.log(`[LOG] HTML gerado: ${fpath}`);
        return fpath;
    } catch(e){ console.error("Erro ao gerar HTML:", e.message); return null; }
}
function escapeHtml(s){ return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;"); }

// ============ EMBEDS ============
function menuEmbed() {
    const totalBots = bots.length;
    const running = botInstances.size + (mcState==="online"?1:0);
    const e = new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle("🤖 Ph4nt0m Bot — Painel de Controle GIGANTE")
        .setDescription(
            `**Bem-vindo ao painel ULTRA COMPLETO do Ph4nt0m!**\n` +
            `Bot AFK multi-instância para manter \`${MC_HOST}:${MC_PORT}\` online 24/7 no Render.\n\n` +
            `**📋 Funcionalidades Completas:**\n` +
            `> 🟢 **Conectar** — Conecta o Ph4nt0m\n` +
            `> 🔴 **Disconnect** — Desconecta\n` +
            `> 💀 **Kill** — Mata TUDO e desliga\n` +
            `> 🔄 **Reconectar** — Reconexão forçada\n` +
            `> 🔄 **Auto: ON/OFF** — Toggle auto-reconnect\n` +
            `> 📜 **Logs** — Histórico com HTML lindo (10k linhas, data/hora, #tentativa)\n` +
            `> 📊 **Status** — Status detalhado com uptime\n` +
            `> 🤖 **/bots** — Gerencia TODOS os bots (criar, IP, nick, deletar)\n` +
            `> 💬 **Comandos:** \`/conectar\` \`/bots\` \`/status\`\n`
        )
        .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
        .setImage("https://i.imgur.com/8Km9tLL.png")
        .setFooter({ text: `Ph4nt0m Bot • ${new Date().toLocaleString('pt-BR')} • Render Ready`, iconURL: "https://mc-heads.net/avatar/Ph4nt0m/32" })
        .setTimestamp()
        .addFields(
            { name: "🌐 Servidor Principal", value: `\`${MC_HOST}:${MC_PORT}\``, inline: true },
            { name: "👤 Nick Principal", value: `\`${MC_USER}\``, inline: true },
            { name: "📦 Versão", value: `\`${MC_VERSION}\``, inline: true },
            { name: "🤖 Bots Totais", value: `\`${totalBots}\``, inline: true },
            { name: "🟢 Rodando", value: `\`${running}\``, inline: true },
            { name: "🕐 Monitorando há", value: `\`${getBotUptime()}\``, inline: true },
            { name: "💓 Auto-Reconnect", value: autoReconnect ? "`✅ ON`" : "`❌ OFF`", inline: true },
            { name: "📜 Logs Salvos", value: `\`${allLogs.length}\``, inline: true },
            { name: "🏓 Health Check", value: "`/health`", inline: true },
            { name: "🛡️ Modo", value: "`Parado • Anti-AFK`", inline: true },
            { name: "☁️ Hospedagem", value: "`Render • Sempre ON`", inline: true },
            { name: "💡 Dica", value: `> \`/op ${MC_USER}\` + \`/gamemode creative ${MC_USER}\` = imortal!`, inline: false },
        );
    return e;
}

function menuRow(disabled = false) {
    // Linha 1: controles principais (5 max)
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_conectar").setLabel("🟢 Conectar").setStyle(ButtonStyle.Success).setDisabled(disabled),
        new ButtonBuilder().setCustomId("btn_reconectar").setLabel("🔄 Reconectar").setStyle(ButtonStyle.Primary).setDisabled(false),
        new ButtonBuilder().setCustomId("btn_desligar").setLabel("🔴 Disconnect").setStyle(ButtonStyle.Danger).setDisabled(false),
        new ButtonBuilder().setCustomId("btn_kill").setLabel("💀 Kill").setStyle(ButtonStyle.Danger).setDisabled(false),
        new ButtonBuilder().setCustomId("btn_status").setLabel("📊 Status").setStyle(ButtonStyle.Secondary).setDisabled(false),
    );
    // Linha 2: auto reconnect + logs + ?
    const autoLabel = autoReconnect ? "🔄 Auto: ON" : "🔄 Auto: OFF";
    const autoStyle = autoReconnect ? ButtonStyle.Success : ButtonStyle.Secondary;
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_autoreconnect").setLabel(autoLabel).setStyle(autoStyle),
        new ButtonBuilder().setCustomId("btn_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_randomize").setLabel("❓ ?").setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2];
}

function statusEmbed() {
    const stateEmoji = emojiForState(mcState);
    const stateText = mcState === "online" ? "ONLINE" : mcState === "conectando" ? "CONECTANDO" : mcState === "caido" ? "CAÍDO / DESCONECTADO" : "DESLIGADO";
    const e = new EmbedBuilder()
        .setColor(colorForState(mcState))
        .setTitle(`${stateEmoji} Ph4nt0m — Status`)
        .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m • ${MC_HOST}:${MC_PORT} • Monitorando há ${getBotUptime()}`, iconURL: "https://mc-heads.net/avatar/Ph4nt0m/32" })
        .addFields(
            { name: "📡 Estado", value: `\`${stateText}\``, inline: true },
            { name: "⏱️ Uptime (sessão)", value: `\`${mcState === "online" ? getUptime() : "—"}\``, inline: true },
            { name: "🕐 Monitorando há", value: `\`${getBotUptime()}\``, inline: true },
            { name: "🔢 Sessão #", value: `\`#${mcInfo.tentativas}\``, inline: true },
            { name: "🌐 Servidor", value: `\`${MC_HOST}:${MC_PORT}\``, inline: false },
            { name: "👤 Nick", value: `\`${MC_USER}\``, inline: true },
            { name: "📦 Versão", value: `\`${MC_VERSION}\``, inline: true },
            { name: "📍 Coordenadas", value: `\`${mcInfo.coords}\``, inline: true },
            { name: "💓 KeepAlives", value: `\`${mcInfo.kaCount}\``, inline: true },
            { name: "🔄 Auto-Reconnect", value: autoReconnect ? "`✅ Ativado`" : "`❌ Desativado`", inline: true },
            { name: "📜 Logs", value: `\`${allLogs.length} HTMLs\``, inline: true },
        );
    if (mcInfo.motivo) e.addFields({ name: "📄 Último evento", value: `\`\`\`${mcInfo.motivo.slice(0, 1000)}\`\`\``, inline: false });
    return e;
}

function connectedEmbed() {
    return liveConnectedEmbed();
}

function liveConnectedEmbed() {
    const uptime = getUptime();
    const e = new EmbedBuilder()
        .setColor(0x2ecc71)
        .setTitle("✅ Ph4nt0m Conectado — Online")
        .setDescription(`${mentionOwner()} @everyone • Atualizado <t:${Math.floor(Date.now()/1000)}:R>`)
        .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m Bot • Online • Uptime ${uptime} • Monitorando há ${getBotUptime()}`, iconURL: "https://mc-heads.net/avatar/Ph4nt0m/32" })
        .addFields(
            { name: "🌐 Servidor", value: `\`${MC_HOST}:${MC_PORT}\``, inline: true },
            { name: "👤 Nick", value: `\`${MC_USER}\``, inline: true },
            { name: "📦 Protocolo", value: `\`${MC_VERSION}\``, inline: true },
            { name: "🔢 Sessão", value: `\`#${mcInfo.tentativas}\``, inline: true },
            { name: "📍 Posição", value: `\`${mcInfo.coords}\``, inline: true },
            { name: "⏱️ Conectado em", value: `<t:${Math.floor((mcStartTime||Date.now())/1000)}:F>`, inline: true },
            { name: "⏳ Uptime (sessão)", value: `\`${uptime}\``, inline: true },
            { name: "🕐 Monitorando há", value: `\`${getBotUptime()}\``, inline: true },
            { name: "💓 KeepAlives", value: `\`${mcInfo.kaCount}\``, inline: true },
            { name: "📜 Logs", value: `\`${allLogs.length} salvos\``, inline: true },
        );
    return e;
}

function disconnectedEmbed(reason, type = "desconectado") {
    let title = "⚠️ Ph4nt0m Desconectado";
    let color = 0xe67e22;
    let desc = `${mentionOwner()} @everyone`;
    if (type === "kickado") { title = "🥾 Ph4nt0m foi Kickado!"; color = 0xe74c3c; }
    else if (type === "banido") { title = "🔨 Ph4nt0m foi Banido!"; color = 0x992d22; }
    else if (type === "morto") { title = "💀 Ph4nt0m Morreu!"; color = 0x71368a; }
    else if (type === "erro") { title = "❌ Erro no Ph4nt0m"; color = 0xe74c3c; }

    const uptime = mcStartTime ? getUptime() : "—";
    const e = new EmbedBuilder()
        .setColor(color)
        .setTitle(title)
        .setDescription(desc)
        .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
        .setTimestamp()
        .setFooter({ text: `Ph4nt0m Bot • ${type}`, iconURL: "https://mc-heads.net/avatar/Ph4nt0m/32" })
        .addFields(
            { name: "🌐 Servidor", value: `\`${MC_HOST}:${MC_PORT}\``, inline: true },
            { name: "👤 Nick", value: `\`${MC_USER}\``, inline: true },
            { name: "⏱️ Ficou online por", value: `\`${uptime}\``, inline: true },
            { name: "📍 Última posição", value: `\`${mcInfo.coords}\``, inline: true },
            { name: "💓 KeepAlives", value: `\`${mcInfo.kaCount}\``, inline: true },
            { name: "🔁 Tentativas", value: `\`${mcInfo.tentativas}\``, inline: true },
            { name: `📄 Motivo: ${type}`, value: `\`\`\`${(reason || "Desconexão sem motivo (timeout/reinício)").slice(0, 1000)}\`\`\``, inline: false },
            { name: "🔄 Ação", value: autoReconnect ? "> *Tentando reconectar automaticamente em 5s...*\n> Use **Desligar Tudo** para parar." : "> *Auto-reconnect desativado. Clique em Reconectar.*", inline: false },
        );
    return e;
}

function fallenRow() {
    const autoLabel = autoReconnect ? "🔄 Auto: ON" : "🔄 Auto: OFF";
    const autoStyle = autoReconnect ? ButtonStyle.Success : ButtonStyle.Secondary;
    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_reconectar").setLabel("🔄 Reconectar Agora").setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId("btn_desligar").setLabel("🔴 Disconnect").setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId("btn_kill").setLabel("💀 Kill").setStyle(ButtonStyle.Danger),
    );
    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId("btn_autoreconnect").setLabel(autoLabel).setStyle(autoStyle),
        new ButtonBuilder().setCustomId("btn_logs").setLabel("📜 Logs").setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId("btn_status").setLabel("📊 Status").setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId("btn_randomize").setLabel("❓ ?").setStyle(ButtonStyle.Secondary),
    );
    return [row1, row2];
}

// ============ MC BOT MANAGEMENT ============
function logMC(line) {
    console.log(`[MC] ${line}`);
}

async function sendToChannel(payload) {
    try {
        const ch = await client.channels.fetch(CHANNEL_ID);
        if (!ch) return null;
        return await ch.send(payload);
    } catch (e) { console.error("Erro ao enviar:", e.message); return null; }
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
        } catch(e) { console.error("Erro ao atualizar uptime:", e.message); }
    }, 1000); // atualiza a cada 1s na mesma mensagem
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

function startMC() {
    if (mcProcess) killMC();
    if (shuttingDown) return;

    mcState = "conectando";
    mcInfo.tentativas++;
    mcInfo.kaCount = 0;
    mcStartTime = Date.now();
    clearSessionLogs();
    const _preBot = getSelectedBot();
    if(_preBot) runningBotId = _preBot.id;
    addLog("connect", `Tentativa #${mcInfo.tentativas} — Conectando em ${MC_HOST}:${MC_PORT} como ${MC_USER}`, `Protocolo ${MC_VERSION} • Bot ${_preBot? _preBot.name : "?"}`);
    console.log(`[MC] Iniciando tentativa #${mcInfo.tentativas}...`);

    const botCfg = getSelectedBot() || { host: MC_HOST, port: MC_PORT, user: MC_USER };
    console.log(`[MC] Conectando bot "${botCfg.name}" em ${botCfg.host}:${botCfg.port} como ${botCfg.user}`);
    addLog("connect", `Iniciando "${botCfg.name}" em ${botCfg.host}:${botCfg.port} como ${botCfg.user}`, `ID ${botCfg.id}`);
    const pyPath = "py";
    const botPath = path.join(__dirname, "bot.py");
    mcProcess = spawn(pyPath, [botPath, botCfg.host, String(botCfg.port), botCfg.user], { cwd: __dirname });

    let buffer = "";
    mcProcess.stdout.on("data", (data) => {
        const text = data.toString();
        buffer += text;
        const lines = text.split("\n");
        for (const raw of lines) {
            const line = raw.trim();
            if (!line) continue;
            logMC(line);

            // Parse events
            if (line.includes("[+] PLAY STATE!") || line.includes("PLAY STATE")) {
                mcState = "online";
                mcStartTime = Date.now();
                addLog("play", "Entrou no servidor — PLAY STATE", `Coords: ${mcInfo.coords}`);
                // Envia e guarda mensagem para editar uptime na mesma mensagem
                sendToChannel({
                    content: `${mentionOwner()} @everyone`,
                    embeds: [liveConnectedEmbed()],
                    components: fallenRow(),
                    allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                }).then(msg => {
                    if (msg) { liveMessage = msg; startLiveUpdate(); }
                });
            } else if (line.includes("[KA #")) {
                const m = line.match(/\[KA #(\d+)\]/);
                if (m) { mcInfo.kaCount = parseInt(m[1]); addLog("keepalive", `KeepAlive #${m[1]} respondido`, `Uptime ${getUptime()}`); }
            } else if (line.includes("[!] Kick")) {
                mcInfo.motivo = line;
                const lower = line.toLowerCase();
                let type = "kickado";
                if (lower.includes("ban")) type = "banido";
                mcState = "caido";
                addLog(type, line.slice(0,200), `Uptime ${getUptime()} KA ${mcInfo.kaCount}`);
                stopLiveUpdate();
                // Edita a mesma mensagem de uptime se existir, senao manda nova
                if (liveMessage) {
                    liveMessage.edit({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [disconnectedEmbed(line, type)],
                        components: fallenRow(),
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    }).catch(()=> sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [disconnectedEmbed(line, type)], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
                    liveMessage = null;
                } else {
                    sendToChannel({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [disconnectedEmbed(line, type)],
                        components: fallenRow(),
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    });
                }
            } else if (line.includes("Conexao perdida") || line.includes("Desconectado")) {
                // will be handled on close
            } else if (line.includes("Player morreu")) {
                mcInfo.motivo = "Morto por Phantom/mob — respawn automático";
                // nao spamma, apenas deixa o live update mostrar; se morrer de verdade, o close handler vai editar
                console.log("[MC] Morte detectada, respawn automatico...");
            }
        }
    });

    mcProcess.stderr.on("data", (data) => {
        const txt = data.toString().trim();
        if (txt) console.error(`[MC-ERR] ${txt}`);
        // Detect ban/kick via stderr
        if (txt.toLowerCase().includes("ban")) {
            mcInfo.motivo = txt;
        }
    });

    mcProcess.on("close", (code) => {
        console.log(`[MC] Processo finalizado code=${code} state=${mcState}`);
        const wasOnline = mcState === "online";
        const uptime = mcStartTime ? getUptime() : "—";

        if (shuttingDown) {
            mcState = "desligado";
            return;
        }

        // Se autoreconnect desligado, apenas edita a LIVE mensagem e para
        stopLiveUpdate();
        let htmlPath = null;
        let sendType = "desconectado";

        if (mcState === "conectando") {
            mcState = "caido";
            mcInfo.motivo = `Falha ao conectar (code ${code})`;
            sendType = "erro";
            addLog("error", mcInfo.motivo, `Code ${code}`);
            htmlPath = generateHTMLLog(mcInfo.motivo, sendType);
            const embed = disconnectedEmbed(mcInfo.motivo, sendType);
            if (liveMessage) {
                liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }).catch(()=> sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
            } else {
                sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } });
            }
            liveMessage = null;
        } else if (mcState === "online") {
            mcState = "caido";
            if (!mcInfo.motivo || mcInfo.motivo === "") mcInfo.motivo = `Desconectado após ${uptime} online`;
            sendType = "desconectado";
            if (buffer.includes("morreu") || buffer.toLowerCase().includes("slain")) sendType = "morto";
            if (!buffer.includes("[!] Kick")) {
                addLog(sendType, mcInfo.motivo, `Uptime ${uptime} KA ${mcInfo.kaCount}`);
                htmlPath = generateHTMLLog(mcInfo.motivo, sendType);
                const embed = disconnectedEmbed(mcInfo.motivo, sendType);
                if (liveMessage) {
                    liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }).catch(()=> sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
                    liveMessage = null;
                } else {
                    sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } });
                }
            } else {
                // ja foi enviado no Kick handler, mas ainda gera log — garante que se o edit falhou, força envio
                htmlPath = generateHTMLLog(mcInfo.motivo, "kickado");
                // se liveMessage ainda existe (edit do Kick falhou), força envio agora
                if (liveMessage) {
                    const embed = disconnectedEmbed(mcInfo.motivo, "kickado");
                    liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }).catch(()=> sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
                }
                liveMessage = null;
            }
        } else {
            mcState = "caido";
            if (!mcInfo.motivo) mcInfo.motivo = `Saiu/Desconectado (code ${code}) ${buffer.slice(-300).trim() || "sem motivo explicito"}`;
            sendType = "desconectado";
            if (mcInfo.motivo.toLowerCase().includes("ban")) sendType = "banido";
            else if (buffer.toLowerCase().includes("kick") || mcInfo.motivo.toLowerCase().includes("kick")) sendType = "kickado";
            addLog(sendType, mcInfo.motivo.slice(0,300), `Uptime ${uptime} KA ${mcInfo.kaCount} Code ${code}`);
            htmlPath = generateHTMLLog(mcInfo.motivo, sendType);
            const embed = disconnectedEmbed(mcInfo.motivo, sendType);
            // FORCE: sempre manda embed, por qualquer motivo
            if (liveMessage) {
                liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }).catch(()=> sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }));
                liveMessage = null;
            } else {
                sendToChannel({ content: `${mentionOwner()} @everyone`, embeds: [embed], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } });
            }
        }
        // Apenas gera o HTML, NAO envia automaticamente — só via botão 📜 Logs
        if (htmlPath) console.log(`[LOG] HTML salvo: ${htmlPath} (ver via botão Logs)`);

        runningBotId = null;
        mcProcess = null;

        if (autoReconnect && !shuttingDown) {
            console.log("[MC] Reconectando em 5s...");
            setTimeout(() => startMC(), 5000);
        } else {
            console.log("[MC] Auto-reconnect DESATIVADO — aguardando comando manual");
        }
    });

    mcProcess.on("error", (err) => {
        console.error("[MC] Spawn error:", err.message);
        mcState = "caido";
        runningBotId = null;
        mcInfo.motivo = `Erro ao iniciar: ${err.message}`;
        addLog("error", mcInfo.motivo, err.stack?.slice(0,500)||"");
        const htmlPath = generateHTMLLog(mcInfo.motivo, "erro");
        sendToChannel({
            content: `${mentionOwner()} @everyone`,
            embeds: [disconnectedEmbed(mcInfo.motivo, "erro")],
            components: fallenRow(),
            allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
        });
        if (autoReconnect) setTimeout(() => startMC(), 5000);
    });
}

// ============ DISCORD EVENTS ============
client.on("ready", async () => {
    console.log(`[DISCORD] Logado como ${client.user.tag}`);

    // Register slash command
    const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
    const commands = [
        new SlashCommandBuilder()
            .setName("conectar")
            .setDescription("Conecta o Ph4nt0m no servidor Minecraft")
            .addStringOption(o => o.setName("token").setDescription("Token (opcional, usa o padrão se vazio)").setRequired(false))
            .toJSON(),
        new SlashCommandBuilder().setName("status").setDescription("Mostra status do Ph4nt0m").toJSON(),
        new SlashCommandBuilder().setName("desconectar").setDescription("Desconecta o Ph4nt0m").toJSON(),
        new SlashCommandBuilder().setName("reconectar").setDescription("Reconecta o Ph4nt0m").toJSON(),
        new SlashCommandBuilder().setName("bots").setDescription("🤖 Gerencia todos os bots — criar, configurar IP, nick, etc").toJSON(),
    ];
    try {
        await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
        console.log("[DISCORD] Slash commands registrados");
    } catch (e) { console.error("Erro ao registrar comandos:", e.message); }

    // Send menu
    try {
        const ch = await client.channels.fetch(CHANNEL_ID);
        if (ch) {
            await ch.send({
                content: `${mentionOwner()} @everyone`,
                embeds: [menuEmbed()],
                components: menuRow(),
                allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
            });
            console.log("[DISCORD] Menu enviado");
        }
    } catch (e) { console.error("Erro ao enviar menu:", e.message); }

    // NAO inicia automaticamente — autoreconnect desligado, usuario clica Conectar
    console.log("[DISCORD] Auto-reconnect DESATIVADO. Aguardando /conectar ou botao Conectar.");
});

client.on("interactionCreate", async (interaction) => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === "conectar") {
                await interaction.deferReply({ ephemeral: false });
                const tokenOpt = interaction.options.getString("token");
                if (tokenOpt && tokenOpt !== DISCORD_TOKEN) {
                    await interaction.editReply({ content: "⚠️ Token diferente do configurado, usando token padrão...", embeds: [] });
                }
                if (mcState === "online") {
                    const e = new EmbedBuilder().setColor(0xf1c40f).setTitle("⚠️ Já Conectado").setDescription(`Ph4nt0m já está online há \`${getUptime()}\` em \`${MC_HOST}:${MC_PORT}\``).setTimestamp();
                    await interaction.editReply({ embeds: [e] });
                    return;
                }
                shuttingDown = false;
                const e = new EmbedBuilder().setColor(0x2ecc71).setTitle("🔄 Conectando...").setDescription(`Iniciando conexão de \`${MC_USER}\` em \`${MC_HOST}:${MC_PORT}\``).setTimestamp();
                await interaction.editReply({ embeds: [e] });
                if (!mcProcess) startMC();
                else {
                    killMC();
                    setTimeout(() => startMC(), 1000);
                }
            } else if (interaction.commandName === "status") {
                await interaction.reply({ embeds: [statusEmbed()], ephemeral: false });
            } else if (interaction.commandName === "desconectar") {
                await interaction.deferReply();
                killMC();
                mcState = "desligado";
                const e = new EmbedBuilder().setColor(0xe74c3c).setTitle("🔴 Desconectado").setDescription("Ph4nt0m desconectado.").setTimestamp();
                await interaction.editReply({ embeds: [e] });
            } else if (interaction.commandName === "reconectar") {
                await interaction.deferReply();
                killMC();
                const e = new EmbedBuilder().setColor(0xf1c40f).setTitle("🔄 Reconectando...").setDescription("Reiniciando conexão...").setTimestamp();
                await interaction.editReply({ embeds: [e] });
                setTimeout(() => startMC(), 1500);
            } else if (interaction.commandName === "bots") {
                await interaction.reply({ embeds: [botsEmbed()], components: botsRows(), ephemeral: false });
            }
        } else if (interaction.isButton()) {
            const id = interaction.customId;
            if (id === "btn_conectar") {
                await interaction.deferUpdate();
                if (mcState === "online") {
                    await interaction.followUp({ content: `⚠️ Já está online há \`${getUptime()}\`!`, ephemeral: true });
                    return;
                }
                shuttingDown = false;
                await sendToChannel({
                    content: `${mentionOwner()}`,
                    embeds: [new EmbedBuilder().setColor(0xf1c40f).setTitle("🔄 Conectando...").setDescription(`Iniciando \`${MC_USER}\` em \`${MC_HOST}:${MC_PORT}\``).setTimestamp()],
                    allowedMentions: { users: [OWNER_ID] }
                });
                if (!mcProcess) startMC();
                else { killMC(); setTimeout(() => startMC(), 1000); }
            } else if (id === "btn_reconectar") {
                await interaction.deferUpdate();
                shuttingDown = false;
                killMC();
                await sendToChannel({
                    content: `${mentionOwner()}`,
                    embeds: [new EmbedBuilder().setColor(0x3498db).setTitle("🔄 Reconectando...").setDescription("Forçando reconexão em 1.5s...").setTimestamp()],
                    allowedMentions: { users: [OWNER_ID] }
                });
                setTimeout(() => startMC(), 1500);
            } else if (id === "btn_desligar") {
                await interaction.deferUpdate();
                shuttingDown = true;
                killMC();
                mcState = "desligado";
                // Edita a live message se existir
                if (liveMessage) {
                    try { await liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle("🔌 Ph4nt0m Desconectado").setDescription(`Desconectado por <@${interaction.user.id}>`).setTimestamp().setFooter({ text: `Disconnect por ${interaction.user.tag}` })], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }); } catch {}
                    liveMessage = null;
                } else {
                    await sendToChannel({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [new EmbedBuilder().setColor(0xe67e22).setTitle("🔌 Ph4nt0m Desconectado").setDescription(`Desconectado por <@${interaction.user.id}>.\nUse **Conectar** para religar.`).setTimestamp().setFooter({ text: `Disconnect por ${interaction.user.tag}` })],
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    });
                }
                shuttingDown = false;
            } else if (id === "btn_kill") {
                await interaction.deferUpdate();
                // Mata TODOS os bots (multi + single)
                let killed = 0;
                for(const [bid, inst] of botInstances.entries()){
                    try{ if(inst.liveInterval) clearInterval(inst.liveInterval); inst.process.kill(); }catch{}
                    killed++;
                }
                botInstances.clear();
                stopLiveUpdate(); killMC(); mcState = "desligado"; runningBotId=null; shuttingDown = true;
                try {
                    await sendToChannel({
                        content: `${mentionOwner()} @everyone`,
                        embeds: [new EmbedBuilder().setColor(0x000000).setTitle("💀 BOT KILLADO").setDescription(`**Tudo foi encerrado por <@${interaction.user.id}>**\n\n> Minecraft: \`${killed} bots multi + single\` desconectados\n> Discord bot: Desligando...\n> Auto-reconnect: OFF\n\n*Para religar, inicie manualmente \`node discord_bot.js\`*`).setTimestamp().setFooter({ text: `Kill por ${interaction.user.tag} • Bot offline • ${killed} bots` })],
                        allowedMentions: { parse: ["everyone"], users: [OWNER_ID] }
                    });
                } catch {}
                setTimeout(async () => {
                    try { await client.destroy(); } catch {}
                    process.exit(0);
                }, 1500);
            } else if (id === "btn_autoreconnect") {
                autoReconnect = !autoReconnect;
                addLog("info", `Auto-Reconnect ${autoReconnect ? "ATIVADO" : "DESATIVADO"} por ${interaction.user.tag}`, `Estado: ${autoReconnect ? "ON" : "OFF"}`);
                // Atualiza botoes da live message se existir
                if (liveMessage && mcState === "online") {
                    try { await liveMessage.edit({ content: `${mentionOwner()} @everyone`, embeds: [liveConnectedEmbed()], components: fallenRow(), allowedMentions: { parse: ["everyone"], users: [OWNER_ID] } }); } catch {}
                }
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(autoReconnect?0x2ecc71:0x95a5a6).setTitle(autoReconnect?"✅ Auto-Reconnect ATIVADO":"❌ Auto-Reconnect DESATIVADO").setDescription(autoReconnect?"> Agora quando cair, reconecta sozinho em 5s.":"> Quando cair, ficará offline até você clicar em Reconectar.").setTimestamp()], ephemeral: true });
            } else if (id === "btn_logs") {
                const count = allLogs.length;
                const sessionCount = sessionLogs.length;
                const e = new EmbedBuilder()
                    .setColor(0x5865F2)
                    .setTitle("📜 Logs — Ph4nt0m")
                    .setDescription(`**Monitorando há:** \`${getBotUptime()}\` • **Sessão atual:** \`${mcState==="online"?getUptime():"—"}\` (\`#${mcInfo.tentativas}\`)\n**Logs salvos:** \`${count}\` • **Eventos na sessão:** \`${sessionCount}\``)
                    .setThumbnail("https://mc-heads.net/avatar/Ph4nt0m/100")
                    .setTimestamp()
                    .setFooter({ text: `Ph4nt0m • Clique nos botões abaixo para baixar cada HTML` })
                    .addFields(
                        { name: "📊 Sessão Atual", value: `> **Estado:** \`${mcState}\`\n> **Uptime:** \`${mcState==="online"?getUptime():"—"}\`\n> **KA:** \`${mcInfo.kaCount}\` • **Tentativa #${mcInfo.tentativas}**\n> **Eventos:** \`${sessionCount}\``, inline: false },
                        { name: `📁 Histórico — ${count} logs (cada disconnect = 1 HTML)`, value: count>0 ? allLogs.slice(0,5).map((l,i)=>{
                            const d = new Date(l.time);
                            const dt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                            return `\`${i+1}.\` **#${l.tent||"?"}** — ${dt} — \`${l.type}\` • \`${l.uptime}\` • \`${l.fname}\``;
                        }).join("\n") : "> *Nenhum log ainda. Cada disconnect gera um .html lindo em `logs/` com timeline completa* ", inline: false },
                    );
                if (sessionLogs.length>0) {
                    const last10 = sessionLogs.slice(-10).map(l=>`\`${new Date(l.ts).toLocaleTimeString('pt-BR')}\` **${l.type}** — ${l.msg}`).join("\n");
                    e.addFields({ name: `🕒 Últimos ${Math.min(10,sessionLogs.length)} eventos (sessão atual)`, value: "```"+last10.slice(0,1000)+"```", inline: false });
                }
                // Cria botoes para cada log
                const comps = [];
                if (count>0) {
                    const row = new ActionRowBuilder();
                    const maxBtns = Math.min(5, count);
                    for(let i=0;i<maxBtns;i++){
                        const l = allLogs[i];
                        const d = new Date(l.time);
                        const label = `#${l.tent||i+1} ${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
                        row.addComponents(new ButtonBuilder().setCustomId(`btn_viewlog_${i}`).setLabel(`📄 ${label}`).setStyle(ButtonStyle.Primary));
                    }
                    comps.push(row);
                }
                await interaction.reply({ embeds: [e], components: comps, ephemeral: true });
            } else if (id === "btn_randomize") {
                await interaction.deferReply({ ephemeral: true });
                const profile = generateUniqueProfile();
                let avatarSuccess = false, nameSuccess = false;
                let details = "";
                // Nome — tenta com criatividade extra
                try{
                    await client.user.setUsername(profile.name);
                    nameSuccess = true; details += `✅ Nome: \`${profile.name}\`\n`;
                }catch(err){ details += `❌ Nome falhou (rate limit Discord: 2/h): \`${profile.name}\` — ${err.message.slice(0,120)}\n`; }
                // Avatar — tenta QUALQUER foto, múltiplos fallbacks com PNG garantido
                const avatarCandidates = [
                    profile.avatar,
                    `https://mc-heads.net/avatar/${encodeURIComponent(profile.name)}/512`,
                    `https://robohash.org/${encodeURIComponent(profile.name+Date.now())}.png?set=set1`,
                    `https://i.pravatar.cc/512?u=${encodeURIComponent(profile.name+Math.random())}`,
                    `https://picsum.photos/seed/${encodeURIComponent(profile.name)}/512/512`
                ];
                for(const url of avatarCandidates){
                    try{
                        const buf = await fetchAvatarBuffer(url);
                        // Verifica se é imagem válida (PNG/JPG/WEBP, não SVG vazio)
                        if(buf.length < 100) throw new Error("imagem muito pequena");
                        await client.user.setAvatar(buf);
                        avatarSuccess = true; details += `✅ Avatar: [${url.slice(0,60)}](${url})\n`; profile.avatar = url; break;
                    }catch(err){ details += `⚠️ Tentativa avatar falhou ${url.slice(0,40)}: ${err.message.slice(0,60)}\n`; }
                }
                if(!avatarSuccess){
                    try{ await client.user.setAvatar(profile.avatar); avatarSuccess=true; details += `✅ Avatar (URL direto): \`${profile.avatar.slice(0,80)}\`\n`; }catch(e2){ details += `❌ Avatar todas tentativas falharam: ${e2.message.slice(0,120)}\n`; }
                }
                // Bio/descrição — MUITO mais criativo, garante funcionar
                let bioSuccess=false;
                try{
                    // Discord bots: presence com Custom Status (type 4) às vezes bloqueia, tenta Playing (0)
                    await client.user.setPresence({ activities:[{ name: profile.bio.slice(0,128), type: 0 }], status:'online' });
                    bioSuccess=true; details += `✅ Bio (Presence): \`${profile.bio}\`\n`;
                }catch{
                    try{ await client.user.setPresence({ activities:[{ name: profile.desc.slice(0,128), type: 2 }], status:'online' }); bioSuccess=true; details += `✅ Bio fallback: \`${profile.desc.slice(0,100)}\`\n`; }catch(e3){ details += `❌ Bio falhou: ${e3.message.slice(0,80)}\n`; }
                }
                // Descrição extra — salva e vai aparecer nos próximos embeds gigantes
                try{
                    const bioFile = path.join(__dirname, "logs", "bot_bio.json");
                    fs.writeFileSync(bioFile, JSON.stringify({ name: profile.name, bio: profile.bio, desc: profile.desc, avatar: profile.avatar, at: new Date().toISOString(), by: interaction.user.tag, avatarOk: avatarSuccess, nameOk: nameSuccess }, null, 2));
                    details += `✅ Desc salva: \`${profile.desc.slice(0,80)}\`\n`;
                }catch{}
                addLog("info", `Randomizado ? → ${profile.name} (avatar:${avatarSuccess?'OK':'FAIL'} bio:${bioSuccess?'OK':'FAIL'})`, `${profile.bio} | ${profile.avatar.slice(0,60)}`);
                const e2 = new EmbedBuilder()
                    .setColor(avatarSuccess && nameSuccess ? 0x2ecc71 : 0x9b59b6)
                    .setTitle(avatarSuccess && nameSuccess ? "❓ RANDOMIZADO COM SUCESSO! — Tudo Unico" : "❓ Randomizado — Parcial")
                    .setDescription(`**Nunca vai ser igual — hash:** \`${profile.key.slice(0,16)}\``)
                    .setThumbnail(profile.avatar)
                    .setTimestamp()
                    .setFooter({ text: `Randomizado por ${interaction.user.tag} • Único garantido` })
                    .addFields(
                        { name: "👤 Novo Nome", value: `\`${profile.name}\` ${nameSuccess?"✅":"❌ rate limit"}`, inline: true },
                        { name: "🖼️ Novo Avatar", value: avatarSuccess ? `✅ Aplicado` : `❌ Falhou`, inline: true },
                        { name: "📝 Nova Bio", value: `\`\`\`${profile.bio}\`\`\``, inline: false },
                        { name: "📄 Descrição", value: `\`\`\`${profile.desc}\`\`\``, inline: false },
                        { name: "🔑 Detalhes", value: details.slice(0,1000) || "—", inline: false },
                        { name: "💡", value: `> Nome e avatar são do bot do Discord (\`tet\`), mudam globalmente. Bio salva em \`logs/bot_bio.json\` e aparece nos próximos embeds.`, inline: false },
                    );
                await interaction.editReply({ embeds:[e2] });
            } else if (id.startsWith("btn_viewlog_")) {
                const idx = parseInt(id.split("_").pop());
                const log = allLogs[idx];
                if (!log) { await interaction.reply({ content: "❌ Log não encontrado.", ephemeral: true }); return; }
                try {
                    if (!fs.existsSync(log.fpath)) { await interaction.reply({ content: `❌ Arquivo não encontrado: \`${log.fname}\``, ephemeral: true }); return; }
                    const file = new AttachmentBuilder(log.fpath);
                    const e = new EmbedBuilder().setColor(0x5865F2).setTitle(`📜 Log #${log.tent||idx+1} — ${log.fname}`).setDescription(`**Tipo:** \`${log.type}\` • **Uptime:** \`${log.uptime}\` • **KA:** \`${log.ka||"?"}\`\n**Data:** <t:${Math.floor(new Date(log.time).getTime()/1000)}:F>\n**Motivo:**\n\`\`\`${(log.reason||"").slice(0,800)}\`\`\``).setTimestamp(new Date(log.time));
                    await interaction.reply({ content: `📎 **Log #${log.tent||idx+1}** — \`${log.fname}\``, embeds: [e], files: [file], ephemeral: true });
                } catch(err){ await interaction.reply({ content: `❌ Erro: ${err.message}`, ephemeral: true }); }
            } else if (id === "btn_bot_create") {
                const modal = new ModalBuilder().setCustomId("modal_bot_create").setTitle("➕ Criar Novo Bot");
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_name").setLabel("Nome do Bot").setStyle(TextInputStyle.Short).setPlaceholder("Ex: Ph4nt0m2").setRequired(true).setMaxLength(32)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_host").setLabel("IP / Host").setStyle(TextInputStyle.Short).setPlaceholder("Ex: 3ww123.play.hosting").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_port").setLabel("Porta").setStyle(TextInputStyle.Short).setPlaceholder("25565").setValue("25565").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_nick").setLabel("Nick no Minecraft").setStyle(TextInputStyle.Short).setPlaceholder("Ex: Ph4nt0m2").setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("bot_version").setLabel("Versão / Protocolo").setStyle(TextInputStyle.Short).setPlaceholder("26.2").setValue("26.2").setRequired(false))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_bot_config_ip") {
                const bot = getSelectedBot();
                const modal = new ModalBuilder().setCustomId("modal_bot_config_ip").setTitle(`⚙️ Configurar IP — ${bot.name}`);
                modal.addComponents(
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_host").setLabel("IP / Host").setStyle(TextInputStyle.Short).setValue(bot.host).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_port").setLabel("Porta").setStyle(TextInputStyle.Short).setValue(String(bot.port)).setRequired(true)),
                    new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("cfg_version").setLabel("Versão").setStyle(TextInputStyle.Short).setValue(bot.version).setRequired(false))
                );
                await interaction.showModal(modal);
            } else if (id === "btn_bot_rename") {
                const bot = getSelectedBot();
                const modal = new ModalBuilder().setCustomId("modal_bot_rename").setTitle(`📝 Renomear — ${bot.name}`);
                modal.addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("new_name").setLabel("Novo Nick").setStyle(TextInputStyle.Short).setValue(bot.user).setRequired(true).setMaxLength(16)));
                await interaction.showModal(modal);
            } else if (id === "btn_bot_delete") {
                if (bots.length<=1) { await interaction.reply({ content:"❌ Não pode deletar o último bot!", ephemeral:true }); return; }
                const bot = bots[0];
                bots.shift(); saveBots(); syncPrimary();
                await interaction.reply({ embeds: [new EmbedBuilder().setColor(0xe74c3c).setTitle("🗑️ Bot Deletado").setDescription(`Bot \`${bot.name}\` (\`${bot.host}:${bot.port}\`) removido.\nRestam \`${bots.length}\` bots.`).setTimestamp()], ephemeral:false });
            } else if (id === "btn_bot_start") {
                const sel = getSelectedBot();
                if(!sel){ await interaction.reply({content:"❌ Nenhum bot selecionado", ephemeral:true}); return; }
                if(botInstances.has(sel.id) && botInstances.get(sel.id).state==="online"){
                    await interaction.reply({ content:`⚠️ **${sel.name}** já está online!`, ephemeral:true }); return;
                }
                if(botInstances.has(sel.id)){
                    await interaction.reply({ content:`⚠️ **${sel.name}** já está conectando...`, ephemeral:true }); return;
                }
                await interaction.deferUpdate();
                // MULTI: inicia em paralelo, NAO mata outros bots
                addLog("info", `Iniciando bot "${sel.name}" (${sel.host}:${sel.port}) em paralelo`, `Por ${interaction.user.tag} • Total antes: ${botInstances.size}`);
                await sendToChannel({ content:`${mentionOwner()}`, embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle(`▶️ Iniciando ${sel.name}...`).setDescription(`Bot **${sel.name}** (\`${sel.user}\`) em \`${sel.host}:${sel.port}\`\nRodando em paralelo — total **${botInstances.size+1}** bots`).setTimestamp()], allowedMentions:{users:[OWNER_ID]}});
                startBotMulti(sel.id);
            } else if (id === "btn_bot_stop") {
                const sel = getSelectedBot();
                await interaction.deferUpdate();
                const stopped = stopBotMulti(sel.id);
                if(stopped){
                    await sendToChannel({ content:`${mentionOwner()} @everyone`, embeds:[new EmbedBuilder().setColor(0xe67e22).setTitle(`⏹️ ${sel.name} Parado`).setDescription(`Bot **${sel.name}** parado por <@${interaction.user.id}>\nRestam **${botInstances.size}** bots rodando`).setTimestamp()], allowedMentions:{parse:["everyone"],users:[OWNER_ID]}});
                    addLog("info", `Bot ${sel.name} parado`, `Por ${interaction.user.tag}`);
                } else {
                    // fallback single
                    shuttingDown=true; killMC(); mcState="desligado";
                    await sendToChannel({ content:`${mentionOwner()} @everyone`, embeds:[new EmbedBuilder().setColor(0xe67e22).setTitle("⏹️ Bot Parado").setDescription(`Parado via painel /bots por <@${interaction.user.id}>`).setTimestamp()], allowedMentions:{parse:["everyone"],users:[OWNER_ID]}});
                    shuttingDown=false;
                }
            } else if (id === "btn_bot_refresh") {
                await interaction.update({ embeds:[botsEmbed()], components: botsRows() });
            } else if (id === "btn_status") {
                await interaction.reply({ embeds: [statusEmbed()], ephemeral: true });
            }
        } else if (interaction.isStringSelectMenu()) {
            if (interaction.customId === "select_bot") {
                const chosen = interaction.values[0];
                const idx = bots.findIndex(b=>b.id===chosen);
                if(idx>0){ const [bot]=bots.splice(idx,1); bots.unshift(bot); saveBots(); syncPrimary(); }
                await interaction.update({ embeds:[botsEmbed()], components: botsRows() });
            }
        } else if (interaction.isModalSubmit()) {
            if (interaction.customId === "modal_bot_create") {
                const name = interaction.fields.getTextInputValue("bot_name").trim();
                const host = interaction.fields.getTextInputValue("bot_host").trim();
                const port = parseInt(interaction.fields.getTextInputValue("bot_port"))||25565;
                const nick = interaction.fields.getTextInputValue("bot_nick").trim();
                const ver = interaction.fields.getTextInputValue("bot_version")?.trim() || "26.2";
                const id = name.toLowerCase().replace(/[^a-z0-9]/g,"").slice(0,16) || `bot${Date.now()}`;
                bots.push({ id, name, host, port, user:nick, version:ver, enabled:true, createdAt:new Date().toISOString() });
                saveBots();
                await interaction.reply({ embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle("✅ Bot Criado!").setDescription(`**${name}** (\`${host}:${port}\` • \`${nick}\`) criado!\nTotal: \`${bots.length}\` bots.`).setTimestamp()], ephemeral:false });
            } else if (interaction.customId === "modal_bot_config_ip") {
                const host = interaction.fields.getTextInputValue("cfg_host").trim();
                const port = parseInt(interaction.fields.getTextInputValue("cfg_port"))||25565;
                const ver = interaction.fields.getTextInputValue("cfg_version")?.trim() || bots[0].version;
                bots[0].host = host; bots[0].port = port; bots[0].version = ver; saveBots(); syncPrimary();
                await interaction.reply({ embeds:[new EmbedBuilder().setColor(0x3498db).setTitle("⚙️ IP Atualizado!").setDescription(`Novo endereço: \`${host}:${port}\` • Versão \`${ver}\`\nBot **${bots[0].name}** atualizado. Use **▶️ Iniciar** para conectar.`).setTimestamp()], ephemeral:false });
            } else if (interaction.customId === "modal_bot_rename") {
                const nick = interaction.fields.getTextInputValue("new_name").trim();
                bots[0].user = nick; bots[0].name = nick; saveBots(); syncPrimary();
                await interaction.reply({ embeds:[new EmbedBuilder().setColor(0x2ecc71).setTitle("📝 Renomeado!").setDescription(`Bot agora é \`${nick}\` (\`${bots[0].host}:${bots[0].port}\`)`).setTimestamp()], ephemeral:false });
            }
        }
    } catch (e) { console.error("Interaction error:", e); }
});

// ============ RENDER KEEP-ALIVE WEB SERVER (não deixa o Render dormir) ============
const WEB_PORT = process.env.PORT || 3000;
try {
    const express = require('express');
    const web = express();
    web.get('/', (req,res)=> res.send(`<h1>Ph4nt0m Bot Online ✅</h1><p>Uptime: ${getBotUptime()}<br>Bots: ${bots.length}<br>MC: ${mcState}<br>Multi: ${botInstances.size} bots<br>${new Date().toISOString()}</p><p><a href="/health">/health</a> • <a href="https://discord.com">Discord</a></p>`));
    web.get('/health', (req,res)=> res.json({ status:'ok', uptime: getBotUptime(), botUptime: botInitTime, bots: bots.length, running: botInstances.size + (mcState==="online"?1:0), mcState, timestamp: new Date().toISOString() }));
    web.get('/ping', (req,res)=> res.send('pong'));
    web.listen(WEB_PORT, ()=> console.log(`[WEB] ✅ Health check ouvindo em :${WEB_PORT} — Render não vai dormir`));
    // Self-ping a cada 9 min (Render free dorme em 15 min sem tráfego)
    setInterval(()=> { try{ require('http').get(`http://localhost:${WEB_PORT}/health`,()=>{}).on('error',()=>{}); }catch{} }, 9*60*1000);
    // Keep-alive externo opcional: UptimeRobot pode pingar /health
} catch(e){ console.log("[WEB] Sem express, sem web server:", e.message); }

// Graceful shutdown
process.on("SIGINT", () => { shuttingDown = true; for(const inst of botInstances.values()){ try{inst.process.kill()}catch{} } killMC(); client.destroy(); process.exit(0); });
process.on("SIGTERM", () => { shuttingDown = true; for(const inst of botInstances.values()){ try{inst.process.kill()}catch{} } killMC(); client.destroy(); process.exit(0); });

client.login(DISCORD_TOKEN).catch(e => { console.error("Login falhou:", e.message); process.exit(1); });

console.log("[DISCORD] Iniciando...");
