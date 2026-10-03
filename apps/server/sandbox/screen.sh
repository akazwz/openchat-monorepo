#!/bin/bash
# Starts the computer's screen (docs/sandbox.md): a virtual display (DISPLAY,
# set by the image), a desktop, and VNC served as a WebSocket on port 6080 for
# the app to show. Running it again starts only what is not working, judged by
# whether it answers (the display, the session bus, the WebSocket) or runs
# (the desktop's programs), never by a leftover name or file: a program that
# died left both behind. It returns once the screen accepts connections.
#
# The WebSocket serves only a viewer that presents the computer's screen
# token, which its Durable Object passes here (SCREEN_TOKEN) and adds to the
# viewer's connection it relays; a web page in the computer's browser that
# connects to localhost:6080 cannot know it. Run without one (by
# heveta-browser, which needs only the display), it keeps the token it has.
set -euo pipefail

# One run at a time: the Durable Object, a viewer's connection, and the
# browser may each start the screen at once, and each would start what it
# found missing. Programs started here must not keep the lock (fd 9).
exec 9>/tmp/heveta-screen.lock
flock 9

start() { setsid -f "$@" >"/tmp/$1.log" 2>&1 </dev/null 9>&-; }
# Waits up to ten seconds for a check to pass.
wait_for() {
  local what=$1
  shift
  for _ in $(seq 100); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 0.1
  done
  echo "$what did not start" >&2
  exit 1
}
# A program of this name that is running: not one that exited and is not yet
# reaped (a zombie keeps its name).
running() { pgrep -x -r R,S,D "$1" >/dev/null; }
# Stops the programs of these names, and waits until they are gone.
stop() {
  pkill -x "$(IFS='|'; echo "$*")" || return 0
  for name in "$@"; do wait_for "$name's end" bash -c "! pgrep -x -r R,S,D $name"; done
}
listening() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
display_answers() { xdpyinfo >/dev/null 2>&1; }
bus=${DBUS_SESSION_BUS_ADDRESS#unix:path=}
bus_answers() {
  dbus-send --session --reply-timeout=2000 --dest=org.freedesktop.DBus \
    --type=method_call --print-reply / org.freedesktop.DBus.Peer.Ping \
    >/dev/null 2>&1
}

# The display is its own VNC server (TigerVNC's Xtigervnc): it knows what it
# drew, so it sends each change as it happens instead of finding changes by
# comparing screenshots (x11vnc on Xvfb sent half as many updates of a
# scrolling page, with pauses of half a second). VNC listens only on
# 127.0.0.1:5900 and asks for no password: only websockify, which asks for
# the token, reaches it. Its defaults are a 1024x768 screen, all interfaces,
# a password, dropping other viewers when one connects unshared, and a
# blacklist: five connections from one host that close before authenticating
# shut it out for a while, and every viewer comes through websockify on
# 127.0.0.1 (as does the port check below), so the screen would refuse
# everyone. A display that stopped answering is replaced, and the desktop's
# programs with it: they were its clients. A dead server's lock file is
# cleared by the new one, which finds no process of its PID.
if ! display_answers; then
  stop Xtigervnc openbox xcompmgr plank
  start Xtigervnc "$DISPLAY" -geometry 1280x800 -depth 24 -nolisten tcp \
    -localhost -rfbport 5900 -SecurityTypes None -AlwaysShared \
    -UseBlacklist=0
  wait_for "The display" display_answers
fi
# The desktop: Openbox frames the windows, over a wallpaper (Openbox sets
# none, and an empty black screen looks broken), and a dock centered at the
# bottom (plank) holds the browser and the terminal, a dot under each one
# running. The dock learns which programs run from bamf over the session bus
# (DBUS_SESSION_BUS_ADDRESS, set by the image), which starts bamf when asked;
# its rounded, translucent plate needs a compositor (xcompmgr, no effects),
# measured not to slow the screen (docs/sandbox.md). A bus that does not
# answer is replaced; its socket stays behind when it is killed, and the new
# one cannot listen there until it is removed. The dock and bamf were its
# clients, and are started again on the new one.
if ! bus_answers; then
  stop dbus-daemon plank bamfdaemon
  rm -f "$bus"
  dbus-daemon --session --fork --address="$DBUS_SESSION_BUS_ADDRESS" 9>&-
  wait_for "The session bus" bus_answers
fi
running openbox || start openbox --config-file /etc/heveta/rc.xml
xwallpaper --zoom /usr/local/share/heveta/wallpaper.jpg
running xcompmgr || start xcompmgr -n
running plank || start plank

# VNC as a WebSocket. websockify looks the token up in this file for each new
# connection (its TokenFile plugin reads it every time), so a new token takes
# effect at once, without restarting it; connections already open stay.
tokens=/tmp/heveta-screen/tokens
mkdir -p -m 700 "${tokens%/*}"
if [ -n "${SCREEN_TOKEN:-}" ]; then
  (umask 077 && printf '%s: localhost:5900\n' "$SCREEN_TOKEN" >"$tokens.next")
  mv "$tokens.next" "$tokens"
fi
[ -f "$tokens" ] || (umask 077 && : >"$tokens")
listening 6080 ||
  start websockify --token-plugin TokenFile --token-source "$tokens" 6080
wait_for "The VNC WebSocket" listening 6080
