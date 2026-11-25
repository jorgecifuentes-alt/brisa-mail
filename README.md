# Brisa Mail

Cliente de correo al estilo Spark para tu propio servidor IMAP/SMTP (Gmail, Outlook, iCloud, Fastmail, el de tu empresa…), para escritorio y celular, con:

- **Bandeja inteligente** en tres modos: *Lista de objetivos*, *Elementos no leídos* y *Lista simple*. Secciones Prioritario, Personal, Notificaciones y Boletines.
- **Correo nuevo al instante**, sin refrescar: el servidor usa IMAP IDLE y avisa a la app en menos de un segundo. Con la app cerrada llegan **notificaciones push** al celular o al computador.
- **Gestos:** desliza a la derecha para marcar como hecho y a la izquierda para posponer.
- **Asistente de IA flotante:** revisa la bandeja, busca y lee correos, prepara respuestas (sin enviarlas), organiza y dibuja mapas mentales.
- **Prioritario, posponer, hecho, papelera**, todo con *Deshacer*.
- **Envío con 5 segundos para deshacer**, firma y plantillas.
- **Dictado por voz** en notas, respuestas y correos nuevos. No se graba audio: el navegador convierte la voz en texto en vivo y solo se guarda el texto si tú lo guardas.
- **Resúmenes y mapas mentales con Claude** de cualquier hilo o nota de voz, y **borradores de respuesta con IA**.
- **Equipo:** comparte un hilo con una nota y coméntalo.

La interfaz es la misma que la versión publicada en claude.ai. Allí usa el conector de Gmail. Aquí usa un backend propio que responde con la misma forma de datos sobre IMAP/SMTP.

## Puesta en marcha

Requiere Node 18.17 o superior.

```bash
npm install
```

```bash
cp .env.example .env.local
```

Completa `.env.local` con tu servidor de correo y tu clave de Anthropic, y luego:

```bash
npm run dev
```

Abre http://localhost:3000.

Para producción:

```bash
npm run build
```

```bash
npm start
```

### Gmail por IMAP

Activa la verificación en dos pasos en tu cuenta de Google, crea una **contraseña de aplicación** y úsala en `IMAP_PASS` y `SMTP_PASS`. Los valores de host del ejemplo ya son los de Gmail.

### Outlook / Microsoft 365

`IMAP_HOST=outlook.office365.com`, `SMTP_HOST=smtp.office365.com`, `SMTP_PORT=587`, `SMTP_SECURE=false` (usa STARTTLS). Algunas cuentas de empresa tienen IMAP desactivado o exigen OAuth. En ese caso, pide a tu administrador que lo habilite.

## Celular y escritorio

Brisa es una app web instalable (PWA):

- **Android / Chrome / Edge:** abre Brisa y toca *Instalar como app* en el menú lateral, o usa *Instalar app* del navegador.
- **iPhone / iPad (iOS 16.4 o superior):** en Safari, *Compartir → Agregar a pantalla de inicio*, y abre Brisa desde ese ícono. Las notificaciones push solo funcionan así en iOS.
- **Mac / Windows / Linux:** en Chrome o Edge, ícono de instalar en la barra de direcciones.

Para recibir avisos con la app cerrada: *Más → Firma, plantillas y avisos → Avisarme de correos nuevos*.

### Usarla desde el celular

El celular tiene que llegar a tu servidor por **HTTPS**: el micrófono, la instalación y las notificaciones lo exigen.

1. Define `APP_PASSWORD` en `.env.local`. Sin ella, Brisa rechaza cualquier acceso que no venga del mismo computador.
2. Publica el servidor con HTTPS. Opciones: un VPS con Caddy o Nginx delante, Railway, Fly.io o Render. Puedes usar el `Dockerfile` incluido y montar `data/` como volumen.
3. Abre la dirección en el celular, ingresa usuario y contraseña, e instálala.

No uses plataformas *serverless* (como Vercel): la conexión IMAP en vivo necesita un proceso que siga corriendo.

## Cómo está armado

```
client/brisa.html          La interfaz (HTML + CSS + JS, sin dependencias)
scripts/build-client.mjs   Genera public/index.html a partir de client/brisa.html
public/shim.js             Implementa claude.use(...) contra este servidor
app/api/gmail/[tool]       search_threads, get_thread, label_thread, unlabel_thread,
                           trash_thread, untrash_thread, send_message, reply
app/api/ai                 Claude en streaming (resúmenes, mapas mentales, borradores)
app/api/ai/tools           Turnos del asistente con herramientas (se ejecutan en la página)
app/api/store              Almacén JSON en data/store.json (firma, plantillas, notas,
                           pospuestos, hilos compartidos)
app/api/events             Correo nuevo en vivo (Server-Sent Events)
app/api/push/*             Clave pública y suscripciones para notificaciones push
lib/mail.js                IMAP (imapflow) y SMTP (nodemailer)
lib/live.js                Conexión IMAP IDLE permanente, avisos SSE y push (web-push)
instrumentation.js         Arranca la conexión en vivo junto con el servidor
middleware.js              Usuario y contraseña para toda la app
public/sw.js               Service worker: interfaz sin conexión y notificaciones push
public/manifest.webmanifest, public/icons/   Instalación como app
```

Correspondencia con las etiquetas de Gmail:

| Acción en Brisa | IMAP |
|---|---|
| Prioritario | bandera `\Flagged` |
| Leído / no leído | bandera `\Seen` |
| Hecho (archivar) | mover a la carpeta `\Archive` (o `\All` en Gmail) |
| Papelera / restaurar | mover a `\Trash` y de vuelta |
| Categoría | `List-Unsubscribe` o `Precedence: bulk` → Boletines; remitentes `no-reply`, `avisos`, `notifications` → Notificaciones; el resto → Personas |

## Limitaciones conocidas

- **Un mensaje es un hilo.** IMAP no tiene hilos estándar. Las respuestas llevan `In-Reply-To` y `References` correctos, pero la lista no agrupa la conversación.
- **Posponer** oculta el correo de la bandeja de Brisa hasta la hora elegida. No lo mueve en el servidor, así que en otros clientes sigue visible.
- **Un solo usuario.** El almacén es un archivo local y la contraseña es una sola para toda la app. Para un equipo, cambia `app/api/store` por una base de datos y agrega cuentas por persona.
- **El correo en vivo vigila INBOX.** Los cambios hechos desde otro cliente (leer, archivar) se ven al actualizar o al llegar el siguiente correo.
- **Dictado:** usa la Web Speech API (Chrome y Edge). El navegador envía el audio a su servicio de reconocimiento para obtener el texto. Brisa no graba ni guarda el audio.
- **Enviados:** Gmail guarda solo lo que envías. En otros servidores pon `SAVE_SENT=true` para copiar cada envío a la carpeta Enviados.

## Modelo de IA

Usa `claude-opus-5-5` por defecto, con respaldo automático del servidor si una solicitud es rechazada (`fallbacks: "default"`). Puedes cambiarlo con `ANTHROPIC_MODEL`. El esfuerzo es `low` para resúmenes, `medium` para mapas mentales y borradores.
