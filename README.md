# Garden Tracker

A small, self-hosted app for **planning your garden layout** (square-foot grid) and **tracking harvests** across years.

- **Backend:** Python standard library + SQLite. There are no pip packages. The app uses about 20 MB of RAM and almost no CPU when idle.
- **Frontend:** plain HTML, CSS and JavaScript. Nothing loads from the internet, so it works on a LAN with no outside access.
- **Data:** a single SQLite file in the `garden-data` Docker volume (`/data/garden.db`).

## Features

**Garden Planner**
- Make a plan for each year, each with its own tab. You can start a new plan blank or as a copy of a previous one.
- Set the garden size in feet, up to 200 × 200.
- Fill squares with the **Brush** (click or drag) or the **Rectangle** tool (drag, or hold Shift with the brush). The **Eraser** clears squares.
- Undo and redo with Ctrl+Z and Ctrl+Y. Changes save automatically.
- **Text size** slider scales all planner text, including plant names on the grid. Each connected block of the same plant gets one label, centered in the block. The label wraps onto more lines when needed, or turns sideways in tall, narrow beds.
- **Square notes:** use the **Select** tool (S) to click a planted square. A notes overlay pops up next to it (drag its header to move it, Esc to close), where you record the variety, whether you liked it (👍 / 😐 / 👎) and free-text notes.
  - Squares with notes get a corner mark.
  - **Copy to connected squares** applies the same notes to a plant that spans several squares.
  - A **Plant notes** table under the grid lists every note in the plan; click a row to jump to that square.
  - When you copy a plan to a new year, varieties carry over, but ratings and notes start fresh.
  - Painting a different plant over a square, or erasing it, removes that square's notes.
- Each plan has a notes field and a list of how many ft² each crop takes up.

**Harvest Tracker**
- Each year has its own tab, plus a **Compare years** tab.
- Log the date, crop and amount for each harvest. Each crop has its own unit: lb, oz, kg, g, count or bunch.
- Each year shows:
  - summary tiles
  - total by crop
  - running total through the season
  - weekly harvest, stacked by crop
  - a harvest calendar showing when each crop produced
  - a totals table and an editable log
- **Compare years** shows:
  - each crop's total and first-to-last harvest window per year
  - a season-vs-season running total by date
  - harvest timing by year
- CSV export for each year or for all years.

**Crops**: one shared list used by both the planner and the tracker. You can set each crop's name, color and harvest unit.

## Deploy with Portainer

Portainer's web editor can't build an image from local files, so pick one of these:

### Option A: Build on the server, then deploy the stack (simplest)
1. Copy this folder to the server, for example `/opt/garden-tracker`.
2. On the server, run:
   ```sh
   cd /opt/garden-tracker
   docker compose up -d --build
   ```
   The stack shows up in Portainer, where you can manage it (it will be labeled "limited" because it was created outside Portainer).

### Option B: Fully managed by Portainer
1. Build the image once on the server: `docker build -t garden-tracker:latest /opt/garden-tracker`.
   You can also use Portainer → **Images → Build a new image** and upload this folder as a `.tar`.
2. In Portainer → **Stacks → Add stack**, paste the contents of `docker-compose.yml` and **delete the `build: .` line**.
3. Deploy.

### Option C: From a Git repo
Push this folder to a Git repo. Then in Portainer go to **Stacks → Add stack → Repository**, point it at the repo, and leave the compose path as `docker-compose.yml`. Portainer will build the image itself.

Then open **`http://<server-ip>:8080`** in a browser on your network.

## Access & security

There are no logins. Anyone who can reach the port can view and edit the data. To keep it local-only:
- Don't port-forward 8080 on your router.
- Optionally, limit the port to one network interface, e.g. `"192.168.1.50:8080:8080"` in `docker-compose.yml`.

## Resource use

`docker-compose.yml` limits the container to 96 MB RAM and half a CPU core. Normal use is about 15–25 MB. Each request opens a short SQLite connection, and nothing runs in the background.

## Backups

Everything is stored in one file. To copy it out of the container:
```sh
docker cp garden-tracker:/data/garden.db ./garden-backup.db
```
The CSV export buttons in the Harvest tab are another easy way to save your harvest data.

## Changing the port
Change the left side of `"8080:8080"` in `docker-compose.yml`, for example `"8095:8080"`.

## Using a bind mount instead of a named volume
If you'd rather keep the data in a host folder (e.g. `./data:/data`), make the folder writable by UID 1000: `sudo chown 1000:1000 ./data`.
