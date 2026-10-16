@echo off
cd /d "%~dp0"
echo Envoi du projet vers GitHub...
git add -A
git commit -m "Mise a jour %date% %time%"
git push
echo.
echo Termine. Attends que Vercel affiche Ready, puis fais Ctrl+F5 sur le site.
pause
