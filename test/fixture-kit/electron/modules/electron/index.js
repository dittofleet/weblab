// Just enough of Electron's main-process modules for the tests to call.
const windows = [];
class BrowserWindow {
  static getAllWindows() {
    return windows;
  }
}
const handlers = new Map();
module.exports = {
  app: { getName: () => "fixture", whenReady: () => Promise.resolve() },
  BrowserWindow,
  ipcMain: { handle: (channel, handler) => handlers.set(channel, handler), removeHandler: (channel) => handlers.delete(channel), handlers },
  dialog: { showMessageBox: async () => ({ response: 0 }) },
};
