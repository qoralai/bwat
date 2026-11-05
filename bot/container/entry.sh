#!/usr/bin/env bash
# The zoom image's entrypoint (under tini): a PulseAudio null sink and zoomus.conf, without
# which the SDK's raw audio never arrives headless; then the in-container bridge; then the
# bot, whose exit ends the container and with it the SDK app (exit 3 on a leave that never
# completed, so the platform restarts it fresh).
set -e

if [[ ! -d /var/run/dbus ]]; then
  mkdir -p /var/run/dbus /var/lib/dbus
  dbus-uuidgen > /var/lib/dbus/machine-id
  dbus-daemon --config-file=/usr/share/dbus-1/system.conf --print-address
fi

usermod -G pulse-access,audio root || true
rm -rf /var/run/pulse /var/lib/pulse /root/.config/pulse/
mkdir -p ~/.config/pulse/ && cp -r /etc/pulse/* ~/.config/pulse/

pulseaudio -D --exit-idle-time=-1 --system --disallow-exit
pactl load-module module-null-sink sink_name=SpeakerOutput
pactl set-default-sink SpeakerOutput
pactl set-default-source SpeakerOutput.monitor

echo -e "[General]\nsystem.audio.type=default" > ~/.config/zoomus.conf

export QT_LOGGING_RULES="*.debug=false;*.warning=false"
# Either one ending ends the container, with the first one's exit code: a bot whose bridge
# has died would keep reporting ready and fail every meeting it takes.
python /app/container/bridge.py &
bridge=$!
python -m bwat_bot &
bot=$!
# A stop goes to the bot alone: it leaves the meeting through the bridge, so the bridge
# must outlive it, and is stopped only once the bot has gone.
trap 'kill -TERM "$bot" 2>/dev/null' TERM INT
set +e
wait -n "$bridge" "$bot"
code=$?
kill -TERM "$bot" 2>/dev/null
wait "$bot" 2>/dev/null
kill -TERM "$bridge" 2>/dev/null
wait
exit "$code"
