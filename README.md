**English** | [한국어](README.ko.md)

# CogentAI AI Agent Studio

CogentAI AI Agent Studio is a web console for [Hermes Agent](https://github.com/NousResearch/hermes-agent) (Nous Research). Use it to monitor many AI Agents that run on Hermes on one screen, give them work, and let them work together in a 3D office, on a Kanban board and in meetings.

![Dashboard](docs/images/dashboard-en.png)

![3D office](docs/images/office-en.png)

**Contents:** [What it does](#what-it-does) · [A tour of the screens](#a-tour-of-the-screens) · [How it works](#how-it-works) · [Quick start](#quick-start) · [Connect an LLM](#connect-an-llm) · [Compose files](#compose-files) · [Features](#features-in-docker-compose) · [Settings](#settings) · [Operations](#operations) · [Troubleshooting](#troubleshooting) · [Development](#development)

## What it does

AI Agent Studio shows each Hermes installation and its profiles in a web browser. You do not need to edit Hermes files or use the Hermes command line.

The screens use three words with a fixed meaning:

- **AI Agent Workspace**: one Hermes installation. It has one or more profiles. Docker Compose starts one AI Agent Workspace.
- **Profile**: one Hermes profile in an AI Agent Workspace. A profile has its own personality, model, skills, tools and scheduled jobs.
- **AI Agent**: a running profile. The AI Agent is who you chat with, who sits at a desk in the office, who replies in meetings and who works on a Kanban card.

The menu has these screens:

| Menu | Screen | What you can do |
|---|---|---|
| Dashboard | Dashboard | See the state of each AI Agent Workspace, and find what needs attention: failed or stalled scheduled jobs, disconnected messengers and errors |
| Chat | Chat | Select an AI Agent and talk to it |
| Chat | Office | Use the 3D office, the Kanban board, meeting rooms and TFT rooms |
| My AI Agents | Profiles | Edit the personality (`SOUL.md`), model, skills, tools, MCP servers, secrets and scheduled jobs of each profile |
| My AI Agents | AI Agent Workspaces | See the status and the limit of your AI Agent Workspaces. Create an AI Agent Workspace (Kubernetes only) |
| My AI Agents | Models | See the models that your LLM endpoint offers to profiles |
| Skills | Skill list, Skill hub, Skill map | Find skills, install skill packages (Kubernetes only), and see which skill calls which skill |
| Automation | Scheduled jobs, Messenger connections | See the scheduled jobs (cron) and their failures. See the state of messenger connections such as Telegram and Slack. AI Agent Studio does not read token values |
| Records | Usage, Change history | See sessions and token usage. See who changed what and when (AI Agent Studio does not record the values) |
| Admin | Users & roles, Role templates, Notices | Administrators only. Manage who can sign in and which AI Agent Workspaces they see. Keep personality templates for each role. Show maintenance, outage and new-feature notices at the top of everyone's screen |
| Settings | My display, API keys & tokens, Company info | Choose the language, time zone and theme. See where the keys and tokens AI Agents use to reach LLM, MCP, REST and WebSocket services are. Set the company name and department slogans |

### Chat

- Select an AI Agent and type a message. The chat shows each step that the AI Agent takes: tool calls, commands and their output.
- When the AI Agent wants to run a command that needs approval, select **Allow once**, **Allow in this conversation**, **Always allow** or **Deny**.
- When the AI Agent asks a question, select one or more answers or type your own answer.
- Attach files (up to 100 MB each, 10 files at a time). The **Files** drawer shows the files that you uploaded and the files that the AI Agent made. All profiles of an AI Agent Workspace share one work folder.
- Click **New chat** to start a new chat at any time. Old chats stay in **Past chats**, and you can search them.

### 3D office, Kanban and meetings

The **Chat** > **Office** screen has five tabs.

- **Office**: a 3D room. Each placed profile sits at a desk. The scene shows if the profile is working, idle, has a problem or is away. Click a profile to see its information, talk to it or see its scheduled jobs. If the browser has no WebGL, AI Agent Studio shows a 2D view.
- **Kanban**: one board for the cards of all your AI Agent Workspaces. When you create a card, select the profile that does the work. AI Agent Studio puts the card on the Hermes board of that AI Agent Workspace, and Hermes runs it. The columns are Triage, To do, Scheduled, Ready, In progress, Blocked, Review, Done and Archived. When the AI Agent finishes, it can attach result files to the card. You can approve the result, ask for changes, unblock or stop a card. **Split into fields with AI** writes the card fields from your free text.
- **Meeting rooms**: people and profiles talk in one room. When a person sends a message, each selected profile replies. Type `@` to select a profile and `/` to select a skill. Share files in the **Files** tab. **Download meeting summary** makes a Markdown summary of the meeting.
- **TFT rooms**: rooms for a task force team (TFT) that works across teams. A room has a purpose, an owner, member people and profiles.
- **Placement** (administrators): profiles take a seat in the office automatically (only names that use lowercase letters, digits, `-` and `_`). Here you change each profile's name, display title, role and team, or remove it from the office. A removed profile does not come back. AI Agent Studio keeps this information in its own database. It does not change Hermes.

When a meeting starts in a team meeting room, the AI Agents of that team get up from their desks and walk to the room. While they reply, the scene shows them as working.

![When a meeting starts, the AI Agents walk to the meeting room](docs/images/office-meeting-en.webp)

## A tour of the screens

The screenshots use sample data for a fictional company, Bluebird Coffee.

### File viewer

Open a file in the **Files** drawer to see it in the browser. You do not have to download it first. The viewer shows:

- Hangul word processor files (HWP and HWPX), Word (DOCX), Excel (XLSX) and PowerPoint (PPTX) files
- PDF, CSV, Markdown, HTML, text and code
- Images, audio and video

The browser draws each document. AI Agent Studio does not send files to an outside conversion service. From the viewer you can download the file, ask the AI about it, copy the path that the agent uses, or post it to a meeting room. The preview can look a little different from the original. Old Office formats (DOC, XLS and PPT) and Office files with a password cannot be previewed. For a PDF with a password, type the password in the viewer.

| | |
|---|---|
| ![Hangul file (HWP)](docs/images/viewer-hwp-en.png) | ![PowerPoint file (PPTX)](docs/images/viewer-pptx-en.png) |
| ![Excel file (XLSX)](docs/images/viewer-xlsx-en.png) | ![Word file (DOCX)](docs/images/viewer-docx-en.png) |

### Text editing and versions

Edit the personality (SOUL), settings, skills and scheduled job prompts on the screen. Open them from the **Personality (SOUL)** and **Settings (config)** tabs of the profile details, or from the **Code** tab of the skill map. Before you save, the editor shows the changed lines. AI Agent Studio keeps up to 40 previous versions of each text. You can compare two versions or restore a previous one.

![Text editing and versions](docs/images/feature-editor-en.png)

### In-app help and walkthroughs

Click the help (?) button at the top of the screen to open guides by task. There are user guides and admin guides. When you start a walkthrough, each step opens the right screen and highlights what to click.

![In-app help and walkthroughs](docs/images/feature-help-en.png)

### Skill map

See where a skill is called from (scheduled jobs, other skills) and what it uses (scripts, libraries, API keys and tokens, outside hosts, MCP servers). AI Agent Studio draws the map from the skill documents and scripts. Open it from **Skills** > **Skill map**.

![Skill map](docs/images/feature-skill-map-en.png)

### Inbox and dashboard

The bell at the top of the screen shows how many items need your attention. Answer command approvals and AI Agent questions right there. A failed scheduled job opens its screen in one click. The dashboard shows the state of each AI Agent Workspace and 30-day trends (jobs, open problems, usage).

![Inbox and dashboard](docs/images/feature-inbox-en.png)

### Chat from any screen

Click the AI button at the top to open a chat window without leaving the screen you are on. You can move, resize and minimize the window. It stays open when you change screens.

![Chat from any screen](docs/images/feature-chat-window-en.png)

### Create a scheduled job

In **Automation** > **Scheduled jobs** > **New scheduled job**, a form sets which profile runs which skill or prompt, when, and where the result goes. The form writes the schedule in words, such as "Daily at 09:00", and shows the next run times. The menu shows the count of failed or stalled jobs.

![Create a scheduled job](docs/images/feature-scheduled-job-en.png)

### Messenger connections

In the **Messenger connections** tab of the profile details, connect Telegram, Discord, Slack or Mattermost from one dialog. A saved token is not shown again. Click **Test connection** to check it.

![Messenger connections](docs/images/feature-messenger-en.png)

### Diagrams and charts in chat

The chat draws Mermaid diagrams, ECharts charts and code that the AI Agent puts in its answer.

![Diagrams and charts in chat](docs/images/feature-chat-chart-en.png)

### Command palette and shortcuts

Use the search box at the top of the screen or press `⌘/Ctrl+K` to find and open screens and guides. Press `g` and then a letter to change the screen. Press `?` to see all shortcuts.

![Command palette and shortcuts](docs/images/feature-command-palette-en.png)

### Role templates

AI Agent Studio includes personality (SOUL) templates for 10 roles, such as marketing, sales and research, in Korean and English. You can start the personality of a new profile from a template. Administrators can edit the templates or add new ones in **Admin** > **Role templates**.

![Role templates](docs/images/feature-role-templates-en.png)

## How it works

![Architecture: browser, AI Agent Studio, Hermes Agent container (dashboard API and gateway), read sidecar, Hermes data folder and an OpenAI-compatible LLM](docs/images/architecture-en.svg)

- **AI Agent Studio server** (`aas/`): Python. It also serves the web UI (`ui/`, React). It keeps its own data (accounts, office, Kanban, meetings, change history) in the `aas-data` and `aas-config` volumes.
- **Read sidecar** (`sidecar/`): a small server that runs next to Hermes. It reads files and SQLite databases in the Hermes data folder and sends the results to AI Agent Studio. It has no write operations. Each request must have the token `AAS_SIDECAR_TOKEN`.
- **Hermes Agent**: the public image `nousresearch/hermes-agent`. One container runs the Hermes dashboard API and the gateway (scheduled jobs and messenger channels). This repository does not include Hermes.

Reading and changing go through different paths:

- **To read**, AI Agent Studio asks the read sidecar. For example: run history, sessions, skills, scheduled jobs and usage.
- **To change something or to chat**, AI Agent Studio calls the Hermes dashboard API. Hermes checks the change and saves it. AI Agent Studio does not write to the Hermes data folder.

Where the data is (Docker Compose):

| Volume | Contents |
|---|---|
| `hermes-data` (`/opt/data` in Hermes) | Hermes settings (`config.yaml`), secrets (`.env`), profiles (`profiles/<name>/`), sessions (`state.db`), scheduled jobs, logs (`logs/`) |
| `aas-data` (`/data` in AI Agent Studio) | The AI Agent Studio database (`aas.db`, SQLite): office, Kanban, meetings, usage, change history, sign-in sessions |
| `aas-config` (`/etc/aas` in AI Agent Studio) | Local accounts (`users.json`), the AI Agent Workspace list (`pods.json`), extra settings (`aas.env`) |

## Quick start

### What you need

- Docker with Docker Compose v2 (Docker Desktop on macOS and Windows, or Docker Engine on Linux).
- Free disk space for the images: the Hermes image is about 4.5 GB, and the AI Agent Studio images come in addition. If you run Ollama, the model also needs space (`llama3.1:8b` is about 5 GB).
- One OpenAI-compatible LLM endpoint with a context of 64,000 tokens or more. **Prepare it before step 1.** See [Connect an LLM](#connect-an-llm).

### Steps

1. Get the files and make your settings file:

   ```sh
   git clone https://github.com/openmaru-io/ai-agent-studio.git
   cd ai-agent-studio/deploy/compose
   cp .env.example .env
   ```

2. Fill in the "required" part at the top of `.env`:

   | Name | Value |
   |---|---|
   | `AAS_ADMIN_EMAIL`, `AAS_ADMIN_PASSWORD` | The first administrator. The password has 10 or more characters |
   | `AAS_SIDECAR_TOKEN` | A random token, 16 or more characters. For example: `openssl rand -hex 24` |
   | `HERMES_DASHBOARD_PASSWORD` | A random password for the Hermes dashboard. Only AI Agent Studio uses it. For example: `openssl rand -hex 16` |
   | `HERMES_LLM_BASE_URL`, `HERMES_LLM_MODEL`, `HERMES_LLM_API_KEY` | The LLM endpoint (up to `/v1`), the model name and the key (empty if not needed) |

   If a required value is empty, `docker compose up` stops and tells you which value is missing.

3. Start it:

   ```sh
   docker compose up -d
   ```

   The first start pulls the Hermes image and can take some minutes. If the AI Agent Studio images are not available from GHCR, Docker Compose builds them from this repository.

4. Check that all services are healthy:

   ```sh
   docker compose ps          # hermes, sidecar and aas are "healthy"; hermes-seed is "exited (0)"
   ```

5. Open http://127.0.0.1:17900 and sign in with `AAS_ADMIN_EMAIL` and `AAS_ADMIN_PASSWORD`.

### After you sign in

1. Open **Dashboard**. It shows one AI Agent Workspace (`default`). The first administrator is its owner.
2. Open **Chat** > **Chat**, select an AI Agent and send a short message, for example "Who are you?". If you get an error, see [Troubleshooting](#troubleshooting).
3. Open **Chat** > **Office**. Profiles take their seats automatically. Change names, roles and teams on the **Placement** tab.
4. On the **Kanban** tab of the same screen, create a card for the profile. Click **Run now**, and the AI Agent starts the work.
5. To add people, open **Admin** > **Users & roles**. To add profiles, open **My AI Agents** > **Profiles**.

Notes on the first start:

- AI Agent Studio creates the first administrator only when it has no accounts. A restart does not overwrite a changed password.
- On the first start, `hermes-seed` copies the Hermes settings and puts the three `HERMES_LLM_*` values in the secrets of the default Hermes profile. If the files already exist, it does not change them.

## Connect an LLM

Hermes and AI Agent Studio use one OpenAI-compatible endpoint. Put the endpoint in `.env` before the first start.

Hermes needs a context of at least 64,000 tokens to use tools. If the context is smaller, the AI Agent does not do the work. It only replies that the context is too small.

### Ollama on this computer

1. Start Ollama with a 64K context:
   - Command line: `OLLAMA_CONTEXT_LENGTH=65536 ollama serve`
   - Ollama app on macOS: run `launchctl setenv OLLAMA_CONTEXT_LENGTH 65536`, then quit and open the app again.
   - Linux (systemd): add `Environment="OLLAMA_CONTEXT_LENGTH=65536"` and `Environment="OLLAMA_HOST=0.0.0.0"` with `sudo systemctl edit ollama`, then run `sudo systemctl restart ollama`. On Linux, Ollama listens only on `127.0.0.1` by default, and containers cannot reach that address.
2. Pull a model that supports 64K tokens, for example `ollama pull llama3.1:8b` (or `llama3.2:3b` on a small computer). Models with a smaller limit, such as the `qwen3` family (40,960 tokens), do not work.
3. Set these values in `.env`:

   ```sh
   HERMES_LLM_BASE_URL=http://host.docker.internal:11434/v1
   HERMES_LLM_MODEL=llama3.1:8b
   HERMES_LLM_API_KEY=
   ```

A 64K context needs much memory. When we ran `llama3.2:3b` with a 64K context on a CPU, the context alone used about 7 GB. Without a GPU, one reply can take some minutes.

### OpenAI

```sh
HERMES_LLM_BASE_URL=https://api.openai.com/v1
HERMES_LLM_MODEL=gpt-4.1-mini
HERMES_LLM_API_KEY=<your key>
AAS_CHAT_TEMPLATE_KWARGS=off
```

The OpenAI API rejects the `chat_template_kwargs` argument, so set `AAS_CHAT_TEMPLATE_KWARGS=off`.

### LiteLLM, vLLM and other OpenAI-compatible servers

- Set `HERMES_LLM_BASE_URL` to the `/v1` address of the server, `HERMES_LLM_MODEL` to the model name on that server, and `HERMES_LLM_API_KEY` to its key (for LiteLLM, a virtual key).
- The model must support tool calls and a context of 64,000 tokens or more. For vLLM, start the server with tool calls enabled (`--enable-auto-tool-choice` and the `--tool-call-parser` for the model) and with `--max-model-len 65536` or more.
- If the server rejects the `chat_template_kwargs` argument, set `AAS_CHAT_TEMPLATE_KWARGS=off`.
- If the LLM server runs on this computer, AI Agent Studio and Hermes in Docker reach it with the host name `host.docker.internal`.

### Change the LLM later

The `.env` values go into the default profile only on the first start. To change the LLM later, open **My AI Agents** > **Profiles**, select the profile, and change the three `HERMES_LLM_*` values on the **Secrets (.env)** tab. A change in `.env` does not change profiles that already exist. The model screen and the AI assist of AI Agent Studio read the values in `.env`, so change them there too, and run `docker compose up -d`.

AI Agent Studio accepts secrets only through `http://127.0.0.1` or `http://localhost` on this computer, or through HTTPS. From another computer over plain HTTP, the **Secrets (.env)** tab is locked. See [Open the console to other computers](#open-the-console-to-other-computers).

## Compose files

All files are in `deploy/compose/`. Details are in `deploy/compose/README.md`.

| File | Services | Use it when |
|---|---|---|
| `docker-compose.yml` | Hermes 1, sidecar 1, AI Agent Studio 1 | You start from nothing. This is the quick start |
| `docker-compose.attach.yml` | sidecar 1, AI Agent Studio 1 | You already run Hermes and want to connect AI Agent Studio to it |
| `docker-compose.multi.yml` | Hermes 3, sidecar 3, AI Agent Studio 1 | You develop AI Agent Studio and test one Hermes for each user |

Use only one of `docker-compose.yml` and `docker-compose.attach.yml`, because both use the project name `aas` and its volumes.

To connect AI Agent Studio to a Hermes that already runs:

1. Fill in the "attach" part of `.env`: `HERMES_DATA_DIR` (the Hermes data folder on this computer), `AAS_DASHBOARD_URL`, `AAS_DASHBOARD_USER` and `AAS_DASHBOARD_PASSWORD` (the Hermes dashboard), and the required values.
2. Set `HERMES_UID` and `HERMES_GID` to the owner of the Hermes files. The sidecar reads files that only their owner can read (`state.db`, `.env`).
3. Run `docker compose -f docker-compose.attach.yml up -d`.

## Features in Docker Compose

| Feature | Status | Note |
|---|---|---|
| Sign-in with local accounts | Works | The first administrator comes from `.env`. Single sign-on (OIDC, for example Keycloak) is optional |
| Dashboard, run history, skills, skill map, files | Works | Through the read sidecar |
| Chat, 3D office, Kanban, meetings | Works | Needs the LLM |
| Scheduled jobs and messenger connections | Works | The Hermes gateway runs in the same container |
| Profiles: create, settings, personality (SOUL), secrets, MCP servers | Works | Through the Hermes dashboard API |
| Model screen and AI assist (tags, summaries, slogans, card split) | Works | Uses the same `HERMES_LLM_*` values |
| Skill hub (marketplace) install | Off | Needs Kubernetes. The screen shows the reason |
| Create or delete AI Agent Workspaces | Off | Needs Kubernetes. The screen shows the reason |
| Agent instructions (`AGENTS.md`) | Off | The public Hermes image has no API for it |

The public Hermes image does not include some changes that OPENMARU uses internally. In Docker Compose:

- Agent instructions (`AGENTS.md`) are off.
- The MCP OAuth connection state shows "not checked yet". After an MCP OAuth sign-in, the gateway can take more than one minute to use the new token.
- An AI Agent introduces itself as "Hermes Agent (by Nous Research)".
- The tool search is less accurate for Korean text.

## Settings

The main settings for Docker Compose. Put them in `deploy/compose/.env`. The full list is in `.env.example`. After you change `.env`, run `docker compose up -d` again.

| Name | Default | Meaning |
|---|---|---|
| `AAS_ADMIN_EMAIL`, `AAS_ADMIN_PASSWORD` | (required) | The first administrator |
| `AAS_SIDECAR_TOKEN` | (required) | The token that the server and the sidecar share |
| `HERMES_DASHBOARD_PASSWORD` | (required) | The Hermes dashboard password |
| `HERMES_LLM_BASE_URL`, `HERMES_LLM_MODEL`, `HERMES_LLM_API_KEY` | (required, the key is optional) | The LLM for Hermes and for AI Agent Studio |
| `AAS_BIND`, `AAS_PORT` | `127.0.0.1`, `17900` | The address and the port of the console |
| `AAS_ALLOWED_HOSTS` | `localhost` and `127.0.0.1` with `AAS_PORT` | The host names that AI Agent Studio accepts |
| `AAS_CHAT_TEMPLATE_KWARGS` | `on` | Set `off` if the LLM server rejects the `chat_template_kwargs` argument (for example, the OpenAI API) |
| `AAS_TRUSTED_PROXY` | (empty) | The connections that AI Agent Studio trusts for `X-Forwarded-Proto` (`true` or CIDR ranges). Set it when an HTTPS reverse proxy is in front of AI Agent Studio |
| `AAS_WS` | `on` | The web UI gets live updates through one WebSocket. Set `off` to use HTTP polling instead |
| `AAS_VERSION`, `AAS_IMAGE`, `AAS_SIDECAR_IMAGE` | `latest`, GHCR images | The AI Agent Studio images. For an air-gapped network, use your own registry |
| `HERMES_IMAGE` | `nousresearch/hermes-agent:v0.22.2` | The Hermes image |
| `HERMES_UID`, `HERMES_GID` | `10000` | The user of Hermes and of the sidecar |

### Open the console to other computers

By default, only this computer can open the console. To open it to your network:

1. Set `AAS_BIND=0.0.0.0`.
2. Set `AAS_ALLOWED_HOSTS` to the full list of names that people use, with the port. For example: `localhost:17900,127.0.0.1:17900,192.168.0.10:17900,aas.example.com:17900`.
3. Run `docker compose up -d`.

Over plain HTTP from another computer, these limits apply:

- The **Secrets (.env)** tab is locked. AI Agent Studio accepts secrets only through HTTPS or through `localhost` on this computer.
- The sign-in cookie does not have the `Secure` flag, and the connection is not encrypted. Use plain HTTP only in a network that you trust.

AI Agent Studio does not serve HTTPS itself. To use HTTPS, put a reverse proxy in front of AI Agent Studio:

1. Keep `AAS_BIND=127.0.0.1` and run the proxy on the same computer.
2. Configure the proxy to send `X-Forwarded-Proto: https` and to pass the `Upgrade` and `Connection` headers for the WebSocket. If it cannot pass them, set `AAS_WS=off`.
3. Set `AAS_TRUSTED_PROXY=true`. Without it, AI Agent Studio ignores `X-Forwarded-Proto` and treats each request as HTTP. `true` is safe here because only this computer can reach the port.
4. Add the `Host` value that the proxy sends to `AAS_ALLOWED_HOSTS`.
5. Run `docker compose up -d`.

AI Agent Studio does not use outside networks at run time. The web UI includes its fonts and 3D assets, and the build checks that the output has no outside addresses.

## Operations

Run these commands in `deploy/compose/`.

### Update

```sh
docker compose pull        # get new AI Agent Studio and sidecar images (the AAS_VERSION tag)
docker compose up -d
```

If you build from source, get the new source and build again:

```sh
git pull
docker compose up -d --build
```

The Hermes version is set by `HERMES_IMAGE`. We test AI Agent Studio with the default version. Back up the `hermes-data` volume before you use a different Hermes version.

### Back up and restore

The data is in three Docker volumes: `aas_hermes-data`, `aas_aas-data` and `aas_aas-config`. Stop the services before a backup, so the databases do not change during the copy.

```sh
docker compose stop
for v in hermes-data aas-data aas-config; do
  docker run --rm -v aas_$v:/v:ro -v "$PWD":/backup busybox:1.36 tar czf /backup/aas_$v.tgz -C /v .
done
docker compose start
```

To restore, stop the services and unpack each file into its volume:

```sh
docker compose stop
for v in hermes-data aas-data aas-config; do
  docker run --rm -v aas_$v:/v -v "$PWD":/backup busybox:1.36 sh -c "rm -rf /v/* /v/.[!.]* ; tar xzf /backup/aas_$v.tgz -C /v"
done
docker compose start
```

The backup files contain secrets (LLM keys, password hashes). Keep them in a safe place.

### Logs

```sh
docker compose logs -f aas                                   # AI Agent Studio server
docker compose logs -f hermes                                # Hermes dashboard and gateway
docker compose exec hermes tail -50 /opt/data/logs/errors.log
```

### Stop and remove

```sh
docker compose down        # stops and removes the containers; the data volumes stay
docker compose down -v     # also removes the volumes: all accounts, profiles and history are lost
```

## Troubleshooting

| Problem | What to do |
|---|---|
| `docker compose up` stops with a message about a missing value | A required value in `.env` is empty. Fill it in and try again |
| GHCR pull fails ("denied" or "not found") | Docker Compose builds the AI Agent Studio images from this repository. You do not have to do anything. To build again, run `docker compose up -d --build` |
| The page does not open | Run `docker compose ps`. Wait until `aas` is "healthy". Check that `AAS_PORT` is not in use by another program |
| "Invalid address" when you open the console from another computer | Add the name and port that you use to `AAS_ALLOWED_HOSTS` |
| Sign-in fails | AI Agent Studio uses `.env` only to create the first administrator. If you changed the password on the screen, use the new password. If you forgot it, run `docker compose exec aas python -m aas user set-password <email>` |
| The AI Agent replies that Ollama loaded the model "with only N tokens of runtime context" | Start Ollama with `OLLAMA_CONTEXT_LENGTH=65536` and use a model that supports 64K tokens |
| Chat or scheduled jobs end with "Connection error" | See `docker compose exec hermes tail -50 /opt/data/logs/errors.log`. If the log shows `base_url=${HERMES_LLM_BASE_URL}`, the profile secrets do not have the `HERMES_LLM_*` values. Add them in **Profiles** > **Secrets (.env)** |
| "Connection error" with Ollama on Linux | Ollama listens only on `127.0.0.1`. Set `OLLAMA_HOST=0.0.0.0` and restart Ollama |
| The **Secrets (.env)** tab is locked | You opened AI Agent Studio from another computer over plain HTTP. Open it on this computer through `http://127.0.0.1:17900`, or use HTTPS with `AAS_TRUSTED_PROXY` |
| The model screen says that the key was rejected | Check `HERMES_LLM_API_KEY` in `.env`, then run `docker compose up -d` |
| AI assist fails with an error about `chat_template_kwargs` | Set `AAS_CHAT_TEMPLATE_KWARGS=off` in `.env`, then run `docker compose up -d` |
| AI Agent Studio cannot read Hermes (empty dashboard) | Check that the server and the sidecar have the same `AAS_SIDECAR_TOKEN`. With the attach file, check that `HERMES_UID` and `HERMES_GID` are the owner of the Hermes files |
| The version at the bottom of the screen is `vN/A` | The images were built from source without version information. This has no effect on the features |

## Development

```sh
make test-python                  # Python tests (creates .venv on the first run)

cd ui
npm ci
npm run lint
npx tsc --noEmit -p .
npx vitest run
npm run build                     # builds into aas/static and runs the air-gap check
```

- The Python tests replace outside APIs and LLMs with test doubles.
- `ui/parity/offline.mjs '#/office'` opens the 3D office in a browser that has no network and checks that there are zero outside requests.
- The test environments with Docker Compose are in `deploy/compose/README.md`.

## Kubernetes mode

AI Agent Studio also runs on Kubernetes, with one Hermes for each user. AI Agent Studio uses Kubernetes mode when `AAS_K8S_NAMESPACE` is set. This mode needs the CogentAI AI Agent Studio operator (the `HermesAgent` custom resource). The operator and the Helm chart are not public.

## Links

- Homepage: <https://www.openmaru.io>
- Documentation: <https://docs.openmaru.io>
- YouTube: <https://www.youtube.com/@kubernetes-tv>

## Contributing and security

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before you open a pull request. Every commit needs a DCO `Signed-off-by` line.
- Report security problems privately. See [SECURITY.md](SECURITY.md).

## License

- The code is licensed under the [Apache License 2.0](LICENSE). See also [NOTICE](NOTICE).
- Third-party software and assets: [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
- Names, logos and the mascot: [TRADEMARKS.md](TRADEMARKS.md).

Copyright (c) 2026. OPENMARU, Inc. https://www.openmaru.io/
