# Graylog Port Alert

Aplikasi monitoring dan alerting untuk mendeteksi **port down / port up** pada network device melalui **Graylog**, mengambil informasi port dari **LibreNMS**, dan menampilkan status secara realtime melalui web dashboard.

Project ini menggunakan:

* **React + Vite** sebagai frontend
* **Node.js + Express** sebagai backend
* **Socket.IO** untuk realtime communication
* **Graylog** sebagai sumber event
* **LibreNMS** sebagai source of truth informasi port
* **Docker** untuk containerization
* **Jenkins** untuk CI/CD dan automated deployment

---

## 🏗️ Architecture

```text
                         ┌─────────────────┐
                         │     Graylog     │
                         │                 │
                         │ Port Down / Up  │
                         └────────┬────────┘
                                  │
                                  │ Webhook
                                  ▼
                    ┌─────────────────────────┐
                    │      Node.js Backend    │
                    │                         │
                    │ Express + Socket.IO     │
                    │                         │
                    │ POST /port-alert        │
                    └───────────┬─────────────┘
                                │
                    Port Down   │   Port Up
                                │
                                ▼
                    ┌─────────────────────────┐
                    │        LibreNMS         │
                    │                         │
                    │ Device / Port Lookup    │
                    │       ifAlias           │
                    └───────────┬─────────────┘
                                │
                                │ Port Description
                                ▼
                    ┌─────────────────────────┐
                    │      Socket.IO          │
                    │                         │
                    │ Realtime Event          │
                    └───────────┬─────────────┘
                                │
                                ▼
                    ┌─────────────────────────┐
                    │    React Dashboard      │
                    │                         │
                    │ Active Alerts            │
                    │ Port History             │
                    └─────────────────────────┘
```

---

## ✨ Features

### Graylog Webhook

Backend menyediakan endpoint:

```text
POST /port-alert
```

Endpoint ini menerima payload event dari Graylog dan mendukung beberapa bentuk payload, termasuk:

* `event`
* `alert`
* `events[]`
* `alerts[]`
* `backlog[]`
* nested `event.fields`
* nested `fields`

Event yang diproses menggunakan field:

```text
event_type
source
interface
timestamp
message
event_definition
```

`source` dan `interface` terutama diambil dari custom fields Graylog.

---

### 🚨 Port Down Detection

Ketika menerima:

```text
event_type = port_down
```

backend akan:

1. Memvalidasi timestamp.
2. Membuat unique key berdasarkan `source` dan `interface`.
3. Mengecek apakah port sudah dalam kondisi down.
4. Melakukan lookup ke LibreNMS.
5. Mengambil `ifAlias` dari LibreNMS.
6. Menyimpan alert ke memory.
7. Menyimpan history outage.
8. Mengirim event realtime melalui Socket.IO.
9. Mengupdate dashboard.

LibreNMS digunakan sebagai **source of truth** untuk informasi port dan aplikasi tidak menyimpan inventory port secara lokal.

---

### 🟢 Port Up Detection

Ketika menerima:

```text
event_type = port_up
```

backend akan:

* Menghapus port dari active alerts.
* Mengupdate event timestamp.
* Menutup occurrence pada history.
* Mengirim event `port-up`.
* Mengupdate `port-state`.
* Mengupdate `port-history`.

---

### ⏱️ Event Ordering

Backend memiliki mekanisme untuk mengabaikan event lama/stale.

Contoh:

```text
10:00:00  PORT DOWN
10:00:05  PORT UP
10:00:02  PORT DOWN
```

Event terakhir akan diabaikan karena timestamp-nya lebih lama daripada event yang sudah diterima.

Hal ini mencegah delayed webhook/event dari membuka kembali alert yang sebenarnya sudah resolved.

---

### 📊 Port History

History outage disimpan selama **24 jam**.

Setiap occurrence mempunyai:

```json
{
  "down_timestamp": "...",
  "up_timestamp": "..."
}
```

History akan dibersihkan secara otomatis dan proses cleanup dijalankan setiap 1 menit.

---

### ⚡ Realtime Dashboard

Backend menggunakan Socket.IO untuk mengirim perubahan state ke frontend.

Event yang digunakan:

```text
port-down
port-up
port-state
port-history
```

Saat dashboard baru terhubung, backend langsung mengirim:

```text
port-state
port-history
```

sehingga frontend dapat melakukan initial synchronization.

---

## 🧰 Tech Stack

### Frontend

```text
React 19
Vite 8
Socket.IO Client
Oxlint
```

Frontend package menggunakan React `19.2.8`, React DOM `19.2.8`, dan Socket.IO Client `4.8.3`.

Development scripts:

```bash
npm run dev
npm run build
npm run lint
npm run preview
```

---

### Backend

```text
Node.js
Express 5
Socket.IO 4
CORS
```

Dependencies backend mencakup:

```text
express
cors
socket.io
```

---

### Infrastructure

```text
Docker
Jenkins
Graylog
LibreNMS
```

---

## 📁 Project Structure

```text
graylog-ci.cd/
│
├── frontend/
│   ├── public/
│   │   ├── favicon.svg
│   │   └── icons.svg
│   │
│   ├── src/
│   │   ├── assets/
│   │   │   ├── hero.png
│   │   │   ├── react.svg
│   │   │   └── vite.svg
│   │   │
│   │   ├── App.css
│   │   ├── App.jsx
│   │   ├── index.css
│   │   └── main.jsx
│   │
│   ├── package.json
│   ├── package-lock.json
│   └── vite.config.js
│
├── Dockerfile
├── Jenkinsfile
├── package.json
├── package-lock.json
└── server.js
```

---

# ⚙️ Configuration

Backend menggunakan environment variables berikut.

| Variable              | Default                 | Description              |
| --------------------- | ----------------------- | ------------------------ |
| `PORT`                | `3001`                  | Port Node.js server      |
| `LIBRENMS_URL`        | `https://mon.as.net.id` | URL LibreNMS             |
| `LIBRENMS_TOKEN`      | -                       | LibreNMS API token       |
| `LIBRENMS_TIMEOUT_MS` | `5000`                  | Timeout LibreNMS request |

Configuration tersebut didefinisikan langsung pada backend.

### Example

```env
PORT=3001
LIBRENMS_URL=https://mon.as.net.id
LIBRENMS_TOKEN=your-librenms-token
LIBRENMS_TIMEOUT_MS=5000
```

> **Jangan commit `LIBRENMS_TOKEN` ke repository.**

---

# 💻 Local Development

## 1. Clone Repository

```bash
git clone <repository-url>
cd graylog-ci.cd
```

---

## 2. Install Backend Dependencies

Dari root project:

```bash
npm install
```

---

## 3. Install Frontend Dependencies

```bash
cd frontend
npm install
```

---

## 4. Run Frontend

```bash
npm run dev
```

Vite akan menjalankan development server.

---

## 5. Run Backend

Kembali ke root project:

```bash
cd ..
node server.js
```

Default backend:

```text
http://localhost:3001
```

Backend menjalankan server pada `0.0.0.0` dan port yang ditentukan oleh environment variable `PORT`.

---

# 🔌 API Endpoints

## Health Check

```http
GET /health
```

Example:

```bash
curl http://localhost:3001/health
```

Response:

```json
{
  "status": "ok",
  "timestamp": "...",
  "active_ports": 0,
  "librenms_configured": true
}
```

---

## Active Port Alerts

```http
GET /port-alerts
```

Mengembalikan semua port yang sedang dalam kondisi down.

---

## Port History

```http
GET /port-history
```

Mengembalikan history outage selama retention period.

---

## Graylog Webhook

```http
POST /port-alert
```

Endpoint utama yang digunakan Graylog untuk mengirim port alerts.

Contoh payload sederhana:

```json
{
  "event_type": "port_down",
  "timestamp": "2026-09-24T10:00:00.000Z",
  "fields": {
    "source": "SW-01",
    "interface": "GigabitEthernet0/2/5"
  },
  "message": "Interface is down"
}
```

---

## Debug Payload

```http
POST /port-debug
```

Digunakan untuk melihat payload yang diterima backend dari Graylog.

Contoh:

```bash
curl -X POST \
  http://localhost:3001/port-debug \
  -H "Content-Type: application/json" \
  -d '{"test":"hello"}'
```

---

## Manual Cleanup

```http
DELETE /port-alerts/cleanup
```

Menghapus seluruh active port alerts dari memory.

---

# 🧪 Test Endpoints

Backend menyediakan endpoint untuk melakukan testing tanpa harus mengirim event dari Graylog.

## Test Port Down

```http
POST /test/port-down
```

Contoh:

```bash
curl -X POST \
  http://localhost:3001/test/port-down \
  -H "Content-Type: application/json" \
  -d '{
    "source": "SW-TEST-HUWE",
    "interface": "GigabitEthernet0/2/5"
  }'
```

---

## Test Port Up

```http
POST /test/port-up
```

Contoh:

```bash
curl -X POST \
  http://localhost:3001/test/port-up \
  -H "Content-Type: application/json" \
  -d '{
    "source": "SW-TEST-HUWE",
    "interface": "GigabitEthernet0/2/5"
  }'
```

---

# 🐳 Docker

Project menggunakan **multi-stage Docker build**.

## Stage 1 — Frontend Build

Docker menggunakan:

```text
node:22-bookworm-slim
```

Frontend dependencies di-install menggunakan:

```bash
npm ci
```

Kemudian React/Vite di-build menggunakan:

```bash
npm run build
```

---

## Stage 2 — Production Backend

Production image kembali menggunakan:

```text
node:22-bookworm-slim
```

Backend dependencies di-install dengan:

```bash
npm ci --omit=dev
```

Build frontend dari stage pertama kemudian disalin ke:

```text
/app/frontend/dist
```

Container expose:

```text
3001
```

dan menjalankan:

```bash
node server.js
```

---

## Build Docker Image

Dari root project:

```bash
docker build -t graylog-alert .
```

---

## Run Docker Container

```bash
docker run -d \
  --name graylog-alert \
  -p 7777:3001 \
  -e PORT=3001 \
  -e LIBRENMS_URL="https://mon.as.net.id" \
  -e LIBRENMS_TOKEN="your-token" \
  -e LIBRENMS_TIMEOUT_MS=5000 \
  graylog-alert
```

Aplikasi dapat diakses melalui:

```text
http://localhost:7777
```

Health check:

```text
http://localhost:7777/health
```

---

# 🔄 CI/CD with Jenkins

Project menggunakan Jenkins Pipeline yang didefinisikan pada:

```text
Jenkinsfile
```

Pipeline menggunakan image:

```text
graylog-alert
```

dan container:

```text
graylog-alert
```

Configuration deployment:

```text
Host Port      : 7777
Container Port : 3001
```

---

## Pipeline Flow

```text
┌──────────────┐
│    Checkout  │
└──────┬───────┘
       ▼
┌──────────────────────┐
│ Build Docker Image   │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Save Previous Image  │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Stop Old Container   │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│ Deploy New Container │
└──────────┬───────────┘
           ▼
┌──────────────────────┐
│     Health Check     │
└──────────┬───────────┘
           │
      ┌────┴────┐
      │         │
   SUCCESS    FAILED
      │         │
      ▼         ▼
   Verify    Rollback
      │
      ▼
   SUCCESS
```

---

## Jenkins Stages

Pipeline terdiri dari:

```text
1. Checkout
2. Build Docker Image
3. Save Current Version
4. Stop Old Container
5. Deploy New Container
6. Health Check
7. Deployment Verification
```

---

## Docker Image Versioning

Setiap Jenkins build membuat dua tag:

```text
graylog-alert:<BUILD_NUMBER>
graylog-alert:latest
```

Contoh:

```text
graylog-alert:42
graylog-alert:latest
```

Build number digunakan sebagai immutable deployment version sehingga Jenkins dapat mengetahui image yang digunakan oleh deployment tertentu.

---

# 🔐 LibreNMS Integration

LibreNMS digunakan untuk mengambil informasi `ifAlias` dari network device.

Endpoint yang digunakan backend:

```text
GET /api/v0/devices/{device}/ports/{port}
```

Request menggunakan header:

```http
X-Auth-Token: <LIBRENMS_TOKEN>
Accept: application/json
```

Jika `ifAlias` kosong atau sama dengan `ifName`, aplikasi menampilkan:

```text
Port belum disetup
```

Jika LibreNMS tidak dapat diakses:

```text
LibreNMS unavailable
```

Backend juga menerapkan timeout request untuk mencegah request ke LibreNMS menggantung terlalu lama.

---

# 🔁 Rollback Strategy

Salah satu fitur utama CI/CD project ini adalah **automatic rollback**.

Sebelum container lama dihentikan, Jenkins menyimpan image yang sedang digunakan:

```text
previous_image.txt
```

Setelah container baru dijalankan, Jenkins melakukan health check terhadap:

```text
/health
/
```

Jika health check gagal:

```text
New Container
      │
      ▼
Health Check Failed
      │
      ▼
Stop New Container
      │
      ▼
Read Previous Image
      │
      ▼
Run Previous Image
      │
      ▼
Health Check Again
      │
      ▼
Rollback Success
```

Dengan mekanisme ini, deployment yang gagal tidak langsung meninggalkan aplikasi dalam kondisi down.

---

# ❤️ Health Check

Jenkins melakukan pengecekan:

```bash
curl -f http://127.0.0.1:7777/health
```

dan:

```bash
curl -f http://127.0.0.1:7777/
```

Jika keduanya berhasil, deployment dianggap berhasil.

---

# 📡 Realtime Event Flow

Ketika Graylog mengirim:

```text
PORT DOWN
```

flow-nya:

```text
Graylog
   │
   ▼
POST /port-alert
   │
   ▼
Parse Payload
   │
   ▼
Validate Timestamp
   │
   ▼
Check Duplicate / Stale Event
   │
   ▼
LibreNMS Lookup
   │
   ▼
Store Active Port
   │
   ├──► port-down
   │
   ├──► port-state
   │
   └──► port-history
            │
            ▼
       React Dashboard
```

Sedangkan ketika:

```text
PORT UP
```

flow-nya:

```text
Graylog
   │
   ▼
POST /port-alert
   │
   ▼
Find Active Port
   │
   ▼
Remove Active Alert
   │
   ├──► port-up
   │
   ├──► port-state
   │
   └──► port-history
```

---

# ⚠️ Important Notes

### In-memory State

Active alerts dan history saat ini disimpan menggunakan JavaScript `Map`:

```text
activePorts
lastEventAt
portHistory
```

Artinya state tersebut **tidak persistent** jika container/server restart.

### History Retention

History hanya dipertahankan selama:

```text
24 hours
```

### LibreNMS Dependency

Untuk mendapatkan port alias/description, backend membutuhkan:

```text
LIBRENMS_TOKEN
```

Tanpa token, lookup LibreNMS akan dianggap unavailable.

### Production Security

Endpoint berikut saat ini tersedia untuk kebutuhan testing/debugging:

```text
POST /port-debug
POST /test/port-down
POST /test/port-up
DELETE /port-alerts/cleanup
```

Jika aplikasi dipublish ke environment production/public, endpoint tersebut sebaiknya diberi authentication atau dibatasi aksesnya.

---

# 🛠️ Troubleshooting

## Container tidak bisa start

Cek:

```bash
docker logs graylog-alert
```

---

## Check container

```bash
docker ps
```

---

## Check health

```bash
curl http://localhost:7777/health
```

---

## Check Graylog webhook

Gunakan:

```text
POST /port-debug
```

untuk melihat payload yang diterima backend.

---

## Check LibreNMS

Pastikan:

```text
LIBRENMS_URL
LIBRENMS_TOKEN
```

sudah benar.

Backend akan mencatat error LibreNMS di console jika request gagal atau timeout.

---

# 📌 Deployment Information

| Component           | Value               |
| ------------------- | ------------------- |
| Docker Image        | `graylog-alert`     |
| Container           | `graylog-alert`     |
| Container Port      | `3001`              |
| Application Port    | `7777`              |
| Node.js             | 22                  |
| Frontend            | React + Vite        |
| Backend             | Express + Socket.IO |
| Event Source        | Graylog             |
| Network Information | LibreNMS            |
| CI/CD               | Jenkins             |
| History Retention   | 24 hours            |

---

# 👨‍💻 Development

Project ini dikembangkan untuk menyediakan monitoring port network secara realtime dengan integrasi:

```text
Graylog
   +
LibreNMS
   +
Node.js
   +
React
   +
Socket.IO
   +
Docker
   +
Jenkins
```

Tujuan utama aplikasi adalah memberikan visibilitas realtime terhadap **port outage**, menampilkan informasi port dari LibreNMS, menyimpan history outage selama 24 jam, dan melakukan deployment aplikasi secara otomatis menggunakan Jenkins dengan mekanisme health check serta rollback.

---

## 📄 License

Project ini menggunakan license:

```text
ISC
```

sesuai konfigurasi `package.json`.
