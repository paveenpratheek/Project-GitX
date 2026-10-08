/* Whether GitX's child processes need windowsHide.
 *
 * A Windows process with no console gives every console program it runs a
 * window of its own - a git call flashes one open and shut. The broker the MCP
 * server starts is detached, and detached means no console, so there it is
 * needed. Everywhere else GitX runs under a terminal or an agent, and its
 * children share that console for free.
 *
 * Not windowsHide everywhere: it gives each child a hidden console of its own
 * instead of the one it would have shared, and that measured 48ms a git call
 * against 27ms - GitX makes hundreds of them per index, synchronously.
 *
 * Set by whoever starts a process without a console: startBroker() in
 * server.js passes GITX_NO_CONSOLE=1. */
export const NO_CONSOLE = process.env.GITX_NO_CONSOLE === '1';
