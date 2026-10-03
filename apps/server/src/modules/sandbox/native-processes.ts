// Process identity and completion live on the instance disk, outside the saved
// workspace. A Durable Object restart can find work without starting it twice.
export const processesDir = "/tmp/heveta-processes";

export function processDir(id: string) {
	if (!/^[a-zA-Z0-9_-]{1,200}$/.test(id)) throw new Error("Invalid process ID");
	return `${processesDir}/${id}`;
}

export const runProcess = `dir=$1; shift
setsid sh -c 'echo "$$ $(cat /proc/sys/kernel/random/boot_id)" >"$0/pid"; exec "$@"' "$dir" "$@"
echo "$?" >"$dir/exit.next" && mv "$dir/exit.next" "$dir/exit"`;

// /proc state excludes zombies; boot ID prevents signaling an unrelated PID
// after an instance restart. A PID alone is not a process identity.
export const processState = `dir=$1
if [ ! -d "$dir" ]; then echo missing
elif [ -f "$dir/exit" ]; then echo "exited $(cat "$dir/exit")"
elif [ ! -f "$dir/pid" ]; then
 if [ "$(( $(date +%s) - $(stat -c %Y "$dir") ))" -lt 120 ]; then echo starting; else echo lost; fi
else
 read -r pid boot <"$dir/pid"
 state=$(awk '{print $3}' "/proc/$pid/stat" 2>/dev/null)
 if [ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] && [ -n "$state" ] && [ "$state" != Z ]; then echo "running $pid"
 elif [ -f "$dir/exit" ]; then echo "exited $(cat "$dir/exit")"
 else echo lost
 fi
fi`;

export const waitProcess = `dir=$1
while :; do
 state=$(sh -c "$2" sh "$dir")
 case "$state" in running*|starting) sleep 0.5;; *) printf '%s\\n' "$state"; exit;; esac
done`;

export const stopProcess = `dir=$1
[ -f "$dir/exit" ] && exit 0
read -r pid boot <"$dir/pid" || exit 0
[ "$boot" = "$(cat /proc/sys/kernel/random/boot_id)" ] || exit 0
kill -s TERM -- "-$pid" 2>/dev/null || exit 0
for i in $(seq 1 20); do
 kill -0 -- "-$pid" 2>/dev/null || exit 0
 sleep 0.5
done
kill -s KILL -- "-$pid" 2>/dev/null || true`;
