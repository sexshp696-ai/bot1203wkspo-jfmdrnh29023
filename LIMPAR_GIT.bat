@echo off
echo Limpando git vazado e refazendo sem token...
echo.

:: Mata bot se estiver rodando
taskkill /F /IM node.exe 2>nul

:: Remove histórico vazado
rmdir /s /q .git 2>nul
del /q .git 2>nul

:: Garante .env existe (copia do exemplo se não tiver)
if not exist .env (
  echo Criando .env a partir do .env.example — EDITE COM SEU NOVO TOKEN!
  copy .env.example .env
  echo.
  echo !!! EDITE o arquivo .env com seu NOVO token antes de continuar !!!
  echo Pegue em: https://discord.com/developers/applications/1540883406219649136/bot -> Reset Token
  echo.
  pause
)

echo Inicializando novo git limpo...
git init
git config user.email "phant0m@bot.com"
git config user.name "Ph4nt0m"
git add .
git commit -m "Ph4nt0m Bot v2 - sem token, env var, multi-bot, logs 10k, ? randomize"

echo.
echo Pronto! Agora crie um NOVO repo no GitHub (ou delete o antigo vazado) e rode:
echo   git remote add origin https://github.com/SEUUSER/phant0m-bot.git
echo   git branch -M main
echo   git push -u origin main
echo.
echo IMPORTANTE: No Render, configure DISCORD_TOKEN em Environment Variables, nunca no código!
echo.
pause
