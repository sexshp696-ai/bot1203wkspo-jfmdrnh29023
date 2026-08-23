# Ph4nt0m Bot — Render Dockerfile (Node 22 + Python 3.11)
FROM node:22-slim

# Instala Python
RUN apt-get update && apt-get install -y python3 python3-pip procps && rm -rf /var/lib/apt/lists/* && ln -sf /usr/bin/python3 /usr/bin/python && ln -sf /usr/bin/python3 /usr/bin/py

WORKDIR /app

# Copia package e instala Node deps
COPY package.json package-lock.json* ./
RUN npm install --production

# Copia resto (bot.py, discord_bot.js, logs, bots.json)
COPY . .

# Cria pasta de logs
RUN mkdir -p logs

# Render usa $PORT — expõe 3000
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 CMD node -e "require('http').get('http://localhost:'+ (process.env.PORT||3000) +'/health', r=>{process.exit(r.statusCode===200?0:1)}).on('error',()=>process.exit(1))"

CMD ["node", "discord_bot.js"]
