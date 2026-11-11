// Loaded with `node --import` before Next boots.
//
// Containers and sandboxes often deny the netlink ioctl behind
// os.networkInterfaces(), which throws ERR_SYSTEM_ERROR (UV_EACCES) on
// startup. Next calls it from the server's 'listening' handler to print the
// "Network:" URL, and an unhandled throw there kills the process after the
// socket is already bound. There is nothing to enumerate in that situation,
// so answer with an empty map and let Next fall back to localhost.
import os from "node:os";

const original = os.networkInterfaces.bind(os);
let warned = false;

os.networkInterfaces = function networkInterfaces() {
  try {
    return original();
  } catch (error) {
    if (!warned) {
      warned = true;
      console.warn(
        `[schemaload] os.networkInterfaces() failed (${error?.code ?? error?.message}); assuming loopback-only host.`,
      );
    }
    return {};
  }
};
