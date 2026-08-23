import asyncio
import random
from quarry.net.client import ClientFactory, ClientProtocol

class AFKBotProtocol(ClientProtocol):
    def player_join(self):
        # Envia pacotes de keep-alive automaticamente pela biblioteca
        print(f"[{self.factory.username}] Entrou no servidor!")
        
        # Opcional: Mover-se levemente para não ser kickado por AFK em alguns servidores
        asyncio.ensure_future(self.mover_afk())

    async def mover_afk(self):
        while True:
            await asyncio.sleep(60) # Espera 1 minuto
            # Envia um pacote de movimento mínimo ou olhada (depende da versão da quarry)
            # A biblioteca quarry gerencia o keep-alive de rede, mas alguns servidores exigem movimento
            # Se o servidor tiver anti-AFK, você pode precisar implementar o envio de pacote de posição aqui.
            pass

    def packet_keep_alive(self, buff):
        # Responde automaticamente ao keep-alive do servidor
        pass

class AFKBotFactory(ClientFactory):
    protocol = AFKBotProtocol
    username = "BotManterOnline" # Nome do bot

    def __init__(self, host, port):
        self.host = host
        self.port = port

    def build_protocol(self, addr):
        protocol = super().build_protocol(addr)
        protocol.factory = self
        return protocol

async def main():
    # CONFIGURAÇÕES
    HOST = "3ww123.play.hosting" # IP do seu servidor Play.Hosting
    PORT = 44947         # Porta padrão
    USERNAME = "3ww2"

    factory = AFKBotFactory(HOST, PORT)
    factory.username = USERNAME
    
    # Conecta ao servidor
    await factory.connect(HOST, PORT)
    
    # Mantém o script rodando
    while True:
        await asyncio.sleep(1)

if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("Bot desligado.")   