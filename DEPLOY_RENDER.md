# 🚀 Deploy no Render — Ph4nt0m Bot SEMPRE ON

## 1) Suba no GitHub
```bash
git init
git add .
git commit -m "Ph4nt0m Bot Render Ready"
git branch -M main
git remote add origin https://github.com/SEUUSER/phant0m-bot.git
git push -u origin main
```

## 2) Render
1. https://dashboard.render.com → **New + → Web Service**
2. Conecte seu GitHub repo `phant0m-bot`
3. Render detecta `Dockerfile` automaticamente
   - **Name:** `phant0m-bot`
   - **Runtime:** `Docker`
   - **Plan:** `Free`
   - **Health Check Path:** `/health`
   - **Auto-Deploy:** `No` (ou Yes)
4. **Add Environment Variable** (OBRIGATÓRIO — nunca hardcode!):
   - `DISCORD_TOKEN` = `SEU_NOVO_TOKEN_AQUI` (pegue em https://discord.com/developers/applications/1540883406219649136/bot → Reset Token)
   - `CHANNEL_ID` = `1540883450708623370`
   - `OWNER_ID` = `1390600304214544525`
5. **Create Web Service** → aguarde build

## 3) Garanta que fica SEMPRE ON (Render free dorme em 15 min sem tráfego)
O bot já faz **self-ping a cada 9 min** em `http://localhost:$PORT/health` + expõe `/health` e `/` pro Render Health Check.

**Recomendado (100% garantido):** crie um monitor no **UptimeRobot** (grátis):
- https://uptimerobot.com → Add New Monitor → HTTP(s) → URL: `https://SEU-SERVICO.onrender.com/health` → Interval 5 min → Create
- Isso pinga seu bot de fora a cada 5 min e o Render NUNCA dorme.

## 4) Teste
- No Discord, canal `1540883450708623370` deve receber o **embed GIGANTE** do painel
- `/bots` → criar/configurar bots
- Cada disconnect gera `.html` lindo em `logs/` (persiste)

## Arquivos incluídos
- `Dockerfile` — Node 22 + Python 3 + healthcheck
- `render.yaml` — infra como código
- `package.json` — `npm start` → `node discord_bot.js`
- `discord_bot.js` — web server em `process.env.PORT` com `/` e `/health`

## Logs
Todos os logs salvos em `logs/*.html` + `logs/index.json` (persiste entre restarts). Baixe via botão 📜 Logs no Discord.
