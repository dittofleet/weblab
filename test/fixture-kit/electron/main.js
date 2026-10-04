// Stands in for an Electron app's main process: a Node process started
// with --inspect, whose electron module (from modules/, on NODE_PATH) is
// a small stand-in for the real one. Kept alive until it is stopped.
//
// An Electron app is one process behind both its ports, so this one
// takes the process id of the Chrome standing in for its window.
if (process.env.WINDOW_PID) Object.defineProperty(process, "pid", { value: Number(process.env.WINDOW_PID) });
const { app } = require("electron");
app.whenReady().then(() => console.log("ready"));
setInterval(() => {}, 1 << 30);
