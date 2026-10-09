const { spawn } = require("node:child_process");

const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000);"], {
  detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"],
});
child.stdout.once("data", () => {
  void fetch(`${process.argv[2]}/tree`, { method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pid: process.pid, child: child.pid }) }).then(() => process.exit(0));
});
