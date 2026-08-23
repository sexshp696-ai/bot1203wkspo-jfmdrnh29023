const { createBot } = require('mineflayer')

const bot = createBot({
  host: '3ww123.play.hosting',
  port: 25565,
  username: 'Ph4nt0m',
  version: false
})

bot.on('spawn', () => {
  console.log('[+] Bot entrou no jogo! Simulando atividade...')

  setInterval(() => {
    const dx = (Math.random() - 0.5) * 0.6
    const dz = (Math.random() - 0.5) * 0.6
    const dy = Math.random() < 0.1 ? 0.4 : 0
    const pos = bot.entity.position
    bot.entity.position = pos.offset(dx, dy, -dz)
    bot.look(Math.random() * Math.PI * 2 - Math.PI, (Math.random() - 0.5) * 0.4)
  }, 2000)

  setInterval(() => {
    if (Math.random() < 0.3) {
      bot.setControlState('jump', true)
      setTimeout(() => bot.setControlState('jump', false), 400)
    }
  }, 15000)

  setInterval(() => {
    const msgs = ['...', 'afk', 'hi', '.', 'yo']
    bot.chat(msgs[Math.floor(Math.random() * msgs.length)])
  }, 120000)
})

bot.on('message', (msg) => {
  console.log(`[Chat] ${msg.toString()}`)
})

bot.on('kicked', (reason) => {
  console.log(`[!] Kickado: ${reason}`)
})

bot.on('error', (err) => {
  console.log(`[!] Erro: ${err.message}`)
})

bot.on('end', (reason) => {
  console.log(`[*] Desconectado: ${reason}`)
  process.exit(0)
})

console.log('[*] Conectando...')
