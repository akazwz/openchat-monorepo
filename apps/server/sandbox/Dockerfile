# Native user computer: Debian, Node/Python, desktop, and Sandbox SDK 1.0's
# file helper. The main process just keeps the instance alive; ctx.container
# executes commands directly. Pin the shim tag to the package version.
#
# Each base image is pinned by digest as well as named by tag, so a rebuild
# starts from the same layers: the tags move (node:24 to each 24.x release,
# trixie-slim to each Debian point release). To update one, look up the tag's
# current digest (`docker buildx imagetools inspect <image>:<tag>`). Debian's
# packages still come from the release's current archive when built, with
# its security fixes; Google Chrome is always its current stable release
# (see below).
FROM docker.io/cloudflare/sandbox:1.0.0@sha256:5bc187515bad0d9d486a4f1476f7d8ad39fe97c57965f044e4b0a0dcc93eac06 AS sandbox
FROM docker.io/library/node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6 AS node
FROM docker.io/library/debian:trixie-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

ENV DEBIAN_FRONTEND=noninteractive

# Native directory backups use zstd; squashfs-tools is needed only by the
# separate upgrade converter. tmux keeps the person's terminal session.
# tini reaps orphan processes.
# Then the agent's: Python (`python` too) with pip and venv, and fast
# search. Then the
# screen: a virtual display that is its own VNC server (TigerVNC), a desktop
# (window manager, the dock and what it runs on: a session bus, bamf, a
# compositor, dconf; terminal, wallpaper), and fonts that cover Chinese and
# emoji. Without recommended packages, which brought GPU drivers and extra
# fonts. Compilers and ffmpeg are left out: the agent installs them when a
# task needs them.
RUN apt-get update && apt-get install -y --no-install-recommends \
    squashfs-tools zstd tmux \
    ca-certificates curl wget procps git unzip zip jq file inotify-tools tini \
    python3 python3-pip python3-venv python-is-python3 ripgrep \
    tigervnc-standalone-server x11-utils openbox lxterminal xwallpaper \
    plank bamfdaemon dbus-daemon dbus-x11 xcompmgr dconf-cli \
    fonts-noto-cjk fonts-noto-color-emoji \
    && rm -rf /var/lib/apt/lists/* \
    && printf 'set -g mouse on\nset -g history-limit 50000\nset -g status off\n' >/etc/tmux.conf

# The browser, which the agent drives with Playwright: Google Chrome, the
# stable release when the image is built, from Google's package (which also
# adds Google's package source). Google serves only its current release, so
# this is the one part of the image a rebuild may change; the version built
# is printed in the build's log and kept in the image
# (/usr/local/share/heveta/chrome-version). Its logo is the browser
# launcher's icon.
RUN curl -fsSLo /tmp/chrome.deb \
        https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb \
    && apt-get update \
    && apt-get install -y --no-install-recommends /tmp/chrome.deb \
    && rm -rf /tmp/chrome.deb /var/lib/apt/lists/* \
    && mkdir -p /usr/local/share/heveta \
    && google-chrome --version | tee /usr/local/share/heveta/chrome-version \
    && cp /opt/google/chrome/product_logo_128.png /usr/local/share/heveta/browser.png
# Web pages in that browser may not reach the computer itself (localhost,
# its own network): the screen and browser's MCP server listen there.
# Chrome asks the person before a site reaches the local network; this
# policy refuses every site instead, so no prompt can be accepted, by the
# person or by the agent led on by a page. A page served from the computer
# itself (a program the agent runs) still reaches it: that is not a request
# into a more private network.
COPY desktop/browser-policy.json /etc/opt/chrome/policies/managed/heveta.json

# Native file/backup helper; no control server or FUSE mount is needed.
COPY --from=sandbox /usr/local/bin/sandbox-shim /usr/local/bin/sandbox-shim
# Node.js with npm, from the official image, as the SDK's image has it.
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=node /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s ../lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
    && ln -s ../lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

# Python packages for data work, at pinned versions (requirements.txt).
# Debian keeps the system's Python to its own packages (PEP 668); in a
# computer that is the agent's alone, pip installs beside them, into
# /usr/local here and /workspace/.local for the agent (pip.conf, below).
COPY requirements.txt /tmp/requirements.txt
RUN pip install --no-cache-dir --break-system-packages -r /tmp/requirements.txt \
    && rm /tmp/requirements.txt
# The screen's VNC-over-WebSocket bridge, in an environment of its own:
# with the system's packages it imported numpy (about 45 MB of memory) only
# to unmask what viewers send, which is their input, a few bytes at a time,
# and its package pulls in redis, requests, and jwcrypto for plugins it is
# not run with. Without them it runs the same, masking in Python.
RUN python3 -m venv --without-pip /opt/websockify \
    && pip --python /opt/websockify/bin/python install --no-cache-dir \
        --no-deps websockify==0.13.0 \
    && ln -s /opt/websockify/bin/websockify /usr/local/bin/websockify
# The system Python's pip installs into /workspace/.local from now on.
COPY pip.conf /usr/pip.conf
# The agent's browser tools: Playwright MCP, driving that same browser (it
# connects over CDP, so it downloads no browser of its own). Keep the version
# equal to @playwright/mcp in apps/server/package.json, whose tool
# definitions are generated into src/modules/sandbox/browser-tools.json.
# Playwright itself for the agent's scripts, which drive that browser too.
RUN PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install -g \
    @playwright/mcp@0.0.82 playwright-core@1.63.0 \
    && npm cache clean --force

COPY desktop/rc.xml /etc/heveta/
# The dock: its theme, its settings as locked system defaults, its launchers.
COPY desktop/dock/dock.theme /usr/share/plank/themes/Heveta/dock.theme
COPY desktop/dock/dconf-profile /etc/dconf/profile/user
COPY desktop/dock/dconf-settings /etc/dconf/db/local.d/00-dock
COPY desktop/dock/dconf-locks /etc/dconf/db/local.d/locks/dock
COPY desktop/dock/heveta-browser.dockitem desktop/dock/heveta-terminal.dockitem \
    /root/.config/plank/dock1/launchers/
RUN dconf update
COPY desktop/themerc /usr/share/themes/Heveta/openbox-3/themerc
# The wallpaper, and the terminal's icon (ours: lxterminal's own is a
# monitor, and an icon theme with a terminal cost 25 MB).
COPY desktop/wallpaper.jpg desktop/terminal.png /usr/local/share/heveta/
COPY desktop/heveta-terminal.desktop desktop/heveta-browser.desktop \
    /usr/share/applications/
# The dock tells programs apart by bamf's index of these launchers, which
# bamf's package rebuilds when this folder changes, through a dpkg trigger:
# without it, the browser and the terminal matched the launchers their
# packages brought, and showed twice.
RUN dpkg-trigger --no-await /usr/share/applications \
    && dpkg --triggers-only --pending
COPY desktop/heveta-browser /usr/local/bin/heveta-browser
RUN update-alternatives --install /usr/bin/x-www-browser x-www-browser \
    /usr/local/bin/heveta-browser 100
COPY browser-mcp.sh /usr/local/bin/heveta-browser-mcp
COPY screen.sh /usr/local/bin/heveta-screen
COPY start.sh /usr/local/bin/heveta-start
RUN mkdir -p /workspace

# The screen and MCP ports are reached through native getTcpPort().

# Graphical programs, a headed browser included, show on the screen, and
# share one session bus (screen.sh starts it). Only /workspace outlives a
# restart, so user-level installs go there by default: `npm install -g` and
# `pip install` land in /workspace/.local (pip's warning about root says
# nothing to the agent); scripts find Playwright and those packages
# (NODE_PATH). What is installed there comes after the image's own, in PATH
# and NODE_PATH: it outlives restarts, so a command written there under a
# system command's name (by a command a web page talked the agent into) would
# otherwise stand in for it from then on. Native exec passes these values
# explicitly from native-machine.ts; image ENV configures the main process.
ENV DISPLAY=:99 \
    DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/heveta-session-bus \
    NPM_CONFIG_PREFIX=/workspace/.local \
    PYTHONUSERBASE=/workspace/.local \
    PIP_ROOT_USER_ACTION=ignore \
    NODE_PATH=/usr/local/lib/node_modules:/workspace/.local/lib/node_modules \
    PATH=$PATH:/workspace/.local/bin

# The idle main process under tini, which reaps orphaned child processes.
WORKDIR /workspace
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/heveta-start"]
