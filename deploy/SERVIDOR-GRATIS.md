# Brisa en un servidor gratis

Para cuando termine la prueba de Railway. Queda encendido siempre, con HTTPS, avisos al instante y
actualizaciones automáticas: cada cambio que se sube a GitHub llega solo en unos 10 minutos.

## Opción A: Oracle Cloud "Always Free" (recomendada)

1. Crea la cuenta en **https://www.oracle.com/cloud/free/**. Pide tarjeta solo para verificar identidad;
   no cobra mientras uses recursos marcados como *Always Free*. Elige como región de inicio una cercana
   (por ejemplo **Chile Central (Santiago)** o **Brazil East (São Paulo)**). No se puede cambiar después.
2. **Compute → Instances → Create instance**:
   - Image: **Ubuntu 22.04** o **24.04**.
   - Shape: **Ampere (VM.Standard.A1.Flex)**, 1 OCPU y 6 GB de memoria (*Always Free eligible*).
     Si dice que no hay capacidad, prueba más tarde o usa **VM.Standard.E2.1.Micro**.
   - Descarga la llave SSH que ofrece (*Save private key*).
3. Abre los puertos web: en la instancia, **Subnet → Security List → Add Ingress Rules**:
   origen `0.0.0.0/0`, protocolo TCP, puertos **80** y **443**.
4. Entra a la máquina. El botón **Cloud Shell** del panel de Oracle evita instalar nada en tu PC:
   ```bash
   ssh -i llave.key ubuntu@IP-DE-LA-INSTANCIA
   ```
5. Ejecuta el instalador y sigue lo que pide:
   ```bash
   curl -fsSL https://raw.githubusercontent.com/jorgecifuentes-alt/brisa-mail/main/deploy/instalar.sh -o instalar.sh
   ```
   Como el repositorio es privado, ese enlace no funciona directo. En su lugar crea el archivo con
   `nano instalar.sh`, pega el contenido de `deploy/instalar.sh` desde GitHub, guarda y luego:
   ```bash
   sudo bash instalar.sh
   ```
   El instalador te pedirá agregar una **Deploy key** en GitHub (solo lectura) y pegar tus variables de
   Railway (**Variables → Raw Editor → Copy ENV**).
6. Al final muestra una dirección como `https://brisa.152-67-10-20.sslip.io`. Ábrela en el teléfono,
   instala la app de nuevo (⋮ → Instalar app) y desinstala la anterior de Railway.

## Opción B: Google Cloud (e2-micro gratis)

1. Cuenta en **https://cloud.google.com/free** (pide tarjeta para verificar; el *free tier* no cobra).
2. **Compute Engine → VM instances → Create**:
   - Region: **us-west1**, **us-central1** o **us-east1** (solo esas son gratis).
   - Machine type: **e2-micro**. Disco: **Standard persistent disk** de 30 GB, Ubuntu 22.04/24.04.
   - Firewall: marca **Allow HTTP traffic** y **Allow HTTPS traffic**.
3. Botón **SSH** de la instancia → pasos 5 y 6 de la opción A.

## Después

- Railway: borra el proyecto para que no quede nada corriendo.
- Ver registros: `cd /opt/brisa && sudo docker compose logs -f brisa`
- Forzar una actualización: `sudo bash /opt/brisa/deploy/actualizar.sh`
