/**
 * `Client` is hai-agents-python's name for the client; the platform's overlay (`oo.ts`, `client.ts.static`)
 * exports it from `hai-agents`, and this branch carries the generator's output for it. The mirror reads the
 * name through this one line so that the branch below, on the generated entry alone, can alias it.
 */
export { Client } from "hai-agents";
