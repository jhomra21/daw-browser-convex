import path from "node:path"
import { credentialPath } from "./credentials"

export const cliDesktopControlOptions = () => ({
  clientName: "daw-control",
  actorPath: process.env.DAW_CONTROL_ACTOR_PATH
    ?? path.join(path.dirname(credentialPath()), "host-actor-v1.json"),
})
