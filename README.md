# Tado Data Capture

A Node.js application to capture data from your Tado heating system and store it in InfluxDB.

## Features

- **Tado OAuth2 Authentication**: Safe login via Tado website using Device Flow.
- **Configurable Polling**: Set intervals for Weather, Rooms, and Heat Pump.
- **InfluxDB Integration**: Stores all metrics in InfluxDB for visualization (e.g., Grafana).
- **Dockerized**: Easy deployment with Docker Compose.
- **Enhanced Dashboard**: Real-time connected status, polling intervals, and next poll countdowns.
- **Dry Run Mode**: Test without writing to InfluxDB.

## Screenshots

| Login View | Dashboard View |
|:---:|:---:|
| ![Login View](docs/screenshots/login.png) | ![Dashboard View](docs/screenshots/dashboard.png) |


## Getting Started

### Prerequisites

- Docker & Docker Compose
- Tado Account
- InfluxDB Instance

### Setup

1. Clone the repository.
2. Copy `.env.example` to `.env` and fill in your details:
   ```bash
   cp .env.example .env
   ```

3. Create an empty `token.json` file in a `data` directory (required for Docker persistence):
   ```bash
   mkdir data
   echo "{}" > data/token.json
   ```

### Running with Docker

```bash
docker compose up -d
```

The app will be available at `http://localhost:3000`.

### Running Locally

```bash
npm install
npm start
```

## Usage

1. Open `http://localhost:3000`.
2. Click **Login to Tado**.
3. Follow the instructions to authorize the device.
4. Once authenticated, the dashboard will show status and API call counts.
5. Data will automatically start flowing to InfluxDB based on your configured intervals.

## Configuration

See `.env.example` for all available options.

| Variable | Description |
|----------|-------------|
| `TADO_DRY_RUN` | Set to `true` to disable InfluxDB writes. |
| `TADO_LOG_LEVEL` | Log level: `trace`, `debug`, `info`, `warn`, `error`, `fatal` (default: `info`). |
| `TADO_POLL_INTERVAL_...` | Polling intervals in milliseconds (`WEATHER`, `ROOMS`, `HEATPUMP`, `DEVICES`). |
| `INFLUX_...` | InfluxDB connection details. |
| `TADO_LOGIN_PORT` | Port for the web interface. |

## Development

```bash
npm install        # install dependencies
cp .env.example .env  # configure env
npm run dev        # start with pino-pretty (human-readable output)
```

## Logging & Loki

All logs are emitted as newline-delimited JSON to stdout:

```json
{"level":30,"time":"2026-02-21T15:00:00.000Z","service":"tado-data-capture","port":3000,"msg":"Server running"}
{"level":50,"time":"2026-02-21T15:00:01.000Z","service":"tado-data-capture","context":"weather","err":"...","msg":"Error polling weather"}
```

Each line carries `"service": "tado-data-capture"`, making it straightforward to create Loki label filters in Promtail/Alloy:

```
{service="tado-data-capture"}
```

For human-readable output during development, pipe through `pino-pretty`:

```bash
node app.js | npx pino-pretty
```

## Project Structure

- `app.js` — Main entry point and orchestration.
- `config.js` — Configuration management and validation.
- `logger.js` — Shared Pino logger instance.
- `tado.js` — Tado OAuth2 authentication and data polling.
- `influx.js` — InfluxDB connection handling and data writing.

