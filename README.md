# Tado Data Capture

A Node.js application to capture data from your Tado heating system and store it in InfluxDB.

## Features

- **Tado OAuth2 Authentication**: Safe login via Tado website using Device Flow.
- **Configurable Polling**: Independent intervals for Weather, Rooms, Heat Pump, and Devices.
- **InfluxDB Integration**: Stores all metrics in InfluxDB for visualization (e.g., Grafana).
- **Real InfluxDB health check**: The `/health` endpoint and dashboard ping InfluxDB's `/health` endpoint to report an accurate connection status.
- **Dockerized**: Easy deployment with Docker Compose.
- **Enhanced Dashboard**: Real-time connected status, polling intervals, and next poll countdowns.
- **Dry Run Mode**: Test without writing to InfluxDB.
- **Automated Testing**: Comprehensive unit testing with Jest for logic, tokens, and mocked external services.
- **Graceful shutdown**: Handles SIGTERM/SIGINT so in-flight requests complete before the process exits.

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
npm test           # run the Jest unit testing suite
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

| File/Directory | Purpose |
|---|---|
| `app.js` | Entry point — Express server, polling scheduler, health route. |
| `config.js` | Reads and validates all environment variables; exported as a frozen config object. |
| `logger.js` | Shared [Pino](https://getpino.io/) logger (structured JSON, Loki-ready). |
| `tado.js` | Tado OAuth2 Device Flow auth and all Tado API calls. |
| `influx.js` | InfluxDB write client and `/health` connectivity check. |
| `tests/` | Jest unit tests covering authentication flows, module initialization, and logic. |

