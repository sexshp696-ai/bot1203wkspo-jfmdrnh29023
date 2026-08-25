import sys
sys.stdout.reconfigure(line_buffering=True)
sys.stderr.reconfigure(line_buffering=True)

import socket
import struct
import time
import uuid
import zlib
import threading


def ev(val):
    out = b""
    while True:
        b = val & 0x7F
        val >>= 7
        if val != 0:
            b |= 0x80
        out += bytes([b])
        if val == 0:
            break
    return out


def dv(data, off=0):
    r = 0
    s = 0
    while off < len(data):
        b = data[off]
        r |= (b & 0x7F) << s
        off += 1
        if not (b & 0x80):
            return r, off
        s += 7
    raise ValueError("incomplete varint")


def ws(s):
    e = s.encode("utf-8")
    return ev(len(e)) + e


def wl(v):
    return struct.pack(">q", v)


def wd(v):
    return struct.pack(">d", v)


def wf(v):
    return struct.pack(">f", v)


def wb(v):
    return bytes([1 if v else 0])


LOGIN_HELLO = 0x00
LOGIN_ACK = 0x03

CONFIG_CLIENT_INFO = 0x00
CONFIG_FINISH = 0x03
CONFIG_KNOWN_PACKS_SB = 0x07

PLAY_CHAT_COMMAND = 0x06
PLAY_CONFIRM_TELEPORT = 0x00
PLAY_CHUNK_BATCH = 0x0B
PLAY_KEEPALIVE = 0x1C

CB_KEEPALIVE = 0x2C
CB_DISCONNECT = 0x20
CB_SYNC_POS = 0x48
CB_CHUNK_BATCH_FINISHED = 0x0B

GAMEMODE_NAMES = {
    0: "Survival",
    1: "Creative",
    2: "Adventure",
    3: "Spectator",
}


class Bot:
    def __init__(self, host, port, user):
        self.host = host
        self.port = port
        self.user = user
        self.sock = None
        self.buf = b""
        self.running = False
        self.compress = -1
        self.state = "login"
        self.x = 0.0
        self.y = 64.0
        self.z = 0.0
        self.spawned = False
        self.gamemode = -1
        self.chat_mode = "enabled"
        self.send_lock = threading.Lock()

    def _recv(self):
        chunk = self.sock.recv(65536)
        if not chunk:
            raise ConnectionError("closed")
        self.buf += chunk

    def _read_packet(self):
        while True:
            try:
                pkt_len, end = dv(self.buf)
                break
            except ValueError:
                self._recv()
        while len(self.buf) < end + pkt_len:
            self._recv()
        pkt_data = self.buf[end : end + pkt_len]
        self.buf = self.buf[end + pkt_len :]

        if self.compress < 0:
            pid, off = dv(pkt_data)
            return pid, pkt_data[off:]
        else:
            data_len, off = dv(pkt_data)
            payload_raw = pkt_data[off:]
            if data_len > 0:
                raw = zlib.decompress(payload_raw)
                pid, off2 = dv(raw)
                return pid, raw[off2:]
            else:
                pid, off2 = dv(payload_raw)
                return pid, payload_raw[off2:]

    def _send(self, pid, data=b""):
        with self.send_lock:
            payload = ev(pid) + data
            if self.compress >= 0:
                if len(payload) >= self.compress:
                    comp = zlib.compress(payload)
                    inner = ev(len(payload)) + comp
                else:
                    inner = ev(0) + payload
                self.sock.sendall(ev(len(inner)) + inner)
            else:
                self.sock.sendall(ev(len(payload)) + payload)

    def _send_raw(self, pid, data=b""):
        with self.send_lock:
            self.sock.sendall(ev(len(ev(pid) + data)) + ev(pid) + data)

    def send_chat_command(self, cmd):
        if not self.running or self.state != "play":
            return
        cmd_clean = cmd.lstrip("/")
        try:
            # 1.21 Chat Command (0x04): command (String)
            self._send(PLAY_CHAT_COMMAND, ws(cmd_clean))
            print(f"[*] Comando enviado ao servidor: /{cmd_clean}")
        except Exception as e:
            print(f"[!] Erro ao enviar comando: {e}")

    def connect(self):
        print(f"[*] Conectando a {self.host}:{self.port} como '{self.user}'...")
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.settimeout(20)
        self.sock.connect((self.host, self.port))

        hand = ev(776) + ws(self.host) + struct.pack(">H", self.port) + ev(2)
        self._send_raw(0x00, hand)

        player_uuid = uuid.uuid5(uuid.NAMESPACE_URL, f"OfflinePlayer:{self.user}")
        self._send_raw(LOGIN_HELLO, ws(self.user) + player_uuid.bytes)

        while self.state == "login":
            pid, payload = self._read_packet()
            if pid == 0x00:
                try:
                    msg = payload.decode("utf-8")
                except Exception:
                    msg = str(payload[:100])
                print(f"[!] Kick: {msg}")
                return False
            elif pid == 0x03:
                threshold, _ = dv(payload)
                self.compress = threshold
                print(f"[*] Compressao: {threshold}")
            elif pid == 0x02:
                print("[+] Login Success!")
                self._send(LOGIN_ACK)
                print("[*] Login Acknowledged enviado")
                self.state = "configuration"
                break

        print("[*] Aguardando configuration...")

        client_info = (
            ws("pt_BR")
            + bytes([12])
            + ev(0)
            + wb(True)
            + bytes([0x7F])
            + ev(1)
            + wb(False)
            + wb(True)
            + ev(0)
        )
        self._send(CONFIG_CLIENT_INFO, client_info)
        print("[*] Client Information enviado")

        while self.state == "configuration":
            try:
                pid, payload = self._read_packet()
            except (ConnectionError, socket.timeout):
                print("[!] Conexao perdida na configuration")
                return False

            if pid == 0x02:
                try:
                    msg = payload.decode("utf-8")
                except Exception:
                    msg = str(payload[:100])
                print(f"[!] Kick config: {msg}")
                return False
            elif pid == 0x0E:
                print("[*] Known Packs, respondendo...")
                self._send(CONFIG_KNOWN_PACKS_SB, ev(0))
            elif pid == 0x03:
                print("[*] Finish Configuration recebido")
                self._send(CONFIG_FINISH)
                print("[*] Acknowledge Finish Configuration enviado")
                self.state = "play"
                print("[+] PLAY STATE!")
                break

        return True

    def _handle(self, pid, data):
        if pid == CB_KEEPALIVE:
            if len(data) >= 8:
                kid = struct.unpack(">q", data[:8])[0]
                self._send(PLAY_KEEPALIVE, wl(kid))

        elif pid == CB_DISCONNECT:
            try:
                msg = data.decode("utf-8")
            except Exception:
                msg = str(data[:100])
            print(f"[!] Kick play: {msg}")
            self.running = False

        elif pid == CB_SYNC_POS:
            try:
                off = 0
                teleport_id, off = dv(data)
                self._send(PLAY_CONFIRM_TELEPORT, ev(teleport_id))
                self.spawned = True
                if len(data) >= off + 24:
                    self.x = struct.unpack(">d", data[off:off + 8])[0]
                    self.y = struct.unpack(">d", data[off + 8:off + 16])[0]
                    self.z = struct.unpack(">d", data[off + 16:off + 24])[0]
                    cx = int(self.x) >> 4
                    cz = int(self.z) >> 4
                    gm = GAMEMODE_NAMES.get(self.gamemode, f"Unknown({self.gamemode})")
                    print(f"[COORDS] X={self.x:.1f} Y={self.y:.1f} Z={self.z:.1f} | Chunk {cx},{cz}")
                    print(f"[GAMEMODE] {self.gamemode} ({gm})")
                    print(f"[CHATMODE] {self.chat_mode}")
            except Exception:
                pass

        elif pid == CB_CHUNK_BATCH_FINISHED:
            self._send(PLAY_CHUNK_BATCH, struct.pack(">f", 1.0))

        elif pid == 0x76:
            print("[*] Start Configuration recebido, respondendo...")
            self.state = "configuration"
            self._send(0x10)

        elif pid == 0x3D:
            if len(data) >= 4:
                ping_id = struct.unpack(">i", data[:4])[0]
                self._send(0x2D, struct.pack(">i", ping_id))

        elif pid == 0x15:
            self._send(0x14, ev(0) + ev(0))

        elif pid == 0x26:
            if len(data) >= 5:
                event = data[0]
                if event == 11:
                    print("[*] Respawn screen, respawnando...")
                    self._send(0x0C, ev(0))
                elif event == 3:
                    try:
                        val = struct.unpack(">f", data[1:5])[0]
                        self.gamemode = int(val)
                        gm = GAMEMODE_NAMES.get(self.gamemode, f"Unknown({self.gamemode})")
                        print(f"[GAMEMODE] {self.gamemode} ({gm})")
                    except Exception:
                        pass

        elif pid == 0x52:
            print("[*] Respawn recebido")
            self.spawned = False

        elif pid == 0x44:
            print("[*] Player morreu!")

        elif pid == 0x60:
            try:
                health = struct.unpack(">f", data[:4])[0]
                if health <= 0:
                    print("[*] Player morreu! (health=0)")
            except Exception:
                pass

        elif pid == 0x31:
            try:
                if len(data) >= 6:
                    gm_byte = data[5]
                    self.gamemode = gm_byte
                    gm = GAMEMODE_NAMES.get(self.gamemode, f"Unknown({self.gamemode})")
                    print(f"[GAMEMODE] {self.gamemode} ({gm})")
            except Exception:
                pass

    def _stdin_reader(self):
        while self.running:
            try:
                line = sys.stdin.readline()
                if not line:
                    break
                line = line.strip()
                if not line:
                    continue
                if line.startswith("cmd:"):
                    cmd = line[4:].strip()
                    self.send_chat_command(cmd)
                elif line.startswith("gm:"):
                    mode = line[3:].strip()
                    self.send_chat_command(f"gamemode {mode}")
                    # Local update
                    modes_map = {"survival": 0, "creative": 1, "adventure": 2, "spectator": 3, "0": 0, "1": 1, "2": 2, "3": 3}
                    if mode.lower() in modes_map:
                        self.gamemode = modes_map[mode.lower()]
                        gm = GAMEMODE_NAMES.get(self.gamemode, f"Unknown({self.gamemode})")
                        print(f"[GAMEMODE] {self.gamemode} ({gm})")
            except Exception:
                break

    def run(self):
        if not self.connect():
            return

        self.sock.settimeout(0.5)
        self.running = True
        ka_count = 0
        start = time.time()
        coord_report_interval = 30
        last_coord_report = time.time()
        print("[*] Bot ativo! Ficando parado no servidor...")

        stdin_thread = threading.Thread(target=self._stdin_reader, daemon=True)
        stdin_thread.start()

        try:
            while self.running:
                try:
                    while True:
                        pid, data = self._read_packet()
                        self._handle(pid, data)
                        if pid == CB_KEEPALIVE:
                            ka_count += 1
                            elapsed = time.time() - start
                            print(f"    [KA #{ka_count}] {elapsed:.0f}s")
                except socket.timeout:
                    pass
                except ConnectionError:
                    print("[!] Conexao perdida.")
                    break
                except Exception:
                    pass

                now = time.time()
                if self.spawned and (now - last_coord_report) >= coord_report_interval:
                    last_coord_report = now
                    gm = GAMEMODE_NAMES.get(self.gamemode, f"GM{self.gamemode}")
                    print(f"[COORDS] X={self.x:.1f} Y={self.y:.1f} Z={self.z:.1f}")
                    print(f"[GAMEMODE] {self.gamemode} ({gm})")
                    print(f"[CHATMODE] {self.chat_mode}")

                time.sleep(0.2)

        except KeyboardInterrupt:
            print("\n[*] Bot encerrado.")
        finally:
            self.running = False
            try:
                self.sock.close()
            except Exception:
                pass
            print("[*] Desconectado.")


if __name__ == "__main__":
    h = sys.argv[1] if len(sys.argv) > 1 else "3ww123.play.hosting"
    p = int(sys.argv[2]) if len(sys.argv) > 2 else 25565
    u = sys.argv[3] if len(sys.argv) > 3 else "Ph4nt0m"
    print(f"[*] Config: {h}:{p} como '{u}'")
    bot = Bot(h, p, u)
    bot.run()
