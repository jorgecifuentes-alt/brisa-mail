#!/usr/bin/env bash
# Instala Brisa en una máquina Ubuntu nueva (Oracle Cloud Always Free o Google Cloud e2-micro).
# Uso, en la máquina:  curl -fsSL <este archivo> -o instalar.sh && sudo bash instalar.sh
set -euo pipefail
REPO="git@github.com:jorgecifuentes-alt/brisa-mail.git"
DIR=/opt/brisa
say(){ printf '\n\033[1;34m== %s\033[0m\n' "$*"; }

[ "$(id -u)" = 0 ] || { echo "Ejecútalo con sudo: sudo bash instalar.sh"; exit 1; }

say "1/7 Paquetes del sistema"
apt-get update -y
apt-get install -y git curl ca-certificates nano cron iptables-persistent >/dev/null || apt-get install -y git curl ca-certificates nano cron

say "2/7 Docker"
command -v docker >/dev/null || curl -fsSL https://get.docker.com | sh
systemctl enable --now docker

say "3/7 Memoria de intercambio (para compilar en máquinas de 1 GB)"
if [ "$(free -m | awk '/Mem:/{print $2}')" -lt 3000 ] && ! swapon --show | grep -q swapfile; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

say "4/7 Puertos 80 y 443 (web) abiertos en el firewall de la máquina"
iptables -C INPUT -p tcp --dport 80 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 80 -j ACCEPT
iptables -C INPUT -p tcp --dport 443 -j ACCEPT 2>/dev/null || iptables -I INPUT 1 -p tcp --dport 443 -j ACCEPT
command -v netfilter-persistent >/dev/null && netfilter-persistent save >/dev/null || true

say "5/7 Acceso de solo lectura a tu repositorio de GitHub"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f /root/.ssh/brisa_deploy ] || ssh-keygen -t ed25519 -N "" -f /root/.ssh/brisa_deploy -C "brisa-servidor" >/dev/null
cat > /root/.ssh/config <<CFG
Host github.com
  IdentityFile /root/.ssh/brisa_deploy
  StrictHostKeyChecking accept-new
CFG
until git ls-remote "$REPO" >/dev/null 2>&1; do
  echo
  echo "Copia esta llave en GitHub → brisa-mail → Settings → Deploy keys → Add deploy key"
  echo "(título: Servidor Brisa; deja SIN marcar 'Allow write access'):"
  echo
  cat /root/.ssh/brisa_deploy.pub
  echo
  read -rp "Cuando la hayas agregado, presiona Enter… " _
done

say "6/7 Código y configuración"
[ -d "$DIR/.git" ] || git clone "$REPO" "$DIR"
cd "$DIR"
IP=$(curl -fsS https://api.ipify.org || curl -fsS https://ifconfig.me)
DOMAIN="brisa.$(echo "$IP" | tr . -).sslip.io"
echo "BRISA_DOMAIN=$DOMAIN" > .env
if [ ! -f .env.local ]; then
  cp .env.example .env.local
  echo
  echo "Se abrirá el editor con la configuración. Pega ahí tus variables de Railway"
  echo "(Railway → brisa-mail → Variables → Raw Editor → Copy ENV), guarda con Ctrl+O, Enter, y sal con Ctrl+X."
  read -rp "Presiona Enter para abrir el editor… " _
  nano .env.local
fi
mkdir -p data

say "7/7 Arranque y actualizaciones automáticas"
docker compose up -d --build
cat > /etc/cron.d/brisa-actualizar <<CRON
*/10 * * * * root bash $DIR/deploy/actualizar.sh >> /var/log/brisa-actualizar.log 2>&1
CRON
chmod 644 /etc/cron.d/brisa-actualizar

echo
echo "Listo. Abre en el teléfono:  https://$DOMAIN"
echo "(El certificado HTTPS tarda 1–2 minutos la primera vez.)"
