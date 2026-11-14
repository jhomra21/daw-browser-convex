import { createNativePlaybackController } from "../../src/lib/desktop/native-playback-controller"
import { fixtureEdit, utilityGainPayload } from "./ae-08-processor-state-fuzz-edit"

type Settled<Value> = { settled: false } | { settled: true; result: Value }

// A controller with no bridge can never report progress or end a session, so nothing could answer a request it kept.
// The wait is a bounded run of microtask turns, never a timer: a request that is settled at all settles within a few.
const settledWithin = async <Value>(request: Value | Promise<Value>, turns = 100): Promise<Settled<Value>> => {
  const promise = Promise.resolve(request)
  const spin = async (): Promise<Settled<Value>> => {
    for (let turn = 0; turn < turns; turn++) await Promise.resolve()
    return { settled: false }
  }
  return Promise.race([promise.then((result): Settled<Value> => ({ settled: true, result })), spin()])
}

export default async function unavailableSession() {
  const controller = createNativePlaybackController({
    bridge: undefined,
    compileSnapshot: async () => { throw new Error("The unavailable-session witness never prepares") },
  })
  const payload = utilityGainPayload(-9)
  const edit = fixtureEdit(payload, 1, 120, 1)
  if (!edit) throw new Error("Missing fixture edit")
  const parameterEdit = { ...edit, content: { params: edit.content.params, values: { "utility.gainDb": -9 } } }
  const answers = await Promise.all([
    settledWithin(controller.deliverProcessor(parameterEdit).settled),
    settledWithin(controller.deliverProcessor({ ...parameterEdit, id: "independent-close" }).settled),
    settledWithin(controller.deliverProcessor(parameterEdit, { token: "gesture", holds: true }).settled),
    settledWithin(controller.deliverProcessor({ ...parameterEdit, id: "independent-preview" }, { token: "other-gesture", holds: true }).settled),
  ])
  await controller.dispose()
  return answers
}
