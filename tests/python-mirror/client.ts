/**
 * `Client` is hai-agents-python's name for the client; the platform's overlay (`oo.ts`, `client.ts.static`)
 * exports it from `hai-agents`. Until that client sync lands on main, the generated entry has `HaiAgentsClient`
 * only, so the mirror reads the name through this one line.
 */
export { HaiAgentsClient as Client } from "hai-agents";
