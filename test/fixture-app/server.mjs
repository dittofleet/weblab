// A stand-in dev server for the tests. Like port-pool under a real
// app, it picks its own port and writes it to .env as it starts, and
// like vite it mounts the app a beat after the page loads.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { join } from "node:path";

const PAGE = `<!doctype html>
<title>fixture</title>
<div id="root"></div>
<script>
  setTimeout(() => {
    document.querySelector("#root").innerHTML =
      '<h1>Fixture app</h1><button id="inc">count 0</button>' +
      '<label>Name <input id="name" placeholder="name"></label><p id="echo"></p>' +
      '<input id="file" type="file" hidden><button id="choose">Choose file</button><p id="picked"></p>' +
      '<label>Size <select id="size"><option value="s">Small</option><option value="l">Large</option></select></label>' +
      '<label><input id="agree" type="checkbox"> Agree</label>' +
      '<button id="ask">Ask</button><p id="answer"></p>' +
      '<button id="dbl" data-testid="dbl">dbl 0</button>' +
      '<a id="pop" href="/other" target="_blank">Open other</a>' +
      '<a id="save" href="data:text/plain,saved%20file" download="note.txt">Download</a>' +
      '<button id="who">Who</button><p id="me"></p>' +
      '<p id="signed">' + (localStorage.getItem("user") ? "signed in as " + localStorage.getItem("user") : "signed out") + '</p>' +
      '<button id="signin">Sign in</button>' +
      '<div id="card" draggable="true">card</div><div id="bin" style="width:80px;height:40px;border:1px solid">bin</div>' +
      '<div id="list" style="height:40px;overflow:auto"><div style="height:400px">a long list</div></div>' +
      '<iframe id="frame" srcdoc="<button onclick=&quot;this.textContent=&#39;pressed&#39;&quot;>Inner</button>"></iframe>';
    const $ = (id) => document.querySelector(id);
    let count = 0;
    $("#inc").addEventListener("click", () => { $("#inc").textContent = "count " + ++count; });
    $("#name").addEventListener("input", (event) => { $("#echo").textContent = "hello " + event.target.value; });
    $("#file").addEventListener("change", async (event) => {
      const [file] = event.target.files;
      $("#picked").textContent = file.name + ": " + (await file.text()).trim();
    });
    $("#choose").addEventListener("click", () => $("#file").click());
    $("#ask").addEventListener("click", () => { $("#answer").textContent = confirm("Sure?") ? "yes" : "no"; });
    let twice = 0;
    $("#dbl").addEventListener("dblclick", () => { $("#dbl").textContent = "dbl " + ++twice; });
    $("#who").addEventListener("click", async () => {
      $("#me").textContent = (await (await fetch("/api/me")).json()).name;
    });
    $("#signin").addEventListener("click", () => { localStorage.setItem("user", "ada"); location.reload(); });
    $("#bin").addEventListener("dragover", (event) => event.preventDefault());
    $("#bin").addEventListener("drop", () => { $("#bin").textContent = "dropped"; });
    console.log("fixture mounted");
    addEventListener("keydown", (event) => {
      if (event.key === "?") document.title = "help open";
    });
  }, 300);
</script>`;

const ROUTES = {
  "/": () => [200, "text/html", PAGE],
  "/other": () => [200, "text/html", "<!doctype html><title>other</title><h1>Other page</h1>"],
  "/api/me": () => [200, "application/json", JSON.stringify({ name: "real" })],
};

const server = createServer((request, response) => {
  const [status, type, body] = ROUTES[request.url]?.() ?? [404, "text/plain", "not found"];
  response.writeHead(status, { "content-type": type }).end(body);
});
if (process.env.WEBLAB_TEST_CRASH) {
  console.log("sh: vite: command not found");
  process.exit(127);
}
// Like `astro dev`, put the real server in the background, out of the
// process group that started it, and exit.
if (process.env.WEBLAB_TEST_DETACH) {
  const child = spawn(process.execPath, [import.meta.filename], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env, WEBLAB_TEST_DETACH: "" },
  });
  child.unref();
  console.log(`server running in the background (pid ${child.pid})`);
  process.exit(0);
}
// Like an app that logs the address of an API it calls.
if (process.env.WEBLAB_TEST_MENTION) console.log(`  API: ${process.env.WEBLAB_TEST_MENTION}`);
if (process.env.WEBLAB_TEST_PIDFILE) writeFileSync(process.env.WEBLAB_TEST_PIDFILE, String(process.pid));
await new Promise((go) => setTimeout(go, Number(process.env.WEBLAB_TEST_DELAY ?? 0)));
// The port from the last start is kept when it is still free, the way a
// port allocator gives a checkout the same port every time.
const envFile = join(import.meta.dirname, ".env");
const last = existsSync(envFile) ? Number(/^PORT=(\d+)$/m.exec(readFileSync(envFile, "utf8"))?.[1] ?? 0) : 0;
// A second server for the same app (as a storybook is), on a port of its own.
const second = Boolean(process.env.WEBLAB_TEST_SECOND);
// Told a port (PORT), it is a copy of the app at that address, and leaves the .env alone.
const told = Number(process.env.PORT ?? 0);
if (!told) server.on("error", () => server.listen(0, "localhost"));
server.listen(told || (second ? 0 : last), "localhost");
server.on("listening", () => {
  const { port } = server.address();
  if (!second && !told) writeFileSync(envFile, `SECRET=do-not-print\nPORT=${port}\n`);
  console.log(`  Local: http://localhost:${port}/`);
});
for (const signal of ["SIGTERM", "SIGINT"]) process.on(signal, () => process.exit(0));
